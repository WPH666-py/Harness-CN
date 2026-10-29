// Patch dsh-wechat's agent setup inside a profile or a seed tree.
//
// The plugin builds every WeChat-bound session through `agents.create`/`agents.resume` and hands them a
// `setup(agentCtx)` callback that mounts the session's agent preset and installs the model-selection
// waterfalls. That callback reads the agent as `ctx.agent` — a property read on the setup context — and
// Cordis answers an undeclared property read with `Error: cannot get property "agent" without inject`.
// The mount never runs, `agents.create` rejects, and the bridge answers the WeChat user with
// 「⚠️ 无法创建/恢复 DSH 会话，请检查 DSH 日志。」 on every message.
//
// The agent is already the callback's second argument: `AgentSetup = (agentCtx: Context, agent: Agent)`
// and the loop invokes it as `setup?.(prepared.agent.ctx, prepared.agent)`, so the installed file is
// corrected to take it from there instead of off the context.
//
// 0.10.0 corrects this upstream: it takes the agent as the callback's second argument. That is the
// version this profile pins, so the correction below only fires for a tree still resolving 0.8.0 — a
// tree reused from an older seed, or a pin that slides back. The module reads no configuration that
// could change this, so the installed file is the only place to correct it without forking the package.
// Running it here — while `prepare-seed.ts` builds the seed — means the archived profile, the tree the
// first launch materializes from it, and every later distribution of that seed all carry the correction,
// and a module that reads the agent off its context in a form this patch cannot anchor on fails the
// build here rather than at the user's first WeChat message.
//
// Writing the file as a new file and renaming it over the old path is deliberate: pnpm hardlinks store
// entries into the profile, so editing the file in place would rewrite the store copy through the link
// while the recorded store index still describes the old bytes.
//
// Usage: node scripts/patch-wechat-sessions.mjs <node_modules-root> [<node_modules-root> ...]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The module the agent setup lives in, relative to a node_modules root. */
const SESSIONS_PATH = join('dsh-wechat', 'dist', 'dsh', 'sessions.js')

/**
 * Resolve a tree to the `node_modules` root that holds dsh-wechat, so a caller can pass either the
 * profile directory (`<profile>/node_modules/...`) or the modules root itself.
 *
 * @param root a profile directory holding `node_modules`, or a `node_modules` root.
 * @returns the directory to look in.
 */
function modulesRoot(root) {
  const nested = join(root, 'node_modules')
  return existsSync(nested) ? nested : root
}

/** The setup callback's signature: the agent arrives as the second argument. */
const SIGNATURE_BEFORE = 'async function agentSetup(agentCtx) {'
const SIGNATURE_AFTER = 'async function agentSetup(agentCtx, agent) {'

/** The preset mount. `agent` is the same object the callback used to reach for through `ctx.agent`. */
const PRESET_BEFORE = 'await presets.mount(agentCtx, ctx.agent?.session?.header?.agentPreset);'
const PRESET_AFTER = 'await presets.mount(agentCtx, agent?.session?.header?.agentPreset);'

/** The session's own latest request header, read the same way. */
const HEADER_BEFORE = 'const logged = ctx.agent?.session?.requestHeader?.()?.config;'
const HEADER_AFTER = 'const logged = agent?.session?.requestHeader?.()?.config;'

/** Every correction as `[before, after]`; both texts are unique in the published module. */
const REPLACEMENTS = [
  [SIGNATURE_BEFORE, SIGNATURE_AFTER],
  [PRESET_BEFORE, PRESET_AFTER],
  [HEADER_BEFORE, HEADER_AFTER],
]

/**
 * A property read of the agent on the setup context — the defect itself. Matching the read rather than
 * the bare name is what keeps a corrected module's own doc comment ("DSH 0.1.5 removed `ctx.agent`")
 * and its `ctx.agents.create`/`ctx.agents.resume` calls out of the match.
 */
const CONTEXT_AGENT_READ = /ctx\.agent\??\./u

/**
 * Correct one installed module's agent setup.
 *
 * @param source the contents of `dsh-wechat/dist/dsh/sessions.js`.
 * @returns the corrected source, or undefined when the module never reads the agent off its context.
 * @throws when the module reads the agent off its context through lines this patch cannot anchor on,
 * because a silently unpatched plugin fails at the user's first WeChat message instead of here.
 */
