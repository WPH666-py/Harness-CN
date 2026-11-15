/**
 * Permission policy for the monolith.
 *
 * One table decides what a tool call may do, so the decision lives in the operation that makes it
 * rather than in a UI convention: `run_shell` is refused by the same function that lets `read_file`
 * through, and no route can call a tool without passing here first.
 *
 * Three modes, session-scoped:
 *   - `ask`       — reads run freely; writes and commands wait for the user.
 *   - `auto`      — reads and writes run freely; commands run unless they match a destructive shape.
 *   - `read-only` — reads are the only thing that runs.
 *
 * Destructive commands always wait for the user, even in `auto`: a mode that silently allows
 * `rm -rf` is not a permission system, it is a delay.
 */

/** Modes a session may be in. */
export const MODES = ['ask', 'auto', 'read-only']

/** Default mode for a new session: the product's normal posture is to ask. */
export const DEFAULT_MODE = 'ask'

/**
 * Command shapes that always need a human, even under `auto`.
 *
 * Matching is deliberately blunt: it is a backstop for an obviously destructive line, not a parser.
 * The real protection for anything subtler is the `ask` mode, which is the default.
 */
const DESTRUCTIVE = /(?:\brm\s+-[a-z]*r[a-z]*\s+|\brmdir\s+\/s|\bdel\s+\/[sq]|\bformat\s+[a-z]:|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\breg\s+delete\b|\bgit\s+push\s+(?:--force|-f)\b|\bgit\s+reset\s+--hard\b|\bdiskpart\b|\bcipher\s+\/w|>\s*\/dev\/sd|:\(\)\s*\{.*\};\s*:)/iu

/** Tools that only read. */
const READ_TOOLS = new Set(['read_file', 'list_dir', 'grep'])
/** Tools that write inside the working directory. */
const WRITE_TOOLS = new Set(['write_file'])
/** Tools that run something. */
const EXEC_TOOLS = new Set(['run_shell'])

/**
 * Classify one tool by its effect.
 * @param name - tool name the model chose.
 * @returns the effect class, or `unknown` for a name this build does not ship.
 */
export function classify(name) {
  if (READ_TOOLS.has(name)) return 'read'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (EXEC_TOOLS.has(name)) return 'exec'
  return 'unknown'
}

/**
 * Report whether a command matches a destructive shape.
 * @param command - command line the model produced.
 * @returns true when a human must decide.
 */
export function isDestructive(command) {
  return DESTRUCTIVE.test(command)
}

/**
 * Decide one tool call.
 * @param options - session mode, tool name, and its arguments.
 * @returns `allow`, `deny`, or `ask`, with the reason shown to the user.
 */
export function decide(options) {
  const mode = MODES.includes(options.mode) ? options.mode : DEFAULT_MODE
  const effect = classify(options.name)
  if (effect === 'unknown') return { outcome: 'deny', reason: `unknown tool ${options.name}` }
  if (effect === 'read') return { outcome: 'allow', reason: 'read-only tool' }
  if (mode === 'read-only') {
    return { outcome: 'deny', reason: '会话处于只读模式，写入与命令都被拒绝。请在设置里切换模式。' }
  }
  if (effect === 'write') {
    return mode === 'auto'
      ? { outcome: 'allow', reason: '自动模式允许写入工作目录' }
      : { outcome: 'ask', reason: '写入文件需要确认' }
  }
  const command = String(options.args?.command ?? '')
  if (mode === 'auto' && !isDestructive(command)) {
    return { outcome: 'allow', reason: '自动模式允许非破坏性命令' }
  }
  return {
    outcome: 'ask',
    reason: mode === 'auto' ? '这条命令看起来是破坏性的，必须确认' : '执行命令需要确认',
  }
}
