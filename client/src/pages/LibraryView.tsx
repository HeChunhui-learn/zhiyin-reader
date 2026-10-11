import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, type BookmarkDto } from '../api/client'
import { parseFile } from '../features/parse'
import { cachePut } from '../features/render/imageCache'
import { useSession } from '../state/session'

type NavKey = 'all' | 'recent' | 'bookmarks' | 'offline'

const NAV: { key: NavKey; label: string; category: string }[] = [
  { key: 'all', label: '全部书籍', category: 'all' },
  { key: 'recent', label: '最近阅读', category: 'recent' },
  { key: 'bookmarks', label: '我的书签', category: 'bookmarked' },
  { key: 'offline', label: '离线文档', category: 'offline' },
]

type ImportStage =
  | { kind: 'idle' }
  | { kind: 'parsing'; fileName: string }
  | { kind: 'uploading'; fileName: string }
  | { kind: 'done'; fileName: string; summary: string; docId: string }
  | { kind: 'error'; fileName: string; message: string; duplicateDocId?: string }

const COVER_COLORS = ['#3B6EA5', '#8A6F4E', '#5B7C5A', '#7C5CBF', '#3E8E6E', '#A2555B']

function coverColorFor(docId: string): string {
  let h = 0
  for (let i = 0; i < docId.length; i++) h = (h * 31 + docId.charCodeAt(i)) >>> 0
  return COVER_COLORS[h % COVER_COLORS.length]
}

