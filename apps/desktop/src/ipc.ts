/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopPluginRecord } from './project-manager.ts'
import type { DesktopLocale } from './locale.ts'
import type { DesktopLogSnapshot, DesktopLogUpdate } from './log-buffer.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  localeGet: 'dsh-desktop:locale-get',
  pluginsList: 'dsh-desktop:plugins-list',
  pluginsAdd: 'dsh-desktop:plugins-add',
  pluginsRemove: 'dsh-desktop:plugins-remove',
  pluginsUpdate: 'dsh-desktop:plugins-update',
  updatesCheck: 'dsh-desktop:updates-check',
  updatesInstall: 'dsh-desktop:updates-install',
  updatesState: 'dsh-desktop:updates-state',
  logsGet: 'dsh-desktop:logs-get',
  logsClear: 'dsh-desktop:logs-clear',
  logsReveal: 'dsh-desktop:logs-reveal',
  logsState: 'dsh-desktop:logs-state',
  startupState: 'dsh-desktop:startup-state',
  apiKeyStatus: 'dsh-desktop:api-key-status',
  apiKeySave: 'dsh-desktop:api-key-save',
  apiKeyDefer: 'dsh-desktop:api-key-defer',
  apiKeyQuit: 'dsh-desktop:api-key-quit',
} as const

/** Configured state of the harness credential the desktop gates startup on. */
export interface DesktopApiKeyStatus {
  readonly configured: boolean
  /** Reporting layer that currently supplies the value, absent when nothing is configured. */
  readonly source?: string
}

/** Desktop release update state rendered by desktop-owned UI. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
}

/** How far the launch has come, reported to the window shown while it runs. */
export interface DesktopStartupState {
  /** Completed fraction of the launch, from 0 through 1. */
  readonly progress: number
}

/** Narrow bridge exposed through context isolation. */
export interface DshDesktopApi {
  readonly protocolVersion: 1
  locale(): Promise<DesktopLocale>
  readonly plugins: {
    list(): Promise<readonly DesktopPluginRecord[]>
    add(spec: string): Promise<void>
    remove(name: string): Promise<void>
    update(name: string, version: string): Promise<void>
  }
  readonly updates: {
    check(): Promise<DesktopUpdateState>
    install(): Promise<void>
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
  }
  readonly logs: {
    get(): Promise<DesktopLogSnapshot>
    clear(): Promise<DesktopLogSnapshot>
    reveal(): Promise<void>
    subscribe(listener: (update: DesktopLogUpdate) => void): () => void
  }
  readonly startup: {
    subscribe(listener: (state: DesktopStartupState) => void): () => void
  }
  readonly apiKey: {
    status(): Promise<DesktopApiKeyStatus>
    save(key: string): Promise<DesktopApiKeyStatus>
    defer(): Promise<void>
    quit(): Promise<void>
  }
}
