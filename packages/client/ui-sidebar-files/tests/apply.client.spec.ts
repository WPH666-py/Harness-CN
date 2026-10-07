/**
 * The plugin's registrations, and their removal when the plugin goes.
 *
 * The registry is real, because "registered" means what it says a type is; the
 * slot, locale, and Remote faces are recorders, because what matters here is
 * what was handed to them — one body seat under the type's id with its store
 * and face — and that every registration is gone after dispose, which is what
 * makes a reload safe.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { FILES_ID, FILES_KIND } from '../src/client/definition.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { FilesBody } from '../src/client/FilesBody.tsx'
import { FilesTitle } from '../src/client/FilesTitle.tsx'
import { FilesToggleAction } from '../src/client/FilesToggleAction.tsx'
import { en, zh } from '../src/client/locales.ts'

interface Recorded {
  name: string
  key: string
  id: string
  locale: string
  store: unknown
  inject: unknown
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    // Copy is the dictionary's contract; the key stands in for the translation.
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const workspaceFiles = { list: vi.fn() }
  // The header control reads the column's live state at the moment of the
  // gesture, so the recorder answers instead of holding a snapshot.
  const sidebarRight = {
    openTab: vi.fn(),
    toggleExpanded: vi.fn(),
    isExpanded: vi.fn(() => false),
    active: vi.fn<() => { kind: string } | undefined>(() => undefined),
  }
  ctx.provide('sidebarRight', sidebarRight as never)
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('remote', { workspaceFiles } as never)
  ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber, sidebarRight }
}

/** The header control's own registration, which carries an `id` rather than a keyed seat. */
function headerToggle(registered: readonly Recorded[]): Recorded {
  const entry = registered.find(candidate => candidate.name === 'conversation.session.header.utilities')
  if (entry === undefined) throw new Error('the header toggle was not registered')
  return entry
}

/** The gesture the registered header contribution hands its component. */
function toggleOf(entry: Recorded): () => void {
  return (entry.inject as () => { toggleWorkspaceFiles: () => void })().toggleWorkspaceFiles
}

describe('ui-sidebar-files apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers the type, its dictionaries, its two keyed seats, and the header toggle', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(FILES_KIND)
    expect(definition?.id).toBe(FILES_ID)
    expect(definition?.priority).toBe('builtin')
    expect(definition?.title('sidebar://files')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[10, 'guide.title', 'guide.description']])
    expect(dictionaries.get('sidebarFiles')).toEqual({ zh, en })
    // The seat key is the implementation's id, not the kind: an extension may
    // take the kind over, and the seat must still find this body.
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', FILES_ID, 'sidebarFiles', FilesBody],
      ['sidebar.right.pane.tab.title', FILES_ID, undefined, FilesTitle],
      ['conversation.session.header.utilities', undefined, 'sidebarFiles', FilesToggleAction],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(typeof registered[0]?.inject).toBe('function')
    // The header seat is a list cell addressed by id, which is how a caller
    // could replace exactly this control without disturbing its neighbours.
    expect(headerToggle(registered).id).toBe('workspace-files')
  })

  it('takes every registration back when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(FILES_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })

  it('opens the file tree when the column is not already showing it', async () => {
    const { registered, sidebarRight } = await boot()
    toggleOf(headerToggle(registered))()
    expect(sidebarRight.openTab).toHaveBeenCalledWith(FILES_KIND)
    expect(sidebarRight.toggleExpanded).not.toHaveBeenCalled()
  })

  it('folds the column away when the file tree is the tab it is showing', async () => {
    const { registered, sidebarRight } = await boot()
    sidebarRight.isExpanded.mockReturnValue(true)
    sidebarRight.active.mockReturnValue({ kind: FILES_KIND })
    toggleOf(headerToggle(registered))()
    expect(sidebarRight.toggleExpanded).toHaveBeenCalledOnce()
    expect(sidebarRight.openTab).not.toHaveBeenCalled()
  })

  it('opens the file tree when an expanded column is showing some other tab', async () => {
    const { registered, sidebarRight } = await boot()
    sidebarRight.isExpanded.mockReturnValue(true)
    sidebarRight.active.mockReturnValue({ kind: 'guide' })
    toggleOf(headerToggle(registered))()
    expect(sidebarRight.openTab).toHaveBeenCalledWith(FILES_KIND)
    expect(sidebarRight.toggleExpanded).not.toHaveBeenCalled()
  })
})