export function patchWeChatSessions(source) {
  if (!CONTEXT_AGENT_READ.test(source)) return undefined
  for (const [before] of REPLACEMENTS) {
    if (!source.includes(before)) {
      throw new Error(`the installed dsh-wechat does not contain the line the patch anchors on: ${before}`)
    }
  }
  return REPLACEMENTS.reduce((body, [before, after]) => body.replace(before, after), source)
}

/**
 * Prove a tree carries a corrected agent setup, and fail loudly when it does not.
 *
 * @param root a `node_modules` root, or a profile directory holding one.
 * @returns the path of the module that was checked.
 * @throws when the tree has no dsh-wechat, or its setup still reads the agent off the context.
 */
export function verifyWeChatSessions(root) {
  const file = join(modulesRoot(root), SESSIONS_PATH)
  if (!existsSync(file)) throw new Error(`the tree has no dsh-wechat module at ${file}`)
  const body = readFileSync(file, 'utf8')
  if (CONTEXT_AGENT_READ.test(body)) {
    throw new Error(`${file} still reads the agent through the setup context`)
  }
  return file
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

function patchOne(root) {
  const file = join(modulesRoot(root), SESSIONS_PATH)
  if (!existsSync(file)) return { root, status: 'absent' }
  const before = readFileSync(file, 'utf8')
  const after = patchWeChatSessions(before)
  if (after === undefined) return { root, status: 'already', bytes: statSync(file).size }
  // The rename below publishes the content, so the checks below run on the exact bytes it writes.
  const temporary = `${file}.patch-tmp`
  writeFileSync(temporary, after, 'utf8')
  renameSync(temporary, file)
  const written = readFileSync(file, 'utf8')
  for (const [anchor, replacement] of REPLACEMENTS) {
    if (written.includes(anchor) || !written.includes(replacement)) {
      throw new Error(`${file} does not carry ${replacement} after the patch`)
    }
  }
  return { root, status: 'patched', bytes: statSync(file).size, sha256: sha256(after) }
}

/**
 * Report what the patch would do to one tree, without writing.
 *
 * `patchWeChatSessions` returns undefined for "nothing to do", which covers both "already patched"
 * and "the module was rewritten upstream". The check separates them: the patched signature is the
 * positive marker, and a surviving `ctx.agent` read is the negative one.
 * @param root - a profile directory or a node_modules root.
 * @returns the state.
 */
function inspectOne(root) {
  const file = join(modulesRoot(root), SESSIONS_PATH)
  if (!existsSync(file)) return { root, status: 'absent' }
  const body = readFileSync(file, 'utf8')
  if (body.includes(SIGNATURE_AFTER)) return { root, status: 'patched' }
  if (CONTEXT_AGENT_READ.test(body)) return { root, status: 'pristine' }
  return { root, status: 'drifted', detail: `no ${SIGNATURE_AFTER} and no ctx.agent read in ${file}` }
}

const roots = process.argv.slice(2).filter((argument) => argument !== '--check')
const check = process.argv.includes('--check')
if (roots.length > 0 && check) {
  let drifted = false
  for (const root of roots) {
    const result = inspectOne(root)
    process.stdout.write(`${JSON.stringify({ patch: 'wechat-sessions', root, state: result.status, detail: result.detail ?? '' })}\n`)
    if (result.status === 'drifted') drifted = true
  }
  process.exit(drifted ? 1 : 0)
} else if (roots.length > 0) {
  for (const root of roots) {
    const result = patchOne(root)
    if (result.status === 'absent') {
      process.stdout.write(`patch-wechat-sessions: no dsh-wechat under ${root}; nothing to patch\n`)
    } else if (result.status === 'already') {
      process.stdout.write(`patch-wechat-sessions: ${root} already reads the agent from the setup callback (${String(result.bytes)} bytes)\n`)
    } else {
      process.stdout.write(`patch-wechat-sessions: patched ${root} (${String(result.bytes)} bytes, sha256 ${String(result.sha256)})\n`)
    }
  }
} else if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stderr.write('patch-wechat-sessions: give at least one node_modules root\n')
  process.exit(2)
}
