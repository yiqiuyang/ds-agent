import { join } from 'node:path'
import { app, BaseWindow, BrowserWindow, type WebContentsView } from 'electron'
import { DshEngineManager } from './engine/engine-manager'
import { WebEngine } from './engine/web-engine'
import { createWebWindow } from './web-window'
import { registerIpc } from './ipc'
import { loadConfig } from './config'

const cfg = loadConfig()

if (cfg.profileType === 'web') {
  startWeb()
} else {
  startAcp()
}

/**
 * web 路径：spawn dsh web profile，WebContentsView 内嵌 DSH Web UI（DirectorX 画布）。
 * 无自研 React UI 与 ACP 协议层，DSH 的浏览器前端就是界面。
 */
function startWeb(): void {
  const engine = new WebEngine()
  let view: WebContentsView | null = null

  engine.onReady = (url) => {
    console.log('[web] 引擎就绪:', url)
    view?.webContents.loadURL(url)
  }
  engine.onError = (message) => {
    console.error('[web]', message)
  }

  function openWindow(): void {
    const created = createWebWindow()
    view = created.view
    created.win.on('closed', () => {
      if (view === created.view) view = null
    })
  }

  app.whenReady().then(() => {
    openWindow()
    engine.start()

    app.on('activate', () => {
      if (BaseWindow.getAllWindows().length === 0) openWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    engine.kill()
  })
}

/** acp 路径：ACP sidecar + 自研 React 聊天 UI（后备模式） */
function startAcp(): void {
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
}
