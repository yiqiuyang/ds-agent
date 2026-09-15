import { useEffect, useRef } from 'react'
import { useShell } from '../store'
import { MessageBubble } from './MessageBubble'
import { ToolCallCard } from './ToolCallCard'
import { ApprovalCard } from './ApprovalCard'

export function ChatView() {
  const timeline = useShell((s) => s.timeline)
  const streamingMessageId = useShell((s) => s.streamingMessageId)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, [timeline])

  return (
    <main className="chat">
      {timeline.length === 0 && (
        <div className="empty-hint">
          <p className="title">ds-agent</p>
          <p>DeepSeek Harness 插件化智能体外壳</p>
          <p className="dim">发送消息开始对话；mock 引擎会演示工具调用与审批流程</p>
        </div>
      )}
      {timeline.map((item) => {
        if (item.kind === 'message') {
          return (
            <MessageBubble key={item.id} message={item} streaming={item.id === streamingMessageId} />
          )
        }
        if (item.kind === 'tool') {
          return <ToolCallCard key={`t-${item.callId}`} item={item} />
        }
        return <ApprovalCard key={`a-${item.requestId}`} item={item} />
      })}
      <div ref={bottomRef} />
    </main>
  )
}
