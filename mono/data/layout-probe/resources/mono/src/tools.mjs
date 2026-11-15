/**
 * Tool surface for the monolith.
 *
 * Each tool returns a short string the model reads. Everything is confined to the session working
 * directory: a path that resolves outside it is refused before any filesystem call, which is the one
 * security invariant this stage keeps. No approval gate yet — see README's migration list.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Most bytes one tool result may return to the model. */
const MAX_RESULT_BYTES = 60_000
/** Most milliseconds one shell command may run. */
const SHELL_TIMEOUT_MS = 120_000

/** JSON-schema declarations handed to the model. */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file. Returns the content with a line-number prefix.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the working directory.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 text file with the given content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List one directory: name, kind, and size for each entry.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory relative to the working directory; empty for the root.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a JavaScript regular expression under one directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Directory to search; empty for the working directory.' },
          ignoreCase: { type: 'boolean' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run one shell command in the working directory and return combined output.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
]

/**
 * Resolve a model-supplied path inside the working directory.
 * @param cwd - absolute working directory of the session.
 * @param path - model-supplied absolute or relative path.
 * @returns the absolute path, guaranteed to be `cwd` or beneath it.
 */
function insideWorkingDirectory(cwd, path) {
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(join(root, path))
  const normalizedRoot = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(normalizedRoot)) {
    throw new Error(`path escapes the working directory: ${path}`)
  }
  return target
}

/** Prefix every line with its number so the model can cite positions. */
function numbered(text) {
  return text.split(/\r?\n/u).map((line, index) => `${String(index + 1).padStart(5, ' ')}  ${line}`).join('\n')
}

/** Cut an oversized result and say so, rather than letting one tool blow the context. */
function bounded(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_RESULT_BYTES) return text
  return `${text.slice(0, MAX_RESULT_BYTES)}\n… truncated at ${String(MAX_RESULT_BYTES)} bytes`
}

/**
 * Run one shell command.
 * @param command - command line the model produced.
 * @param cwd - working directory.
 * @returns combined stdout and stderr plus the exit code.
 */
function shell(command, cwd) {
  const windows = process.platform === 'win32'
  const file = windows ? 'pwsh' : 'bash'
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command]
  return new Promise((resolvePromise) => {
    execFile(file, args, { cwd, timeout: SHELL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
      const body = `${stdout}${stderr}`.trim()
      resolvePromise(bounded(`exit ${String(code)}\n${body === '' ? '(no output)' : body}`))
    })
  })
}

/**
 * Execute one tool call.
 * @param name - tool name the model chose.
 * @param args - parsed JSON arguments.
 * @param cwd - absolute working directory.
 * @returns the text the model receives as the tool result.
 */
export async function runTool(name, args, cwd) {
  try {
    if (name === 'read_file') {
      const target = insideWorkingDirectory(cwd, String(args.path ?? ''))
      return bounded(numbered(await readFile(target, 'utf8')))
    }
    if (name === 'write_file') {
      const target = insideWorkingDirectory(cwd, String(args.path ?? ''))
      const content = String(args.content ?? '')
      await writeFile(target, content, 'utf8')
      return `wrote ${String(Buffer.byteLength(content, 'utf8'))} bytes to ${relative(resolve(cwd), target)}`
    }
    if (name === 'list_dir') {
      const target = insideWorkingDirectory(cwd, String(args.path ?? ''))
      const entries = await readdir(target, { withFileTypes: true })
      const rows = []
      for (const entry of entries.slice(0, 500)) {
        const size = entry.isFile() ? (await stat(join(target, entry.name))).size : 0
        rows.push(`${entry.isDirectory() ? 'dir ' : 'file'}  ${String(size).padStart(10)}  ${entry.name}`)
      }
      return bounded(rows.join('\n') || '(empty)')
    }
    if (name === 'grep') {
      const root = insideWorkingDirectory(cwd, String(args.path ?? '.'))
      const flags = args.ignoreCase === true ? 'iu' : 'u'
      const pattern = new RegExp(String(args.pattern ?? ''), flags)
      const hits = []
      const walk = async (directory) => {
        if (hits.length >= 200) return
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (hits.length >= 200) return
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          const path = join(directory, entry.name)
          if (entry.isDirectory()) await walk(path)
          else if (entry.isFile()) {
            let text
            try {
              text = await readFile(path, 'utf8')
            } catch {
              continue
            }
            text.split(/\r?\n/u).forEach((line, index) => {
              if (hits.length < 200 && pattern.test(line)) {
                hits.push(`${relative(root, path)}:${String(index + 1)}: ${line.trim().slice(0, 240)}`)
              }
            })
          }
        }
      }
      await walk(root)
      return bounded(hits.join('\n') || 'no matches')
    }
    if (name === 'run_shell') return await shell(String(args.command ?? ''), cwd)
    return `unknown tool: ${name}`
  } catch (error) {
    return `tool failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
