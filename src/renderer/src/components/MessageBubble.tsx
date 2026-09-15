import { Markdown } from './Markdown'
import type { TimelineItem } from '../store'

export function MessageBubble({
  message,
  streaming
}: {
  message: Extract<TimelineItem, { kind: 'message' }>
  streaming: boolean
}) {
  return (
    <div className={`message message-${message.role}`}>
      <div className="message-content">
        <Markdown text={message.text} />
        {streaming && <span className="cursor" />}
      </div>
    </div>
  )
}
