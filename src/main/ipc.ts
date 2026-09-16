import { ipcMain } from 'electron'
import type { DshEngineManager, EngineOptions } from './engine/engine-manager'
import { loadConfig, resolveWorkspaceDir, saveConfig } from './config'
import { loadBundleProfile, setBundleEnabled } from './bundles'
import type { PermissionDecision, ShellConfig } from '../shared/protocol'

const DECISIONS: readonly PermissionDecision[] = ['allow_once', 'allow_always', 'deny']

function engineOptions(): EngineOptions {
  const cfg = loadConfig()
  return {
    dshPath: cfg.dshPath,
    profile: cfg.profile,
    workspaceDir: resolveWorkspaceDir(cfg),
    forceMock: cfg.forceMock
  }
}

export function registerIpc(manager: DshEngineManager): void {
  ipcMain.handle('engine:start', () => manager.start(engineOptions()))

  ipcMain.handle('engine:restart', () => manager.start(engineOptions()))

  ipcMain.handle('engine:send', (_event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('无效的输入')
    manager.send({ type: 'user.input', text })
  })

  ipcMain.handle('engine:permission', (_event, requestId: unknown, decision: unknown) => {
    if (typeof requestId !== 'string' || !DECISIONS.includes(decision as PermissionDecision)) {
      throw new Error('无效的审批响应')
    }
    manager.send({
      type: 'permission.response',
      requestId,
      decision: decision as PermissionDecision
    })
  })

  ipcMain.handle('engine:interrupt', () => {
    manager.send({ type: 'interrupt' })
  })

  ipcMain.handle('engine:session-list', (_event, cursor: unknown) => {
    manager.send({ type: 'session.list', ...(typeof cursor === 'string' && cursor ? { cursor } : {}) })
  })

  ipcMain.handle('engine:session-new', () => {
    manager.send({ type: 'session.new' })
  })

  ipcMain.handle('engine:session-resume', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('无效的会话 id')
    manager.send({ type: 'session.resume', sessionId })
  })

  ipcMain.handle('engine:set-config', (_event, configId: unknown, value: unknown) => {
    if (typeof configId !== 'string' || !configId) throw new Error('无效的配置 id')
    if (typeof value !== 'string') throw new Error('无效的配置值')
    manager.send({ type: 'session.config', configId, value })
  })

  ipcMain.handle('config:get', () => loadConfig())

  ipcMain.handle('config:set', (_event, patch: unknown) => {
    // 边界校验：仅接受已知字段
    const allowed: (keyof ShellConfig)[] = ['dshPath', 'profile', 'workspaceDir', 'forceMock']
    const safe: Partial<ShellConfig> = {}
    if (patch && typeof patch === 'object') {
      for (const key of allowed) {
        const value = (patch as Record<string, unknown>)[key]
        if (typeof value === 'string' || typeof value === 'boolean') {
          ;(safe as Record<string, unknown>)[key] = value
        }
      }
    }
    return saveConfig(safe)
  })

  ipcMain.handle('bundles:get', () => loadBundleProfile())

  ipcMain.handle('bundles:setEnabled', (_event, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('无效的 bundle id')
    if (typeof enabled !== 'boolean') throw new Error('无效的开关状态')
    return setBundleEnabled(id, enabled)
  })
}
