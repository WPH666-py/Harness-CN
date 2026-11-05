/**
 * Bring the remote workspace tree in line with the workstation tree.
 *
 * The shipped explorer is a flat re-render: a folder row toggles its own `expanded` flag, but a
 * folder that is still loading, failed to load, or is empty draws nothing at all. A user who
 * connects to a server therefore sees an expandable row that appears to do nothing when the listing
 * is slow, and sees no explanation at all when it fails — including no way to ask again. The
 * workstation tree (`packages/client/ui-workstation/src/client/FileTree.tsx`) instead gives every
 * level its own loading, failure and empty row, and a failed level is retryable.
 *
 * This module rewrites the plugin's authored source (`workspace.js`, `styles.js`) and then runs the
 * plugin's own `scripts/build-client.js`, because `client.js` embeds the sources as escaped string
 * literals — editing the source alone changes nothing the browser runs, and hand-editing the bundle
 * would be undone by the next build.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, report } from './lib/patch-check.mjs'

/** The plugin package, relative to the tree's node_modules directory. */
const PACKAGE = 'dsh-remote-ssh-ops'

/** Authored explorer source; the bundle embeds it, so the source is the thing to edit. */
const WORKSPACE = join(PACKAGE, 'src', 'plugin', 'client', 'workspace.js')

/** Authored style source; `client.js` embeds it the same way. */
const STYLES = join(PACKAGE, 'src', 'plugin', 'client', 'styles.js')

/** The generated bundle the browser actually loads. */
const CLIENT = join(PACKAGE, 'src', 'plugin', 'client.js')

/** The plugin's own bundle generator; it strips `export` and re-escapes each source. */
const BUILD = join(PACKAGE, 'scripts', 'build-client.js')

/** Present in every patched file, so a re-run and a verification agree on what "patched" means. */
const MARKER = 'remoteWorkspace__retry'

/**
 * One exact source edit: `from` must occur once, and the result must contain `MARKER`.
 * @type {readonly {file: string, from: string, to: string}[]}
 */
