import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { KernelEvent, PermissionDecision, ShellConfig } from '../shared/protocol'
import type { BundleProfile } from '../shared/bundles'

const api = {
  /** 订阅引擎事件，返回取消订阅函数 */
  onEvent(cb: (event: KernelEvent) => void): () => void {
    const listener = (_e: IpcRendererEvent, event: KernelEvent): void => cb(event)
    ipcRenderer.on('engine:event', listener)
    return () => ipcRenderer.removeListener('engine:event', listener)
  },
  startEngine(): Promise<'dsh' | 'mock'> {
    return ipcRenderer.invoke('engine:start')
  },
  restartEngine(): Promise<'dsh' | 'mock'> {
    return ipcRenderer.invoke('engine:restart')
  },
  sendInput(text: string): Promise<void> {
    return ipcRenderer.invoke('engine:send', text)
  },
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    return ipcRenderer.invoke('engine:permission', requestId, decision)
  },
  interrupt(): Promise<void> {
    return ipcRenderer.invoke('engine:interrupt')
  },
  listSessions(cursor?: string): Promise<void> {
    return ipcRenderer.invoke('engine:session-list', cursor)
  },
  newSession(): Promise<void> {
    return ipcRenderer.invoke('engine:session-new')
  },
  resumeSession(sessionId: string): Promise<void> {
    return ipcRenderer.invoke('engine:session-resume', sessionId)
  },
  setSessionConfig(configId: string, value: string): Promise<void> {
    return ipcRenderer.invoke('engine:set-config', configId, value)
  },
  getConfig(): Promise<ShellConfig> {
    return ipcRenderer.invoke('config:get')
  },
  setConfig(patch: Partial<ShellConfig>): Promise<ShellConfig> {
    return ipcRenderer.invoke('config:set', patch)
  },
  getBundleProfile(): Promise<BundleProfile> {
    return ipcRenderer.invoke('bundles:get')
  },
  setBundleEnabled(id: string, enabled: boolean): Promise<BundleProfile> {
    return ipcRenderer.invoke('bundles:setEnabled', id, enabled)
  }
}

contextBridge.exposeInMainWorld('dsh', api)

export type DshApi = typeof api
