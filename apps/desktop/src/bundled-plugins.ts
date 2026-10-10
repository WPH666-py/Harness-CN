/** Third-party plugins that Harness-CN ships and activates in every fresh profile. */

/** One bundled plugin pinned to the exact version its seed store entry was warmed for. */
export interface BundledPlugin {
  readonly name: string
  readonly version: string
  /**
   * Whether a fresh profile lists the plugin in `dsh.profile.bundles`.
   *
   * Every bundled plugin is installed either way. Two kinds are installed but not listed:
   * a companion a sibling's bundle patch pulls in itself, and a plugin whose first run
   * would block startup on unrelated provisioning. A companion must stay out of the list
   * because it declares no `dsh.bundle.patch`, which `inspectPlugin` rejects.
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
