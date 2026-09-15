import { useEffect, useState } from 'react'
import { useShell } from './store'
import { subscribeKernelEvents } from './kernel-events'
import { StatusBar } from './components/StatusBar'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { SettingsModal } from './components/SettingsModal'
import { PermissionModal } from './components/PermissionModal'
import { BundlesPage } from './components/BundlesPage'

export function App() {
  const view = useShell((s) => s.view)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    // 先订阅事件，再启动引擎，避免丢失 engine.ready
    const unsubscribe = subscribeKernelEvents()
    void window.dsh.startEngine()
    return unsubscribe
  }, [])

  return (
    <div className="app">
      <StatusBar onOpenSettings={() => setSettingsOpen(true)} />
      {view === 'chat' ? (
        <>
          <ChatView />
          <Composer />
        </>
      ) : (
        <BundlesPage />
      )}
      <PermissionModal />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
