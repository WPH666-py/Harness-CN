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
