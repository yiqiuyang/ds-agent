import { app, BaseWindow, WebContentsView, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * 承载 DSH Web UI 的窗口：BaseWindow + WebContentsView（BrowserView 已弃用）。
 * 上下文隔离 + 禁 nodeIntegration + sandbox，仅作浏览器容器加载 DSH Web UI。
 */
export function createWebWindow() {
  const win = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'ds-agent'
  })
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.contentView.addChildView(view)

  // DSH Web UI 在 Electron 里默认无右键菜单；补上复制/粘贴/全选，否则画布会话坞里选中文字也无法右键复制。
  view.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: '剪切', enabled: hasSelection },
        { role: 'copy', label: '复制', enabled: hasSelection },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      )
    } else {
      items.push({ role: 'copy', label: '复制', enabled: hasSelection })
    }
    if (!app.isPackaged) {
      items.push({ type: 'separator' }, { role: 'toggleDevTools', label: '检查元素' })
    }
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win })
  })
  // 铺满内容区并随窗口缩放（setAutoResize 是已弃用的 BrowserView API，WebContentsView 需手动）
  const fit = (): void => {
    const { width, height } = win.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  fit()
  win.on('resize', fit)
  return { win, view }
}
