import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { provisionRuntimes, runtimePlan } from '../src/runtimes.ts'
import type { RuntimeComponent } from '../src/runtimes.ts'

/** Longest a test waits for a background component before failing. */
const WAIT_MILLISECONDS = 15_000

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Create one throwaway home below the temporary directory. */
function temporaryHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtimes-'))
  roots.push(root)
  return root
}

/**
 * Wait until a condition holds.
 * @param settle - condition that reports completion.
 * @param label - text used when the deadline passes.
 */
async function waitFor(settle: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_MILLISECONDS
  while (!settle()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(10)
  }
}

/**
 * Wait until the log carries a line starting with the given text.
 * @param lines - log lines collected so far.
 * @param text - prefix to wait for.
 */
async function waitForLine(lines: readonly string[], text: string): Promise<void> {
  await waitFor(() => lines.some(line => line.startsWith(text)), text)
}

/**
 * Read the URL a fetch input names.
 * @param input - request the downloader passed.
 * @returns the URL as text.
 */
function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * Build a `fetch` replacement that answers from memory.
 * @param handler - maps a request URL to a response.
 * @returns a fetch-compatible function that never reaches the network.
 */
function respond(handler: (url: string) => Response): typeof globalThis.fetch {
  return async input => handler(requestUrl(input))
}

/**
 * Read a component's ordered sources from the plan.
 * @param home - home the plan describes.
 * @param component - component to look up.
 * @returns the sources in the order the provisioner tries them.
 */
function sourcesOf(home: string, component: RuntimeComponent): readonly string[] {
  const entry = runtimePlan(home).find(item => item.component === component)
  if (entry === undefined) throw new Error(`plan has no ${component} entry`)
  return entry.sources
}

/**
 * List provisioning leftovers a finished component must not leave behind.
 * @param root - the home's `runtimes` directory.
 * @returns names of partial directories, in-flight archives, and wheel temporaries.
 */
function leftovers(root: string): readonly string[] {
  return readdirSync(root).filter(
    name => name.includes('.partial-') || name.includes('.download-') || name.endsWith('.wheel'),
  )
}

/** One file of a test archive. */
interface ZipFixture {
  /** Entry path, with `/` separators. */
  readonly name: string
  /** Entry bytes before compression. */
  readonly data: Buffer
  /** Whether the entry is stored raw (`false`) or raw-deflated (`true`). */
  readonly deflate?: boolean
}

/**
 * Build a ZIP archive with the entries the reader under test must handle.
 * @param entries - files to place in the archive.
 * @returns the archive bytes, central directory included.
 */
