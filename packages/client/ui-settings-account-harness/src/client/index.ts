/**
 * Account & balance settings plugin, browser half. It mounts the Desktop
 * account Remote contribution, registers one `settings.section` row that signs
 * in to DeepSeek, shows the topped-up and granted balances, and surfaces each
 * credited bonus once. Every call goes to the Host's `remote.account`
 * namespace; no credential ever reaches this half.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Value import: the generated Remote contribution this half mounts. The Desktop
// Host serves the same namespace, so the peer is always there; this Client
// assembly selects no account namespace of its own (packages/api/remotes).
import accountRemote from '@deepseek-ai/dsh-api-account-controller/remote'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AccountSection } from './AccountSection.tsx'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { AccountSectionController } from './account-store.ts'
import { en, zh, type AccountSettingsKey } from './locales.ts'

export type { AccountSectionInjected, AccountSectionProps } from './AccountSection.tsx'
export type { AccountSettingsKey } from './locales.ts'
export type { AccountSectionState } from './account-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Account & balance section copy. */
    'settings.account': AccountSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.account'

/**
 * Required services (cordis fiber inject). `remote` is the typed Namespace
 * Table this plugin mounts the account contribution into — injecting
 * `remote.account` would be circular, since this apply is what provides it.
 * The target slot belongs to ui-settings' apply, whose activation order
 * relative to this one is NOT constrained; registration depends on that slot
 * through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote']

/**
 * Mount the account namespace, register the Account & balance row once the
 * `settings.section` declaration is on the ledger, and drive its store from the
 * Host account stream for as long as this fiber is active.
 * @param ctx - client root context.
 * @returns fulfilment once the namespace is mounted and the row is registered.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  const unmount = await ctx.remote.$mount(accountRemote)
  // Registered ahead of every consumer below: Cordis unwinds effects in reverse
  // registration order, so the namespace outlives the row and its stream.
  ctx.effect(() => () => unmount(), 'ui-settings-account-harness: account namespace')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-account-harness: copy dictionaries')

  const controller = new AccountSectionController(ctx)
  // The stream belongs to the plugin's activation, not to the row: a user who
  // never opens Settings still gets the granted-bonus notice delivered.
  ctx.effect(() => {
    controller.start()
    return () => { controller.end() }
  }, 'ui-settings-account-harness: account state stream')

  // Registration-time text (the nav label thunk) and the row's inject face
  // share one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS)
  // Bound once, here: the row receives stable callbacks, so its mount effect
  // never re-runs on a re-render.
  const injected: AccountSectionInjected = {
    hooks: { accountSection: controller.store },
    begin: () => { controller.mounted() },
    leave: () => { controller.unmounted() },
    signIn: () => controller.signIn(),
    cancel: attemptId => controller.cancel(attemptId),
    signOut: () => controller.signOut(),
    hasRunningAccountTasks: () => controller.hasRunningAccountTasks(),
    noticeShown: (orderId) => { controller.noticeShown(orderId) },
    noticeDismissed: (orderId) => { controller.noticeDismissed(orderId) },
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'account',
    // Above every Harness section: the account state is the first thing a
    // signed-out user has to resolve.
    order: -10,
    label: () => t('nav'),
    locale: NS,
    inject: () => injected,
  }, AccountSection))
}
