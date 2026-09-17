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
]

/**
 * Direct dependencies contributed to the seed and profile manifests.
 *
 * Every bundled plugin is installed whether or not a fresh profile activates it, so the
 * seed store carries its closure and it can be enabled later without a download.
 * @returns Bundled plugin names mapped to their pinned versions.
 */
export function bundledPluginDependencies(): Record<string, string> {
  return Object.fromEntries(BUNDLED_PLUGINS.map(plugin => [plugin.name, plugin.version]))
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
