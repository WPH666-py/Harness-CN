// Name this product inside the WeChat conversation.
//
// dsh-wechat injects one prompt section (`dsh-wechat-surface`) whose built-in text —
// `DEFAULT_SURFACE_PROMPT` in `dist/config.js` — tells the model it is chatting through WeChat and
// nothing else, so a user asking the bridge who it is gets an unnamed assistant. The contact name
// WeChat displays for the bot is assigned by Tencent's iLink platform to `bot_type=3`
// (「微信ClawBot」) and is not settable from here: the request that creates the bot carries `bot_type`
// alone, which is true of dsh-wechat 0.10.0 and 0.11.0 and of Tencent's own
// `@tencent-weixin/openclaw-weixin@1.0.2` (`login-qr.ts` sends the same single parameter). A product
// name therefore has to come from the side this product owns — the prompt the bridge chats through.
//
// The correction appends one sentence to the built-in prompt. It is the default only: a profile whose
// `~/.dsh-wechat/config.json` carries an edited `surfacePrompt` keeps that text, because the plugin
// persists it verbatim and only drops stored values equal to a superseded built-in.
//
// Usage: node scripts/patch-wechat-identity.mjs <node_modules-root> [<node_modules-root> ...]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The name the bridge answers to in WeChat. */
export const WECHAT_BOT_NAME = 'DSH-MoBot'

/** The module that holds the built-in surface prompt, relative to a node_modules root. */
const CONFIG_PATH = join('dsh-wechat', 'dist', 'config.js')

/** The export the patch rewrites; the captured group is the prompt text itself. */
const DEFAULT_PROMPT = /export const DEFAULT_SURFACE_PROMPT = "([^"]*)";/u

/**
 * The sentence appended to the built-in prompt.
 *
 * @returns the identity sentence for {@link WECHAT_BOT_NAME}.
 */
function identitySentence() {
  return `你在微信里的名字是 ${WECHAT_BOT_NAME}；用户问起你是谁时，请用这个名字介绍自己。`
}

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

/**
 * Name the bridge in one installed module's built-in surface prompt.
 *
 * @param source the contents of `dsh-wechat/dist/config.js`.
 * @returns the corrected source, or undefined when the prompt already carries the product name.
 * @throws when the module exports no surface prompt this patch can anchor on, because a silently
 * unnamed bridge is what the user reports as a missing feature rather than a build failure.
 */
export function patchWeChatIdentity(source) {
  const match = DEFAULT_PROMPT.exec(source)
  if (match === null) {
    throw new Error('the installed dsh-wechat does not export DEFAULT_SURFACE_PROMPT in a form the patch anchors on')
  }
  const prompt = match[1] ?? ''
  if (prompt.includes(WECHAT_BOT_NAME)) return undefined
  return source.replace(match[0], `export const DEFAULT_SURFACE_PROMPT = "${prompt}${identitySentence()}";`)
}

/**
 * Prove a tree carries the named surface prompt, and fail loudly when it does not.
 *
 * @param root a `node_modules` root, or a profile directory holding one.
 * @returns the path of the module that was checked.
 * @throws when the tree has no dsh-wechat, or its built-in prompt never names the bridge.
 */
export function verifyWeChatIdentity(root) {
  const file = join(modulesRoot(root), CONFIG_PATH)
  if (!existsSync(file)) throw new Error(`the tree has no dsh-wechat module at ${file}`)
  const body = readFileSync(file, 'utf8')
  const match = DEFAULT_PROMPT.exec(body)
  if (match === null || !(match[1] ?? '').includes(WECHAT_BOT_NAME)) {
    throw new Error(`${file} does not name the bridge ${WECHAT_BOT_NAME} in its built-in surface prompt`)
  }
  return file
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

async function patchOne(root) {
  const file = join(modulesRoot(root), CONFIG_PATH)
  if (!existsSync(file)) return { root, status: 'absent' }
  const before = readFileSync(file, 'utf8')
  const after = patchWeChatIdentity(before)
  if (after === undefined) return { root, status: 'already', bytes: statSync(file).size }
  // The replacement is published by a rename, so prove the new bytes load and export the name from
  // the temporary path first: a prompt edited into invalid JavaScript would otherwise reach the seed.
  // The temporary name carries `.mjs` because that is what lets this file import it — an unknown
  // extension is refused before the module is parsed.
  const temporary = `${file}.patch-tmp.mjs`
  writeFileSync(temporary, after, 'utf8')
  const loaded = await import(pathToFileURL(temporary).href)
  if (typeof loaded.DEFAULT_SURFACE_PROMPT !== 'string' || !loaded.DEFAULT_SURFACE_PROMPT.includes(WECHAT_BOT_NAME)) {
    throw new Error(`${temporary} does not export a surface prompt naming ${WECHAT_BOT_NAME}`)
  }
  renameSync(temporary, file)
  return { root, status: 'patched', bytes: statSync(file).size, sha256: sha256(after) }
}

const roots = process.argv.slice(2)
if (roots.length > 0) {
  for (const root of roots) {
    const result = await patchOne(root)
    if (result.status === 'absent') {
      process.stdout.write(`patch-wechat-identity: no dsh-wechat under ${root}; nothing to patch\n`)
    } else if (result.status === 'already') {
      process.stdout.write(`patch-wechat-identity: ${root} already names the bridge ${WECHAT_BOT_NAME} (${String(result.bytes)} bytes)\n`)
    } else {
      process.stdout.write(`patch-wechat-identity: patched ${root} (${String(result.bytes)} bytes, sha256 ${String(result.sha256)})\n`)
    }
  }
} else if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stderr.write('patch-wechat-identity: give at least one node_modules root\n')
  process.exit(2)
}
