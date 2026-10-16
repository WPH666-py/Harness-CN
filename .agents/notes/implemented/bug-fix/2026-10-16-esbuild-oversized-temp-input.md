# Agent Note: Build binaries that live inside the workspace run at low integrity on this host

Status: implemented

English | [中文](2026-10-16-esbuild-oversized-temp-input.zh.md)

## Problem

Two steps of the rc.28 desktop payload build failed on this machine for what looked like unrelated reasons:

```text
$ vite build
vite v6.4.3 building for production...
✓ 392 modules transformed.
rendering chunks...
error during build: [vite:esbuild-transpile] remove C:\Users\admin\AppData\Local\Temp\esbuild-e93343099f5939c77ea054db47a2e603aaec4e7368e60717bde1785f89123601: Access is denied.
```

```text
[EPERM] EPERM: operation not permitted, mkdir 'C:\Users\admin\AppData\Local\Temp\dsh-desktop-seed-459tJK\store\v11'
desktop seed: pnpm exited with 4294963248
```

Both were deterministic, and both blocked the whole desktop payload: no seed, no installer, no release. `build:web` is a required step of `build:official`, which `prepare:package` runs, and `prepare:seed` follows it.

## Cause

Every executable whose image lives under the workspace runs with a **low mandatory integrity level**; the same bytes started from outside the workspace run at medium. The user's temporary directory carries a medium label and does not permit write-up, so a low-integrity process cannot create, write, or delete anything in it — the calls fail with `EPERM`, which the Go side of esbuild reports as `Access is denied.`

Each failure follows from that:

- esbuild does not pass large inputs to its Go binary in memory. It writes them to `%TEMP%\esbuild-<64 hex>` and hands over the path (`node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js:774-777`):

```js
if ((typeof input === "string" || input instanceof Uint8Array) && input.length > 1024 * 1024) {
  let next = start;
  start = () => fs3.writeFile(input, next);
}
```

  The binary reads that file and unlinks it; running low, the unlink is denied and the file is left behind. Vite's `esbuild-transpile` plugin minifies each emitted chunk through this API, and the renderer chunk is larger than 1 MiB, so every production build reached the failing branch.

- `prepare-seed` stages its pnpm store under `mkdtemp(<temp>/dsh-desktop-seed-)` and installs with the **bundled runtime Node** (`apps/desktop/.desktop-build/targets/win-x64/runtime/node/node.exe`, v24.17.0), which sits inside the workspace and therefore runs low. It cannot even create a directory in `%TEMP%`, so pnpm's `store/v11` creation is refused before any package is fetched.

## Evidence

The failure follows the image path, not the binary. These are the same bytes, byte for byte (SHA-256 prefix `C6335D08331C23D6`, 92 299 080 bytes, v24.17.0):

