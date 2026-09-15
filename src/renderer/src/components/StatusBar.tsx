import { useShell, type View } from '../store'

const STATUS_TEXT: Record<string, string> = {
  starting: '启动中',
  ready: '就绪',
  busy: '处理中',
  waiting_permission: '等待确认',
  restarting: '重启中',
  exited: '已退出',
  error: '错误'
}

const VIEWS: { key: View; label: string }[] = [
  { key: 'chat', label: '对话' },
  { key: 'bundles', label: 'Bundle' }
]

export function StatusBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const status = useShell((s) => s.status)
  const engine = useShell((s) => s.engine)
  const view = useShell((s) => s.view)
  const setView = useShell((s) => s.setView)

  return (
    <header className="status-bar">
      <nav className="view-tabs">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            className={`tab ${view === v.key ? 'active' : ''}`}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </nav>
      <div className={`status-dot status-${status}`} />
      <span className="status-text">{STATUS_TEXT[status] ?? status}</span>
      {engine && (
        <span className={`engine-badge engine-${engine.mode}`}>
          {engine.mode === 'mock' ? 'mock 引擎' : 'dsh'}
        </span>
      )}
      {engine?.model && <span className="engine-model">{engine.model}</span>}
      <span className="spacer" />
      <button className="ghost-button" onClick={() => void window.dsh.restartEngine()}>
        重启引擎
      </button>
      <button className="ghost-button" onClick={onOpenSettings}>
        设置
      </button>
    </header>
  )
}
