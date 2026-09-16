import { BaseWindow, WebContentsView } from 'electron'

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
  // 铺满内容区并随窗口缩放（setAutoResize 是已弃用的 BrowserView API，WebContentsView 需手动）
  const fit = (): void => {
    const { width, height } = win.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  fit()
  win.on('resize', fit)
  return { win, view }
}
