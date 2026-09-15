import { useState } from 'react'
import type { TimelineItem } from '../store'

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  ok: '完成',
  error: '失败',
  denied: '已拒绝'
}

export function ToolCallCard({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)

  return (
    <div className={`tool-card tool-${item.status}`}>
      <button className="tool-header" onClick={() => setOpen(!open)}>
        <span className="tool-name">{item.tool}</span>
        <span className="tool-status">{STATUS_LABEL[item.status]}</span>
        <span className="tool-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="tool-detail">
          <section>
            <h4>输入</h4>
            <pre>{JSON.stringify(item.input, null, 2)}</pre>
          </section>
          {item.output !== undefined && (
            <section>
              <h4>输出</h4>
              <pre>{item.output}</pre>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
