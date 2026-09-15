import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { DshEngineManager } from './engine/engine-manager'
import { registerIpc } from './ipc'

const manager = new DshEngineManager()

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 600,
    title: 'ds-agent',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs')
    }
  })

  // 引擎事件推送到渲染进程
  manager.onEvent((event) => {
    if (!win.isDestroyed()) win.webContents.send('engine:event', event)
  })

  win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

app.whenReady().then(() => {
  registerIpc(manager)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前终止引擎子进程
app.on('will-quit', () => {
  void manager.stop()
})
