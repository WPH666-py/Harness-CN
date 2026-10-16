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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SUBJECT = 'CN=水哥';
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
function signingArgs() {
  const certificate = resolveCertificate();
  if (!certificate) {
    console.log('[tauri-build] no code-signing certificate; building an unsigned installer');
    return [];
  }
  const timestampUrl = process.env.HARNESS_CN_SIGN_TIMESTAMP_URL ?? DEFAULT_TIMESTAMP_URL;
  const windows = { certificateThumbprint: certificate.thumbprint, digestAlgorithm: 'sha256' };
  if (timestampUrl) windows.timestampUrl = timestampUrl;
  console.log(`[tauri-build] signing with ${certificate.thumbprint} from ${certificate.source}`);
  return ['--config', JSON.stringify({ bundle: { windows } })];
}

function tauriEntry() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('@tauri-apps/cli/tauri.js');
  } catch {
    return undefined;
  }
}

const extra = signingArgs();
const entry = tauriEntry();
const command = entry ? process.execPath : 'tauri';
const args = entry ? [entry, 'build', ...extra] : ['build', ...extra];
const result = spawnSync(command, args, { stdio: 'inherit', shell: !entry, windowsHide: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