export default function LibraryView() {
  const [nav, setNav] = useState<NavKey>('all')
  const [keyword, setKeyword] = useState('')
  const [books, setBooks] = useState<Awaited<ReturnType<typeof api.listDocuments>>['items']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stage, setStage] = useState<ImportStage>({ kind: 'idle' })

  const [overview, setOverview] = useState<
    Awaited<ReturnType<typeof api.listBookmarksOverview>>['groups']
  >([])
  const [bmLoading, setBmLoading] = useState(false)
  const [bmPage, setBmPage] = useState(1)
  const [bmTotal, setBmTotal] = useState(0)
  const [bmError, setBmError] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { user, ready, logout } = useSession()

  /* 未登录先去登录页；ready 之前不要跳，否则刷新页面会被踢出去 */
  useEffect(() => {
    if (ready && !user) navigate('/login', { replace: true })
  }, [ready, user, navigate])

  const category = NAV.find((n) => n.key === nav)?.category ?? 'all'

  const load = useCallback(async () => {
    if (!user || nav === 'bookmarks') return
    setLoading(true)
    setError('')
    try {
      const { items } = await api.listDocuments({
        keyword: keyword.trim() || undefined,
        category,
      })
      setBooks(items)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载书架失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [user, keyword, category, nav])

  useEffect(() => {
    const t = window.setTimeout(() => void load(), keyword ? 300 : 0)
    return () => window.clearTimeout(t)
  }, [load, keyword])

  /* B2：书签分类走跨文档总览接口，不再走文档列表 */
  const loadOverview = useCallback(async () => {
    if (!user || nav !== 'bookmarks') return
    setBmLoading(true)
    setBmError('')
    try {
      const r = await api.listBookmarksOverview({ page: bmPage, pageSize: 20 })
      setOverview(r.groups)
      setBmTotal(r.total)
    } catch (e) {
      setBmError(e instanceof ApiError ? e.message : '加载书签失败，请稍后重试。')
    } finally {
      setBmLoading(false)
    }
  }, [user, nav, bmPage])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setStage({ kind: 'parsing', fileName: file.name })
    try {
      const { payload, summary, imageBlobs } = await parseFile(file)
      setStage({ kind: 'uploading', fileName: file.name })

      const r = await api.importDocument(payload)

      // 契约 §4.2：把原始文件也传上去，换设备后不必重新选本地文件。
      // 失败不影响导入本身 —— 文档标记为"仅本地可见"（resource_url 为空），
      // 下次导入同名文件时会命中去重，不会重复建条目。
      void api.putOriginalFile(r.docId, file).catch(() => {
        /* 上传失败就维持"仅本地可见" */
      })

      // EPUB 抽出来的图片先落到本地缓存（IndexedDB）。
      // 二进制本体不上传——按契约 §4.3 由阅读时首次进入视口再懒上传。
      if (imageBlobs?.size) {
        for (const [imageId, blob] of imageBlobs) {
          await cachePut(r.docId, imageId, blob)
        }
      }

      setStage({ kind: 'done', fileName: file.name, summary, docId: r.docId })
      await load()
      window.setTimeout(
        () => setStage((s) => (s.kind === 'done' ? { kind: 'idle' } : s)),
        4000,
      )
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT_DOCUMENT_DUPLICATE') {
        setStage({
          kind: 'error',
          fileName: file.name,
          message: '这本书已经在书架里了。',
          duplicateDocId: String(err.details?.docId ?? ''),
        })
      } else {
        setStage({
          kind: 'error',
          fileName: file.name,
          message: err instanceof Error ? err.message : '导入失败，请重试。',
        })
      }
    }
  }

  if (!ready || !user) {
    return <div className="shelf-page"><div className="shelf-empty">正在恢复登录状态…</div></div>
  }

  return (
    <div className="shelf-page">
      <header className="shelf-topbar">
        <div className="shelf-brand">知音漫卷</div>
        <input
          className="input shelf-search"
          placeholder="书名／作者／正文全文检索"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
          导入文档
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".epub,.txt,.md,.markdown"
          hidden
          onChange={onPickFile}
        />
        <div className="shelf-user">
          <span>{user.nickname}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await logout()
              navigate('/login', { replace: true })
            }}
          >
            退出
          </button>
        </div>
      </header>

      <div className="shelf-body">
        <aside className="shelf-side">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={'side-item' + (nav === n.key ? ' active' : '')}
              onClick={() => setNav(n.key)}
            >
              {n.label}
            </button>
          ))}
          <div className="sync-badge sync-ok">已同步</div>
        </aside>

        <main className="shelf-main">
          {stage.kind !== 'idle' && (
            <div className={'parse-bar' + (stage.kind === 'done' ? ' done' : stage.kind === 'error' ? ' failed' : '')}>
              {stage.kind === 'parsing' && <span>正在解析「{stage.fileName}」…</span>}
              {stage.kind === 'uploading' && <span>正在上传「{stage.fileName}」…</span>}
              {stage.kind === 'done' && (
                <span>
                  导入完成：{stage.fileName}（{stage.summary}）
                  <button
                    className="btn btn-ghost btn-sm parse-open"
                    onClick={() => navigate(`/read/${stage.docId}`)}
                  >
                    立即阅读
                  </button>
                </span>
              )}
              {stage.kind === 'error' && (
                <span>
                  {stage.message}
                  {stage.duplicateDocId && (
                    <button
                      className="btn btn-ghost btn-sm parse-open"
                      onClick={() => navigate(`/read/${stage.duplicateDocId}`)}
                    >
                      打开它
                    </button>
                  )}
                </span>
              )}
            </div>
          )}

          {nav === 'bookmarks' && (
            <div className="marks-overview">
              {bmLoading && <div className="shelf-empty">正在加载书签…</div>}

              {!bmLoading && bmError && (
                <div className="shelf-empty">
                  <p className="error-text">{bmError}</p>
                  <button className="btn btn-primary" onClick={() => void loadOverview()}>
                    重试
                  </button>
                </div>
              )}

              {!bmLoading && !bmError && overview.length === 0 && (
                <div className="shelf-empty">
                  <p>还没有任何书签</p>
                  <p className="muted">在阅读界面点右上角「书签 → 加当前位置」</p>
                </div>
              )}

              {!bmLoading && !bmError && overview.length > 0 && (
                <>
                  {overview.map((g) => (
                    <section className="marks-group" key={g.docId}>
                      <header className="marks-group-head">
                        <span className="marks-group-title">{g.docTitle}</span>
                        <span className="muted">{g.bookmarkCount} 条</span>
                      </header>
                      {g.items.map((b: BookmarkDto) => (
                        <button
                          className="marks-row"
                          key={b.bookmarkId}
                          onClick={() => navigate(`/read/${b.docId}?para=${b.anchor.paragraphIndex}`)}
                        >
                          <span className="marks-row-name">{b.name || '（无名）'}</span>
                          {/* B4 之前的旧数据没有 chapterTitle，降级成"文档名 + 段落序号" */}
                          <span className="marks-row-chapter">
                            {b.chapterTitle
                              ? `${b.chapterTitle} · 第 ${b.anchor.paragraphIndex + 1} 段`
                              : `${g.docTitle} · 第 ${b.anchor.paragraphIndex + 1} 段`}
                          </span>
                          <span className="marks-row-time">
                            {new Date(b.createdAt).toLocaleString('zh-CN')}
                          </span>
                        </button>
                      ))}
                    </section>
                  ))}

                  {bmTotal > 20 && (
                    <div className="marks-pager">
                      <span className="muted">
                        第 {bmPage} / {Math.ceil(bmTotal / 20)} 页 · 共 {bmTotal} 本
                      </span>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={bmPage <= 1}
                        onClick={() => setBmPage((p) => p - 1)}
                      >
                        上一页
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={bmPage >= Math.ceil(bmTotal / 20)}
                        onClick={() => setBmPage((p) => p + 1)}
                      >
                        下一页
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {loading && <div className="shelf-empty">正在加载书架…</div>}

          {!loading && error && (
            <div className="shelf-empty">
              <p className="error-text">{error}</p>
              <button className="btn btn-primary" onClick={() => void load()}>重试</button>
            </div>
          )}

          {nav !== 'bookmarks' && !loading && !error && books.length === 0 && (
            <div className="shelf-empty">
              <p>
                {keyword
                  ? '没有匹配的文档'
                  : nav === 'offline'
                    ? '这里恒为空'
                    : '书架还是空的'}
              </p>
              <p className="muted">
                {nav === 'offline'
                  ? '"有本地副本"是纯客户端状态，服务端不可知（材料审查 O21）'
                  : '点右上角「导入文档」，选一个 EPUB / TXT / Markdown 文件试试'}
              </p>
            </div>
          )}

          {nav !== 'bookmarks' && !loading && !error && books.length > 0 && (
            <div className="book-grid">
              {books.map((b) => (
                <article
                  key={b.docId}
                  className="book-card"
                  onClick={() => navigate(`/read/${b.docId}`)}
                >
                  <div className="book-cover" style={{ background: coverColorFor(b.docId) }}>
                    <span>{b.title}</span>
                  </div>
                  <div className="book-meta">
                    <div className="book-title" title={b.title}>{b.title}</div>
                    <div className="book-author">{b.author}</div>
                    <div className="book-progress">
                      <div
                        className="book-progress-fill"
                        style={{ width: `${Math.round((b.progress?.percent ?? 0) * 100)}%` }}
                      />
                    </div>
                    <div className="book-foot">
                      <span className="tag">{b.fileFormat}</span>
                      <span className="muted">
                        {b.progress ? `已读 ${Math.round(b.progress.percent * 100)}%` : `${b.paragraphCount} 段`}
                      </span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
