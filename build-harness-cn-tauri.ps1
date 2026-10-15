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
  [switch]$SkipPrepare
)

$ErrorActionPreference = 'Stop'

$RepoRoot     = $PSScriptRoot
$TauriRoot    = Join-Path $RepoRoot 'apps\desktop-shell\src-tauri'
$ArtifactsDir = Join-Path $TauriRoot 'target\release\bundle\nsis'
$LogFile      = Join-Path $RepoRoot 'build-tauri.log'
$IconPath     = Join-Path $RepoRoot 'Harness.ico'

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

# --- Release identity and packaging environment ------------------------------
#
# The fork's own application identity. `DSH_DESKTOP_UNSIGNED=1` selects the unsigned path that
# skips the EV certificate, the SafeNet token, and the updater origin; upstream 0.1.5-rc.1 has no
# unsigned mode of its own, so this fork adds one and a build needs no signing material.
$env:DSH_DESKTOP_APP_ID = 'com.harnesscn.desktop'
$env:DSH_DESKTOP_UNSIGNED = '1'
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
  if ($produced.Count -gt 0 -and ($watchdogKilled -or $tauriFinished)) {
    Write-Warning "The build reported exit code $rc, but the installer for $planned was written anyway."
    if ($watchdogKilled) {
      Write-Warning 'Cause: DSH Desktop''s pnpm runner killed the run for five minutes of silence; `tauri build` says nothing while rustc compiles.'
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
  Write-Host 'The installer is unsigned, so Windows SmartScreen warns on first run.'
} else {
  Write-Warning "Expected artifact directory was not created: $ArtifactsDir"
}
