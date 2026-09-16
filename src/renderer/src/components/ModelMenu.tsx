import { useEffect, useRef, useState } from 'react'
import { useShell } from '../store'
import type { SessionConfigOption } from '../../../shared/protocol'

/**
 * 模型菜单：当前会话的配置项选择器（model / reasoning_effort）。
 * 数据由 session.config 事件异步送达（store.configOptions）；
 * 修改经 session.config 命令 -> ACP session/set_config_option，对新轮次生效。
 */
export function ModelMenu() {
  const status = useShell((s) => s.status)
  const configOptions = useShell((s) => s.configOptions)
  const setSessionConfig = useShell((s) => s.setSessionConfig)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const model = configOptions.find((o) => o.id === 'model')
  const switchable = status === 'ready'

  // 点击面板外部 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="session-menu" ref={rootRef}>
      <button
        className={`ghost-button ${open ? 'active' : ''}`}
        disabled={!switchable || configOptions.length === 0}
        title={switchable ? '切换模型 / 推理强度（对新轮次生效）' : '引擎就绪后才能修改配置'}
        onClick={() => setOpen((v) => !v)}
      >
        {model ? model.currentLabel : '模型'}
      </button>
      {open && (
        <div className="session-panel">
          {configOptions.map((opt) => (
            <ConfigSection key={opt.id} opt={opt} onPick={(value) => setSessionConfig(opt.id, value)} />
          ))}
          <p className="session-note dim">配置对当前会话的新轮次生效。</p>
        </div>
      )}
    </div>
  )
}

/** 单个配置项的分区：标题 + 当前值高亮的选项列表 */
function ConfigSection({
  opt,
  onPick
}: {
  opt: SessionConfigOption
  onPick: (value: string) => void
}) {
  return (
    <div className="config-section">
      <div className="session-panel-head">
        <span className="dim">{opt.name}</span>
        <span className="session-id">{opt.currentLabel}</span>
      </div>
      {opt.choices.map((choice) => (
        <button
          key={choice.value}
          className={`config-choice ${choice.value === opt.currentValue ? 'current' : ''}`}
          title={choice.description ?? choice.label}
          onClick={() => onPick(choice.value)}
        >
          <span>{choice.label}</span>
          {choice.value === opt.currentValue && <span className="config-check">✓</span>}
        </button>
      ))}
    </div>
  )
}