function buildZip(entries: readonly ZipFixture[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const payload = entry.deflate === true ? deflateRawSync(entry.data) : entry.data
    const method = entry.deflate === true ? 8 : 0
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(payload.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(method, 10)
    record.writeUInt32LE(payload.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    local.push(header, name, payload)
    central.push(record, name)
    offset += 30 + name.length + payload.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

describe('runtimePlan', () => {
  it('reports every component absent for an empty home', () => {
    const home = temporaryHome()
    const plan = runtimePlan(home)
    expect(plan.map(entry => entry.component)).toEqual(['python', 'mingw', 'r'])
    expect(plan.every(entry => !entry.present)).toBe(true)
    expect(plan.every(entry => entry.sources.length > 1)).toBe(true)
  })

  it('puts a China mirror first and the canonical host last', () => {
    const [python, mingw, r] = runtimePlan(temporaryHome())
    expect(python?.sources[0]).toContain('npmmirror.com')
    expect(python?.sources.at(-1)).toContain('github.com')
    expect(mingw?.sources[0]).toContain('mirror.nju.edu.cn')
    expect(mingw?.sources.at(-1)).toContain('github.com')
    expect(r?.sources[0]).toContain('ghfast.top')
    expect(r?.sources.at(-1)).toContain('github.com')
  })

  it('ships R as an archive rather than an installer', () => {
    const [, , r] = runtimePlan(temporaryHome())
    // An installer needs an elevation prompt a background sidecar can never answer, so R must
    // arrive as a ZIP the provisioner unpacks itself.
    expect(r?.sources.every(source => source.endsWith('.zip'))).toBe(true)
  })

  it('reports a component present once its marker exists', () => {
    const home = temporaryHome()
    const marker = join(home, 'runtimes', 'mingw', 'bin', 'g++.exe')
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, '')
    const plan = runtimePlan(home)
    expect(plan.find(entry => entry.component === 'mingw')?.present).toBe(true)
    expect(plan.filter(entry => entry.present).length).toBe(1)
  })
})

describe('provisionRuntimes', () => {
  it('reports a provisioned component ready without downloading it', () => {
    const home = temporaryHome()
    const marker = join(home, 'runtimes', 'mingw', 'bin', 'g++.exe')
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, '')
    const lines: string[] = []
    let requests = 0
    const states = provisionRuntimes({
      home,
      log: (text) => {
        lines.push(text)
      },
      components: ['mingw'],
      fetch: respond(() => {
        requests += 1
        return new Response(null, { status: 500 })
      }),
    })
    expect(states).toEqual(['skipped', 'ready', 'skipped'])
    expect(lines).toEqual(['runtimes: mingw ready'])
    expect(requests).toBe(0)
  })

  it('tries the next source when a mirror answers with an error status', async () => {
    const home = temporaryHome()
    const root = join(home, 'runtimes')
    const sources = sourcesOf(home, 'mingw')
    const archive = buildZip([{ name: 'mingw64/bin/g++.exe', data: Buffer.from('MZ') }])
    const attempts: string[] = []
    const lines: string[] = []
    const states = provisionRuntimes({
      home,
      log: (text) => {
        lines.push(text)
      },
      components: ['mingw'],
      fetch: respond((url) => {
        attempts.push(url)
        if (url === sources[0]) return new Response(null, { status: 404 })
        return new Response(new Uint8Array(archive), { status: 200 })
      }),
    })
    expect(states).toEqual(['skipped', 'started', 'skipped'])
    await waitForLine(lines, 'runtimes: mingw ready')
    await waitFor(() => leftovers(root).length === 0, 'leftover cleanup')
    expect(attempts).toEqual([sources[0], sources[1]])
    expect(lines).toContain(`runtimes: mingw trying ${sources[0]}`)
    expect(lines).toContain('runtimes: mingw mirror answered HTTP 404')
    expect(lines).toContain(`runtimes: mingw trying ${sources[1]}`)
    expect(existsSync(join(root, 'mingw', 'bin', 'g++.exe'))).toBe(true)
    expect(readdirSync(root)).toEqual(['mingw'])
  })

  it('unpacks entries compressed with raw deflate', async () => {
    const home = temporaryHome()
    const root = join(home, 'runtimes')
    const payload = 'g++.exe content that deflate can shrink '.repeat(20)
    const archive = buildZip([{ name: 'mingw64/bin/g++.exe', data: Buffer.from(payload), deflate: true }])
    const lines: string[] = []
    provisionRuntimes({
      home,
      log: (text) => {
        lines.push(text)
      },
      components: ['mingw'],
      fetch: respond(() => new Response(new Uint8Array(archive), { status: 200 })),
    })
    await waitForLine(lines, 'runtimes: mingw ready')
    expect(readFileSync(join(root, 'mingw', 'bin', 'g++.exe'), 'utf8')).toBe(payload)
  })

  it('tries the next source when a download breaks off mid-stream', async () => {
    const home = temporaryHome()
    const root = join(home, 'runtimes')
    const sources = sourcesOf(home, 'mingw')
    const archive = buildZip([{ name: 'mingw64/bin/g++.exe', data: Buffer.from('MZ') }])
    const lines: string[] = []
    provisionRuntimes({
      home,
      log: (text) => {
        lines.push(text)
      },
      components: ['mingw'],
      fetch: respond((url) => {
        if (url === sources[0]) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error('connection reset'))
              },
            }),
            { status: 200 },
          )
        }
        return new Response(new Uint8Array(archive), { status: 200 })
      }),
    })
    await waitForLine(lines, 'runtimes: mingw ready')
    expect(lines).toContain(`runtimes: mingw download from ${sources[0]} failed (connection reset)`)
    expect(existsSync(join(root, 'mingw', 'bin', 'g++.exe'))).toBe(true)
  })

  it('leaves no partial directory when every source fails', async () => {
    const home = temporaryHome()
    const root = join(home, 'runtimes')
    const lines: string[] = []
    provisionRuntimes({
      home,
      log: (text) => {
        lines.push(text)
      },
      components: ['mingw'],
      fetch: respond(() => new Response(null, { status: 503 })),
    })
    await waitForLine(lines, 'runtimes: mingw stopped (')
    await waitFor(() => leftovers(root).length === 0, 'leftover cleanup')
    expect(lines.at(-1)).toBe('runtimes: mingw stopped (no source answered after 2 attempts)')
    expect(existsSync(join(root, 'mingw'))).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('leaves no partial directory when the archive cannot be unpacked', async () => {
    const home = temporaryHome()
    const root = join(home, 'runtimes')
    const lines: string[] = []
    provisionRuntimes({
      home,
      log: (text) => {
        lines.push(text)
      },
      components: ['mingw'],
      fetch: respond(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })),
    })
    await waitForLine(lines, 'runtimes: mingw stopped (')
    await waitFor(() => leftovers(root).length === 0, 'leftover cleanup')
    expect(lines.at(-1)).toBe(
      'runtimes: mingw stopped (zip archive is too short to hold an end record)',
    )
    expect(readdirSync(root)).toEqual([])
  })

  it('reports a stop instead of throwing when the runtimes directory is a file', async () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'runtimes'), '')
    const lines: string[] = []
    let states: readonly string[] = []
    expect(() => {
      states = provisionRuntimes({
        home,
        log: (text) => {
          lines.push(text)
        },
        components: ['mingw'],
        fetch: respond(() => new Response(null, { status: 200 })),
      })
    }).not.toThrow()
    expect(states).toEqual(['skipped', 'started', 'skipped'])
    await waitForLine(lines, 'runtimes: mingw stopped (')
    expect(lines.at(-1)).toContain('EEXIST')
  })

  it('does not start a component twice while it is running', async () => {
    const home = temporaryHome()
    const lines: string[] = []
    const archive = buildZip([{ name: 'mingw64/bin/g++.exe', data: Buffer.from('MZ') }])
    const options = {
      home,
      log: (text: string): void => {
        lines.push(text)
      },
      components: ['mingw'] as const,
      fetch: respond(() => new Response(new Uint8Array(archive), { status: 200 })),
    }
    expect(provisionRuntimes(options)).toEqual(['skipped', 'started', 'skipped'])
    expect(provisionRuntimes(options)).toEqual(['skipped', 'started', 'skipped'])
    await waitForLine(lines, 'runtimes: mingw ready')
    expect(lines.filter(line => line.startsWith('runtimes: mingw trying')).length).toBe(1)
  })
})
