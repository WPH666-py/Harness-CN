/** Context-isolated renderer bridge for desktop package and update operations. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  type DesktopApiKeyStatus,
  type DshDesktopApi,
  type DesktopStartupState,
  type DesktopUpdateState,
} from './ipc.ts'
import type { DesktopLogSnapshot, DesktopLogUpdate } from './log-buffer.ts'

const api: DshDesktopApi = {
  protocolVersion: 1,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as Promise<ReturnType<DshDesktopApi['locale']> extends Promise<infer T> ? T : never>,
  plugins: {
    list: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsList) as Promise<ReturnType<DshDesktopApi['plugins']['list']> extends Promise<infer T> ? T : never>,
    add: spec => ipcRenderer.invoke(DESKTOP_IPC.pluginsAdd, spec) as Promise<void>,
    remove: name => ipcRenderer.invoke(DESKTOP_IPC.pluginsRemove, name) as Promise<void>,
    update: (name, version) => ipcRenderer.invoke(DESKTOP_IPC.pluginsUpdate, name, version) as Promise<void>,
  },
  updates: {
    check: () => ipcRenderer.invoke(DESKTOP_IPC.updatesCheck) as Promise<DesktopUpdateState>,
    install: () => ipcRenderer.invoke(DESKTOP_IPC.updatesInstall) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.updatesState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesState, handle) }
    },
  },
  logs: {
    get: () => ipcRenderer.invoke(DESKTOP_IPC.logsGet) as Promise<DesktopLogSnapshot>,
    clear: () => ipcRenderer.invoke(DESKTOP_IPC.logsClear) as Promise<DesktopLogSnapshot>,
    reveal: () => ipcRenderer.invoke(DESKTOP_IPC.logsReveal) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, update: DesktopLogUpdate): void => { listener(update) }
      ipcRenderer.on(DESKTOP_IPC.logsState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.logsState, handle) }
    },
  },
  startup: {
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopStartupState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.startupState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.startupState, handle) }
    },
  },
  apiKey: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.apiKeyStatus) as Promise<DesktopApiKeyStatus>,
    save: key => ipcRenderer.invoke(DESKTOP_IPC.apiKeySave, key) as Promise<DesktopApiKeyStatus>,
    defer: () => ipcRenderer.invoke(DESKTOP_IPC.apiKeyDefer) as Promise<void>,
    quit: () => ipcRenderer.invoke(DESKTOP_IPC.apiKeyQuit) as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
