/** The plugin set Harness-CN installs into every fresh Desktop profile. */

/** One bundled plugin pinned to the exact version its seed store entry was warmed for. */
export interface BundledPlugin {
  readonly name: string
  readonly version: string
  /**
   * Whether a fresh profile lists the plugin in `dsh.profile.bundles`.
   *
   * Every bundled plugin is installed either way. Four kinds are installed but not listed:
   * a companion a sibling's bundle patch pulls in itself, a plugin whose first run would block
   * startup on unrelated provisioning, a plugin whose rows the Desktop Host's own patch layer
   * mounts, and a plugin whose browser half waits on a service only a later line provides. A
   * companion must stay out of the list because it declares no `dsh.bundle.patch`, which
   * `inspectPlugin` rejects — the same reason the Host-mounted rows cannot be listed, since
   * upstream mounts those from its own bundle compositions — and an absent service has to stay
   * absent from the mounted set because Cordis leaves the waiting fiber pending forever, which
   * fails the whole Web boot (`packages/client/web/src/boot.ts:138-158`).
   */
  readonly active: boolean
}

/**
 * Plugin set installed into a fresh Desktop profile without any user action.
 *
 * Versions are exact because three places must agree: the pnpm store warmed by
 * `prepare-seed`, the profile manifest that `applyRelease` copies from the seed, and the
 * `dsh.profile.bundles` list that activates them. A version that drifts from the warmed
 * store makes the offline first launch fail, which `verifyOfflineInstallation` catches at
 * build time rather than on a user's machine.
 *
 * Every activated entry must declare `dsh.bundle.patch`; `inspectPlugin` rejects one that
 * does not. An entry with `active: false` is installed without being listed, so it is
 * exempt.
 */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    // This toolkit provisions a standalone Python runtime (about 35 MB) plus Pillow, NumPy,
    // and vtracer the first time it runs, and the Host cannot report ready until that
    // finishes. Provisioning stalled on a build machine at 3.37 MB with no further
    // progress, leaving the Host permanently un-ready and failing the profile-activation
    // rename that follows it. The plugin also needs a configured vision provider and
    // credential before it does anything, so an unconfigured install is inert. Shipping it
    // inactive keeps it one toggle away without letting its first-run provisioning decide
    // whether the application opens.
    name: '@anionex/dsh-vision-toolkit',
    version: '0.1.45',
    active: false,
  },
  {
    // Mobile adaptation for the Web GUI: a client-only plugin whose host half is an empty apply,
    // so it adds a plugin row and nothing else. Its one runtime request,
    // `@deepseek-ai/dsh-client-ui-primitives`, is a baseline module every dynamic bundle may
    // request (`PLATFORM_MODULES` in `packages/client/web/src/platform.ts`), so it needs no
    // package beside it in the profile; the request is written to fall back to a null icon when a
    // host release does not export the name it asks for.
    name: 'dsh-web-mobile',
    version: '3.0.6',
    active: true,
  },
  {
    // Phone access: the LAN/remote gateway that serves the Web GUI over HTTPS with a QR pairing
    // page, plus its own in-page pickers for the two cases this profile gets wrong on a phone.
    // `dsh-web-mobile` above is only the mobile *layout*; this is the piece that makes the GUI
    // reachable from the phone at all, which is why it is the one that was missing.
    //
    // It declares no `engines.dsh` at all — all six of its peers (react, cordis, dsh-llm,
    // dsh-commands, dsh-host-webserver, dsh-client-connection) are optional, so there is no second
    // copy of the cordis/session chain for pnpm to install beside the Host's own, and it mounts on
    // this baseline — observed running here, serving with managed TLS and a signed CA.
    //
    // Order matters. Its bundle patch disables the stock `directory-picker` row and inserts a
    // mobile host/Client browse pair guarded by a platform check, so the patch has to be applied
    // in a layer that can still see the row it disables; `dsh-web-mobile` above stays first so
    // the mobile surface is mounted before this one starts rearranging rows.
    name: 'dsh-mobile',
    version: '0.6.4',
    active: true,
  },
  {
    // WeChat bridge.
    //
    // 0.8.0 was the last release declaring `engines.dsh >=0.1.2-rc.1`, the line this product
    // carries, so the earlier pins stopped there: 0.9.7 fixed the engine at `0.2.0-rc.2` and later
    // releases widened it to `>=0.2.0-rc.2`. That declared range is stale rather than true — it was
    // raised when the author moved their own baseline, not because the bridge started calling
    // 0.2-era APIs. 0.10.0 was observed booting on this exact host line with the row mounted, the
    // native command layer attached, the approval/question waterfall answerers attached, and the
    // QR login flow running, with no module-resolution or missing-API failure anywhere in the
    // startup log. The engine field is metadata no loader on this path enforces; the observable
    // mount is the stronger evidence, so the shipped version tracks the one verified in the field.
    name: 'dsh-wechat',
    version: '0.10.0',
    active: true,
  },
  { name: '@jieai/dsh-plugin-vet', version: '0.3.12', active: true },
  { name: '@liustack/modlens', version: '3.26.1', active: true },
  {
    // Long-term project memory for coding agents, backed by a Hindsight server. Its bundle
    // patch mounts one host row (`@vectorize-io/hindsight-coding-agents/dsh`) that reaches
    // every session through the layered tools registry — the same wiring the package's own
    // `install dsh` writes into a profile. Memory itself is configured outside the product,
    // in `~/.hindsight/coding-agent.json`; with no server configured the row resolves its
    // bank and stays inert.
    name: '@vectorize-io/hindsight-coding-agents',
    version: '0.8.0',
    active: true,
  },
  {
    // Model-driven context management: the model decides when the window is worth
    // reclaiming and writes the summary itself, instead of a fixed threshold summarising on
    // its own. Its bundle patch disables the host's `compaction-basic` row, which is what
    // makes room for a second CompactionEngine backend in one realm.
    //
    // Pinned below the newest release on purpose. From 0.2.27 the package also pins
    // `@deepseek-ai/dsh-brand`, `dsh-timeout`, `dsh-util-crypto`, `dsh-util-values`,
    // `dsh-session-format` and its migrations to exactly 0.2.0-rc.2 — a line this product
    // does not carry, because its baseline is upstream `dsh-v0.1.5-rc.1`. pnpm would satisfy
    // those peers by installing a second copy of the session-format chain beside the Host's
    // own, and an engine reading a different format generation than the Host writes is not a
    // version skew worth discovering at runtime. 0.2.26 declares the same six runtime seams
    // the profile already provides, at ranges 0.1.5-rc.8 satisfies.
    name: 'billion-context-dsh',
    version: '0.2.26',
    active: true,
  },
  { name: 'dsh-chat-import', version: '0.17.1', active: true },
  { name: 'dsh-cost-meter', version: '1.7.28', active: true },
  { name: 'dsh-rule-engine', version: '0.6.4', active: true },
  {
    // `dsh-rule-engine`'s bundle patch carries an `include` row for this client half, so
    // the rule-engine bundle fails to load with ERR_MODULE_NOT_FOUND unless the package is
    // installed. It declares only `dsh.client` and no `dsh.bundle.patch`, so it must stay
    // out of the bundle list while still shipping.
    name: 'dsh-rule-engine-client',
    version: '0.1.0',
    active: false,
  },
  {
    // An encrypted credential vault (AES-256-GCM with TOTP) exposing model tools and a
    // Settings page.
    //
    // Installed but not activated, and the reason is startup rather than preference: the vault
    // refuses to load without `DSH_VAULT_PASSWORD` — that is its fail-closed design, and it is
    // right — but a bundle row is applied while the composition boots, so an activated vault
    // turns a missing environment variable into a product that cannot open at all. Shipping it
    // one toggle away is the same trade the vision toolkit below already makes: present without
    // letting an unconfigured plugin decide whether the application starts.
    name: 'dsh-vault',
    version: '1.10.74',
    active: false,
  },
  {
    // Prompt-injection, jailbreak, and secret-leak defense: it intercepts inbound messages, tool
    // arguments, and tool results on the official seams and answers allow/ask/block, plus a
    // destructive-delete guard on shell commands. Its declared peer corridor already covers this
    // line (`>=0.1.5-alpha.1 <0.2.0`), and it was verified mounted here before being bundled.
    //
    // One documented degradation on this line: the audit event's `ignorable` marker is dropped by
    // hosts that predate it, so the plugin disables session-log audit and warns once instead of
    // writing events that would make a session unresumable. Detection and interception are
    // unaffected — only the audit trail is.
    name: 'dsh-defend',
    version: '0.3.21',
    active: true,
  },
  {
    // Shadow-git checkpoints of the workspace with one-click rollback, so an agent's multi-file
    // refactor can be undone without touching the user's own commits or branches.
    //
    // Pinned to the last release of its 0.1.5 corridor: 0.1.23 moved its peers to
    // `^0.1.7-rc.2 || ^0.2.0-rc.1`, a line this product does not carry. 0.1.22 declares
    // `^0.1.0-rc.6` for tools, settings, and the web server, which `0.1.5-rc.9` satisfies, and it
    // was verified mounted here on that version.
    name: '@goodandready/dsh-time-machine',
    version: '0.1.22',
    active: true,
  },
  {
    // An IDE-style Git panel in the Web GUI: branch and history overview, uncommitted changes
    // with commit and amend, diff stats, and a branch marker in the input bar.
    //
    // Its declared peers name `@deepseek-ai/dsh >=0.1.7-rc.2` and `@deepseek-ai/schemastery
    // >=3.18.4`, neither of which this baseline satisfied as published: the host half called
    // `Schema.boolean(...).default(...).volatile()`, a method schemastery only gained in 3.18.3,
    // so the row threw at load. The vendored schemastery was raised to 3.18.4 for it.
    //
    // The client half is the other half of that gap, and it is why this baseline carries
    // `languageForPath` and `useCodeHighlighter`: its bundle requires both from
    // `@deepseek-ai/dsh-client-ui-primitives`, which upstream added to that package after this
    // line was cut. Without them the bundle materializes and throws on the missing export,
    // taking the whole panel down. It also registers into `plugins.bundle.config`, a slot this
    // baseline does not declare, so its settings pane stays absent — `slots.inject` waits for a
    // declaration rather than failing, so the panel itself is unaffected.
    name: '@xbzbing/dsh-git-panel',
    version: '1.4.0',
    active: true,
  },
  {
    // White-box long-term memory: a host row plus the knowledge tree its tools read. Its own
    // bundle patch is a single insert, and every package it imports at runtime
    // (`dsh-session`, `dsh-system-prompt`, `dsh-tools`) is one this profile provides, as are
    // its peers (`dsh-llm`, `schemastery >=3.0.0`, `@deepseek-ai/cordis >=4.0.1`).
    //
    // It is the largest package bundled here by two orders of magnitude — 25.7 MB across 1594
    // files, most of it a Python knowledge base that ships with skills and documentation. That
    // weight lands in the seed store and in every installed profile, which is the cost of
    // carrying it at all; nothing about it is fetched at run time.
    name: '@furongjun1999/dsh-memory',
    version: '0.8.1',
    active: true,
  },
  {
    // Image recognition for text-only models, configured from its own Settings page. Distinct
    // from `@anionex/dsh-vision-toolkit` above, which is inactive because it provisions a
    // Python runtime on first use: this one is 44 KB of JavaScript, its host half imports only
    // `@deepseek-ai/cordis` and `@deepseek-ai/schemastery`, and its client half asks for
    // `react`, a baseline platform module. Its peers are unconstrained, so no version of this
    // line can disagree with them.
    //
    // It stays installed but unlisted all the same, because its browser half cannot activate
    // on this line. `lib/client.js` declares `inject = ['slots', 'locale', 'configForms']` and
    // reads `ctx.configForms.get('vision-plugin')` at the top of `apply`, before it registers
    // the `settings.section` seat this line does have. `configForms` is the 0.1.7-line plugin
    // config-form service, and no package in this profile provides it, so the fiber waits
    // forever — which the Client reports as `web boot: 2 entries did not activate` and renders
    // as the `Failed to load plugins` screen, failing the boot for every other plugin too.
    //
    // The service this line has instead is `settingsScope.bind({ namespace })`
    // (`packages/client/ui-settings/src/client/settings-scope.ts`), whose snapshot, subscribe,
    // and mutate contract is the one this plugin's own duck-typed adapter expects. Providing a
    // `configForms` alias over it was rejected: `dsh-chat-import`, a bundled plugin, probes for
    // that service by name and, when it exists, drops its `settings.section` page for the
    // 0.1.7-only `plugins.bundle.config` slot this line does not declare — one plugin's
    // settings page would disappear to make room for another's. Patching the service name out
    // of the published bundle is the same class of fix the account note already rejected,
    // because it has to be re-verified against every upstream release.
    name: '@lp181818/dsh-vision-plugin',
    version: '1.2.3',
    active: false,
  },
  {
    // The WorkBuddy desktop app's own model serving, mounted as an `llm-workbuddy` provider row
    // (its patch starts no OAuth flow and does not change the profile's default model).
    //
    // Pinned to the last release of its 0.1.5 corridor: 0.7.0 and later fix every dsh peer at
    // `0.2.0-rc.2`, a line this product does not carry, while 0.6.5 declares
    // `^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1 || ^0.2.0-rc.1` for the seven seams it
    // needs. Its one peer outside that corridor, `@earendil-works/pi-ai`, is already installed
    // here at exactly the version it asks for: `dsh-llm-pi-ai` depends on it, so the provider
    // resolves the same copy the DeepSeek pi-ai adapter uses.
    name: 'dsh-workbuddy-connect',
    version: '0.6.5',
    active: true,
  },
  {
    // DeepSeek account sign-in, and the platform reads behind the balance card.
    //
    // Installed but not listed, for a different reason than the companions above: this package
    // declares no `dsh.bundle.patch` at all. Upstream mounts its rows from its own `dsh-base`
    // and `dsh-web-app` compositions; this line mounts them from the Desktop Host's patch layer
    // (`apps/desktop-host/config/desktop.cordis.patch.yml`), which is the only layer that can
    // name them — they are installed only by the Desktop seed, and a bundle layer is shared with
    // every other profile, where an insert naming an absent package fails the whole tree.
    //
    // Its peers are `@deepseek-ai/dsh-authorization`, `dsh-credentials`, `dsh-host-webserver`,
    // and its own base package at `^0.1.7-alpha.1`, while this distribution's profile carries the
    // 0.1.5 line. That
    // range is declared, not enforced: the profile workspace sets `autoInstallPeers: false`, so
    // pnpm warns instead of installing a second copy of the seams, and the APIs this package
    // calls are the ones the line already has — `credentials.readRecord` / `modifyRecord` /
    // `deleteRecord`, the `credentials/record-updated` event, `authorization.registerFlow` /
    // `begin` / `cancel`, and `webServer.register`.
    //
    // 0.1.7-rc.2 is the release this line needs, not the newest one it could take: the
    // bonus-credit reads and acknowledgements (赠金) exist in no earlier package, and rc.2 was
    // booted here to `ready` with its rows mounted, `getState`/`getBalance`/`startSignIn` and
    // `getUnnotifiedBonuses`/`ackBonusNotified` all present. The `0.2.0-rc.2` peer pinning that
    // rules out later releases belongs to the 0.2 line, not to rc.2.
    name: '@deepseek-ai/dsh-deepseek-account-platform',
    version: '0.1.7-rc.2',
    active: false,
  },
  {
    // The authenticated Remote surface the browser half calls — `getState`, `getProfile`,
    // `getBalance`, `startSignIn`, `cancelSignIn`, `signOut`, `watch`, and the bonus pair
    // `getUnnotifiedBonuses` / `ackBonusNotified` — and the codecs that carry it. Those codecs
    // are emitted in the newer `create()` schema form, which this line's typert loader, registry,
    // and gateway now accept alongside the eager `schema` form they emit themselves (see the
    // Agent Note `2026-10-16-typert-codec-schema-forms`).
    name: '@deepseek-ai/dsh-api-account-controller',
    version: '0.1.7-rc.2',
    active: false,
  },
  // No third-party Client package is listed here on purpose. Upstream's account UI registers
  // its rows into `settings.launcher`, `settings.models.sign-in` and `shell.quota-notice`, none
  // of which exist in this line's Client (which has `settings.section` and `shell.overlay`), and
  // its 0.1.7-rc.2 build additionally injects a `configForms` service this line does not have —
  // so it mounts without ever rendering an entry. The browser half is instead this repository's
  // own `@deepseek-ai/dsh-client-ui-settings-account-harness`, packed with the desktop package
  // set and mounted from the same Host patch layer as the two rows above.
]

