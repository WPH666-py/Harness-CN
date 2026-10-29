# Overlay triage: files that need a human decision

133 of 705 differences could not be attributed by evidence.
Each one is either a fork edit the rebase must keep, or an upstream revision the base tag simply
lacks. Read the sample lines: text about this product, its ports, menus or Chinese copy is ours;
a refactor of upstream internals is theirs.

## packages/api/workspace-files/tests/mutations.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 174

    /**
    * The mutating endpoints: create, remove, copy, and move. Every one of them is
    * workspace-contained, so the containment refusal and the path-segment rules are

## packages/client/ui-settings-account-harness/README.i18n.yaml

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 6

    # Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each
    # side as of the last confirmed-consistent state. Both languages carry equal authority;
    # after editing either side, bring the other along and re-record with:

## packages/client/ui-settings-account-harness/src/client/account-store.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 179

    /**
    * Account section state: the sign-in view, the two detail reads, the bonus
    * notice lifecycle, and the operations the row triggers.

## packages/client/ui-settings-account-harness/src/client/AccountSection.module.css

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 52

    /* Account & balance section. Every colour comes from a theme token so the row
    * follows the active appearance. */
    .section {

## packages/client/ui-settings-account-harness/src/client/AccountSection.tsx

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 214

    /**
    * Account & balance settings section: the sign-in state, the two wallet reads,
    * and one granted-bonus card.

## packages/client/ui-settings-account-harness/src/client/bonus-notices.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 149

    /**
    * Lifecycle of granted-bonus notices: one displayed notice at a time, one read
    * in force at a time, and one acknowledgement per displayed card.

## packages/client/ui-settings-account-harness/src/client/client-metadata.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 17

    /**
    * Request identity for one account call. The Host forwards the active UI
    * language and the local UTC offset so the Platform answers in the reader's

## packages/client/ui-settings-account-harness/src/client/format.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 58

    /**
    * Balance presentation. Amounts are validated decimal strings; the section
    * renders them the way Platform Web does, so a wallet reads the same in the

## packages/client/ui-settings-account-harness/src/client/index.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 85

    /**
    * Account & balance settings plugin, browser half. It mounts the Desktop
    * account Remote contribution, registers one `settings.section` row that signs

## packages/client/ui-settings-account-harness/src/client/locales.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 84

    /** Copy for the Account & balance settings section. */
    /** Locale keys the Account & balance section reads. */
    export type AccountSettingsKey =

## packages/client/ui-settings-account-harness/src/client/types.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 116

    /**
    * Account domain types the section renders, plus the `account` Remote
    * namespace surface it calls.

## packages/client/ui-settings-account-harness/src/index.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 7

    /**
    * Account settings section, host half. The section is desktop-renderer only,
    * so this half carries no behavior; it exists so the Loader sees the package

## packages/client/ui-settings-account-harness/tests/account-store.client.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 377

    // @vitest-environment jsdom
    /**
    * Account section controller: the Host sign-in stream, the profile and balance

## packages/client/ui-settings-account-harness/tests/AccountSection.client.spec.tsx

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 243

    // @vitest-environment jsdom
    /**
    * Account & balance row: the signed-out and stored-credential arms, both wallet

## packages/client/ui-settings-account-harness/tests/apply.client.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 239

    // @vitest-environment jsdom
    /**
    * Account & balance plugin, browser half: the copy dictionaries and account

## packages/client/ui-settings-account-harness/tests/bonus-notices.client.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 203

    // @vitest-environment jsdom
    /**
    * Granted-bonus notice lifecycle: one card at a time, one read in force, and one

## packages/client/ui-settings-account-harness/tests/client-metadata.client.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 27

    // @vitest-environment jsdom
    /**
    * Client metadata every account remote call carries: locale, client build

## packages/client/ui-settings-account-harness/tests/format.client.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 53

    // @vitest-environment jsdom
    /**
    * Balance presentation: a wallet must read exactly the way Platform Web renders

## packages/client/ui-settings-account-harness/tests/host.client.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 12

    // @vitest-environment jsdom
    /**
    * The Host half of the Account & balance plugin: every account call belongs to

## packages/client/ui-settings-account-harness/tests/locales.client.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 18

    // @vitest-environment jsdom
    /**
    * Copy for the Account & balance section: both dictionaries must cover the same

## packages/client/ui-sidebar-files/src/client/FilesToggleAction.module.css

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 16

    .trigger {
    display: inline-flex;
    align-items: center;

## packages/client/ui-sidebar-files/src/client/FilesToggleAction.tsx

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 48

    /**
    * Session-header entry point for the file tree's tab.
    *

## packages/client/ui-sidebar-files/tests/files-toggle-action.client.spec.tsx

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 25

    // @vitest-environment jsdom
    /** The header control: one gesture, and an accessible name that says what it is. */
    import { afterEach, describe, expect, it, vi } from 'vitest'

## packages/e2b/fs-e2b/tests/fake-remote.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 240

    /**
    * The in-memory E2B controller shared by the filesystem provider's suites: an
    * entry tree with the SDK methods the provider calls, plus the injection points

## packages/e2b/fs-e2b/tests/mutations.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 123

    /**
    * The remote provider's path-changing operations: create, remove, copy, and
    * move, including the cross-device move fallback that a single remote

## packages/fs/fs-local/tests/fsio-mutations.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 225

    /**
    * Cordis-free tests for the path-changing local-filesystem operations: create a
    * directory or an empty file, remove, copy a subtree, and move (including the

## packages/fs/fs-sandbox/tests/fs-sandbox-mutations.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 153

    /**
    * The per-call policy fence on the path-changing operations: `read-only` denies
    * every one of them, `workspace-write` contains both ends of a copy or a move

## packages/fs/node-vision/README.i18n.yaml

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 6

    # Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each
    # side as of the last confirmed-consistent state. Both languages carry equal authority;
    # after editing either side, bring the other along and re-record with:

## packages/fs/node-vision/README.md

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 27

    # @deepseek-ai/dsh-node-vision
    English | [中文](README.zh.md)
    ## Summary

## packages/fs/node-vision/README.zh.md

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 27

    # @deepseek-ai/dsh-node-vision
    [English](README.md) | 中文
    ## 概述

## packages/fs/node-vision/src/image-io.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 193

    /**
    * Filesystem reads, sharp pipelines, and durable image commits shared by every
    * node-vision tool.

## packages/fs/node-vision/src/index.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 36

    /**
    * Node-native image inspection and pixel-operation tools over `sharp`.
    *

## packages/fs/node-vision/src/sharp-runtime.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 74

    /** Lazy loader for the optional sharp raster engine. @module @deepseek-ai/dsh-node-vision/src/sharp-runtime */
    import type { Sharp } from 'sharp'
    /**

## packages/fs/node-vision/src/tools/inspect.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 155

    /**
    * Read-only inspection tools: `vision_info` reports one image's facts and
    * `vision_colors` reduces it to a palette. Neither produces an image block, so

## packages/fs/node-vision/src/tools/transform.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 396

    /**
    * Raster transform tools: `vision_crop`, `vision_resize`, and `vision_diff`.
    *

## packages/fs/node-vision/tests/node-vision.spec.ts

- kind: add, layer: upstream
- in later tags: no path match
- changed lines: 314

    /**
    * The node-vision tools over the REAL local filesystem, attachment store, and sharp:
    * inspection, cropping, rescaling, palette extraction, pixel comparison, the

## website/.dist/favicon.svg

- kind: add, layer: meta
- in later tags: no path match
- changed lines: 3

    <svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50" fill="none">
    <path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.807
    </svg>

## website/.dist/wordmark.svg

- kind: add, layer: meta
- in later tags: no path match
- changed lines: 19

    <svg xmlns="http://www.w3.org/2000/svg" width="143" height="23" viewBox="0 0 143 23" fill="none">
    <path d="M78.6784 18.6813H77.1077V16.2462H78.6784C79.6513 16.2462 80.6341 16.0037 81.2672 15.3298C81.9009 14.6559 82.14 
    <path d="M36.7486 6.93999H38.3188V9.37511H36.7486C35.7752 9.37511 34.7929 9.61762 34.1593 10.2915C33.5256 10.9654 33.287

## .agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.i18n.yaml

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2
- changed lines: 2

    2026-07-24-web-config-tree-boot-and-transport-layering.md: 477888f8ed1f72c7913ddfeb3a208d8a398c16fb
    2026-07-24-web-config-tree-boot-and-transport-layering.zh.md: b38e859f38f9a6f38cb1be0b2f727276f7eadaa7

## .agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2
- changed lines: 1

    **Transport responsibilities have explicit owners.** `dsh-client-connection` owns the `/api` route, request and response

## .agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.zh.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2
- changed lines: 1

    **传输职责各有明确 owner。** `dsh-client-connection` 持有 `/api` 路由、请求与响应 envelope、浏览器认证、Host/Origin 检查、精确 Fetch 路由注册以及共享 Typert in

## .agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.i18n.yaml

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    2026-08-25-electron-desktop-packaging-and-updates.md: 4449d61b01908a4e2d6b0e827d562127dfc1ffcd
    2026-08-25-electron-desktop-packaging-and-updates.zh.md: 05da332a04de49efa2408e7d8267798e7a18d06f

## .agents/notes/implemented/feature/2026-09-05-sidebar-text-preview-and-file-tree.i18n.yaml

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2
- changed lines: 2

    2026-09-05-sidebar-text-preview-and-file-tree.md: 118a163e05408680832219c70d1117dcfb7db050
    2026-09-05-sidebar-text-preview-and-file-tree.zh.md: fa163a7e1a322c8c324263c9864598fba6ee4a45

## .agents/notes/implemented/feature/2026-09-05-sidebar-text-preview-and-file-tree.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2
- changed lines: 7

    The tree is not one resource, and that decides where its state lives. A directory listing per level, expanded lazily, is
    The face is the tree's only asynchronous half. `start(tabId, root, signal)` seeds the bucket with the root expanded and 
    The root's header row carries the tree's controls: new file (`newFile`), new folder (`newFolder`), paste (`paste`), and 

## .agents/notes/implemented/feature/2026-09-05-sidebar-text-preview-and-file-tree.zh.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2
- changed lines: 7

    树不是一个资源，这决定了它的状态住在哪。逐层懒加载的目录列表是类型自己拥有的视图状态，所以它住在 Slot 标准的独占 store（每会话一实例）里、按 tab id 分桶，并连同该 tab 下读者自己的状态：`{ root, levels
    face 是树唯一的异步半边。`start(tabId, root, signal)` 以根展开态播种桶并列出根；`toggle(tabId, path, loaded, signal)` 翻转展开集合并只在第一次列出该层；`load(ta
    根标题行承载这棵树的控件：新建文件（`newFile`）、新建文件夹（`newFolder`）、粘贴（`paste`）与重新读取（`reload`），文件操作成组位于行的末端。剪贴板为空时粘贴处于禁用状态。重新读取重置所有层，并恰好重新列出

## docs/subsystems/filesystem.i18n.yaml

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    filesystem.md: 966ca1d9a7dbbc96caf7ef625e0b7b73380b51ed
    filesystem.zh.md: 0e9319119af32a726907acb338999d8f502bfa61

## docs/subsystems/filesystem.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 4

    /** The destination of a create, copy, or move already exists. */
    | 'FS_ALREADY_EXISTS'
    /** A non-recursive directory removal found entries beneath the target. */

## docs/subsystems/filesystem.zh.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 4

    /** The destination of a create, copy, or move already exists. */
    | 'FS_ALREADY_EXISTS'
    /** A non-recursive directory removal found entries beneath the target. */

## docs/subsystems/typert.i18n.yaml

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    typert.md: e574646bd5da51ec4ca77590d23ffa80f6af887f
    typert.zh.md: 692fdb6e761c4cba3c785c045d5ab8c186d1b165

## docs/subsystems/typert.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 4

    /** Eager runtime schema. */
    readonly schema?: TypertSchema
    /** Lazy runtime-schema factory accepted in place of `schema`. */

## docs/subsystems/typert.zh.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 4

    /** Eager runtime schema. */
    readonly schema?: TypertSchema
    /** Lazy runtime-schema factory accepted in place of `schema`. */

## packages/api/gateway/src/client/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 24

    import { RemoteError, remoteErrorOf, typertSchemaOf } from '@deepseek-ai/dsh-typert-protocol'
    if (method.scoped) handle.service.uninstall('scoped', method.descriptor.method, method.token)
    if (method.direct) handle.service.uninstall('direct', method.descriptor.method, method.token)

## packages/api/gateway/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 5

    typertSchemaOf,
    const schema = typertSchemaOf(codec)
    if (schema === undefined) {

## packages/api/gateway/tests/gateway.client.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 6

    descriptors: [{ ...context, id: '@fixture/probe#probe/uninstall', method: 'uninstall' }],
    // `remove` is a product verb (`workspaceFiles/remove` backs the Sidebar's delete action) and
    // must therefore stay installable: only the service's own members are reserved, and this is

## packages/api/session-controller/src/commands.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 4

    // A selection applies to the NEXT request, so it must not queue behind the one in flight.
    // `serializeImageAdmission` is the agent's live-call gate: routing a selection through it made
    // the model chip do nothing for the length of a turn — and stay that way when a turn ended

## packages/api/workspace-files/README.i18n.yaml

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    README.md: 92fcd7a97ffa53090874c450896b3966679b7385
    README.zh.md: 5bd4116ce67e7dad4c5bd1056db010a222de338c

## packages/api/workspace-files/README.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 15

    Use this package to preview files readable through a Session's filesystem from the web client, and to change entries ins
    | `createDirectory(path, name)` | `WorkspaceFileMutation { path, absolutePath, version, bytes? }` | One new directory na
    | `createFile(path, name)` | `WorkspaceFileMutation` | One new empty file named `name` inside `path` |

## packages/api/workspace-files/README.zh.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 15

    使用本包可从 Web Client 预览 Session 文件系统允许读取的文件，并在该 Session 的工作区内增删条目。它按页读取 UTF-8 文本、按有界窗口或完整文件读取原始字节、从基文件目录解析关联文件，并报告文件元数据。文件读
    | `createDirectory(path, name)` | `WorkspaceFileMutation { path, absolutePath, version, bytes? }` | 在 `path` 内新建一个名为 `na
    | `createFile(path, name)` | `WorkspaceFileMutation` | 在 `path` 内新建一个名为 `name` 的空文件 |

## packages/api/workspace-files/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 178

    * listings, the filesystem-observation change feed, and workspace-confined
    * mutations, exposed as `workspaceFiles`.
    * remain workspace-scoped, and every mutation is contained: the Session's

## packages/api/workspace-files/src/types.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 25

    import type { SessionId } from '@deepseek-ai/dsh-session/types'
    /** Options for the mutating `remove` verb. */
    export interface WorkspaceRemoveOptions {

## packages/bundle/base/cordis.patch.yml

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    - id: node-vision
    name: '@deepseek-ai/dsh-node-vision'

## packages/bundle/base/package.json

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    "version": "0.1.5-rc.37",
    "@deepseek-ai/dsh-node-vision": "workspace:^",

## packages/bundle/web-app/package.json

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    "version": "0.1.5-rc.37",
    "@deepseek-ai/dsh-client-ui-settings-account-harness": "workspace:^",

## packages/client/connection/src/rpc-host.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 7

    ConnectionFetchFallback,
    * @param fallback - owner of a request no exact route and no intercepted endpoint claims.
    fallback?: ConnectionFetchFallback,

## packages/client/connection/src/rpc.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 15

    * Owner of one `/api` request that neither an exact Fetch route nor the shared-channel
    * interceptor claimed.
    *

## packages/client/connection/tests/fetch-routes.host.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 17

    it('hands a request no owner claimed to the carrier fallback', async () => {
    const route = vi.fn(async () => Response.json({ owner: 'route' }))
    const fallback = vi.fn(async (request: Request) =>

## packages/client/store/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 16

    if (opts?.persist) attachPersistence(api, init, opts.persist.name)
    * Restore one persisted payload over the state its store declares.
    * A payload was written by whichever build ran before, so it can predate a member this store

## packages/client/store/tests/store.client.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 8

    it('keeps a member the stored payload predates, instead of handing it to consumers absent', () => {
    // A payload written before this store declared `b` is exactly what rehydration meets
    // after an upgrade; adopting it wholesale is what makes the next action read undefined.

## packages/client/ui-settings-models/src/client/CustomProviderCard.tsx

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 77

    * One provider a hand-declared route can start from.
    * `api` and `baseURL` are the values the installed pi-ai catalog declares for
    * that vendor. A preset carries neither when the catalog does not describe the

## packages/client/ui-settings-models/src/client/locales.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 26

    customPreset: 'Provider',
    customPresetNone: 'Select a provider',
    customPresetManual: 'This provider is not in the installed catalog, so enter its endpoint and protocol yourself.',

## packages/client/ui-settings-models/tests/provider-form.client.spec.tsx

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 32

    it('fills the route, name, protocol, and endpoint a catalog preset declares', () => {
    fireEvent.change(screen.getByLabelText(en.customPreset), { target: { value: 'deepseek' } })
    expect(screen.getByLabelText<HTMLInputElement>(en.customRoute).value).toBe('deepseek')

## packages/client/ui-sidebar-files/README.i18n.yaml

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    README.md: 7a56efdf00b2b9de16ddc269127fb1d6084e5055
    README.zh.md: c9b9ccadc67c426ad800decd9f33ae27cfb825c2

## packages/client/ui-sidebar-files/README.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 9

    description: "The right Sidebar's file-tree tab type for the dsh web client: the session workspace root listed one level
    The right Sidebar's navigator tab type: the session's workspace root as a tree, listed one level at a time over the wire
    - **The body** — the keyed `sidebar.right.pane.tab` seat under that id: a header row under the strip, then the tree. The

## packages/client/ui-sidebar-files/README.zh.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 9

    description: "dsh Web 客户端右侧 Sidebar 的文件树 tab 类型：逐层经线上列出会话工作区根目录，按资源地址把文件打开到 Sidebar，并可新建、删除、复制与移动条目。"
    右侧 Sidebar 的导航器 tab 类型：把会话的工作区根目录画成一棵树，逐层经线上列出，把文件打开到 Sidebar 里，并在列目录之上补上文件管理器的那几个操作。它是从引导页进入的页类型，不认领任何地址；它按地址打开文件，交给 `d
    - **正文**：以该 id 为键的 `sidebar.right.pane.tab` 坑位：strip 下的一行标题行，然后是树。标题行与文档预览（`ui-sidebar-documentpreview`）的相同：根路径，目录部分灰色、最

## packages/client/ui-sidebar-files/src/client/definition.tsx

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 3

    // The workspace's files are what this sidebar is for, so a freshly opened one shows the
    // tree rather than a menu offering it beside everything else that registered an entry.
    default: true,

## packages/client/ui-sidebar-files/src/client/face.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 128

    * The tree's asynchronous half: listing directories into the store, and the
    * file operations a file manager adds.
    * The component never awaits anything. It calls `start` / `load` / `toggle` for

## packages/client/ui-sidebar-files/src/client/FilesBody.module.css

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 24

    /* The selected row is what the header's file operations act on, so it keeps a
    fill of its own: the tree draws one selection at a time, and the stronger
    active fill separates it from whatever the pointer happens to rest on. */

## packages/client/ui-sidebar-files/src/client/FilesBody.tsx

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 201

    * The file tree's body: the session's workspace root, listed one level at a
    * time, with the file operations a file manager adds.
    * draw for each absolute path and what a gesture means: a directory toggles, a

## packages/client/ui-sidebar-files/src/client/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 27

    * Browser half: register `files` as a right-Sidebar tab type, and the
    * Session-header control that shows it.
    * it draws (`FilesBody.tsx`, `FilesTitle.tsx`, `FilesToggleAction.tsx`), what it

## packages/client/ui-sidebar-files/src/client/locales.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 45

    * directory each suggest a different next step. The gesture lines do the same
    * for what the reader asked the tree to change: a destination already taken and
    * a directory that still holds something each say what was left alone, and an

## packages/client/ui-sidebar-files/src/client/store.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 73

    * The file tree's view state: which directories are expanded, what each loaded
    * level contains, and what the reader is doing to those entries.
    * in one session expand independently. The reader's own working state — the

## packages/client/ui-sidebar-files/tests/apply.client.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 36

    import { FilesToggleAction } from '../src/client/FilesToggleAction.tsx'
    id: string
    // The header control reads the column's live state at the moment of the

## packages/client/ui-sidebar-files/tests/face.client.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 154

    * tab whose record is gone leaves no bucket behind. The mutations add the other
    * half: each gesture reaches its own Remote verb with the path it names, and
    * what a settled mutation writes — the notice, the clipboard, the level it

## packages/client/ui-sidebar-files/tests/files-body.client.spec.tsx

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 189

    * only. The file operations add the other half: a row is selectable and stays
    * selected, the header's controls and the row's own menu reach the Remote verb
    * each gesture names, the name input commits and cancels where the reader says

## packages/client/ui-sidebar-files/tests/mount.client.tsx

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 5

    import { scriptedFiles } from './scripted-list.client.ts'
    import type { ScriptedFiles } from './scripted-list.client.ts'
    readonly script: ScriptedFiles

## packages/client/ui-sidebar-files/tests/scripted-list.client.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 82

    * A `workspaceFiles` namespace whose every verb answers when the spec says so.
    *
    * The package binds these six verbs through `createList`, so these mocks are

## packages/client/ui-sidebar-files/tests/store.client.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 71

    * for again. The reader's own state is load-bearing for the file operations:
    * the selection is what a gesture acts on, the clipboard is what a paste
    * places, the draft is the name input, and `pruned` is what keeps a removed

## packages/client/ui-sidebar-right/src/client/contract/seed.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 10

    * Resolve the default page from the registered entries.
    * An entry that declares itself the default wins outright: a product whose sidebar has one
    * obvious subject wants that subject open, not a menu of everything that could be. Failing that,

## packages/client/ui-sidebar-right/src/client/tab-registry.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 8

    * Whether this type is the page a fresh right sidebar opens on.
    * Without one, the sidebar opens on the guide — the list of everything that
    * registered an entry — which is the right answer only while the list is short

## packages/context/agent-instructions/tests/agent-instructions.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 26

    import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
    FsCopyOutcome,
    FsCreateDirectoryOptions,

## packages/credentials/authorization/tests/authorization.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 10

    describe('the session commit', () => {
    /** A flow that commits through the session, the contract newer flows are written against. */
    function sessionCommittingFlow(): AuthorizationFlow {

## packages/e2b/fs-e2b/README.i18n.yaml

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3
- changed lines: 2

    README.md: 2c3fc76041cb508182d208ac6c4d3d852a179b97
    README.zh.md: 991ae6c4534595cc1a2603c648cc6956c98e0554

## packages/e2b/fs-e2b/README.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3
- changed lines: 9

    `dsh-fs-e2b` runs the agent's file operations inside the remote sandbox: read files, list directories, write, overwrite 
    ### Creating, removing, copying, and moving
    The agent can create a directory or an empty file, remove a file or a directory, copy a file or a whole subtree, and mov

## packages/e2b/fs-e2b/README.zh.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3
- changed lines: 9

    `dsh-fs-e2b` 让 agent（智能体）的文件操作在远程沙箱内运行：读取文件、列出目录、写入、覆盖或编辑、创建目录、删除条目、复制子树、移动或重命名条目，以及读取准确的元数据——全部发生在与它的命令相同的远程世界里。它不需要任何配
    ### 创建、删除、复制与移动
    agent 可以创建目录或空文件、删除文件或目录、复制文件或整棵子树，以及移动或重命名条目。创建、复制或移动的目标已被占用时，操作会被拒绝且不改变任何内容。不带 `recursive` 的目录删除在该目录仍有条目时会被拒绝。复制会把链接作为

## packages/e2b/fs-e2b/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3
- changed lines: 173

    FsByteWriteOutcome,
    FsCopyOutcome,
    FsCreateDirectoryOptions,

## packages/e2b/fs-e2b/tests/filesystem.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3
- changed lines: 5

    import { posix } from 'node:path'
    import { FileNotFoundError, FileType } from '@deepseek-ai/dsh-e2b'
    import { FakeRemote, bytes, commandError } from './fake-remote.ts'

## packages/extensions/cordis-client-runner/src/client/slot-catalog.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    'client-ui-sidebar-files FilesToggleAction id \'workspace-files\'',
    'client-ui-settings-account-harness AccountSection id \'account\'',

## packages/fs/fs-local/README.i18n.yaml

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    README.md: 279dd2c50b6f4c7b8871484de23144a29bf843e7
    README.zh.md: 288b9910e92eac735d6da420eb8b001385f20db7

## packages/fs/fs-local/README.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 10

    Create a directory (with `recursive: true` for missing ancestors), create an empty file, remove a file or a directory, c
    ### The path-changing operations
    `createDirectory` creates one directory, or a whole chain of missing ancestors under `recursive: true`. An existing dire

## packages/fs/fs-local/README.zh.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 10

    创建目录（`recursive: true` 时连缺失的祖先一起创建）、创建空文件、删除文件或目录、复制文件或整棵子树、移动或重命名一个条目。创建、复制或移动的目的地已被占用时以 `FS_ALREADY_EXISTS` 失败，且什么都不改动
    ### 变更路径的操作
    `createDirectory` 创建一个目录，在 `recursive: true` 下则创建一整条缺失的祖先链。目标处已存在的目录只在 `recursive` 下算成功；非递归调用遇到被占用的目标、以及目标处存在任何文件或链接，都是 

## packages/fs/fs-local/src/fsio.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 206

    import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, syml
    import type {
    FsCopyOutcome,

## packages/fs/fs-local/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 65

    FsByteWriteOutcome,
    FsCopyOutcome,
    FsCreateDirectoryOptions,

## packages/fs/fs-local/tests/filesystem.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 35

    describe('writeBytes', () => {
    it('publishes bytes verbatim and reports how many', async () => {
    const payload = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])

## packages/fs/fs-sandbox/README.i18n.yaml

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    README.md: 70261d82fac33cc1ff74687c32fa12cfbab93277
    README.zh.md: c28ae1ac57bcad00353fd9422bc97c26a3788bb3

## packages/fs/fs-sandbox/README.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 10

    `dsh-fs-sandbox` confines model file writes, edits, and path changes according to each session's sandbox mode while pres
    Mount this backend instead of `fs-local` when the model's file writes, edits, and path changes must be confined by the s
    ### What the fence covers

## packages/fs/fs-sandbox/README.zh.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 10

    `dsh-fs-sandbox` 按各会话的沙箱模式限制模型对文件的写入、编辑以及路径变更，同时保留本地文件系统的读取行为。`read-only` 拒绝所有变更；`workspace-write` 只允许目标位于会话工作区或平台临时根目录内
    当模型的文件写入、编辑以及路径变更必须受会话沙箱模式约束、而读取保持不受约束时，挂载此后端以替代 `fs-local`。围栏按调用生效：工具层把调用会话的模式与工作区根目录解析为与 bash runner 收到的相同策略，因此文件系统与 s
    ### 围栏覆盖哪些操作

## packages/fs/fs-sandbox/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 112

    * write and the read-match-write edit critical section, and the path-changing
    * operations — are the local implementation's, verbatim; this package adds only
    * the per-call POLICY fence on the mutations. Reads pass through untouched:

## packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 29

    describe('writeBytes under the fence', () => {
    it('denies a byte write in read-only mode, leaving no file on disk', async () => {
    const path = join(workspace, 'denied.bin')

## packages/fs/fs/README.i18n.yaml

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    README.md: ca6fd7cbfd8378b5f9ac86d66bbd5e49e217defb
    README.zh.md: 71f05f87e003f66b23259c3a343280b422a4c54e

## packages/fs/fs/README.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 10

    Use `dsh-fs` when an application needs consistent filesystem operations across host, confined, or remote execution envir
    Through `ctx.fs` you can resolve any path to a stable target identity, read a whole text file or stream it in chunks, re
    <a id="the-path-changing-operations"></a>

## packages/fs/fs/README.zh.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 10

    应用需要在宿主、受限或远程执行环境中使用一致的文件系统操作时，选择 `dsh-fs`。消费方可以解析稳定的文件身份、在受支持时映射共享宿主文件、执行有界的文本与字节读取、列出目录，并原子地写入文本及执行字面量编辑、创建、删除、复制和移动条目
    通过 `ctx.fs`，你可以把任意路径解析为稳定的目标身份、完整读取或分片流式读取文本文件、按显式上限读取原始字节、列出一层目录、原子地创建或替换文件，并原子地应用字面量文本编辑。两个变更操作上的版本防护都是可选的：省略它即无条件创建或覆
    <a id="the-path-changing-operations"></a>

## packages/fs/fs/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 109

    * binary rejection on the text read path, atomic mutations of either
    * encoded text or verbatim bytes, and the path-changing operations — create,
    * remove, copy, and move. Read windows and

## packages/fs/fs/src/types.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 43

    * Outcome of a full-file byte write.
    *
    * It reports the same `operation` and `version` {@link FsWriteOutcome} does, but not a

## packages/fs/fs/tests/service.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 69

    * behavior, disposal, the path-changing operations, and the branded id
    * factories. The provider primitives and
    FsCopyOutcome,

## packages/fs/README.i18n.yaml

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    README.md: 306873f0c538f2bc4e4f00b06a44ec961e9271a3
    README.zh.md: c466cd926667d01f3902b25158fa88106bb6984b

## packages/fs/README.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    Nine packages plus the remote sibling `fs-e2b` play the filesystem roles; the subsystem reference owns the exhaustive co
    | [`node-vision/`](node-vision/README.md) | Model-facing `vision_info`, `vision_crop`, `vision_resize`, `vision_colors`,

## packages/fs/README.zh.md

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    九个包加上远程同级 `fs-e2b` 承担文件系统角色；子系统参考文档拥有穷尽式约定与错误分类体系。
    | [`node-vision/`](node-vision/README.zh.md) | 面向模型的 `vision_info`、`vision_crop`、`vision_resize`、`vision_colors` 与 `visi

## packages/fs/tool-fs/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 9

    // The route gate and the regular-file resolution are the shared contract for any tool
    // that hands an image to the model or reads one from disk. `@deepseek-ai/dsh-node-vision`
    // reuses both rather than restating either rule, which is why they are published here.

## packages/fs/tool-fs/tests/tools.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 34

    FsCopyOutcome,
    FsCreateDirectoryOptions,
    FsCreateOutcome,

## packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 14

    import { FileSystem, FsError, FsVersion, type FsByteWriteOutcome, type FsCopyOutcome, type FsCreateDirectoryOptions, typ
    override async writeBytes(target: FsTarget, content: Uint8Array): Promise<FsByteWriteOutcome> {
    return { operation: 'create', version: FsVersion('test'), bytes: content.byteLength }

## packages/typert/loader/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 15

    const resolved = generatedSchema(schema)
    if (typeof resolved !== 'object' || resolved === null || !('_zod' in resolved)) {
    const schema = generatedSchema(codec)

## packages/typert/loader/tests/loader.spec.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    const codec = descriptor.parameters[0].codec
    expect((codec.schema ?? codec.create?.())?.parse('request')).toBe('request')

## packages/typert/protocol/src/index.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    export { typertSchemaOf } from './types.ts'
    TypertSchemaSource,

## packages/typert/protocol/src/types.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 22

    * Either generated runtime-schema form: the eager `schema` this line's
    * generator emits, or the lazy `create()` factory newer generators emit. The
    * generated module memoizes the factory's result, so resolution may call it on

## packages/typert/registry/src/service.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 16

    const materialized = materializedSchema(schema)
    if (materialized === undefined) {
    throw new Error(`typert: schema "${schema.name}" declares neither a schema nor a create() factory`)

## packages/typert/registry/src/types.ts

- kind: edit, layer: upstream
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 10

    * One generated live Zod schema declaration. Both generated forms are accepted:
    * the eager `schema` this line's generator emits, and the lazy `create()`
    * factory newer generators emit for self-referential schemas. Registration

## pnpm-workspace.yaml

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 7

    # Markdown parsing pins two copies of this type-only package (2.0.2 for
    # mdast-util-from-markdown and micromark-extension-gfm, 2.0.3 for the rest).
    # Their exported types are structurally incompatible under

## README.i18n.yaml

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    README.md: 43ff37051f74fd0dfc7a1b13fb749b9d5c712682
    README.zh.md: 35b30a65389e343a8a4b3d67f3dfbff77f561acc

## scripts/verify-package-readme-model-experience.ts

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 1

    'packages/client/ui-settings-account-harness': { kind: 'none', reason: 'Browser-side settings row over the desktop-only 

## THIRD_PARTY_NOTICES.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 4

    | [`@deepseek-ai/dsh-api-account-controller`](https://github.com/deepseek-ai/deepseek-harness) | MIT |
    | [`qrcode`](https://github.com/soldair/node-qrcode) | MIT |
    | [`@tauri-apps/cli`](https://github.com/tauri-apps/tauri) | Apache-2.0 OR MIT |

## tsconfig.base.json

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 2

    "@deepseek-ai/dsh-client-ui-settings-account-harness": ["./packages/client/ui-settings-account-harness/src"],
    "@deepseek-ai/dsh-node-vision": ["./packages/fs/node-vision/src"],

## tsconfig.client.json

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 1

    { "path": "./packages/client/ui-settings-account-harness" },

## vendor/README.md

- kind: edit, layer: meta
- in later tags: dsh-v0.1.5-rc.3, dsh-v0.1.6-alpha.2, dsh-v0.2.2-alpha.2
- changed lines: 3

    | `cosmokit/` | `@deepseek-ai/cosmokit` | `cosmokit` | 1.8.5 | https://github.com/deepseek-harness/cosmokit | `16f6fc058
    | `schemastery/` | `@deepseek-ai/schemastery` | `schemastery` | 3.18.4 | https://github.com/deepseek-harness/schemastery
    20. **`cosmokit` 1.8.3 → 1.8.5 and `schemastery` 3.18.2 → 3.18.4: the volatile config-reference protocol.** `cosmokit` g
