; Installer hooks for the Harness-CN Tauri shell.
;
; Every Harness-CN release up to and including 0.1.5-rc.2 was an Electron application packaged by
; electron-builder, which installed into `%LOCALAPPDATA%\Programs\Harness-CN` and registered its
; own uninstaller. This build is a Tauri application that installs into a different directory, so
; without this hook an upgrade would leave the old shell installed beside the new one: two entries
; in "Apps & features", a stale Start Menu shortcut, and an old executable that can still be
; launched. The hook therefore removes the previous installation before this one lands.
;
; It runs the old uninstaller rather than deleting the tree, because that is the program which
; knows about the shortcuts and the registry entry it wrote. A leftover directory — an uninstaller
; that failed, or an installation whose uninstaller was already removed by hand — is then cleaned
; up directly.
;
; The payload directory is removed for a second reason, and it is the important one: the bundled
; seed names every file it ships after the release that produced it (`…-0.1.5-rc.4.tgz`), and the
; first launch refuses a seed that holds a file its own inventory does not list. Installing over
; an older version without clearing the old seed therefore left both sets on disk, and the upgrade
; would fail at `desktop seed: integrity verification failed` with a perfectly good download. The
; check is right to be strict — a seed that is not exactly what was published is not something to
; assemble a runtime from — so the installer is what has to leave it exactly as published.

!macro NSIS_HOOK_PREINSTALL
  ; A running shell holds its own files open, and the old uninstaller refuses to run while it is
  ; up. This release is replacing it, so asking it to stop is not destructive.
  ExecWait '"$SYSDIR\taskkill.exe" /IM Harness-CN.exe /F'

  ; Everything this release owns and replaces wholesale: the runtime, the seed, the shell pages,
  ; and the sidecar. User data lives in `~/.dsh` and is never touched here.
  RMDir /r "$INSTDIR\resources"

  IfFileExists "$LOCALAPPDATA\Programs\Harness-CN\Uninstall Harness-CN.exe" 0 hcn_no_previous
    ExecWait '"$LOCALAPPDATA\Programs\Harness-CN\Uninstall Harness-CN.exe" /S'
  hcn_no_previous:

  ; Whatever the uninstaller could not finish. `RMDir /r` is silent about what it cannot remove,
  ; which is the right behaviour here: this hook must never fail the installation of the new
  ; build because an old file was locked.
  RMDir /r "$LOCALAPPDATA\Programs\Harness-CN"
  Delete "$DESKTOP\Harness-CN.lnk"
  Delete "$SMPROGRAMS\Harness-CN.lnk"
  RMDir "$SMPROGRAMS\Harness-CN"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.harnesscn.desktop"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.harnesscn.desktop_is1"
!macroend

; Build the desktop runtime at the end of the installation, so the first launch has nothing to
; assemble. The cost this moves is a one-time cost either way, and paying it here means it happens
; while the user is already waiting for setup rather than in front of a window that looks stuck.
;
; The build runs from the Node runtime the installer just laid down, using the same sidecar
; entry point the application uses: `--prebuild` takes the launch path's transaction and stops
; short of starting the backend. The seed is not bundled — a normal installer fetches it — so this
; is the one step that can fail on a machine with no network, and the exit code is therefore not
; inspected: a prebuild that fails is not an installation that failed, and the first launch builds
; exactly the same runtime with the exactly same code. The timeout bounds a slow or stalled fetch
; so setup can never hang on it; a run that is cut short leaves a partial profile behind, which
; the next launch's own transaction discards and rebuilds.
;
; The log directory is the application's own, so a prebuild that fails leaves its reason where the
; run-log viewer will show it.
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog /TIMEOUT=1200000 '"$INSTDIR\resources\runtime\node\node.exe" "$INSTDIR\resources\sidecar\shell.mjs" --prebuild --resource-dir "$INSTDIR\resources" --version "${VERSION}" --log-dir "$LOCALAPPDATA\com.harnesscn.desktop\logs" --install-dir "$INSTDIR"'
  Pop $0
!macroend
