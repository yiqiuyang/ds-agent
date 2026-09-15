import { useCallback, useEffect, useState } from 'react'
import type { BundleProfile } from '../../../shared/bundles'

/** Bundle 管理：列表来自当前 profile 的 dsh.profile.bundles，开关编辑该数组（重启引擎生效） */
export function BundlesPage() {
  const [data, setData] = useState<BundleProfile | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  const reload = useCallback(() => {
    void window.dsh.getBundleProfile().then(setData)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const flip = (id: string, current: boolean) => {
    setBusyId(id)
    setError(null)
    void window.dsh
      .setBundleEnabled(id, !current)
      .then(setData)
      .catch((err) => setError(String(err?.message ?? err)))
      .finally(() => setBusyId(null))
  }

  const restart = () => {
    setRestarting(true)
    void window.dsh
      .restartEngine()
      .catch(() => undefined)
      .finally(() => setRestarting(false))
  }

  if (!data) {
    return (
      <main className="bundles-page">
        <p className="dim">加载中…</p>
      </main>
    )
  }

  return (
    <main className="bundles-page">
      <header className="bundles-header">
        <div>
          <h3>Bundle 管理</h3>
          <p className="dim">
            profile <code>{data.profileName}</code>：{data.path}
          </p>
        </div>
        <div className="bundles-actions">
          <button className="ghost-button" onClick={reload}>
            刷新
          </button>
          {data.found && !data.error && (
            <button className="ghost-button" onClick={restart} disabled={restarting}>
              {restarting ? '重启中…' : '重启引擎'}
            </button>
          )}
        </div>
      </header>

      {error && <p className="bundle-error">{error}</p>}

      {!data.found ? (
        <div className="empty-hint">
          <p className="title">未找到 profile 目录</p>
          <p className="dim">dsh 会在首次以该 profile 启动时自动初始化</p>
          <p className="dim">
            当前查找路径：<code>{data.path}</code>
          </p>
          <p className="dim">启动一次 dsh 引擎（或切换到 mock 再切回）后刷新</p>
        </div>
      ) : data.error ? (
        <div className="empty-hint">
          <p className="title">profile package.json 解析失败</p>
          <p className="dim">{data.error}</p>
        </div>
      ) : (
        <>
          <p className="dim bundle-hint">
            开关写入 profile 的 dsh.profile.bundles 数组（层叠顺序 = 列表顺序），重启引擎后生效；禁用核心
            bundle（如 dsh-acp-app）会导致引擎无法通过 ACP 通信
          </p>
          {data.bundles.length === 0 && <p className="dim">未发现任何 bundle（数组为空或无已安装 bundle）</p>}
          <ul className="bundle-list">
            {data.bundles.map((b) => (
              <li key={b.id} className="bundle-row">
                <div className="bundle-info">
                  <span className="bundle-name">{b.name}</span>
                  {b.description && <span className="bundle-desc">{b.description}</span>}
                  {b.name !== b.id && <span className="bundle-id">{b.id}</span>}
                </div>
                <label className={`toggle ${busyId === b.id ? 'busy' : ''}`}>
                  <input
                    type="checkbox"
                    checked={b.enabled}
                    disabled={busyId === b.id}
                    onChange={() => flip(b.id, b.enabled)}
                  />
                  <span className="toggle-track">
                    <span className="toggle-thumb" />
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <section className="profile-preview">
            <h4>profile package.json 预览</h4>
            <pre>{JSON.stringify(data.profile, null, 2)}</pre>
          </section>
        </>
      )}
    </main>
  )
}