const EDITS = [
  {
    file: WORKSPACE,
    from: '    const [loadingPaths, setLoadingPaths] = useState({})\n',
    to: '    const [loadingPaths, setLoadingPaths] = useState({})\n'
      + '    // Listing failures stay on their folder row: the global alert bar is for one-off actions\n'
      + '    // such as saving or running a command, and a failed folder needs its own retry affordance.\n'
      + '    const [failedPaths, setFailedPaths] = useState({})\n',
  },
  {
    file: WORKSPACE,
    from: `    const loadDirectory = async (path, force = false) => {
      if (!hostId || (!force && directories[path])) return
      setLoadingPaths((current) => ({ ...current, [path]: true }))
      try {
        const result = await api.listFiles(hostId, path)
        setDirectories((current) => ({ ...current, [result.path ?? path]: result.entries ?? [] }))
      } finally {
        setLoadingPaths((current) => ({ ...current, [path]: false }))
      }
    }
`,
    to: `    const loadDirectory = async (path, force = false) => {
      if (!hostId || (!force && directories[path])) return
      setLoadingPaths((current) => ({ ...current, [path]: true }))
      try {
        const result = await api.listFiles(hostId, path)
        const listed = result.path ?? path
        setDirectories((current) => ({ ...current, [listed]: result.entries ?? [] }))
        setFailedPaths((current) => {
          if (Object.keys(current).length === 0) return current
          const next = { ...current }
          Reflect.deleteProperty(next, path)
          Reflect.deleteProperty(next, listed)
          return next
        })
      } catch (error) {
        setFailedPaths((current) => ({ ...current, [path]: error?.message || '目录读取失败' }))
      } finally {
        setLoadingPaths((current) => ({ ...current, [path]: false }))
      }
    }
`,
  },
  {
    file: WORKSPACE,
    from: `      setDirectories({})
      setExpanded({ [cwd]: true })
`,
    to: `      setDirectories({})
      setFailedPaths({})
      setExpanded({ [cwd]: true })
`,
  },
  {
    file: WORKSPACE,
    from: `    const renderTree = (path, depth = 0) => sortDirectoryEntries(directories[path]).filter((entry) => {
      if (!treeFilter.trim()) return true
      return entry.name.toLocaleLowerCase().includes(treeFilter.trim().toLocaleLowerCase())
    }).map((entry) => {
      const folder = directoryEntry(entry)
      const isOpen = Boolean(expanded[entry.path])
      return h(Fragment, { key: entry.path },
        h('button', { className: 'remoteWorkspace__treeEntry', type: 'button', style: { paddingLeft: \`\${6 + depth * 16}px\` }, 'data-active': String(folder ? activeDirectory === entry.path : file?.path === entry.path), title: entry.path, onClick: () => openEntry(entry) },
          h('span', { className: 'remoteWorkspace__treeChevron' }, icon(folder ? (isOpen ? IconChevronDownOutline14 : IconChevronRightOutline14) : null)),
          icon(folder ? (isOpen ? IconFolderOpen16 : IconFolderClose16) : IconCodeOutline16),
          h('span', { className: 'remoteWorkspace__treeName' }, entry.name),
        ),
        folder && isOpen ? renderTree(entry.path, depth + 1) : null,
      )
    })
`,
    to: `    // Parity with the workstation tree's Level: an expanded folder always draws something — its
    // children, a loading row, its failure with a retry, or the fact that it is empty.
    const renderChildren = (parentPath, depth) => {
      const indent = { paddingLeft: \`\${24 + depth * 16}px\` }
      const failure = failedPaths[parentPath]
      if (failure !== undefined) {
        return h('div', { className: 'remoteWorkspace__treeMessage', role: 'alert', style: indent },
          failure,
          h('button', { className: 'remoteWorkspace__retry', type: 'button', onClick: () => { loadDirectory(parentPath, true) } }, '重试'),
        )
      }
      if (loadingPaths[parentPath] || directories[parentPath] === undefined) {
        return h('div', { className: 'remoteWorkspace__treeMessage', style: indent }, '读取中…')
      }
      if (directories[parentPath].length === 0) {
        return h('div', { className: 'remoteWorkspace__treeMessage', style: indent }, '空文件夹')
      }
      return renderTree(parentPath, depth)
    }
    const renderTree = (path, depth = 0) => sortDirectoryEntries(directories[path]).filter((entry) => {
      if (!treeFilter.trim()) return true
      return entry.name.toLocaleLowerCase().includes(treeFilter.trim().toLocaleLowerCase())
    }).map((entry) => {
      const folder = directoryEntry(entry)
      const isOpen = Boolean(expanded[entry.path])
      return h(Fragment, { key: entry.path },
        h('button', { className: 'remoteWorkspace__treeEntry', type: 'button', style: { paddingLeft: \`\${6 + depth * 16}px\` }, 'data-active': String(folder ? activeDirectory === entry.path : file?.path === entry.path), title: entry.path, onClick: () => openEntry(entry) },
          h('span', { className: 'remoteWorkspace__treeChevron' }, icon(folder ? (isOpen ? IconChevronDownOutline14 : IconChevronRightOutline14) : null)),
          icon(folder ? (isOpen ? IconFolderOpen16 : IconFolderClose16) : IconCodeOutline16),
          h('span', { className: 'remoteWorkspace__treeName' }, entry.name),
        ),
        folder && isOpen ? renderChildren(entry.path, depth + 1) : null,
      )
    })
`,
  },
  {
    file: WORKSPACE,
    from: `            h('div', { className: 'remoteWorkspace__tree' }, h('button', { className: 'remoteWorkspace__treeEntry', type: 'button', 'data-active': String(activeDirectory === rootPath), onClick: () => { setActiveDirectory(rootPath); setExpanded((current) => ({ ...current, [rootPath]: !current[rootPath] })) } }, icon(expanded[rootPath] ? IconChevronDownOutline14 : IconChevronRightOutline14), icon(expanded[rootPath] ? IconFolderOpen16 : IconFolderClose16), h('span', { className: 'remoteWorkspace__treeName' }, rootPath)), expanded[rootPath] ? renderTree(rootPath) : null, loadingPaths[rootPath] ? h('div', { className: 'remoteWorkspace__treeMessage' }, '读取中…') : null),
`,
    to: `            h('div', { className: 'remoteWorkspace__tree' }, h('button', { className: 'remoteWorkspace__treeEntry', type: 'button', 'data-active': String(activeDirectory === rootPath), onClick: () => { const opening = !expanded[rootPath]; setActiveDirectory(rootPath); setExpanded((current) => ({ ...current, [rootPath]: opening })); if (opening) loadDirectory(rootPath, false) } }, icon(expanded[rootPath] ? IconChevronDownOutline14 : IconChevronRightOutline14), icon(expanded[rootPath] ? IconFolderOpen16 : IconFolderClose16), h('span', { className: 'remoteWorkspace__treeName' }, rootPath)), expanded[rootPath] ? renderChildren(rootPath, 0) : null),
`,
  },
  {
    file: WORKSPACE,
    from: `    const renderDiff = (change) => DiffBlock
      ? h(DiffBlock, {
        className: 'remoteWorkspace__nativeDiff',
`,
    to: `    // The shared card draws its toolbar from the owning site's chrome. This host mounts it
    // directly, so it has to supply the dictionary itself: reading it off an absent object threw
    // while React rendered the change list, taking the whole workbench down with it.
    const diffLabels = {
      codeLabel: '代码',
      wrapLabel: '自动换行',
      unwrapLabel: '不换行',
      copy: '复制',
      copied: '已复制',
      collapseAria: '收起改动',
      collapse: '收起',
      expandAria: (hidden) => '展开其余 ' + hidden + ' 行',
      expand: (hidden) => '展开其余 ' + hidden + ' 行',
    }
    const renderDiff = (change) => DiffBlock
      ? h(DiffBlock, {
        className: 'remoteWorkspace__nativeDiff',
        labels: diffLabels,
`,
  },
  {
    file: STYLES,
    from: '  .remoteWorkspace__treeMessage { color: var(--ro-dim); font-size: 12px; padding: 8px; }\n',
    to: '  .remoteWorkspace__treeMessage { color: var(--ro-dim); font-size: 12px; padding: 8px; }\n'
      + '  .remoteWorkspace__retry { background: transparent; border: 0; color: var(--ro-accent); cursor: pointer; font: inherit; font-size: 12px; margin-left: 6px; padding: 0; text-decoration: underline; }\n',
  },
]

