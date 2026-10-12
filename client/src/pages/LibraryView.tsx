import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api/client'
import { parseFile } from '../features/parse'
import { cachePut } from '../features/render/imageCache'
import UserAvatar from '../features/profile/UserAvatar'
import { useSession } from '../state/session'

type NavKey = 'all' | 'recent' | 'favorite' | 'bookmarks' | 'offline'

const NAV: { key: NavKey; label: string; category: string }[] = [
  { key: 'all', label: '全部书籍', category: 'all' },
  { key: 'recent', label: '最近阅读', category: 'recent' },
  { key: 'favorite', label: '我的收藏', category: 'favorite' },
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

/**
 * 书名钳短，只用在回执这类提示语里。
 *
 * 书名是数据，可能长得离谱 —— 解析坏掉的 TXT（整章被误判成标题）书名能有两千多字，
 * 直接塞进提示语会刷屏。卡片和确认层各有自己的钳法（CSS 省略号 / 截断），这里只管提示语。
 */
function shortTitle(title: string, max = 20): string {
  return title.length > max ? `${title.slice(0, max)}…` : title
}

export default function LibraryView() {
  const [nav, setNav] = useState<NavKey>('all')
  const [keyword, setKeyword] = useState('')
  const [books, setBooks] = useState<Awaited<ReturnType<typeof api.listDocuments>>['items']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stage, setStage] = useState<ImportStage>({ kind: 'idle' })
  /** 正在等读者确认删除的文档；同一时刻只允许一张卡片进入确认态 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** 正在删的那个文档（按钮转"正在删除…"，防重复提交） */
  const [deleting, setDeleting] = useState<string | null>(null)
  /** 删除结果提示。删除是破坏性操作，无论成败都要给回执 */
  const [notice, setNotice] = useState<{ kind: 'done' | 'failed'; text: string } | null>(null)
  /** 正在切换收藏状态的那本书（防连点） */
  const [busyFav, setBusyFav] = useState<string | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { user, ready, logout } = useSession()

  /* 未登录先去登录页；ready 之前不要跳，否则刷新页面会被踢出去 */
  useEffect(() => {
    if (ready && !user) navigate('/login', { replace: true })
  }, [ready, user, navigate])

  const category = NAV.find((n) => n.key === nav)?.category ?? 'all'

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError('')
    setPendingDelete(null)
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
  }, [user, keyword, category])

  useEffect(() => {
    const t = window.setTimeout(() => void load(), keyword ? 300 : 0)
    return () => window.clearTimeout(t)
  }, [load, keyword])

  /* 删除回执自动消失（与阅读界面的 toast 一个口径） */
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 3200)
    return () => window.clearTimeout(t)
  }, [notice])

  /**
   * 删除一本书。
   *
   * 契约 §4.6 的 DELETE 接口按外键级联，正文 / 句子 / 书签 / 进度一并删掉；
   * 服务端还会校验属主（不是自己的书返回 403）。
   * 删除失败**不**走 setError —— 那会把整页书架替换成错误页，
   * 为了删一本书丢掉整个书架不值得，这里只在顶部给一条回执。
   */
  async function onDeleteBook(docId: string, title: string) {
    const shown = shortTitle(title)
    setDeleting(docId)
    setNotice(null)
    try {
      await api.deleteDocument(docId)
      setPendingDelete(null)
      setNotice({ kind: 'done', text: `已删除《${shown}》，正文、书签与阅读进度一并清除。` })
      await load()
    } catch (e) {
      setPendingDelete(null)
      setNotice({
        kind: 'failed',
        text: e instanceof ApiError ? e.message : `删除《${shown}》失败，请稍后重试。`,
      })
    } finally {
      setDeleting(null)
    }
  }

  /**
   * 切换收藏。
   *
   * 先乐观改本地再发请求 —— 收藏是个高频小动作，等一个来回才亮星星会显得很钝。
   * 失败就改回来并给回执；在「我的收藏」视图里成功取消收藏后要重新拉一次列表，
   * 否则那本已经不属于当前视图的书会赖在界面上。
   */
  async function onToggleFavorite(docId: string, next: boolean) {
    setBusyFav(docId)
    setNotice(null)
    setBooks((prev) => prev.map((b) => (b.docId === docId ? { ...b, isFavorite: next } : b)))
    try {
      if (next) await api.addFavorite(docId)
      else await api.removeFavorite(docId)
      if (nav === 'favorite') await load()
    } catch (e) {
      setBooks((prev) => prev.map((b) => (b.docId === docId ? { ...b, isFavorite: !next } : b)))
      setNotice({
        kind: 'failed',
        text: e instanceof ApiError ? e.message : '收藏操作失败，请稍后重试。',
      })
    } finally {
      setBusyFav(null)
    }
  }

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
          {/* 右上角的圆形头像：点它进个人主页 */}
          <button
            className="shelf-avatar"
            title="个人主页"
            aria-label="个人主页"
            onClick={() => navigate('/profile')}
          >
            <UserAvatar avatarUrl={user.avatarUrl} name={user.nickname || user.account} size={34} />
          </button>
          <span className="shelf-user-name">{user.nickname}</span>
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
          {/* 阅读时长是独立页面，不是书架的一个分类，所以不放进 NAV 里 */}
          <button className="side-item side-item-link" onClick={() => navigate('/stats')}>
            阅读时长
          </button>
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

          {loading && <div className="shelf-empty">正在加载书架…</div>}

          {!loading && error && (
            <div className="shelf-empty">
              <p className="error-text">{error}</p>
              <button className="btn btn-primary" onClick={() => void load()}>重试</button>
            </div>
          )}

          {!loading && !error && books.length === 0 && (
            <div className="shelf-empty">
              <p>
                {keyword
                  ? '没有匹配的文档'
                  : nav === 'favorite'
                    ? '还没有收藏任何书'
                    : nav === 'bookmarks'
                      ? '还没有任何文档带书签'
                      : nav === 'offline'
                        ? '这里恒为空'
                        : '书架还是空的'}
              </p>
              <p className="muted">
                {nav === 'favorite'
                  ? '把鼠标移到书封面上，点亮左上角的 ☆ 就收藏了'
                  : nav === 'bookmarks'
                    ? '在阅读界面点右上角「书签 → 加当前位置」'
                    : nav === 'offline'
                      ? '"有本地副本"是纯客户端状态，服务端不可知（材料审查 O21）'
                      : '点右上角「导入文档」，选一个 EPUB / TXT / Markdown 文件试试'}
              </p>
            </div>
          )}

          {notice && (
            <div
              className={'parse-bar' + (notice.kind === 'done' ? ' done' : ' failed')}
              role="status"
            >
              <span>{notice.text}</span>
              <button className="btn btn-ghost btn-sm parse-open" onClick={() => setNotice(null)}>
                知道了
              </button>
            </div>
          )}

          {!loading && !error && books.length > 0 && (
            <div className="book-grid">
              {books.map((b) => (
                <article
                  key={b.docId}
                  className="book-card"
                  // 处于确认删除状态时整卡不再充当"打开这本书"的入口，避免误触跳转
                  onClick={() => {
                    if (pendingDelete !== b.docId) navigate(`/read/${b.docId}`)
                  }}
                >
                  <div className="book-cover" style={{ background: coverColorFor(b.docId) }}>
                    <span>{b.title}</span>

                    {/* 收藏入口所有分类下都给：它只改"这本收没收藏"，
                        不像删除那样会跟当前视图的语义打架 */}
                    <button
                      className={'book-fav' + (b.isFavorite ? ' on' : '')}
                      title={b.isFavorite ? `取消收藏《${b.title}》` : `收藏《${b.title}》`}
                      aria-label={b.isFavorite ? '取消收藏' : '收藏'}
                      aria-pressed={b.isFavorite}
                      disabled={busyFav === b.docId}
                      onClick={(e) => {
                        e.stopPropagation()
                        void onToggleFavorite(b.docId, !b.isFavorite)
                      }}
                    >
                      {b.isFavorite ? '★' : '☆'}
                    </button>

                    {/* 删除入口只给「全部书籍」：其余分类是"最近阅读""我的书签"这类视图，
                        在那里删书会跟当前视图的语义打架 */}
                    {nav === 'all' && pendingDelete !== b.docId && (
                      <button
                        className="book-del"
                        title={`删除《${b.title}》`}
                        aria-label={`删除《${b.title}》`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setNotice(null)
                          setPendingDelete(b.docId)
                        }}
                      >
                        删除
                      </button>
                    )}

                    {nav === 'all' && pendingDelete === b.docId && (
                      <div className="book-del-confirm">
                        <p className="book-del-ask">删除《{b.title}》？</p>
                        <p className="book-del-note">正文、书签与阅读进度一并清除，不可恢复。</p>
                        <div className="book-del-actions">
                          <button
                            className="btn btn-sm book-del-danger"
                            disabled={deleting === b.docId}
                            onClick={(e) => {
                              e.stopPropagation()
                              void onDeleteBook(b.docId, b.title)
                            }}
                          >
                            {deleting === b.docId ? '正在删除…' : '确认删除'}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={deleting === b.docId}
                            onClick={(e) => {
                              e.stopPropagation()
                              setPendingDelete(null)
                            }}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
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