/**
 * Runtime dependency of a bundled plugin that pnpm does not install on its own.
 *
 * A plugin's `dependencies` are installed with it, but a package that is reachable only through
 * another package's own tree is not the same thing as one this profile can resolve: the Host
 * loads plugins from the profile, so a plugin's runtime import has to sit where the profile
 * resolves it. Declaring it here is what puts it in the seed store and in the profile manifest.
 */
export interface BundledPluginDependency {
  readonly name: string
  readonly version: string
  /** Bundled plugin whose runtime imports it. */
  readonly requiredBy: string
}

/**
 * Dependencies the bundled plugins import at runtime but do not bring with them.
 *
 * `billion-context-dsh` imports `acp-kernel` from its own code, and the lockfile for the seed
 * never contained it — so the first launch assembled a profile whose `billion-context-dsh` could
 * not load, and the Host spent its whole startup budget failing to compose. A dependency that is
 * only ever reached through another package's tree is exactly the one that has to be named.
 */
export const BUNDLED_PLUGIN_DEPENDENCIES: readonly BundledPluginDependency[] = [
  { name: 'acp-kernel', version: '0.0.101', requiredBy: 'billion-context-dsh' },
  {
    // The account platform extends this service rather than declaring its own, and names it as a
    // peer, so pnpm never installs it on the platform's behalf. Both the platform and its
    // controller import it at load time, which makes it the same kind of missing piece
    // `acp-kernel` was: reachable through another package's tree and therefore absent, unless
    // the profile is told to carry it.
    name: '@deepseek-ai/dsh-deepseek-account',
    version: '0.1.7-rc.2',
    requiredBy: '@deepseek-ai/dsh-deepseek-account-platform',
  },
]