/**
 * Read a source file as LF text, and report whether it used CRLF so the write can restore it.
 * @param file - absolute path.
 * @returns the normalized text and the original line ending.
 */
function readSource(file) {
  const text = readFileSync(file, 'utf8')
  const crlf = text.includes('\r\n')
  return { text: crlf ? text.replaceAll('\r\n', '\n') : text, crlf }
}

/**
 * Apply the explorer edits to an installed plugin tree.
 * @param nodeModules - the profile's node_modules directory.
 * @returns the files this call rewrote.
 * @throws When the package is installed but its source no longer contains an anchor, because that
 * means the patch would silently stop applying instead of reporting that upstream changed.
 */
export function patchRemoteSshWorkspaceTree(nodeModules) {
  const workspace = join(nodeModules, WORKSPACE)
  if (!existsSync(workspace)) return []
  if (readFileSync(workspace, 'utf8').includes(MARKER)) return []
  const sources = new Map()
  const changed = []
  for (const edit of EDITS) {
    const file = join(nodeModules, edit.file)
    if (!sources.has(file)) sources.set(file, readSource(file))
    const source = sources.get(file)
    const occurrences = source.text.split(edit.from).length - 1
    if (occurrences !== 1) {
      throw new Error(`${file}: expected exactly one anchor for the workspace tree patch, found ${String(occurrences)}`)
    }
    source.text = source.text.replace(edit.from, edit.to)
    if (!changed.includes(file)) changed.push(file)
  }
  for (const [file, source] of sources) {
    writeFileSync(file, source.crlf ? source.text.replaceAll('\n', '\r\n') : source.text, 'utf8')
  }
  buildClient(nodeModules)
  return changed
}

/**
 * Regenerate `client.js` from the patched sources with the plugin's own generator.
 * @param nodeModules - the profile's node_modules directory.
 * @throws When the generator is missing or fails, because a stale bundle would serve none of the
 * above edits.
 */
function buildClient(nodeModules) {
  const script = join(nodeModules, BUILD)
  if (!existsSync(script)) throw new Error(`desktop seed: ${script} is missing; the remote workspace bundle cannot be regenerated`)
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`desktop seed: regenerating ${CLIENT} failed (exit ${String(result.status)}): ${result.stderr ?? ''}`)
  }
}

/**
 * Require the patched explorer in a tree the seed produced.
 * @param tree - the seed's node_modules directory.
 * @returns the files that carry the patch.
 * @throws When a bundle the seed would ship still lacks the loading, failure and retry rows.
 */
export function verifyRemoteSshWorkspaceTree(tree) {
  const workspace = join(tree, WORKSPACE)
  if (!existsSync(workspace)) return []
  const files = [WORKSPACE, STYLES, CLIENT].map((relative) => join(tree, relative))
  for (const file of files) {
    if (!readFileSync(file, 'utf8').includes(MARKER)) {
      throw new Error(`desktop seed: ${file} lost the remote workspace tree patch`)
    }
  }
  return files
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { check, root } = parseArgs(process.argv.slice(2))
  if (root === undefined) {
    console.error('usage: patch-remote-ssh-workspace-tree.mjs [--check] <node_modules>')
    process.exit(2)
  }
  const workspace = join(root, WORKSPACE)
  if (!existsSync(workspace)) report('remote-ssh-workspace-tree', root, 'absent', WORKSPACE)
  if (check) {
    const patched = [WORKSPACE, STYLES, CLIENT].every((relative) => readFileSync(join(root, relative), 'utf8').includes(MARKER))
    if (patched) report('remote-ssh-workspace-tree', root, 'patched', [WORKSPACE, STYLES, CLIENT].join(', '))
    const source = readFileSync(workspace, 'utf8').replaceAll('\r\n', '\n')
    const intact = EDITS.filter((edit) => edit.file === WORKSPACE).every((edit) => source.includes(edit.from))
    report('remote-ssh-workspace-tree', root, intact ? 'pristine' : 'drifted', workspace)
  }
  const changed = patchRemoteSshWorkspaceTree(root)
  verifyRemoteSshWorkspaceTree(root)
  console.log(`remote-ssh workspace tree: ${String(changed.length)} source file(s) updated`)
}
