import { useState, type KeyboardEvent } from 'react'
import { useShell } from '../store'

export function Composer() {
  const [text, setText] = useState('')
  const status = useShell((s) => s.status)
  const appendUserMessage = useShell((s) => s.appendUserMessage)

  const canSend = status === 'ready' && text.trim().length > 0
  const canInterrupt = status === 'busy' || status === 'waiting_permission'

  const send = () => {
    const value = text.trim()
    if (!value || status !== 'ready') return
    appendUserMessage(value)
    void window.dsh.sendInput(value)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法选词回车不触发发送
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <footer className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          status === 'ready' ? '输入任务，Enter 发送（Shift+Enter 换行）' : '引擎处理中…'
        }
        rows={3}
      />
      <div className="composer-actions">
        {canInterrupt && (
          <button className="danger-button" onClick={() => void window.dsh.interrupt()}>
            停止
          </button>
        )}
        <button className="primary-button" disabled={!canSend} onClick={send}>
          发送
        </button>
      </div>
    </footer>
  )
}
