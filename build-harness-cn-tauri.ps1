# Build the Harness-CN Windows x64 installer for the Tauri shell.
#
#   powershell -File build-harness-cn-tauri.ps1                 # full build
#   powershell -File build-harness-cn-tauri.ps1 -SkipPrepare    # resources are already staged
#
# The two halves of this build belong to different packages, and the order between them matters:
#
#   1. `@deepseek-ai/dsh-desktop` prepares the shared payload — the bundled Node and pnpm runtime,
#      the local first-party tarballs, and the seed: the pre-installed profile the first launch
#      links from the store. This is the same pipeline the Electron build used, unchanged.
#   2. `@deepseek-ai/dsh-desktop-shell` bundles the Node sidecar, stages the runtime, seed, and
#      shell pages under `src-tauri/resources`, and runs `tauri build` to produce the installer.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a script without a BOM as ANSI, so a
# non-ASCII byte in this file breaks parsing there.
[CmdletBinding()]
param(
  [switch]$SkipPrepare,
  # Commit the Client bundle reports as its build identity. A tree without `.git`
  # cannot answer `git rev-parse HEAD`, which the official profile requires, so
  # the identity arrives here instead: the argument, then the environment, then
  # the sibling checkout's HEAD.
  [string]$CommitHash
)

$ErrorActionPreference = 'Stop'

$RepoRoot     = $PSScriptRoot
$TauriRoot    = Join-Path $RepoRoot 'apps\desktop-shell\src-tauri'
$ArtifactsDir = Join-Path $TauriRoot 'target\release\bundle\nsis'
$MsiDir       = Join-Path $TauriRoot 'target\release\bundle\msi'
$WixDir       = Join-Path $TauriRoot 'target\release\wix\x64'
$LogFile      = Join-Path $RepoRoot 'build-tauri.log'
$IconPath     = Join-Path $RepoRoot 'Harness.ico'
$PortableGit  = 'D:\projects-py\git-portable\cmd\git.exe'
$SiblingRepo  = Join-Path (Split-Path $RepoRoot -Parent) 'harness-0.1.5-rc.1'

# Start from an empty log. The recovery check at the end reads this file to decide whether a
# non-zero exit still produced its installer, and a message left by an earlier run would let a
# build that genuinely failed be reported as complete.
Remove-Item -LiteralPath $LogFile -Force -ErrorAction SilentlyContinue

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found on PATH."
  }
}