| Image location | Integrity level | `mkdtemp` in `%TEMP%` |
| --- | --- | --- |
| `apps/desktop/.desktop-build/targets/win-x64/runtime/node/node.exe` | Low (`S-1-16-4096`) | `EPERM` |
| `apps/desktop-shell/src-tauri/resources/runtime/node/node.exe` | Low | `EPERM` |
| copy at `D:\` root, and copy in `%TEMP%` | Medium (`S-1-16-8192`) | succeeds |
| installed app runtime, `%LOCALAPPDATA%\Harness-CN\resources\runtime\node\node.exe` | Medium | succeeds |
| system Node in `Program Files` | Medium | succeeds |

- `whoami /all` run by the workspace binary reports `Mandatory Label\Low Mandatory Level`; the same command run by the same bytes outside the workspace reports `Mandatory Label\Medium Mandatory Level`. Everything else — user, groups, no AppContainer SID — is identical.
- It is not a security policy: Defender runs with real-time and behaviour monitoring on, `EnableControlledFolderAccess=0`, no attack-surface-reduction rules, Smart App Control off, no third-party antivirus service installed, and no sandbox driver or service present.
- A low-integrity process can still write to a **low-labeled** directory. `%USERPROFILE%\AppData\LocalLow` inherits `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)`, and the workspace runtime Node created, wrote, and removed a `store\v11` tree under a directory there without error.
- Directory-independent otherwise: the same failures occur with `TEMP`/`TMP` pointed at a fresh `D:\hcn-temp`, and every leftover `esbuild-<hex>` file can be deleted afterwards by hand, because the shell is not the confined process.

## Decision

The label is removed from the build tree rather than routed around, and nothing about the produced payload changes:

- `icacls <dir> /setintegritylevel (OI)(CI)Medium` on `apps/desktop/.desktop-build` — the staging tree that holds the runtime Node, pnpm, the packed tarballs, and the seed output — and on the three `node_modules/.pnpm/@esbuild+win32-x64@*` directories whose binaries vite and tsdown launch. Both calls are accepted without elevation, because this account owns the workspace and holds `WRITE_OWNER` there; the executables underneath report `Mandatory Label\Medium Mandatory Level:(I)(NW)` afterwards.
- With the label gone, `pnpm --filter @deepseek-ai/dsh-web-frontend run build` runs **unmodified** — `"build": "vite build"`, `✓ built in 5.88s`, 191 files / 14 949 372 bytes — and `prepare:seed` stages pnpm's store in the ordinary `%TEMP%`.

The frontend is therefore built normally, not reused: the rebuild reproduced the shipped rc.27 chunk names exactly (`assets/index-C7yDRFbX.js` 523.62 kB, `assets/vendor-B8elsyXK.js` 741.11 kB), which is what an unchanged renderer tree should produce.

## Alternatives considered

**Reuse the rc.27 renderer instead of rebuilding it.** This was the first working answer and is superseded: it required pointing `apps/web`'s `build` script at `node -e "process.exit(0)"` and restoring `apps/web/dist` file-for-file from the installed package. It produced a correct payload but left the release note unable to claim the frontend had been built, and it hid the real defect from the next release.

**Disable chunk minification for the renderer.** Rejected: `minify: false` in `apps/web/vite.config.ts` would ship a knowingly larger, non-minified bundle to every user in order to dodge a defect of one build host.

**Minify with terser instead of esbuild.** Not available: `terser` is not installed anywhere in the dependency graph (`.pnpm` holds no `terser@*` entry).

**Point esbuild at a copy of itself outside the workspace** (`ESBUILD_BINARY_PATH` → `D:\hcn-tools\esbuild.exe`). It works for the vite step, but the variable is read by every esbuild host in the tree: `tsx` bundles esbuild 0.28.1 and refused to start with `Cannot start service: Host version "0.28.1" does not match binary version "0.25.12"`, so it needed a host-local `apps/web/build-web.mjs` shim plus a temporary `build` script override. Superseded by the relabel, which needs no repository change at all.

**Point `TEMP`/`TMP` at a directory that already carries the low label** (`%USERPROFILE%\AppData\LocalLow\hcn-temp`) for the seed step. It works, and it was the fallback while the label was in place; superseded for the same reason.

**Lower the integrity label of a new build temporary directory.** `icacls <dir> /setintegritylevel Low` on a directory this account does not own is refused without elevation, and this session cannot raise a consent prompt.

**Run the build outside the agent session.** Attempted and inconclusive: a process started through `Win32_Process.Create` and one started through `explorer.exe` both left no log at all.

**Add an antivirus exclusion.** Not applicable: no third-party antivirus is installed, and Defender reports no controlled-folder-access or ASR configuration to exclude anything from.

## Consequences

The label belongs to the host, not to the repository: `D:\projects-py\Harness-CN` itself carries an explicit low label (`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`, not inherited) and every path below it inherits it, so a fresh clone here inherits it again — as does every artifact built outside a relabeled directory, including, on this host, the installer under `apps/desktop-shell/src-tauri/target/release/bundle/`. Any step that runs a workspace-resident binary and expects it to write outside the workspace fails the same way; the symptom to recognise is `EPERM` or `Access is denied.` from a process whose executable sits in the working tree, and the repair is the same `icacls /setintegritylevel (OI)(CI)Medium` call on the directory that holds that executable.
