/** Values the Tauri shell's sidecar reports to the Rust shell and the shell's own pages. */

import type { DesktopApiKeyStatus, DesktopUpdateState } from '../../desktop/src/ipc.ts'
import type { DesktopLogUpdate } from '../../desktop/src/log-buffer.ts'

/** How far the sidecar has come in preparing the desktop runtime. */
export interface ShellStatus {
  readonly phase: 'starting' | 'ready' | 'error'
  /** Completed fraction of the launch, from 0 through 1. */
  readonly progress: number
  /** Harness-CN version this installation is bound to. */
  readonly version: string
  /**
   * What the launch is doing right now, for the line under the progress bar.
   *
   * The first launch fetches the offline package, which takes far longer than everything else the
   * launch does put together; a bar that only advances cannot say whether that wait is work or a
   * hang. Absent when there is nothing worth saying.
   */
  readonly note?: string
  /**
   * Short name of the startup step the launch is in right now.
   *
   * A first launch spends its minutes in four or five steps that differ in kind — fetching,
   * hashing, unpacking, linking — and the overall bar moves so little within one of them that it
   * cannot say whether that step is working or stuck. Present whenever a step is known.
   */
  readonly step?: string
  /**
   * Completed fraction of `step`, from 0 through 1.
   *
   * Omitted for a step that has no denominator to measure against, such as starting the Host: the
   * window then shows the step's elapsed time rather than a percentage that would be invented.
   */
  readonly stepProgress?: number
  /** Reason the launch stopped, present only while `phase` is `error`. */
  readonly message?: string
}

/**
 * One line the sidecar writes to its own stdout.
 *
 * The Rust shell reads these instead of polling the HTTP surface: the window it has to
 * create and the port it has to point at are both facts only the sidecar knows, and a
 * line-oriented stream keeps that handshake free of an HTTP client in the shell.
 */
export type ShellHandshake =
  | { readonly type: 'listen'; readonly port: number }
  | { readonly type: 'status'; readonly status: ShellStatus }
  | { readonly type: 'ready'; readonly port: number; readonly needsApiKey: boolean }
  | { readonly type: 'update'; readonly state: DesktopUpdateState }
  | { readonly type: 'message'; readonly title: string; readonly body: string }
  | { readonly type: 'fatal'; readonly message: string }

/**
 * One command the Rust shell writes to this process's stdin.
 *
 * The shell has no HTTP client and no JavaScript bridge into the sidecar, so the two halves
 * talk over this process's own standard streams in both directions: the sidecar reports facts
 * on stdout, and the shell asks for operations here. A menu that has to reach an operation only
 * the sidecar can perform therefore needs a line, not a server.
 */
export type ShellCommand =
  | { readonly command: 'check-updates' }
  | { readonly command: 'quit' }

/** Arguments the Rust shell passes to the sidecar on its command line. */
export interface ShellArguments {
  /** Absolute directory holding `runtime`, `seed`, and `shell`. */
  readonly resourceDir: string
  /** Harness-CN version this build reports and binds its profile to. */
  readonly version: string
  /** Absolute path of `node.exe`, used again for the pnpm runs and the Host child. */
  readonly node: string
  /** Absolute path of the embedded pnpm entry, `pnpm.mjs`. */
  readonly pnpm: string
  /** Absolute directory this process may write the run log into. */
  readonly logDirectory: string
  /**
   * Absolute directory the application is installed in.
   *
   * The platform uninstaller lives there, and this process cannot derive it: the only path it
   * knows is the Node runtime inside the installation, so the shell states the directory instead
   * of the sidecar guessing at it.
   */
  readonly installDir: string
}

/** State sink the sidecar publishes to both its pages and the Rust shell. */
export interface ShellEventBus {
  /** Publish the launch status. */
  status(state: ShellStatus): void
  /** Publish a coalesced batch of run-log lines. */
  logs(update: DesktopLogUpdate): void
  /** Publish the release-channel state. */
  update(state: DesktopUpdateState): void
  /** Report a status transition to the Rust shell on stdout. */
  handshake(message: ShellHandshake): void
}

export type { DesktopApiKeyStatus, DesktopUpdateState }
