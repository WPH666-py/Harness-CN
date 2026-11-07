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
/** The three ways the frame can present its columns. */
export type PresentationStage = 'conversation' | 'workstation' | 'ide'

/**
 * The three arrangements the header's presentation menu names.
 *
 * `desk` is the plain conversation layout; `ide-three` and `ide-full` are the
 * full-screen stage with the Conversation in a drawer and without it. They are
 * named after what the user sees rather than after the two flags they set.
 */
export type Presentation = 'desk' | 'ide-three' | 'ide-full'

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
export type LayoutPanelActions = Omit<PanelActions, 'setWorkstation' | 'setWorkstationWidth' | 'setIde' | 'setDrawer' | 'setServerMode'> & {
  setWorkstation?: (on: boolean) => void
  setWorkstationWidth?: (px: number) => void
  setIde?: (on: boolean) => void
  setDrawer?: (on: boolean) => void
  setServerMode?: (on: boolean) => void
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
   * Whether the frame is in the full-screen IDE stage: the seat keeps its tree
   * and editor while the centre column steps aside.
   */
  readonly ide: HostObservable<boolean>
  /**
   * Whether the Conversation slides over the IDE stage as a drawer. Only ever
   * true while {@link ide} is, and it goes away with that stage.
   */
  readonly drawer: HostObservable<boolean>
  /**
   * Advance the frame one stage: the conversation layout, then the workstation
   * layout, then the IDE stage, and back to the conversation.
   */
  cyclePresentation(): void
  /**
   * Whether the seat is showing a remote server instead of this machine. The
   * workstation plugin publishes the answer; every other surface reads it to
   * tell the two modes apart.
   */
  readonly serverMode: HostObservable<boolean>
  /**
   * Publish which machine the seat is showing.
   * @param on - true once a remote host is current, false when the seat is back
   *   on this machine.
   */
  setServerMode(on: boolean): void
  /**
   * Pull the Conversation in over the IDE stage, or push it back out. Does
   * nothing outside that stage, where the Conversation has a column of its own.
   */
  toggleDrawer(): void
  /**
   * Put the frame into one named stage whatever it is showing now.
   *
   * Optional: it is a convenience over the setters, and a controller assembled by
   * an older caller still satisfies this face.
   * @param stage - the stage to show.
   */
  setStage?(stage: PresentationStage): void
  /**
   * Put the frame into one named presentation: the desk, or the IDE stage with
   * the Conversation inside a drawer or out of it. Optional so a controller
   * assembled by an older caller still satisfies this face.
   * @param presentation - the arrangement to show.
   */
  present?(presentation: Presentation): void
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
    readonly ide: HostObservable<boolean> = HIDDEN_WORKSTATION,
    readonly drawer: HostObservable<boolean> = HIDDEN_WORKSTATION,
    readonly serverMode: HostObservable<boolean> = HIDDEN_WORKSTATION,
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

  /**
   * Advance one stage: conversation → workstation → IDE → conversation.
   *
   * The IDE stage is entered from the workstation layout and left by closing
   * that layout, so the sequence never jumps from the conversation straight
   * into a seat the user has not seen yet.
   */
  cyclePresentation(): void {
    if (!this.workstation.getSnapshot()) {
      this.panels.setWorkstation?.(true)
      return
    }
    // The seat has two stages, so the toggle swaps between them. Leaving the
    // seat altogether is the header corner's gesture: this control's label
    // never has to describe a destination outside the seat.
    this.panels.setIde?.(!this.ide.getSnapshot())
  }

  /** Publish which machine the seat is showing. */
  setServerMode(on: boolean): void {
    this.panels.setServerMode?.(on)
  }

  /** Pull the Conversation over the IDE stage, or push it back out. */
  toggleDrawer(): void {
    this.panels.setDrawer?.(!this.drawer.getSnapshot())
  }

  /**
   * Show one named stage.
   *
   * The seat layout is opened first because the IDE stage lives inside it: the
   * store refuses the full-screen flag while the seat is off, so asking for both
   * in the other order would silently land on the conversation layout.
   * @param stage - the stage to show.
   */
  setStage(stage: PresentationStage): void {
    const seat = stage !== 'conversation'
    if (this.workstation.getSnapshot() !== seat) this.panels.setWorkstation?.(seat)
    this.panels.setIde?.(stage === 'ide')
  }

  /**
   * Put the frame into one of the three presentations the header's menu offers.
   *
   * The desk is the layout without the seat; the two IDE presentations are the
   * full-screen stage with the Conversation pulled in as a drawer and pushed back
   * out. Asking for one is therefore a pair of decisions — whether the seat is
   * on and whether its drawer is — and this is the one place that keeps them
   * consistent: the seat opens before the IDE flag, because the store refuses the
   * full-screen stage while the seat is off.
   * @param presentation - the arrangement to show.
   */
  present(presentation: Presentation): void {
    if (presentation === 'desk') {
      this.setStage('conversation')
      return
    }
    if (!this.workstation.getSnapshot()) this.panels.setWorkstation?.(true)
    this.panels.setIde?.(true)
    this.panels.setDrawer?.(presentation === 'ide-three')
  }

  /** Save the workstation seat's drag width. */
  setWorkstationWidth(px: number): void {
    this.panels.setWorkstationWidth?.(px)
  }
}
