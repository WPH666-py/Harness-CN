/** Browser tab ownership for one UI-initiated authorization attempt. */
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'

/** Keeps a preopened browser tab separate from Host authorization state. */
export class BrowserLogin {
  private popup: Window | null = null
  private navigated = false
  private blocked = false
  private attempt: SignInAttemptId | undefined

  /** @param destination - maps the Host authorization URL to the page the tab opens, read when the tab navigates. */
  constructor(private readonly destination: (authorizeUrl: string) => string) {}

  /** Whether the browser refused the tab opened during the click, so only the copied link can carry the attempt. */
  get tabBlocked(): boolean { return this.blocked }

  /**
   * Preopen a tab and bind it to the attempt returned by the Host.
   * @param request - authenticated Host start request.
   * @param latest - most recent streamed state, including frames received before the response.
   * @returns after this UI is following the new attempt.
   */
  async start(request: () => Promise<AccountView>, latest: () => AccountView | undefined): Promise<void> {
    this.begin()
    try {
      this.follow(await request())
      this.update(latest())
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /**
   * Preopen a tab during the user's click.
   *
   * A desktop shell can refuse the blank tab outright, and the refusal is a normal outcome rather
   * than a failure: the attempt keeps running, and when the authorization page arrives
   * {@link update} asks for it directly so the shell opens its external browser instead.
   */
  begin(): void {
    this.dispose()
    this.blocked = false
    const popup = window.open('about:blank', '_blank')
    this.blocked = popup === null
    this.popup = popup
    if (popup) popup.opener = null
  }

  /**
   * Bind the preopened tab to its Host attempt.
   * @param view - initial RPC response identifying this UI's attempt.
   */
  follow(view: AccountView): void {
    this.attempt = view.attempt?.id
    this.update(view)
  }

  /**
   * Navigate or close the pending tab when its attempt changes.
   * @param view - latest Host state.
   */
  update(view: AccountView | undefined): void {
    const attempt = view?.attempt
    if (attempt?.id !== this.attempt) return
    if (attempt && ['failed', 'expired', 'cancelled'].includes(attempt.phase)) {
      this.dispose()
      return
    }
    if (attempt?.phase === 'succeeded') {
      // A tab that never reached the authorization page stays blank; the Host finished without it.
      if (!this.navigated) this.popup?.close()
      this.popup = null
      this.attempt = undefined
      return
    }
    if (!attempt?.authorizeUrl || this.navigated) return
    this.navigated = true
    const destination = this.destination(attempt.authorizeUrl)
    if (this.popup && !this.popup.closed) {
      this.popup.location.replace(destination)
      return
    }
    // No tab survived the click. Asking for the page itself lets a desktop shell hand it to the
    // external browser; a browser that blocks this too leaves the dialog's copy-link route.
    const opened = window.open(destination, '_blank')
    if (opened) opened.opener = null
  }

  /** Close the owned authorization tab and stop following its attempt. */
  dispose(): void {
    this.popup?.close()
    this.popup = null
    this.attempt = undefined
    this.navigated = false
    this.blocked = false
  }
}