/**
 * Direct dependencies contributed to the seed and profile manifests.
 *
 * Every bundled plugin is installed whether or not a fresh profile activates it, so the
 * seed store carries its closure and it can be enabled later without a download. The
 * runtime dependencies above are named here for the same reason: they are part of that
 * closure, and a profile that cannot resolve one of them cannot load the plugin that
 * imports it.
 * @returns Bundled plugin names and their runtime dependencies, mapped to pinned versions.
 */
export function bundledPluginDependencies(): Record<string, string> {
  return {
    ...Object.fromEntries(BUNDLED_PLUGINS.map(plugin => [plugin.name, plugin.version])),
    ...Object.fromEntries(BUNDLED_PLUGIN_DEPENDENCIES.map(dependency => [dependency.name, dependency.version])),
  }
}

/**
 * Bundle activation order appended after the built-in Desktop bundles.
 * @returns Names of the bundled plugins a fresh profile activates.
 */
export function bundledPluginNames(): readonly string[] {
  return BUNDLED_PLUGINS.filter(plugin => plugin.active).map(plugin => plugin.name)
}

/**
 * Package names of every bundled plugin, active or not.
 * @returns Names of all bundled plugins as they are installed.
 */
export function bundledPluginPackageNames(): readonly string[] {
  return BUNDLED_PLUGINS.map(plugin => plugin.name)
}
