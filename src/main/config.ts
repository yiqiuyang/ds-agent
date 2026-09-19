import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ShellConfig } from '../shared/protocol'

const DEFAULT_CONFIG: ShellConfig = {
  dshPath: '',
  profile: 'acp',
  profileType: 'web',
  workspaceDir: '',
  forceMock: false
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): ShellConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(patch: Partial<ShellConfig>): ShellConfig {
  const next = { ...loadConfig(), ...patch }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

export function resolveWorkspaceDir(cfg: ShellConfig): string {
  // 默认工作区放每用户数据目录（Win: AppData\Roaming\<app>\workspace；mac: ~/Library/Application Support/<app>/workspace；
  // Linux: ~/.config/<app>/workspace），不落开发机项目路径、不写死，用户可在 config.workspaceDir 覆盖。
  return cfg.workspaceDir || path.join(app.getPath('userData'), 'workspace')
}
