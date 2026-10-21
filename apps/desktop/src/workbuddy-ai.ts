/**
 * Locate the WorkBuddy AI desktop application so its plugin can connect.
 *
 * The plugin ships two cards — one for the mainland WorkBuddy desktop app, one for the
 * international WorkBuddy AI app — and the international card needs the path of that app's
 * Electron binary before it will read the account file the app writes. It looks for the binary in
 * a default install location and in the Windows uninstall records, and the records this machine
 * has do not carry an `InstallLocation`, so the card reports
 * `electron-binary-not-found` and shows a signed-out state even though the account is signed in.
 *
 * The uninstall record does carry `DisplayIcon`, which is the executable the app's own shortcut
 * uses. Reading that turns the failing lookup into a working one without asking the user to set a
 * variable by hand, and it keeps working when the app is installed outside `Program Files`.
 *
 * @module @deepseek-ai/dsh-desktop/workbuddy-ai
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/** Environment variable the plugin documents for an explicit binary path. */
export const WORKBUDDY_AI_BINARY_ENV = 'WORKBUDDY_AI_ELECTRON_BIN'

/** Display name prefix of the uninstall record the international app writes. */
const UNINSTALL_DISPLAY_PREFIX = 'WorkBuddy AI'

/** Registry roots the app may have registered its uninstall record under. */
const UNINSTALL_ROOTS = [
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const

/** Inputs that make the lookup testable without a Windows registry. */
export interface WorkbuddyAiLookup {
  /** Environment the search starts from; an explicit override wins. */
  readonly env?: NodeJS.ProcessEnv | undefined
  /** Platform gate; a non-Windows host has no registry to read. */
  readonly platform?: NodeJS.Platform | undefined
  /** File existence check. */
  readonly exists?: ((path: string) => boolean) | undefined
  /** Uninstall-record reader; returns the `DisplayIcon` values it found. */
  readonly readDisplayIcons?: (() => readonly string[]) | undefined
}

/**
 * Turn a registry `DisplayIcon` value into an executable path.
 *
 * Windows stores `"C:\path\App.exe,0"`, so the index suffix and the surrounding quotes are part of
 * the value rather than part of the path. A value that names no `.exe` (an `.ico`, an empty string)
 * yields `undefined` instead of a path that cannot be spawned.
 * @param value - raw registry value.
 * @returns the executable path, or `undefined` when the value names something else.
 */
export function displayIconToPath(value: string): string | undefined {
  const trimmed = value.trim().replace(/^"+|"+$/gu, '')
  const withoutIndex = trimmed.replace(/,\s*-?\d+$/u, '')
  return withoutIndex.toLowerCase().endsWith('.exe') ? withoutIndex : undefined
}

/**
 * Decode `reg.exe` output.
 *
 * The console tools write in the system ANSI code page, not UTF-8; on a Chinese Windows that is
 * GBK. Decoding as UTF-8 mangles exactly the part that matters here — the install directory may
 * carry Chinese characters — and the mangled path then fails the existence check.
 * @param output - raw bytes from the child process.
 * @returns the text the tool meant to write.
 */
function decodeConsoleOutput(output: Buffer): string {
  try {
    return new TextDecoder('gbk').decode(output)
  } catch {
    return output.toString('utf8')
  }
}

/**
 * Read `DisplayIcon` out of every uninstall record whose display name starts with `WorkBuddy AI`.
 *
 * `reg query` is the only registry access available to a Node process without a native module. The
 * first call finds the record keys (`/f` matches the display name in the data lines and prints the
 * key above each match), the second reads the one value that names the executable.
 * @returns every path the records name, in the order the roots were queried.
 */
function readDisplayIconsFromRegistry(): readonly string[] {
  const keys = new Set<string>()
  for (const root of UNINSTALL_ROOTS) {
    const found = spawnSync('reg', ['query', root, '/s', '/f', UNINSTALL_DISPLAY_PREFIX, '/d'], {
      windowsHide: true,
    })
    if (found.status !== 0 || found.stdout === null || found.stdout === undefined) continue
    for (const line of decodeConsoleOutput(found.stdout).split(/\r?\n/u)) {
      if (line.startsWith('HKEY_')) keys.add(line.trim())
    }
  }
  const icons: string[] = []
  for (const key of keys) {
    const value = spawnSync('reg', ['query', key, '/v', 'DisplayIcon'], { windowsHide: true })
    if (value.status !== 0 || value.stdout === null || value.stdout === undefined) continue
    const match = /DisplayIcon\s+REG_\w+\s+(.+)$/mu.exec(decodeConsoleOutput(value.stdout))
    if (match?.[1] !== undefined) icons.push(match[1].trim())
  }
  return icons
}

/**
 * Resolve the international app's Electron binary.
 *
 * Order: an explicit environment override (the plugin's own contract), the default per-user install
 * location, then the uninstall records. A path that does not exist is skipped rather than returned:
 * the plugin would fail on it anyway, and a stale record from a previous install is common.
 * @param lookup - environment, platform, and injectable probes.
 * @returns an existing executable path, or `undefined` when the app is not installed.
 */
export function resolveWorkbuddyAiBinary(lookup: WorkbuddyAiLookup = {}): string | undefined {
  const env = lookup.env ?? process.env
  const platform = lookup.platform ?? process.platform
  const exists = lookup.exists ?? existsSync
  const override = env[WORKBUDDY_AI_BINARY_ENV]?.trim()
  if (override !== undefined && override !== '' && exists(override)) return override
  if (platform !== 'win32') return undefined
  const localAppData = env.LOCALAPPDATA?.trim()
  const defaults = localAppData === undefined || localAppData === ''
    ? []
    : [join(localAppData, 'Programs', 'WorkBuddy AI', 'WorkBuddyAI.exe')]
  const icons = (lookup.readDisplayIcons ?? readDisplayIconsFromRegistry)()
  const candidates = [...defaults, ...icons.map(displayIconToPath).filter((path): path is string => path !== undefined)]
  return candidates.find((path) => exists(path))
}
