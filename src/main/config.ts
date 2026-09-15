import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ShellConfig } from '../shared/protocol'

const DEFAULT_CONFIG: ShellConfig = {
  dshPath: '',
  profile: 'acp',
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
  return cfg.workspaceDir || os.homedir()
}
