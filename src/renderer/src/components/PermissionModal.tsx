import type { PermissionDecision } from '../../../shared/protocol'
import { useShell } from '../store'

/**
 * permission.request 事件触发的审批弹窗。
 * 必须显式做出选择（允许 / 常驻允许 / 拒绝）才会关闭。
 */
export function PermissionModal() {
  const pending = useShell((s) => s.pendingPermission)
  const respondPermission = useShell((s) => s.respondPermission)
  if (!pending) return null

  const decide = (decision: PermissionDecision) => {
    respondPermission(pending.requestId, decision)
  }

  return (
    <div className="modal-mask permission-mask">
      <div className="modal permission-modal">
        <h3>操作确认</h3>
        <div className="permission-tool">
          工具 <code>{pending.tool}</code> 请求执行以下操作
        </div>
        {pending.reason && <div className="permission-reason">{pending.reason}</div>}
        <pre className="permission-input">{JSON.stringify(pending.input, null, 2)}</pre>
        <div className="modal-actions">
          <button className="danger-button" onClick={() => decide('deny')}>
            拒绝
          </button>
          <button onClick={() => decide('allow_always')}>本次会话总是允许</button>
          <button className="primary-button" onClick={() => decide('allow_once')}>
            允许一次
          </button>
        </div>
      </div>
    </div>
  )
}
