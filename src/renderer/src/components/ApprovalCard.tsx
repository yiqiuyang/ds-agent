import type { PermissionDecision } from '../../../shared/protocol'
import type { TimelineItem } from '../store'

const DECISION_LABEL: Record<PermissionDecision, string> = {
  allow_once: '已允许',
  allow_always: '已常驻允许',
  deny: '已拒绝'
}

/**
 * 时间线中的审批记录。交互入口在 PermissionModal 弹窗，
 * 这里仅保留历史痕迹（是否已处理、处理结果）。
 */
export function ApprovalCard({ item }: { item: Extract<TimelineItem, { kind: 'approval' }> }) {
  return (
    <div className="approval-card">
      <div className="approval-title">需要确认：{item.tool}</div>
      {item.reason && <div className="approval-reason">{item.reason}</div>}
      <pre className="approval-input">{JSON.stringify(item.input, null, 2)}</pre>
      <div className="approval-resolved">
        {item.resolved ? DECISION_LABEL[item.resolved] : '待确认（见弹窗）'}
      </div>
    </div>
  )
}
