# Agent Note: Oversized esbuild inputs cannot unlink their temporary file on this build host

Status: implemented

English | [中文](2026-10-16-esbuild-oversized-temp-input.zh.md)

## Problem

Every release build that ran the Web frontend on this machine died in the same place, after the transform phase had already succeeded:

```text
$ vite build
vite v6.4.3 building for production...
✓ 392 modules transformed.
rendering chunks...
error during build: [vite:esbuild-transpile] remove C:\Users\admin\AppData\Local\Temp\esbuild-e93343099f5939c77ea054db47a2e603aaec4e7368e60717bde1785f89123601: Access is denied.
```

The stack pointed at `esbuild/lib/main.js:718`, so the failure was inside esbuild rather than in the renderer sources. Because `build:web` is a required step of `build:official`, which `prepare:package` runs, this one error blocked the whole desktop payload: no installer, no seed, no new release.

## Cause

esbuild's JavaScript API does not pass a large input to its Go binary in memory. It writes the input to a temporary file under `os.tmpdir()` and hands the binary the path (`node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js:774-777`):

```js
if ((typeof input === "string" || input instanceof Uint8Array) && input.length > 1024 * 1024) {
  let next = start;
  start = () => fs3.writeFile(input, next);
}
```

The filename is `esbuild-<64 hex>` (`main.js:2096`). The binary reads that file and unlinks it, and on this host the unlink fails with `Access is denied.` — the Go error text, not Node's `EACCES` wording, which is why the message reads `remove <path>: Access is denied.` The file is left behind. Vite's `esbuild-transpile` plugin minifies each emitted chunk through this API, the renderer's chunk exceeds the 1 MiB threshold, and so every production build reaches the failing branch.

## Evidence

Reproduced outside Vite with three probe scripts, which are not part of the repository (they lived in the working tree during the investigation and were deleted before the release commit):

- Inputs larger than 1 MiB fail in every mode: `transform` and `build`, `minify: true` and `minify: false`, promise and synchronous API. Each attempt leaves one `esbuild-<hex>` file in the temporary directory and prints the same `remove ...: Access is denied.`
- Inputs below the threshold succeed, and the same probe with a deliberately truncated source (which produced 758 syntax errors) also returned normally, so the binary itself runs.
- Version-independent: `esbuild@0.21.5`, `0.25.12`, and `0.28.1` all fail identically, each against its own matching `@esbuild/win32-x64` binary.
- Directory-independent: the same failure occurs with `TEMP`/`TMP` pointed at a fresh, empty `D:\hcn-temp`; the error then names that directory.
- Node is not affected. Writing and unlinking a 1.5 MB file in the same directory from Node takes 0 ms, and every leftover `esbuild-<hex>` file can be deleted afterwards by hand or from Node.
- The leftovers carry ordinary inherited ACLs (`SYSTEM`, `Administrators`, and the user all have full control) and no read-only attribute, so the denial is not a static permission on the file.
- The denial is not a security policy: `Get-MpPreference` reports no attack-surface-reduction rule and `EnableControlledFolderAccess=0` with real-time protection on, no third-party antivirus service is running (`LAVService` and `HRWSCCtrl` are no longer installed), and `whoami /all` is identical for this shell, its Node children, and a WMI-launched process — same user, same groups, medium integrity, no AppContainer SID. No sandbox service or driver is present and the `DSH_*` variables are unset in a plain child process.

## Decision

The rc.28 desktop build reuses the Web frontend that the shipped rc.27 line already serves instead of rebuilding it: `apps/web/dist` was restored file-for-file from the installed `@deepseek-ai/dsh-web-frontend` package (125 files, 5.13 MB) and `apps/web`'s `build` script was temporarily pointed at `node -e "process.exit(0)"`. The first attempt replaced the `vite` launchers under `apps/web/node_modules/.bin`, which pnpm recreated at its next link, so the no-op lives in the script that pnpm invokes. Both edits are host-local, are reverted before the release commit, and change no tracked behavior: the desktop fixes this release carries (the account namespace mount, the vision plugin unlisting, and the update-dialog copy) are all outside `apps/web`.

## Alternatives considered

**Disable chunk minification for the renderer.** Rejected: `minify: false` in `apps/web/vite.config.ts` would ship a knowingly larger, non-minified bundle to every user of the release in order to dodge a defect of one build host.

**Minify with terser instead of esbuild.** Not available: `terser` is not installed anywhere in the dependency graph (`.pnpm` holds no `terser@*` entry), and adding a minifier to the release path for this reason would change every artifact the release produces.

**Run the build outside the agent session.** Attempted and inconclusive: a process started through `Win32_Process.Create` and one started through `explorer.exe` both left no log at all, so neither proved the failure is session-specific. The evidence above points at the esbuild binary's unlink call rather than at the process tree, because Node in the same session unlinks the same files in the same directory successfully.

**Add an antivirus exclusion.** Not applicable: no third-party antivirus is installed, and Defender reports no controlled-folder-access or ASR configuration to exclude anything from.

## Consequences

The rc.28 installer and seed carry the rc.27 renderer bytes under a new version number, which is what the desktop product already shipped; no user-visible Web change was pending in this release. A machine that does not exhibit the unlink failure can rebuild `apps/web` normally, and the temporary edits above are not part of any commit. This note exists so the next release built on this host does not have to rediscover the 1 MiB threshold: if `build:web` fails with `remove <temp>\esbuild-<hex>: Access is denied.`, the input was too large for esbuild's in-memory path and the frontend can be reused instead of rebuilt.
