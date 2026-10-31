/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry and main-panel selection live in the root layout store;
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (main-panel selection and sidebar toggle,
 * right-panel show/hide from ui-sidebar-right) — writes stay inside the
 * store's declared action set, shared with the root registration.
 */
import type { BoundActions, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { createLayoutStore } from './stores.ts'

/** Identity shared by a sidebar panel entry and its main-slot occupant. */
export type MainPanelId = Branded<'MainPanelId'>

/** Root-scoped navigation state exposed to panel-aware components. */
export interface PanelInfo {
  /** Selected global panel; null displays the current Conversation. */
  readonly activePanelId: MainPanelId | null
}

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * Panel actions the controller drives. The workstation writer stays optional so
 * a host that predates the workstation seat — or a hand-built panel-action fake
 * in a spec — still constructs a controller; every other transition it exposes
 * is required.
 */
export type LayoutPanelActions = Omit<PanelActions, 'setWorkstation' | 'setWorkstationWidth'> & {
  setWorkstation?: (on: boolean) => void
  setWorkstationWidth?: (px: number) => void
}

/** The presentation source a controller reports when its host has none. */
const HIDDEN_WORKSTATION: HostObservable<boolean> = {
  getSnapshot: () => false,
  subscribe: () => () => {},
}

/** The seat width a controller reports when its host has none. */
const UNSAVED_WORKSTATION_WIDTH: HostObservable<number | null> = {
  getSnapshot: () => null,
  subscribe: () => () => {},
}

/** Panel navigation and geometry actions exposed through ctx.layout. */
export interface ILayout {
  /** Selected central panel from the same root store used by `usePanelInfo`. */
  readonly panelInfo: HostObservable<PanelInfo>
  /**
   * Select a global central panel without changing the current Session.
   * @param panelId - registered main key, or null to show the Conversation.
   * @throws if the selected main key is not registered; preserves the current selection.
   */
  selectPanel(panelId: MainPanelId | null): void
  /**
   * Start an asynchronous navigation, superseding any earlier pending navigation.
   * @returns a signal aborted by the next navigation or layout disposal; check it before committing UI state.
   */
  beginNavigation(): AbortSignal
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /**
   * Report the right panel's presentation without changing its expanded state.
   * @param track - whether the normal panel width reserves a grid track,
   *   including beneath a fullscreen overlay.
   * @param fullscreen - whether the panel covers the frame and hides its outer
   *   resize handle; independent of the underlying grid track.
   */
  openRightbar(track: boolean, fullscreen: boolean): void
  /** Report the right panel as hidden: no track, no handle. */
  closeRightbar(): void
  /** Whether the frame presents the workstation layout. */
  readonly workstation: HostObservable<boolean>
  /**
   * Show or hide the workstation layout.
   * @param on - true seats the workstation in the first column and collapses the
   *   right column; false restores the navigation and right columns.
   */
  setWorkstation(on: boolean): void
  /** Toggle the workstation layout. */
  toggleWorkstation(): void
  /**
   * Saved workstation seat width in px, or null while the ratio default applies.
   *
   * Optional like the seat's writer, so a controller built before the seat became
   * resizable still satisfies this face.
   */
  readonly workstationWidth?: HostObservable<number | null>
  /**
   * Save the workstation seat's drag width.
   * @param px - requested width in px; the store clamps it into the frame's range.
   */
  setWorkstationWidth?(px: number): void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  private navigation = new AbortController()

  /**
   * @param panels - actions of the instance shared with the root entry.
   * @param hasMainPanel - checks the live main-slot registry for a panel id.
   * @param panelInfo - root store's shared central-panel selection source.
   * @param workstation - root store's shared workstation-presentation source;
   *   omitting it reports the seat as permanently hidden.
   * @param workstationWidth - root store's shared seat-width preference;
   *   omitting it reports no saved width.
   */
  constructor(
    private readonly panels: LayoutPanelActions,
    private readonly hasMainPanel: (id: MainPanelId) => boolean,
    readonly panelInfo: HostObservable<PanelInfo>,
    readonly workstation: HostObservable<boolean> = HIDDEN_WORKSTATION,
    readonly workstationWidth: HostObservable<number | null> = UNSAVED_WORKSTATION_WIDTH,
  ) {}

  /** Select a global panel or return to the Conversation. */
  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    this.panels.selectPanel(panelId)
  }

  /** @returns the new pending navigation's cancellation signal. */
  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  /** Invalidate pending navigations when the layout owner is unloaded. */
  dispose(): void {
    this.navigation.abort()
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.panels.toggleSidebar()
  }

  /** Report the right panel's track and fullscreen presentation. */
  openRightbar(track: boolean, fullscreen: boolean): void {
    this.panels.openRightbar(track, fullscreen)
  }

  /** Report the right panel as hidden: no track, no handle. */
  closeRightbar(): void {
    this.panels.closeRightbar()
  }

  /** Show or hide the workstation layout. */
  setWorkstation(on: boolean): void {
    this.panels.setWorkstation?.(on)
  }

  /** Toggle the workstation layout against its current presentation. */
  toggleWorkstation(): void {
    this.panels.setWorkstation?.(!this.workstation.getSnapshot())
  }

  /** Save the workstation seat's drag width. */
  setWorkstationWidth(px: number): void {
    this.panels.setWorkstationWidth?.(px)
  }
}
