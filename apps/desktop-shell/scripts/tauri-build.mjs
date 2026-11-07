/**
 * Runs `tauri build`, adding the Windows Authenticode signing override when a code-signing
 * certificate is available. Tauri signs the application binary and then the installer it bundles,
 * so a signed installer always embeds a signed `harness-cn.exe`.
 *
 * Certificate resolution, in order:
 *   1. `HARNESS_CN_SIGN_THUMBPRINT` — 40-hex thumbprint, used verbatim.
 *   2. `HARNESS_CN_SIGN_SUBJECT` (default `CN=水哥`) — subject match in `Cert:\CurrentUser\My`.
 *   3. The only certificate in that store with a private key and the code-signing usage.
 *
 * The lookup script is written to a temporary `.ps1` and run with `-File` so the subject survives
 * the command line regardless of the console code page. No certificate means an unsigned build,
 * logged and never fatal, so machines without the certificate still produce installers.
 *
 * `HARNESS_CN_SIGN_TIMESTAMP_URL` overrides the RFC 3161 timestamp authority; an empty value
 * disables timestamping for offline builds, which shortens the signature's usable lifetime.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SUBJECT = 'CN=水哥';
/** Package root of `@deepseek-ai/dsh-desktop-shell`, the directory holding `src-tauri`. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';

/**
 * PowerShell inventory of matching code-signing certificates, one `thumbprint<TAB>subject` per line.
 *
 * `-CodeSigningCert` is the certificate provider's own filter; reading `EnhancedKeyUsageList`
 * directly looks equivalent but returns an empty list under Windows PowerShell 5.1, which silently
 * matches no certificate at all.
 */
function inventoryScript() {
  return [
    'param([string]$Subject)',
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert |',
    '  Where-Object { -not $Subject -or $_.Subject -eq $Subject } |',
    '  ForEach-Object { "$($_.Thumbprint)\t$($_.Subject)" }',
    '',
  ].join('\n');
}

/**
 * Lists code-signing certificates in the current user's store.
 *
 * The subject travels as a `-File` argument rather than inside the script: Windows passes command
 * lines as UTF-16, while PowerShell 5.1 reads a BOM-less script file as ANSI and would compare a
 * mangled subject.
 *
 * @param subject - X.500 subject to match exactly; omitted lists every code-signing certificate.
 * @returns Thumbprint and subject pairs, empty when none match.
 */
function inventory(subject) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cn-sign-'));
  const file = join(dir, 'inventory.ps1');
  try {
    writeFileSync(file, inventoryScript(), 'utf8');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];
    if (subject) args.push(subject);
    const result = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true });
    return (result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.split('\t'))
      .filter(([thumbprint]) => /^[0-9A-Fa-f]{40}$/.test(thumbprint ?? ''))
      .map(([thumbprint, matched]) => ({ thumbprint, subject: matched ?? '' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolves the signing certificate, preferring an explicit thumbprint over a store lookup. */
function resolveCertificate() {
  const explicit = process.env.HARNESS_CN_SIGN_THUMBPRINT?.trim();
  if (explicit) return { thumbprint: explicit, source: 'HARNESS_CN_SIGN_THUMBPRINT' };

  const subject = process.env.HARNESS_CN_SIGN_SUBJECT?.trim() || DEFAULT_SUBJECT;
  const matched = inventory(subject);
  const exact = matched.find((certificate) => certificate.subject.trim() === subject) ?? matched[0];
  if (exact) return { thumbprint: exact.thumbprint, source: `certificate store (${subject})` };

  const available = inventory();
  if (available.length === 1) {
    return { thumbprint: available[0].thumbprint, source: `the only code-signing certificate (${available[0].subject})` };
  }
  if (available.length > 1) {
    console.log(
      `[tauri-build] no certificate matches ${subject}; ${available.length} code-signing certificates exist, ` +
        'so set HARNESS_CN_SIGN_THUMBPRINT to choose one',
    );
  }
  return undefined;
}

/** Builds the `--config` override enabling Tauri's Windows signing, or no override at all. */
function signingWindows() {
  const certificate = resolveCertificate();
  if (!certificate) {
    console.log('[tauri-build] no code-signing certificate; building an unsigned installer');
    return undefined;
  }
  // An empty PowerShell assignment drops the variable, so the documented "empty disables it" only
  // holds for shells that keep it; `none` is the spelling every shell can pass through.
  const requested = process.env.HARNESS_CN_SIGN_TIMESTAMP_URL;
  const timestampUrl = requested === 'none' ? '' : requested ?? DEFAULT_TIMESTAMP_URL;
  const windows = { certificateThumbprint: certificate.thumbprint, digestAlgorithm: 'sha256' };
  if (timestampUrl) windows.timestampUrl = timestampUrl;
  console.log(`[tauri-build] signing with ${certificate.thumbprint} from ${certificate.source}`);
  return windows;
}

/**
 * Reads the brand overlay named by `HARNESS_CN_BRAND`, e.g. `HARNESS_CN_BRAND=harscience` reads
 * `src-tauri/tauri.harscience.conf.json`.
 *
 * One tree ships several products, and everything that distinguishes them — product name, bundle
 * identifier, installer icon, description — is a Tauri configuration value, not code. Keeping the
 * overlay a separate file means the default product's `tauri.conf.json` stays exactly as upstream
 * wrote it, and a branded build cannot silently alter it.
 */
function brandOverlay() {
  const brand = process.env.HARNESS_CN_BRAND?.trim();
  if (!brand) return undefined;
  const file = join(PACKAGE_ROOT, 'src-tauri', `tauri.${brand}.conf.json`);
  if (!existsSync(file)) throw new Error(`tauri-build: brand overlay ${file} is missing`);
  const overlay = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`[tauri-build] brand overlay ${brand}: ${String(overlay.productName)}`);
  return overlay;
}

/**
 * Merges the brand overlay and the signing override into the single `--config` Tauri accepts.
 *
 * The signing block belongs under `bundle.windows`, which the overlay may already have populated
 * with NSIS settings, so the two are merged rather than replaced — a shallow spread would drop the
 * installer icon and silently produce an unbranded setup program.
 */
function configArgs() {
  const overlay = brandOverlay();
  const windows = signingWindows();
  if (!overlay && !windows) return [];
  const config = { ...(overlay ?? {}) };
  if (windows) {
    config.bundle = {
      ...(overlay?.bundle ?? {}),
      windows: { ...(overlay?.bundle?.windows ?? {}), ...windows },
    };
  }
  return ['--config', JSON.stringify(config)];
}

function tauriEntry() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('@tauri-apps/cli/tauri.js');
  } catch {
    return undefined;
  }
}

const extra = configArgs();
const entry = tauriEntry();
// `tauri build` refreshes `target/release/resources` from `bundle.resources` but never clears a
// resource the manifest no longer names. A seed staged by an older release therefore survived here
// and travelled into every portable copy assembled from this directory, where the launch compared
// its version against the application's and refused to start. Removing the directory first makes
// this build's output describe this build only.
rmSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'target', 'release', 'resources'), { recursive: true, force: true });
const command = entry ? process.execPath : 'tauri';
const args = entry ? [entry, 'build', ...extra] : ['build', ...extra];
const result = spawnSync(command, args, { stdio: 'inherit', shell: !entry, windowsHide: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
