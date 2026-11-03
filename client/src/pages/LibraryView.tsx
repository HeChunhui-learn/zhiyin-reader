import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api, type BookmarkDto } from '../api/client'
import { parseFile } from '../features/parse'
import { cachePut } from '../features/render/imageCache'
import UserAvatar from '../features/profile/UserAvatar'
import LineIcon, { type LineIconName } from '../features/brand/LineIcon'
import { usePointerGlow } from '../features/motion/usePointerGlow'
import ThemeToggle from '../features/settings/ThemeToggle'
import { useSession } from '../state/session'
import { pendingSyncCount, syncAllPending } from '../features/sync/oneClickSync'

type NavKey = 'all' | 'recent' | 'favorite' | 'bookmarks' | 'offline'

const NAV: { key: NavKey; label: string; category: string; icon: LineIconName }[] = [
  { key: 'all', label: '全部书籍', category: 'all', icon: 'shelf' },
  { key: 'recent', label: '最近阅读', category: 'recent', icon: 'clock' },
  { key: 'favorite', label: '我的收藏', category: 'favorite', icon: 'star' },
  { key: 'bookmarks', label: '我的书签', category: 'bookmarked', icon: 'bookmark' },
  { key: 'offline', label: '离线文档', category: 'offline', icon: 'cloud' },
]

type ImportStage =
  | { kind: 'idle' }
  | { kind: 'parsing'; fileName: string }
  | { kind: 'uploading'; fileName: string }
  | { kind: 'done'; fileName: string; summary: string; docId: string }
  | { kind: 'error'; fileName: string; message: string; duplicateDocId?: string }

/**
 * 书封底色按 docId 稳定取一套（0–5）。
 *
 * 颜色本身写在 app.css 的 `.book-cover[data-cover="n"]` 里，这里只负责"同一本书
 * 每次刷新都是同一个封面"。用 data 属性而不是内联 background，是为了让渐变色、
 * 纹理和深色主题都能在 CSS 里统一维护。
 */
