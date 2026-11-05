import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, type ReadingSummary } from '../api/client'
import InkSeal from '../features/motion/InkSeal'
import ThemeToggle from '../features/settings/ThemeToggle'
import { useSession } from '../state/session'
import { useGoUp } from '../features/app/useGoUp'

/**
 * 阅读时长（R7-5）。
 *
 * 时长只在"页面可见且窗口聚焦"时累计（见 features/sync/useReadingTime.ts），
 * 所以这里的数字是真实阅读时间，不含挂着标签页走开的那部分。
 */

/** 毫秒 →「3 小时 12 分钟」这种中文说法 */
function humanDuration(ms: number): string {
  if (ms <= 0) return '还没有记录'
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 1) return '不足 1 分钟'
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m} 分钟`
  if (m === 0) return `${h} 小时`
  return `${h} 小时 ${m} 分钟`
}

export default function StatsView() {
  const navigate = useNavigate()
  const goUp = useGoUp()
  const { user, ready } = useSession()

  const [data, setData] = useState<ReadingSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (ready && !user) navigate('/login', { replace: true })
  }, [ready, user, navigate])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await api.getReadingSummary())
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载阅读时长失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (user) void load()
  }, [load, user])

  if (!ready || !user) {
    return (
      <div className="shelf-page">
        <div className="shelf-empty">正在恢复登录状态…</div>
      </div>
    )
  }

  const maxMs = data?.books.reduce((n, b) => Math.max(n, b.totalMs), 0) ?? 0

  return (
    <div className="shelf-page">
      <header className="shelf-topbar">
        <button className="btn btn-ghost" onClick={goUp}>
          返回书架
        </button>
        <div className="shelf-brand">阅读时长</div>
        <InkSeal className="stat-seal" text="漫卷" delay={200} />
        <div className="topbar-end">
          <ThemeToggle />
        </div>
      </header>

      <main className="shelf-main stats-main">
        {loading && <div className="shelf-empty">正在统计…</div>}

        {!loading && error && (
          <div className="shelf-empty">
            <p className="error-text">{error}</p>
            <button className="btn btn-primary" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}

        {!loading && !error && data && (
          <>
            <div className="stat-cards">
              <div className="stat-card">
                <div className="stat-value">{humanDuration(data.totalMs)}</div>
                <div className="stat-label">累计阅读</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{humanDuration(data.todayMs)}</div>
                <div className="stat-label">今天</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{humanDuration(data.weekMs)}</div>
                <div className="stat-label">本周（周一起算）</div>
              </div>
            </div>

            <p className="muted stat-note">
              只统计阅读界面可见、且窗口处于聚焦状态的时间 —— 挂在后台标签页不算，
              切出去做别的事也不算。跨零点的那一段算在开始那天。
            </p>

            {data.books.length === 0 ? (
              <div className="shelf-empty">
                <p>还没有阅读记录</p>
                <p className="muted">去书架打开一本书，读一会儿再回来看看</p>
              </div>
            ) : (
              <div className="stat-books">
                <div className="stat-books-head">按书统计</div>
                {data.books.map((b) => (
                  <div className="stat-book" key={b.docId}>
                    <button
                      className="stat-book-title"
                      title={`打开《${b.title}》`}
                      onClick={() => navigate(`/read/${b.docId}`)}
                    >
                      {b.title}
                    </button>
                    <div className="stat-book-bar">
                      <div
                        className="stat-book-fill"
                        style={{ width: `${maxMs > 0 ? (b.totalMs / maxMs) * 100 : 0}%` }}
                      />
                    </div>
                    <div className="stat-book-time">{humanDuration(b.totalMs)}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
