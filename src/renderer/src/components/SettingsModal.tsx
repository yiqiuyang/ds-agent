import { useEffect, useState, type FormEvent } from 'react'
import type { ShellConfig } from '../../../shared/protocol'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<ShellConfig | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.dsh.getConfig().then(setCfg)
  }, [])

  const update = (patch: Partial<ShellConfig>) => {
    setCfg((c) => (c ? { ...c, ...patch } : c))
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!cfg) return
    setSaving(true)
    try {
      await window.dsh.setConfig({
        dshPath: cfg.dshPath,
        profile: cfg.profile,
        workspaceDir: cfg.workspaceDir,
        forceMock: cfg.forceMock
      })
      // 配置变更后重启引擎生效
      await window.dsh.restartEngine()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  if (!cfg) return null

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h3>设置</h3>
        <label>
          dsh 路径
          <input
            value={cfg.dshPath}
            onChange={(e) => update({ dshPath: e.target.value })}
            placeholder="留空则自动检测 PATH 中的 dsh"
          />
        </label>
        <label>
          dsh profile
          <input value={cfg.profile} onChange={(e) => update({ profile: e.target.value })} />
        </label>
        <label>
          工作区目录
          <input
            value={cfg.workspaceDir}
            onChange={(e) => update({ workspaceDir: e.target.value })}
            placeholder="留空使用用户主目录"
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={cfg.forceMock}
            onChange={(e) => update({ forceMock: e.target.checked })}
          />
          强制使用 mock 引擎
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存并重启引擎'}
          </button>
        </div>
      </form>
    </div>
  )
}
