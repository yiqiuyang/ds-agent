import { useEffect, useRef, useState } from 'react'
import { useShell } from '../store'

/**
 * 会话菜单：新会话 + 历史会话列表（恢复）。
 * 挂在 StatusBar；列表数据由 session.list 事件异步送达（store.sessionList）。
 */
export function SessionMenu() {
  const status = useShell((s) => s.status)
  const sessionId = useShell((s) => s.sessionId)
  const sessionList = useShell((s) => s.sessionList)
  const loadSessions = useShell((s) => s.loadSessions)
  const newSession = useShell((s) => s.newSession)
  const resumeSession = useShell((s) => s.resumeSession)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const switchable = status === 'ready'

  // 首次展开时拉取列表
  useEffect(() => {
    if (open && sessionList === null) loadSessions()
  }, [open, sessionList, loadSessions])

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
        className="ghost-button"
        disabled={!switchable}
        title={switchable ? '关闭当前会话并新建一个会话' : '引擎就绪后才能切换会话'}
        onClick={() => {
          newSession()
          setOpen(false)
        }}
      >
        新会话
      </button>
      <button
        className={`ghost-button ${open ? 'active' : ''}`}
        disabled={!switchable}
        onClick={() => setOpen((v) => !v)}
      >
        历史会话{sessionId ? ` (${sessionId.slice(0, 8)}…)` : ''}
      </button>
      {open && (
        <div className="session-panel">
          <div className="session-panel-head">
            <span className="dim">当前工作区的可恢复会话</span>
            <button className="ghost-button" disabled={sessionList?.loading} onClick={() => loadSessions()}>
              刷新
            </button>
          </div>
          {!sessionList && <p className="session-empty">加载中…</p>}
          {sessionList && sessionList.sessions.length === 0 && !sessionList.loading && (
            <p className="session-empty">暂无历史会话</p>
          )}
          {sessionList?.sessions.map((item) => (
            <div key={item.sessionId} className="session-row">
              <div className="session-info">
                <span className="session-id" title={item.sessionId}>
                  {item.sessionId.slice(0, 8)}…
                </span>
                <span className="session-cwd" title={item.cwd}>
                  {item.cwd}
                </span>
              </div>
              <button
                className="ghost-button"
                disabled={!switchable}
                onClick={() => {
                  resumeSession(item.sessionId)
                  setOpen(false)
                }}
              >
                恢复
              </button>
            </div>
          ))}
          {sessionList?.loading && <p className="session-empty">加载中…</p>}
          {sessionList?.nextCursor && !sessionList.loading && (
            <button className="ghost-button session-more" onClick={() => loadSessions(sessionList.nextCursor!)}>
              加载更多
            </button>
          )}
          <p className="session-note dim">恢复后引擎侧保留完整上下文；历史消息不在本窗口回放。</p>
        </div>
      )}
    </div>
  )
}