# Run a native command, echoing its output AND appending it to a log file, and return its exit code.
#
# `2>&1 | Tee-Object` is deliberately NOT used here: under `$ErrorActionPreference = 'Stop'`, a native
# command that writes to stderr (pnpm does this for every `[WARN] Unsupported platform: darwin-arm64`
# line) makes PowerShell turn the pipeline into a terminating NativeCommandError, so a build whose only
# "error" was a warning would abort before it compiled anything. Redirection into a plain file has no
# such behaviour, and the exit code is read from $LASTEXITCODE rather than inferred from the text.
function Invoke-Logged([string]$Exe, [string[]]$ExeArgs, [string]$Log, [switch]$Append) {
  $tmp = [System.IO.Path]::GetTempFileName()
  $savedEap = $ErrorActionPreference
  try {
    # PowerShell 5.1 turns a native command's stderr lines into error records even when they are
    # redirected, and `Stop` then ends the script on the first one — so this runs under `Continue`
    # and the real verdict comes from the exit code, never from the text.
    $ErrorActionPreference = 'Continue'
    $cmdExit = 0
    & $Exe @ExeArgs > $tmp 2>&1
    $cmdExit = $LASTEXITCODE
    $ErrorActionPreference = $savedEap
    Get-Content -LiteralPath $tmp | ForEach-Object { Write-Host $_ }
    if ($Append) { Get-Content -LiteralPath $tmp | Add-Content -LiteralPath $Log -Encoding UTF8 }
    else { Get-Content -LiteralPath $tmp | Set-Content -LiteralPath $Log -Encoding UTF8 }
    return $cmdExit
  } finally {
    $ErrorActionPreference = $savedEap
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
}

Assert-Command node
Assert-Command cargo
Assert-Command pnpm

# Relink the MSI when `tauri build` fails inside WiX.
#
# `light.exe` runs ICE validation actions that talk to the Windows Installer service; on a
# machine where that service is unreachable or the user's `%TEMP%` refuses WiX's temporary
# collection, linking stops with `LGHT0001` (access denied on a temp file) or `LGHT0217`
# (`无法访问 Windows Installer 服务` / `0x643`). Both happen after candle has already written
# `main.wixobj`, and `-sval` skips only the validation pass, so the MSI it links is the same
# artifact the normal path produces.
function Repair-Msi([string]$Version) {
  $wixobj = Join-Path $WixDir 'main.wixobj'
  $light = Join-Path $WixDir 'wix\light.exe'
  if (-not (Test-Path -LiteralPath $wixobj) -or -not (Test-Path -LiteralPath $light)) { return $false }
  New-Item -ItemType Directory -Force -Path $MsiDir | Out-Null
  $out = Join-Path $MsiDir ("Harness-CN_{0}_x64_zh-CN.msi" -f $Version)
  if (Test-Path -LiteralPath $out) {
    $stamp = (Get-Item -LiteralPath $out).LastWriteTime
    if ($stamp -gt (Get-Item -LiteralPath $wixobj).LastWriteTime) { return $true }
  }
  Write-Host ''
  Write-Host '=== Relinking the MSI with light.exe -sval ===' -ForegroundColor Cyan
  $rc = Invoke-Logged -Exe $light -ExeArgs @(
    '-sval', '-ext', 'WixUIExtension', '-ext', 'WixUtilExtension',
    '-cultures:zh-CN', '-loc', 'locale.wxl', '-out', $out, 'main.wixobj'
  ) -Log $LogFile -Append
  if ($rc -ne 0) {
    Write-Warning "light.exe -sval exited with $rc; the MSI was not produced."
    return $false
  }
  return (Test-Path -LiteralPath $out)
}

# --- Release identity and packaging environment ------------------------------
#
# The fork's own application identity. `DSH_DESKTOP_UNSIGNED=1` selects the unsigned path that
# skips the EV certificate, the SafeNet token, and the updater origin; upstream 0.1.5-rc.1 has no
# unsigned mode of its own, so this fork adds one and a build needs no signing material.
$env:DSH_DESKTOP_APP_ID = 'com.harnesscn.desktop'
$env:DSH_DESKTOP_UNSIGNED = '1'

# --- Build environment the pipeline cannot infer -----------------------------
#
# Three settings the official profile needs and that a release build must not
# leave to the operator (each one has already broken a build of this fork):
#
#   1. DSH_CLIENT_COMMIT_HASH / DSH_CLIENT_VERSION: `scripts/client-build-environment.ts`
#      shells out to `git rev-parse HEAD` for the official profile, and this tree has no
#      `.git` (the release tree is assembled by copying), so the build dies with
#      `spawnSync git ENOENT`. Both variables are required together.
#   2. TEMP / TMP: esbuild removes its temporary files from `%LOCALAPPDATA%\Temp` at the
#      end of the Web build; when that directory denies the delete, the whole `build:web`
#      gate fails with `[vite:esbuild-transpile] ... Access is denied`. A directory this
#      build owns makes the removal succeed.
$planned = (Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version

if (-not $CommitHash) { $CommitHash = $env:DSH_CLIENT_COMMIT_HASH }
if (-not $CommitHash -and (Test-Path -LiteralPath $PortableGit) -and (Test-Path -LiteralPath (Join-Path $SiblingRepo '.git'))) {
  $CommitHash = (& $PortableGit -C $SiblingRepo rev-parse HEAD).Trim()
}
if (-not $CommitHash -or $CommitHash -notmatch '^[0-9a-fA-F]{7,40}$') {
  throw 'No usable commit identity: pass -CommitHash <sha>, set DSH_CLIENT_COMMIT_HASH, or keep the sibling checkout with its .git in place.'
}
$env:DSH_CLIENT_COMMIT_HASH = $CommitHash
$env:DSH_CLIENT_VERSION = $planned

$BuildTmp = Join-Path (Split-Path $RepoRoot -Parent) 'tmp'
New-Item -ItemType Directory -Force -Path $BuildTmp | Out-Null
$env:TEMP = $BuildTmp
$env:TMP = $BuildTmp
Write-Host ("Build identity: {0} {1}" -f $planned, $CommitHash) -ForegroundColor DarkGray
Write-Host ("Scratch directory: {0}" -f $BuildTmp) -ForegroundColor DarkGray

if (-not (Test-Path $IconPath)) {
  throw "Application icon not found at $IconPath."
}

if ($SkipPrepare) {
  Write-Host 'Skipping the shared payload preparation' -ForegroundColor Yellow
} else {
  Write-Host '=== pnpm --filter @deepseek-ai/dsh-desktop run prepare:package ===' -ForegroundColor Cyan
  Write-Host '(build:official, release:pack, prepare:runtime, prepare:packages, prepare:seed)'
  $rc = Invoke-Logged -Exe 'pnpm' -ExeArgs @('--filter', '@deepseek-ai/dsh-desktop', 'run', 'prepare:package') -Log $LogFile
  if ($rc -ne 0) { throw "Payload preparation failed with exit code $rc. See $LogFile" }
}

Write-Host ''
Write-Host '=== pnpm --filter @deepseek-ai/dsh-desktop-shell run build ===' -ForegroundColor Cyan
Write-Host '(build:sidecar, prepare:shell, tauri build)'
$rc = Invoke-Logged -Exe 'pnpm' -ExeArgs @('--filter', '@deepseek-ai/dsh-desktop-shell', 'run', 'build') -Log $LogFile -Append
if ($rc -ne 0) {
  # The build can finish its work and still exit non-zero, and two known causes are both
  # benign here. Neither is detectable from the exit code, so both are read out of the log
  # and both require the installer itself to have been written to be accepted.
  #
  #   1. DSH Desktop wraps pnpm in its own runner, which stops a run that has shown no
  #      output and touched nothing under the profile for IDLE_TIMEOUT_MS (five minutes,
  #      dsh-desktop-market-installer/pnpm-runner.mjs). `tauri build` prints nothing at all
  #      while rustc compiles, so a long compile is exactly the shape it misreads; the
  #      runner kills the tree and the wrapper reports exit code 1 for a build that had
  #      already written its bundle.
  #   2. `tauri build` itself has been observed to exit 1 after reporting 'Finished 1
  #      bundle', which leaves a complete installer behind.
  #
  # The version has to be the one just built, not any installer sitting in the folder.
  $planned = (Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
  $produced = @(
    Get-ChildItem -Path (Join-Path $ArtifactsDir ("*{0}*" -f $planned)) -Filter '*.exe' -ErrorAction SilentlyContinue
  )
  $log = ''
  if (Test-Path -LiteralPath $LogFile) { $log = Get-Content -LiteralPath $LogFile -Raw }
  $watchdogKilled = $log -match 'produced no output and touched nothing'
  $tauriFinished  = $log -match 'Finished 1 bundle'
  # WiX failures leave the NSIS bundle and the candle output behind, so the MSI can be
  # relinked here instead of costing another full build.
  $msiMissing = -not (Test-Path -LiteralPath (Join-Path $MsiDir ("Harness-CN_{0}_x64_zh-CN.msi" -f $planned)))
  $msiRepaired = $false
  if ($msiMissing -and ($log -match 'light\.exe|LGHT|wix')) { $msiRepaired = Repair-Msi -Version $planned }
  if ($produced.Count -gt 0 -and ($watchdogKilled -or $tauriFinished -or $msiRepaired)) {
    Write-Warning "The build reported exit code $rc, but the installer for $planned was written anyway."
    if ($watchdogKilled) {
      Write-Warning 'Cause: DSH Desktop''s pnpm runner killed the run for five minutes of silence; `tauri build` says nothing while rustc compiles.'
    }
    if ($msiRepaired) {
      Write-Warning 'Cause: WiX could not run its ICE validation actions; the MSI was relinked with `light.exe -sval` from the existing main.wixobj.'
    }
    Write-Warning 'Treating this as a completed build. Verify the installer before publishing.'
  } else {
    throw "Tauri packaging failed with exit code $rc. See $LogFile"
  }
}

# --- Report ------------------------------------------------------------------

Write-Host ''
Write-Host '=== Build complete ===' -ForegroundColor Green
if (Test-Path $ArtifactsDir) {
  Get-ChildItem $ArtifactsDir -Filter '*.exe' |
    Select-Object Name, @{ n = 'SizeMB'; e = { [math]::Round($_.Length / 1MB, 2) } }, LastWriteTime |
    Format-Table -AutoSize
  Write-Host "Artifacts: $ArtifactsDir"
  Write-Host ''
  Write-Host 'The installer carries a Harness-CN Authenticode signature whenever a code-signing'
  Write-Host 'certificate is present in the current user store (HARNESS_CN_SIGN_THUMBPRINT or'
  Write-Host 'HARNESS_CN_SIGN_SUBJECT); otherwise it is unsigned and SmartScreen warns on first run.'
} else {
  Write-Warning "Expected artifact directory was not created: $ArtifactsDir"
}