function coverIndexFor(docId: string, title: string): number {
  // FNV-1a，种子带上书名：
  //   · 原先的 h*31 散不开 —— 实际书库里 8 本书只落到 2 号和 4 号两套颜色；
  //   · 只用 docId 时低位仍偏，改用 32 位值整体缩放，再去掉书名相同的撞色。
  const seed = `${docId}|${title}`
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return Math.floor((h / 0x100000000) * 6)
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
  // 书封上那圈跟着光标走的墨晕。只写 CSS 变量、不改 transform，
  // 免得鼠标一挪卡片就位移，点起来发飘
  const glow = usePointerGlow()
  const [nav, setNav] = useState<NavKey>('all')
  /** 手机横向分类条：切分类时把当前项滚到中间，别让"我的书签"半截藏在屏幕外 */
  const activeSideRef = useRef<HTMLButtonElement | null>(null)
  const [keyword, setKeyword] = useState('')
  const [books, setBooks] = useState<Awaited<ReturnType<typeof api.listDocuments>>['items']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stage, setStage] = useState<ImportStage>({ kind: 'idle' })
  // 有文件被拖到窗口上时，整页变成一张等待落纸的宣纸
  const [dragging, setDragging] = useState(false)
  /** 正在等读者确认删除的文档；同一时刻只允许一张卡片进入确认态 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** 正在删的那个文档（按钮转"正在删除…"，防重复提交） */
  const [deleting, setDeleting] = useState<string | null>(null)
  /** 删除结果提示。删除是破坏性操作，无论成败都要给回执 */
  const [notice, setNotice] = useState<{ kind: 'done' | 'failed'; text: string } | null>(null)

  const [overview, setOverview] = useState<
    Awaited<ReturnType<typeof api.listBookmarksOverview>>['groups']
  >([])
  const [bmLoading, setBmLoading] = useState(false)
  const [bmPage, setBmPage] = useState(1)
  const [bmTotal, setBmTotal] = useState(0)
  const [bmError, setBmError] = useState('')
  /** 正在切换收藏状态的那本书（防连点） */
  const [busyFav, setBusyFav] = useState<string | null>(null)
  /** 一键同步：进行中 / 完成 / 有冲突 / 失败 */
  const [syncPhase, setSyncPhase] = useState<'idle' | 'syncing' | 'ok' | 'conflict' | 'error'>(
    'idle',
  )
  /** IndexedDB 待同步队列里的条数，用来把「已同步」变成真实的徽标 */
  const [pendingSync, setPendingSync] = useState(0)

  /**
   * 已展开的文档组。**存"展开集"而不是"折叠集"**：
   * 需求是"默认全部折叠"，那正好就是空集本身，不需要任何初始化 effect；
   * 新冒出来的组、翻页翻回来又见到的组，天然也是折叠的。
   * 反过来存折叠集就得在每次 loadOverview 后把新 docId 补进去，容易漏。
   *
   * 翻页时保留：展开是读者的显式动作，翻回来该还是展开的。
   */
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set())
  /** 正在确认删除的那条书签。与书架的 pendingDelete 同一范式：同一时刻只允许一个 */
  const [pendingBmDelete, setPendingBmDelete] = useState<string | null>(null)
  /** 总览页的写操作（改名/删除/批量）进行中，防重复提交 */
  const [bmBusy, setBmBusy] = useState(false)
  /** 行内改名的目标与草稿，写法与 BookmarkPanel 一致 */
  const [renamingId, setRenamingId] = useState('')
  const [renamingText, setRenamingText] = useState('')
  /**
   * 勾选中的书签 id。bookmarkId 全局唯一，所以天然是跨组的。
   *
   * **翻页/换分类时清空**（见下面那个 effect）：选中的书签在新一页上根本看不见，
   * 留着的话"删除所选"会删掉读者视野之外的数据 —— 一个不可恢复的破坏性操作
   * 不该作用在看不见的东西上。
   */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** 底部操作栏是否处于"确认删除"态 */
  const [confirmBatch, setConfirmBatch] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { user, ready, logout } = useSession()

  /* 未登录先去登录页；ready 之前不要跳，否则刷新页面会被踢出去 */
  useEffect(() => {
    if (ready && !user) navigate('/login', { replace: true })
  }, [ready, user, navigate])

  /* 回到书架时读一次待同步条数：阅读中失败的进度/书签会在这里显示成「待同步 N 条」 */
  useEffect(() => {
    if (!user) return
    let alive = true
    void pendingSyncCount()
      .then((n) => {
        if (alive) setPendingSync(n)
      })
      .catch(() => {
        /* IndexedDB 不可用时不显示待同步数，不影响书架 */
      })
    return () => {
      alive = false
    }
  }, [user])

  /* 手机横向分类条：切分类时把当前项滚到中间 */
  useEffect(() => {
    if (!window.matchMedia('(max-width: 767px)').matches) return
    activeSideRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [nav])

  const category = NAV.find((n) => n.key === nav)?.category ?? 'all'

  const load = useCallback(async () => {
    if (!user || nav === 'bookmarks') return
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
      // 当前页被删空了（这一页那几本的书签全被删光，组就整批消失）。
      // 不兜的话读者停在空白页上，而分页器的"下一页"此时是 disabled 的 —— 进退两难。
      // 一次退一页，靠上面的 effect 重拉，最终必然落到第 1 页。
      if (r.groups.length === 0 && bmPage > 1) {
        setBmPage(bmPage - 1)
        return
      }
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

  const syncBadgeClass =
    syncPhase === 'syncing'
      ? 'sync-busy'
      : syncPhase === 'conflict' || syncPhase === 'error'
        ? 'sync-conflict'
        : pendingSync > 0
          ? 'sync-idle'
          : 'sync-ok'

  const syncBadgeText =
    syncPhase === 'syncing'
      ? '同步中…'
      : syncPhase === 'conflict'
        ? '有冲突待处理'
        : syncPhase === 'error'
          ? '同步失败'
          : pendingSync > 0
            ? `待同步 ${pendingSync} 条`
            : '已同步'

  /**
   * 一键同步：补报离线队列 → 读回未决冲突 → 刷新当前书架。
   *
   * 不做全量拉取 —— 书架用 listDocuments、书签总览用 listBookmarksOverview，
   * 两者本来就直接读服务端，同步完重新加载即可。
   */
  async function onSyncAll() {
    if (syncPhase === 'syncing') return
    setSyncPhase('syncing')
    try {
      const result = await syncAllPending()
      setPendingSync(0)
      if (result.conflicts > 0) {
        setSyncPhase('conflict')
        setNotice({ kind: 'done', text: `同步完成，有 ${result.conflicts} 条冲突待处理` })
      } else {
        setSyncPhase('ok')
        setNotice({
          kind: 'done',
          text: result.flushed > 0 ? `同步完成，补报 ${result.flushed} 条变更` : '已是最新状态',
        })
      }
      await load()
      if (nav === 'bookmarks') await loadOverview()
    } catch (e) {
      setSyncPhase('error')
      setNotice({
        kind: 'failed',
        text: e instanceof ApiError ? e.message : '同步失败，请稍后重试。',
      })
      try {
        setPendingSync(await pendingSyncCount())
      } catch {
        /* 读不到队列就保留旧数字 */
      }
    }
  }

  // 翻页 / 换分类时把待决的编辑态一律收干净：选中的书签在新一页上看不见，
  // 留着会让"删除所选"作用到视野之外（见 selected 的注释）；
  // 改名框与删除确认层同理，留着会指到一条已经不在列表里的记录上。
  useEffect(() => {
    setSelected(new Set())
    setConfirmBatch(false)
    setPendingBmDelete(null)
    setRenamingId('')
  }, [bmPage, nav])

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

  /* ------------------------------------------------ 我的书签：折叠与管理 */

  function toggleGroup(docId: string) {
    setExpandedDocs((prev) => {
      const next = new Set(prev)
      if (next.has(docId)) next.delete(docId)
      else next.add(docId)
      return next
    })
  }

  function selectOne(bookmarkId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(bookmarkId)) next.delete(bookmarkId)
      else next.add(bookmarkId)
      return next
    })
  }

  /** 组头那个勾选框：整组已全选就全不选，否则补齐。全选的粒度是**组**，不是全局 ——
      跨页选中已被否掉，而"选全部"得先知道有哪些，不值当 */
  function selectGroup(items: BookmarkDto[]) {
    setSelected((prev) => {
      const next = new Set(prev)
      const ids = items.map((b) => b.bookmarkId)
      const all = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (all) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  /**
   * 批量删除勾选的书签。
   *
   * 走既有的单条 DELETE（§7.3）**逐条发，不新增批量端点**：
   *  · 软删除本来就是"逐条 + 带各自 baseVersion 的条件更新"，没有跨行原子性可言 ——
   *    这跟 §7.7 的拖动排序不同，那里的 sort_order 互相耦合才必须整批事务。
   *    批量化并不能省掉逐条条件更新，只是把 N 个往返压成 1 个。
   *  · 逐条发天然给出逐条结果：N 条里坏 1 条（被别的设备改过），其余照样删掉，
   *    回执能如实报数。批量端点反而要额外设计"部分失败"的响应形状，
   *    而 §7.7 的先例是整体回滚、不接受部分成功，两套语义并存更难讲清楚。
   *  · 零服务端改动 = 零契约改动 = 不动 sync-bookmark.test.ts 那 61 例。
   * better-sqlite3 是同步驱动，服务端本来就一条条落库，并发发没有额外代价。
   */
  async function onBatchDelete() {
    const byId = new Map<string, BookmarkDto>()
    for (const g of overview) for (const it of g.items) byId.set(it.bookmarkId, it)
    const targets = [...selected].map((id) => byId.get(id)).filter((b): b is BookmarkDto => !!b)
    if (targets.length === 0) return

    setBmBusy(true)
    setConfirmBatch(false)
    setNotice(null)
    // allSettled 不 reject，所以这里不需要 try/catch
    const results = await Promise.allSettled(
      targets.map((b) => api.deleteBookmark(b.bookmarkId, b.version)),
    )
    const done = results.filter((r) => r.status === 'fulfilled').length
    const failed = results.length - done
    setBmBusy(false)
    setSelected(new Set())
    setNotice(
      failed === 0
        ? { kind: 'done', text: `已删除 ${done} 条书签。` }
        : {
            kind: 'failed',
            text: `已删除 ${done} 条，${failed} 条失败（可能已被其他设备改过），请刷新后重试。`,
          },
    )
    await loadOverview()
  }

  /**
   * 改一条书签的名字（契约 §7.2）。
   *
   * 内联编辑，只有 Enter 提交 —— **不要加"保存"按钮**：点保存会让输入框先 blur，
   * 而 blur 是取消（见下面 input 的 onBlur），结果保存了个寂寞。
   * BookmarkPanel 里也是这个写法。
   */
  async function submitRename(b: BookmarkDto) {
    const name = renamingText.trim()
    setRenamingId('')
    if (!name || name === (b.name ?? '')) return // 没改就别白发一个请求
    setBmBusy(true)
    setNotice(null)
    try {
      await api.patchBookmark(b.bookmarkId, {
        name,
        baseVersion: b.version,
        updatedAt: new Date().toISOString(),
      })
      setNotice({ kind: 'done', text: `已改名为「${shortTitle(name)}」。` })
    } catch (e) {
      setNotice({
        kind: 'failed',
        // 版本冲突是内部术语，别原样甩给读者
        text:
          e instanceof ApiError && e.code === 'SYNC_VERSION_CONFLICT'
            ? '这条书签已被其他设备改过，改名没有生效。'
            : '改名失败，请稍后重试。',
      })
    } finally {
      setBmBusy(false)
      await loadOverview()
    }
  }

  /**
   * 删一条书签（契约 §7.3 的软删除）。
   *
   * 失败**只给 notice、不 setBmError** —— 与书架删书同一口径（见 onDeleteBook）：
   * 为了一条书签把整页换成错误页不值得。
   */
  async function onDeleteBookmark(b: BookmarkDto) {
    setBmBusy(true)
    setNotice(null)
    try {
      await api.deleteBookmark(b.bookmarkId, b.version)
      setNotice({ kind: 'done', text: `已删除书签「${shortTitle(b.name || '（无名）')}」。` })
    } catch (e) {
      setNotice({
        kind: 'failed',
        text:
          e instanceof ApiError && e.code === 'SYNC_VERSION_CONFLICT'
            ? '这条书签已被其他设备改过，删除已取消。'
            : e instanceof ApiError
              ? e.message
              : '删除书签失败，请稍后重试。',
      })
    } finally {
      setPendingBmDelete(null)
      setBmBusy(false)
      await loadOverview()
    }
  }

  async function importFile(file: File) {
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

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await importFile(file)
  }

  /* ---- 拖文件到窗口任意处就能导入（落纸动画由 CSS 负责） ---- */

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dragging) setDragging(true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    // 在子元素之间移动也会触发 dragleave，只有真的离开整页才算
    const next = e.relatedTarget as Node | null
    if (next && e.currentTarget.contains(next)) return
    setDragging(false)
  }

  const onDropFile = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void importFile(file)
  }


  /** 当前这一页的组是不是都展开了 —— 决定总开关按钮显示「全部折叠」还是「全部展开」 */
  const allExpanded =
    overview.length > 0 && overview.every((g) => expandedDocs.has(g.docId))

  if (!ready || !user) {
    return <div className="shelf-page"><div className="shelf-empty">正在恢复登录状态…</div></div>
  }

  return (
    <div
      className="shelf-page"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDropFile}
    >
      {/* 书架背后的墨点阵：很淡，只在翻书时才看得见 */}
      {dragging && (
        <div className="shelf-drop" aria-hidden="true">
          <span className="shelf-drop-ink" />
          <span className="shelf-drop-text">松手放进书架</span>
        </div>
      )}
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
          <ThemeToggle />
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
          <div className="shelf-nav-scroll">
            {NAV.map((n) => (
              <button
                key={n.key}
                ref={nav === n.key ? activeSideRef : undefined}
                className={'side-item' + (nav === n.key ? ' active' : '')}
                onClick={() => setNav(n.key)}
              >
                <LineIcon name={n.icon} size={17} />
                <span>{n.label}</span>
              </button>
            ))}
            {/* 阅读时长是独立页面，不是书架的一个分类，所以不放进 NAV 里 */}
            <button className="side-item side-item-link" onClick={() => navigate('/stats')}>
              <LineIcon name="chart" size={17} />
              <span>阅读时长</span>
            </button>
          </div>
          <div className="sync-box">
            <button
              type="button"
              className="sync-now"
              onClick={() => void onSyncAll()}
              disabled={syncPhase === 'syncing'}
            >
              {syncPhase === 'syncing' ? '同步中…' : '一键同步'}
            </button>
            <div className={`sync-badge ${syncBadgeClass}`}>{syncBadgeText}</div>
          </div>
        </aside>

        <main className="shelf-main">
          {/* 纸上的两团墨晕，慢慢漂；纯装饰，不吃点击 */}
          <div className="shelf-wash" aria-hidden="true">
            <i />
            <i />
          </div>
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
                  {/* 作用域是**当前这一页的组**（分页是按文档分的，没加载的组我们不知道）。
                      页大小 20，实际上够用 */}
                  <div className="marks-overview-bar">
                    <span className="muted">共 {bmTotal} 本书有书签</span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setExpandedDocs(
                          allExpanded ? new Set() : new Set(overview.map((g) => g.docId)),
                        )
                      }
                    >
                      {allExpanded ? '全部折叠' : '全部展开'}
                    </button>
                  </div>

                  {overview.map((g) => {
                    const expanded = expandedDocs.has(g.docId)
                    return (
                      <section className="marks-group" key={g.docId}>
                        <header className="marks-group-head">
                          {/* 全选的粒度是"这一组"。放在现成的组头里 —— 组是页面上
                              最自然的视觉单元，读者不用去别处找 */}
                          <input
                            type="checkbox"
                            className="marks-check"
                            checked={
                              g.items.length > 0 &&
                              g.items.every((b) => selected.has(b.bookmarkId))
                            }
                            aria-label={`选中《${g.docTitle}》的全部 ${g.bookmarkCount} 条书签`}
                            onChange={() => selectGroup(g.items)}
                          />
                          {/* 组头不整体做按钮：里面还有别的按钮，按钮套按钮是非法 HTML。
                              可点的是中间那块 .marks-group-toggle */}
                          <button
                            className="marks-group-toggle"
                            aria-expanded={expanded}
                            onClick={() => toggleGroup(g.docId)}
                          >
                            <span className="marks-caret" aria-hidden="true">
                              {expanded ? '▾' : '▸'}
                            </span>
                            <span className="marks-group-title">{g.docTitle}</span>
                            <span className="muted">{g.bookmarkCount} 条</span>
                          </button>
                        </header>

                        {expanded &&
                          g.items.map((b: BookmarkDto) => (
                            <div className="marks-row" key={b.bookmarkId}>
                              <input
                                type="checkbox"
                                className="marks-check"
                                checked={selected.has(b.bookmarkId)}
                                aria-label={`选择书签「${b.name || '（无名）'}」`}
                                onChange={() => selectOne(b.bookmarkId)}
                              />
                              {renamingId === b.bookmarkId ? (
                                <input
                                  className="input mark-rename marks-row-rename"
                                  autoFocus
                                  value={renamingText}
                                  onChange={(e) => setRenamingText(e.target.value)}
                                  onBlur={() => setRenamingId('')}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void submitRename(b)
                                    if (e.key === 'Escape') setRenamingId('')
                                  }}
                                />
                              ) : (
                                <button
                                  className="marks-row-main"
                                  onClick={() =>
                                    navigate(`/read/${b.docId}?para=${b.anchor.paragraphIndex}`)
                                  }
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
                              )}

                              <div className="marks-row-acts">
                                <button
                                  className="mark-act"
                                  title="重命名"
                                  aria-label={`重命名书签「${b.name || '（无名）'}」`}
                                  disabled={bmBusy}
                                  onClick={() => {
                                    setRenamingId(b.bookmarkId)
                                    setRenamingText(b.name ?? '')
                                  }}
                                >
                                  ✎
                                </button>
                                <button
                                  className="mark-act"
                                  title="删除"
                                  aria-label={`删除书签「${b.name || '（无名）'}」`}
                                  disabled={bmBusy}
                                  onClick={() => {
                                    setNotice(null)
                                    setPendingBmDelete(b.bookmarkId)
                                  }}
                                >
                                  ✕
                                </button>
                              </div>

                              {/* 就地确认，仿书架的 .book-del-confirm（覆盖式），不另开模态 */}
                              {pendingBmDelete === b.bookmarkId && (
                                <div className="marks-row-confirm">
                                  <span className="muted">删除这条书签？</span>
                                  <button
                                    className="btn btn-sm book-del-danger"
                                    disabled={bmBusy}
                                    onClick={() => void onDeleteBookmark(b)}
                                  >
                                    {bmBusy ? '正在删除…' : '确认删除'}
                                  </button>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    disabled={bmBusy}
                                    onClick={() => setPendingBmDelete(null)}
                                  >
                                    取消
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                      </section>
                    )
                  })}

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

                  {/* 选中集非空才出现的底部操作栏。sticky 到底：滚动容器就是 .shelf-main
                      （flex:1 + overflow-y:auto），所以 sticky 直接生效，不用 fixed
                      + 手算左偏移，也不用跟侧栏的宽度较劲。
                      二次确认就地做在栏里，不再套一层 modal —— 对一个已经悬浮在屏幕
                      底部的操作栏来说那层模态是多余的，而 .book-del-confirm 已经是
                      项目里"就地确认"的语言 */}
                  {selected.size > 0 && (
                    <div className="marks-selbar">
                      {confirmBatch ? (
                        <>
                          <span>确认删除选中的 {selected.size} 条书签？不可恢复。</span>
                          <button
                            className="btn btn-sm book-del-danger"
                            disabled={bmBusy}
                            onClick={() => void onBatchDelete()}
                          >
                            {bmBusy ? '正在删除…' : '确认删除'}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={bmBusy}
                            onClick={() => setConfirmBatch(false)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <span>已选 {selected.size} 条</span>
                          <button
                            className="btn btn-sm"
                            disabled={bmBusy}
                            onClick={() => setConfirmBatch(true)}
                          >
                            删除所选
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setSelected(new Set())}
                          >
                            取消选择
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* 加载态：先摆 8 个墨线格子，一根根"画"出来（B3）。
              外层仍然是 .shelf-empty，加载提示也还在，只是多了一层骨架 */}
          {loading && (
            <div className="shelf-empty shelf-loading">
              <div className="sk-grid" aria-hidden="true">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div className="sk-card" key={i} style={{ animationDelay: `${i * 70}ms` }}>
                    <span className="sk-cover" />
                    <span className="sk-line" />
                    <span className="sk-line sk-line-sm" />
                  </div>
                ))}
              </div>
              <p className="sk-note">正在加载书架…</p>
            </div>
          )}

          {!loading && error && (
            <div className="shelf-empty">
              <p className="error-text">{error}</p>
              <button className="btn btn-primary" onClick={() => void load()}>重试</button>
            </div>
          )}

          {nav !== 'bookmarks' && !loading && !error && books.length === 0 && (
            <div className="shelf-empty">
              <p>
                {/* 没有 bookmarks 分支：上面那层已经把它排除了，
                    书签总览自带空状态（见上面的 marks-overview） */}
                {keyword
                  ? '没有匹配的文档'
                  : nav === 'favorite'
                    ? '还没有收藏任何书'
                    : nav === 'offline'
                      ? '这里恒为空'
                      : '书架还是空的'}
              </p>
              <p className="muted">
                {nav === 'favorite'
                  ? '把鼠标移到书封面上，点亮左上角的 ☆ 就收藏了'
                  : nav === 'offline'
                    ? '"有本地副本"是纯客户端状态，服务端不可知'
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

          {nav !== 'bookmarks' && !loading && !error && books.length > 0 && (
            <div className="book-grid">
              {books.map((b, i) => (
                <article
                  key={b.docId}
                  className="book-card"
                  // 序号给 CSS：书是一本一本落架的，不是整页一起冒出来
                  style={{ '--i': i } as CSSProperties}
                  {...glow}
                  // 处于确认删除状态时整卡不再充当"打开这本书"的入口，避免误触跳转
                  onClick={() => {
                    if (pendingDelete !== b.docId) navigate(`/read/${b.docId}`)
                  }}
                >
                  <div className="book-cover" data-cover={coverIndexFor(b.docId, b.title)}>
                    {/* 首字做淡墨底纹；aria-hidden 免得读屏把书名念两遍 */}
                    <b className="book-cover-mark" aria-hidden="true">
                      {b.title.trim().charAt(0) || '书'}
                    </b>
                    {/* 悬停时从左上扫到右下的一道纸光 */}
                    <i className="book-cover-sheen" aria-hidden="true" />
                    {/* 悬停时书封右上角微微翘起，露出底下的纸背（B2） */}
                    <i className="book-cover-peel" aria-hidden="true" />
                    {/* 灯下反光：跟着光标走的一团柔光，书封像有涂层 */}
                    <i className="book-cover-lamp" aria-hidden="true" />
                    {/* 书脊：左边一道窄窄的暗边，抽出时才显出来 */}
                    <i className="book-spine" aria-hidden="true" />
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
