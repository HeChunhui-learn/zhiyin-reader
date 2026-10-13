import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ApiError, api, type ContentImageRef, type DocumentDetail } from '../api/client'
import type { Paragraph } from '../models/types'
import { splitSentences, type Sentence } from '../features/readalong/splitSentences'
import { useReadAlong } from '../features/readalong/useReadAlong'
import { useProgress } from '../features/sync/useProgress'
import { useBookmarks } from '../features/sync/useBookmarks'
import { useReadingTime } from '../features/sync/useReadingTime'
import { anchorAt, clampToParagraphs } from '../features/sync/anchor'
import {
  buildGeometry,
  computeWindow,
  offsetOf,
  paragraphAt,
  recomputeFrom,
  totalHeight,
} from '../features/render/virtualWindow'
import { tocIndexAt } from '../features/render/toc'

/**
 * 超过这个段落数才启用窗口化渲染。
 * 演示书只有十几段，走原来的"全部渲染"路径，行为与之前完全一致 ——
 * 不该为了长文档的性能把已经跑通的短文档体验换掉。
 */
const VIRTUAL_THRESHOLD = 150
import LazyImage from '../features/render/LazyImage'
import { useSession } from '../state/session'
import { useSettings } from '../features/settings/SettingsProvider'
import {
  BG_IMAGE_ID,
  backgroundUrl,
  clearBackground,
  getBackground,
  putBackground,
  releaseBackgroundUrl,
} from '../features/settings/readerBackground'
import PlaybackBar from './PlaybackBar'
import ConflictDialog from './ConflictDialog'
import BookmarkPanel from './BookmarkPanel'
import ReaderSettingsPanel from './ReaderSettingsPanel'

/**
 * 翻页模式下前后两屏的重叠量（像素）。
 * 完全按一屏翻的话，跨屏的那一行会被切掉一半，读着容易丢行。
 */
const PAGE_OVERLAP = 48

export default function ReaderView() {
  const { docId = '' } = useParams()
  const navigate = useNavigate()
  const { user, ready } = useSession()
  const [searchParams] = useSearchParams()
  const jumpPara = searchParams.get('para')

  const [book, setBook] = useState<DocumentDetail | null>(null)
  const [paragraphs, setParagraphs] = useState<Paragraph[]>([])
  const [imageRefs, setImageRefs] = useState<ContentImageRef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const { prefs, setPrefs } = useSettings()

  const [tocOpen, setTocOpen] = useState(false)
  const [marksOpen, setMarksOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 背景图的 object URL；空串 = 不画背景 */
  const [bgUrl, setBgUrl] = useState('')
  const [bgName, setBgName] = useState('')
  const [bgError, setBgError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [toast, setToast] = useState('')

  /**
   * 朗读控制条是否收起。
   *
   * 收起是读者的显式动作，所以**不做**"播放中自动展开" —— 播出声音来就自己
   * 弹回去，等于把收起变成一个会自己撤销的开关。跟读在不在跑由胶囊自己报
   * （"跟读中 · 第 N / M 句"），信息不丢。
   *
   * 默认 false（可见）：第一次进阅读页该看见的东西不该藏起来。
   * 不持久化 —— 换个文档、刷新一次就回到可见，这是想要的行为。
   */
  const [barHidden, setBarHidden] = useState(false)
  const restoreBarRef = useRef<HTMLButtonElement>(null)
  // 收起按钮一点下去自己就卸载了，键盘读者的焦点会掉到 body 上，
  // 在长文里得按几十次 Tab 才找得回来。把焦点接到胶囊上。
  useEffect(() => {
    if (barHidden) restoreBarRef.current?.focus()
  }, [barHidden])

  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ready && !user) navigate('/login', { replace: true })
  }, [ready, user, navigate])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [doc, content] = await Promise.all([
        api.getDocument(docId),
        api.getContent(docId),
      ])
      setBook(doc)
      setParagraphs(content.paragraphs)
      setImageRefs(content.imageRefs)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载正文失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [docId])

  useEffect(() => {
    if (user) void load()
  }, [load, user])

  /** 句子由前端切分（CLAUDE.md 裁决 1：解析在前端） */
  const sentences = useMemo(() => splitSentences(paragraphs), [paragraphs])
  /** 跟读编排：引擎选择、游标推进、预加载、降级都在这里面 */
  const ra = useReadAlong(docId, sentences)

  /** 阅读进度：打开时恢复到上次位置，滚动时防抖上报（契约 §6） */
  const prog = useProgress(docId, !!user)

  /** 书签：单项接口即时读写，冲突走 409 信封（契约 §7） */
  const bms = useBookmarks(docId, !!user)

  /**
   * A4：进页时若拉到了未决冲突（或本页当场撞上冲突），自动把对话框弹出来一次。
   *
   * ref 保证"每次进页面只自动弹一次"：读者点了「稍后处理」后，conflicts 仍留在
   * state 里（服务端也还留着未决记录，下次进页还会读到），不设这个闸会反复弹。
   * 想看时顶栏的「同步冲突」按钮随时能再打开。
   */
  const conflictPrompted = useRef(false)
  useEffect(() => {
    if (conflictPrompted.current || bms.conflicts.length === 0) return
    conflictPrompted.current = true
    setDialogOpen(true)
  }, [bms.conflicts])

  /** 阅读时长：只累计"可见且聚焦"的时间（R7-5，契约 §6.4） */
  useReadingTime(docId, !!user)

  const byPara = useMemo(() => {
    const m = new Map<number, Sentence[]>()
    for (const s of sentences) {
      const arr = m.get(s.paraIndex)
      if (arr) arr.push(s)
      else m.set(s.paraIndex, [s])
    }
    return m
  }, [sentences])

  /* 打开文档后恢复到上次阅读位置（契约 §6.1 的跨设备续读） */
  /** 长文档才启用窗口化渲染 */
  const virtual = paragraphs.length > VIRTUAL_THRESHOLD
  /*
   * 高度估算跟字号绑定 —— 字号一变整张几何表就作废，必须重建。
   * 只改 DOM 上的 font-size 而让 geom 保持旧值的话，估算和实测对不上，
   * 表现是"跳转落点偏掉几百像素"，而且**不报任何错**。
   */
  const geom = useMemo(() => buildGeometry(paragraphs, prefs.fontSize), [paragraphs, prefs.fontSize])
  const [win, setWin] = useState({ start: 0, end: VIRTUAL_THRESHOLD })

  /**
   * 目录条目 = 全部 h1/h2。要在滚动回调之前算出来（那个回调的依赖数组在这里就求值了）。
   * 必须 useMemo：每次渲染都 filter 出一个新数组的话，滚动回调会每帧重订阅一次。
   */
  const tocItems = useMemo(
    () => paragraphs.filter((p) => p.type === 'h1' || p.type === 'h2'),
    [paragraphs],
  )
  /** 当前章节在 tocItems 里的下标；-1 = 还没读到第一个标题 */
  const [activeToc, setActiveToc] = useState(-1)
  const activeTocRef = useRef(-1)
  const tocPanelRef = useRef<HTMLElement>(null)

  /**
   * 把"当前章节"同步到目录高亮。
   *
   * 关键在于**只在真的跨章时才 setState**：滚动回调是 ref 化的（就是为了躲开
   * 每 16ms 一次的全量重渲染），在那儿无条件 setState 等于把它白写了 ——
   * 500 段的文档会肉眼可见地卡。
   */
  const syncActiveToc = useCallback(
    (paraIndex: number) => {
      let next = tocIndexAt(tocItems, paraIndex)
      // 读到第一个标题**之前**时（正文常有一段卷首语）tocIndexAt 给的是 -1。
      // 这里按第一张处理：目录里宁可亮着第一章，也不要一条都不亮 ——
      // 后者看起来像是功能坏了，而不是"你还没读到正文章节"
      if (next < 0 && tocItems.length > 0) next = 0
      if (next === activeTocRef.current) return
      activeTocRef.current = next
      setActiveToc(next)
    },
    [tocItems],
  )

  // R7-2 的 excerptOf（默认名取正文前 10 个字）与 B4 的 defaultNameFor
  // （章节标题 · 首句片段）是同一件事的两版规则。这里保留 B4 那版：
  // 章节标题同时要写进 T_Bookmark.chapter_title 供 B2 的「按章节排序」用，
  // 两套并存只会让默认名跟列表里的分组对不上。

  /** 跳到某一段。窗口化时不能靠 querySelector —— 目标段落可能还没渲染 */
  const gotoParagraph = useCallback(
    (index: number, smooth = true) => {
      const root = rootRef.current
      if (!root) return
      // 程序化跳转要同步刷新"当前段落"，不能只靠滚动事件的防抖回调 ——
      // 那个 effect 的依赖里含 prog，而 useProgress 每次渲染都返回新对象，
      // 于是每次渲染都会清掉待触发的定时器；跳转后没滚动的话 ref 会停在旧值，
      // 紧接着加的书签就会拿到上一段的锚点、默认名与章节标题。
      currentParaRef.current = index
      // 跳转不走滚动回调（下面是直接操作 scrollTop 的），不在这里补一下的话
      // 目录高亮会停在旧章节，直到读者自己滚一下才更新
      syncActiveToc(index)
      if (!virtual) {
        root
          .querySelector(`[data-para="${index}"]`)
          ?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' })
        return
      }
      root.scrollTo({ top: offsetOf(geom, index), behavior: smooth ? 'smooth' : 'auto' })
      setWin(computeWindow(geom, offsetOf(geom, index), root.clientHeight || 600, index))
    },
    [virtual, geom, syncActiveToc],
  )


  /** 当前可见段落号，加书签时用它 */
  const currentParaRef = useRef(0)
  const resumedRef = useRef(false)

  /** B2：从书架「我的书签」点进来时，定位到锚点段落（只跳一次，不干扰后续滚动） */
  const jumpedRef = useRef(false)
  useEffect(() => {
    if (jumpedRef.current) return
    if (jumpPara === null || paragraphs.length === 0) return
    jumpedRef.current = true
    gotoParagraph(Number(jumpPara), false)
  }, [jumpPara, paragraphs, gotoParagraph])

  useEffect(() => {
    if (resumedRef.current) return
    if (!prog.ready || paragraphs.length === 0) return
    resumedRef.current = true
    // 带 ?para= 时由上面的 effect 负责定位，不再恢复上次位置（否则两个跳转打架）
    if (jumpPara !== null) return
    if (prog.resumeParagraph <= 0) return
    const idx = clampToParagraphs({ ...anchorAt(prog.resumeParagraph) }, paragraphs)
    gotoParagraph(idx, false)
  }, [prog.ready, prog.resumeParagraph, paragraphs, gotoParagraph, jumpPara])

  /**
   * 正文一到位就先同步一次当前章节。
   *
   * 不做的话，读者打开文档后不滚一下，目录里就一条高亮都没有 ——
   * 上面那个恢复位置的 effect 在"上次读到第 0 段"或新文档时是直接 return 的。
   */
  useEffect(() => {
    if (paragraphs.length === 0) return
    syncActiveToc(currentParaRef.current)
  }, [paragraphs, syncActiveToc])

  /* 滚动停止后上报位置（防抖在 hook 里，契约 §6.3 要求 1500ms） */
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // 用 setTimeout 而不是 requestAnimationFrame 做节流：
    // rAF 只在"可见"时触发（后台标签页会被暂停），而且 jsdom 默认没有它。
    // 这里只需要"别每像素都算一次"，16ms 的定时器够用且到处都成立。
    let pending = 0
    const onScroll = () => {
      if (pending) return
      pending = window.setTimeout(() => {
        pending = 0
        const viewport = root.clientHeight || 600
        let idx: number
        if (virtual) {
          // 窗口化时只能靠几何表算，DOM 里根本没有那些没渲染的段落
          idx = paragraphAt(geom, root.scrollTop + viewport * 0.3)
          setWin(computeWindow(geom, root.scrollTop, viewport, -1))
        } else {
          const top = root.scrollTop + viewport * 0.3
          idx = 0
          for (const el of Array.from(root.querySelectorAll('[data-para]'))) {
            const he = el as HTMLElement
            if (he.offsetTop <= top) idx = Number(he.dataset.para ?? 0)
            else break
          }
        }
        currentParaRef.current = idx
        syncActiveToc(idx)
        prog.report(anchorAt(idx, ra.cursor))
      }, 16)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (pending) window.clearTimeout(pending)
    }
  }, [prog, ra.cursor, virtual, geom, syncActiveToc])

  /* 高亮自动跟随 */
  useEffect(() => {
    if (!ra.autoScroll) return
    const el = rootRef.current?.querySelector(`[data-sentence="${ra.cursor}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [ra.cursor, ra.autoScroll])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(''), 2400)
    return () => window.clearTimeout(t)
  }, [toast])

  /** 段落号 → 图片引用，渲染 img 段落时按它取图 */
  const imageByPara = useMemo(() => {
    const m = new Map<number, ContentImageRef>()
    for (const r of imageRefs) m.set(r.paraIndex, r)
    return m
  }, [imageRefs])

  /** 窗口化时只取这一段；短文档就是全部 */
  const visibleParagraphs = useMemo(
    () => (virtual ? paragraphs.slice(win.start, win.end + 1) : paragraphs),
    [virtual, paragraphs, win.start, win.end],
  )

  /**
   * 窗口化时把渲染出来的段落实测高度回写进几何表。
   * 估算高度和真实排版总有出入，不回写的话滚动位置会越飘越远。
   */
  useLayoutEffect(() => {
    if (!virtual) return
    const root = rootRef.current
    if (!root) return

    let changed = false
    for (let i = win.start; i <= win.end; i++) {
      const el = root.querySelector(`[data-para="${i}"]`) as HTMLElement | null
      if (!el) continue
      const actual = el.offsetHeight
      if (actual > 0 && Math.abs(actual - geom.heights[i]) > 1) {
        geom.heights[i] = actual
        changed = true
      }
    }
    if (changed) {
      recomputeFrom(geom, win.start)
      // 让撑高块用上新的偏移；下一轮实测高度与记录一致，不会反复触发
      setWin((w) => ({ ...w }))
    }
  }, [virtual, win, geom])

  /**
   * 改字号后按"当前段落"重新锚定滚动位置。
   *
   * 为什么非做不可：字号一变，视口里那些段落的实际高度就全变了，
   * 而 root.scrollTop 是个绝对像素值 —— 内容整体变高变矮之后它还停在原处，
   * 视觉上就是"读着读着突然跳章了"。
   *
   * 必须排在上面那个回写 effect **之后**：先把看得见的那几段高度实测回写，
   * 再拿修正过的偏移去锚定，落点才准。
   */
  const lastFontRef = useRef(prefs.fontSize)
  useLayoutEffect(() => {
    const root = rootRef.current
    const fontChanged = lastFontRef.current !== prefs.fontSize
    lastFontRef.current = prefs.fontSize
    // 只在**字号**变化时重锚：段落数组换掉（换文档）是恢复位置那套逻辑的事
    if (!fontChanged || !root) return

    const viewport = root.clientHeight || 600
    const idx = currentParaRef.current
    // 减去 30% 视口高度，让这一段落回原来那条"当前段落"线上，而不是跳到顶端
    const top = Math.max(0, offsetOf(geom, idx) - viewport * 0.3)
    root.scrollTo({ top, behavior: 'auto' })
    if (virtual) setWin(computeWindow(geom, top, viewport, idx))
  }, [prefs.fontSize, geom, virtual])

  /* 目录抽屉：Esc 关掉，以及把当前章节滚进视野 */
  useEffect(() => {
    if (!tocOpen && !settingsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setTocOpen(false)
      setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tocOpen, settingsOpen])

  useEffect(() => {
    if (!tocOpen || activeToc < 0) return
    const panel = tocPanelRef.current
    if (!panel) return
    const el = panel.querySelector(`[data-toc-index="${activeToc}"]`) as HTMLElement | null
    if (!el) return
    // 直接设 scrollTop，不用 scrollIntoView —— 后者会往上找到可滚动的祖先，
    // 把 .reader-scroll 一起滚了，读者会发现自己莫名其妙被带走了
    panel.scrollTop = Math.max(0, el.offsetTop - panel.clientHeight / 2 + el.clientHeight / 2)
  }, [tocOpen, activeToc])

  /* ---- 阅读背景图 ---- */

  useEffect(() => {
    let alive = true
    if (!prefs.bgImageId) {
      setBgUrl('')
      return
    }
    void getBackground().then((blob) => {
      if (!alive) return
      if (!blob) {
        // IndexedDB 被禁用，或者记录被清掉了。静默把偏好改回"没有背景" ——
        // 读者只是没看见壁纸，不是操作失败，弹提示反而是噪音
        setPrefs({ bgImageId: null })
        return
      }
      setBgUrl(backgroundUrl(blob))
    })
    return () => {
      alive = false
    }
  }, [prefs.bgImageId, setPrefs])

  /* object URL 必须显式撤销，否则 Blob 收不回来 */
  useEffect(() => () => releaseBackgroundUrl(), [])

  const onPickBackground = useCallback(
    async (file: File) => {
      setBgError('')
      try {
        await putBackground(file)
        setBgName(file.name)
        // 只有一张背景图，键是固定的；偏好里记的就是它
        setPrefs({ bgImageId: BG_IMAGE_ID })
      } catch (e) {
        setBgError(e instanceof Error ? e.message : '设置背景图失败。')
      }
    },
    [setPrefs],
  )

  const onClearBackground = useCallback(() => {
    setBgError('')
    setBgName('')
    void clearBackground()
    setPrefs({ bgImageId: null })
  }, [setPrefs])

  /* ---- 翻页模式：点左右两侧翻屏 ---- */

  const onReaderClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (prefs.pageMode !== 'paged') return
      if (e.button !== 0 || e.defaultPrevented) return

      const t = e.target as HTMLElement
      // 点句子要跳转跟读、点图片重试按钮要重试、点链接要跳转 ——
      // 这些都不能被翻页吃掉。少了这道守卫，招牌的「点句子跟读」在翻页模式下就废了
      if (t.closest('.sent, button, a, input, select, textarea, img, figure')) return
      // 拖着选文字时鼠标抬起也会触发 click，这时候不该翻页
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return

      const root = e.currentTarget
      const r = root.getBoundingClientRect()
      const x = e.clientX - r.left
      const step = root.clientHeight - PAGE_OVERLAP

      // 用 scrollBy 而不是 gotoParagraph：平滑滚动会自然触发上面那个
      // 节流滚动回调，窗口化零改动继续工作；gotoParagraph 反而会跟动画打架
      if (x > r.width * 0.7) root.scrollBy({ top: step, behavior: 'smooth' })
      else if (x < r.width * 0.3) root.scrollBy({ top: -step, behavior: 'smooth' })
    },
    [prefs.pageMode],
  )

  /**
   * B4：书签默认名 =「章节标题 + 首句片段」（.context/08-书签补充.md §2.3 的要求）。
   *
   * 章节标题不需要动解析层——ReaderView 已经拿到带 type: 'h1' | 'h2' 的 paragraphs，
   * 取锚点段落**之前最近的一个标题段**即可；之前没有就退回文档里第一个标题段，
   * 再没有就用书名。
   */
  const chapterTitleFor = useCallback(
    (paraIndex: number): string => {
      for (let i = Math.min(paraIndex, paragraphs.length - 1); i >= 0; i--) {
        const p = paragraphs[i]
        if (p && (p.type === 'h1' || p.type === 'h2')) return p.text
      }
      const first = paragraphs.find((p) => p.type === 'h1' || p.type === 'h2')
      return first?.text ?? book?.title ?? ''
    },
    [paragraphs, book],
  )

  /** 首句片段：取锚点段落切分后的第一句，去掉句末标点，超过 20 字截断 */
  const firstSentenceOf = useCallback(
    (paraIndex: number): string => {
      const p = paragraphs[paraIndex]
      // 标题段本身没有句子（splitSentences 把 h1/h2 排除在外），若锚点正好落在标题段上，
      // 兜底取 paragraphs[paraIndex].text 会拿到与章节标题一模一样的一串，
      // 默认名会变成「卷二 · 境界说 · 卷二 · 境界说」。此时不取片段。
      if (p && (p.type === 'h1' || p.type === 'h2')) return ''
      const raw = (byPara.get(paraIndex) ?? [])[0]?.text ?? p?.text ?? ''
      // 去掉句末标点：默认名是「章节标题 · 首句片段」这种复合名，末尾再挂一个句号读着别扭，
      // 也与任务书 B4 给出的示例形式一致（任务书示例没有句号）
      const trimmed = raw.replace(/[。．.！!？?；;…]+$/, '')
      return trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed
    },
    [byPara, paragraphs],
  )

  const defaultNameFor = useCallback(
    (paraIndex: number): string => {
      const parts = [chapterTitleFor(paraIndex), firstSentenceOf(paraIndex)].filter(Boolean)
      return parts.join(' · ')
    },
    [chapterTitleFor, firstSentenceOf],
  )

  if (!ready || !user || loading) {
    return <div className="reader-page"><div className="shelf-empty">正在加载正文…</div></div>
  }

  if (error || !book) {
    return (
      <div className="reader-page">
        <div className="shelf-empty">
          <p className="error-text">{error || '找不到这篇文档'}</p>
          <div className="shelf-empty-actions">
            <button className="btn btn-primary" onClick={() => void load()}>重试</button>
            <button className="btn btn-ghost" onClick={() => navigate('/shelf')}>回到书架</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="reader-page">
      <header className="reader-topbar">
        <button className="btn btn-ghost" onClick={() => navigate('/shelf')}>返回</button>
        <div className="reader-title" title={book.title}>{book.title}</div>
        {/* 三个面板互斥：目录是覆盖式抽屉，书签是推开正文的栏，
            设置是浮层，同时开会叠在一起 */}
        <button
          className="btn btn-ghost"
          onClick={() => {
            setTocOpen((v) => !v)
            setMarksOpen(false)
            setSettingsOpen(false)
          }}
        >
          目录
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setSettingsOpen((v) => !v)
            setTocOpen(false)
            setMarksOpen(false)
          }}
        >
          设置
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setMarksOpen((v) => !v)
            setTocOpen(false)
            setSettingsOpen(false)
          }}
        >
          书签{bms.total > 0 ? `（${bms.total}）` : ''}
        </button>
        <button
          className="btn btn-ghost btn-conflict"
          onClick={() => {
            if (bms.conflicts.length === 0) {
              setToast('当前没有同步冲突')
              return
            }
            setDialogOpen(true)
          }}
        >
          同步冲突
          {bms.conflicts.length > 0 && <span className="badge">{bms.conflicts.length}</span>}
        </button>
      </header>

      <div className="reader-body">
        {/* 背景图层：脱离文档流。放进流里会给每个段落加上 offsetTop，
            直接把窗口化的几何表和撑高块高度算坏 */}
        {bgUrl && (
          <div
            className="reader-bg"
            style={{ backgroundImage: `url(${bgUrl})` }}
            aria-hidden="true"
          />
        )}
        {/* 蒙版压一层，否则亮壁纸配深色文字根本看不清。
            白天用白蒙版、夜晚用黑蒙版，两边的正文对比度都保住 */}
        {bgUrl && (
          <div
            className={'reader-bg-scrim' + (prefs.theme === 'dark' ? ' on' : '')}
            aria-hidden="true"
          />
        )}

        {settingsOpen && (
          <>
            <div className="toc-mask" onClick={() => setSettingsOpen(false)} aria-hidden="true" />
            <ReaderSettingsPanel
              prefs={prefs}
              setPrefs={setPrefs}
              bgName={bgName}
              bgError={bgError}
              onPickBackground={(f) => void onPickBackground(f)}
              onClearBackground={onClearBackground}
              onClose={() => setSettingsOpen(false)}
            />
          </>
        )}

        {tocOpen && (
          <>
            <div className="toc-mask" onClick={() => setTocOpen(false)} aria-hidden="true" />
            <aside className="toc-panel drawer" ref={tocPanelRef}>
              <div className="toc-head">目录</div>
              {tocItems.length === 0 && (
                <p className="muted marks-empty">
                  这篇文档没有章节标题，暂时没有目录。
                </p>
              )}
              {tocItems.map((p, i) => (
                <button
                  key={p.paraIndex}
                  data-toc-index={i}
                  className={
                    'toc-item' +
                    (p.type === 'h2' ? ' lv2' : '') +
                    (i === activeToc ? ' active' : '')
                  }
                  onClick={() => {
                    gotoParagraph(p.paraIndex)
                    ra.stopAutoScroll()
                  }}
                >
                  {p.text}
                </button>
              ))}
            </aside>
          </>
        )}

        {/* 书签栏用 B 迭代的 BookmarkPanel：分页 / 排序 / 拖动重排都在里面，
            R7 那版是它的前身（只有一份平铺列表 + 行内重命名），功能是它的子集 */}
        {marksOpen && (
          <BookmarkPanel
            items={bms.items}
            total={bms.total}
            page={bms.page}
            pageSize={bms.pageSize}
            sort={bms.sort}
            onSortChange={bms.setSort}
            onPageChange={bms.setPage}
            defaultAddName={defaultNameFor(currentParaRef.current)}
            onAdd={(name) => {
              const idx = currentParaRef.current
              void bms.add(
                anchorAt(idx, ra.cursor),
                name || defaultNameFor(idx),
                chapterTitleFor(idx),
              )
            }}
            onRename={(id, name) => void bms.rename(id, name)}
            onRemove={(id) => void bms.remove(id)}
            onReorder={(ids) => void bms.reorder(ids)}
            onJump={(paraIndex) => {
              gotoParagraph(paraIndex)
              ra.stopAutoScroll()
            }}
          />
        )}

        <div
          className={'reader-scroll' + (prefs.pageMode === 'paged' ? ' paged' : '')}
          ref={rootRef}
          onClick={onReaderClick}
        >
          <article className="reader-content" style={{ fontSize: `${prefs.fontSize}px` }}>
            {/* 窗口上方用撑高块占位，保持滚动条长度正确 */}
            {virtual && (
              <div
                style={{ height: geom.offsets[win.start] }}
                aria-hidden="true"
                data-spacer="top"
              />
            )}
            {visibleParagraphs.map((p) => {
              if (p.type === 'h1' || p.type === 'h2') {
                const Tag = p.type === 'h1' ? 'h1' : 'h2'
                return (
                  <Tag key={p.paraIndex} data-para={p.paraIndex} className={'doc-' + p.type}>
                    {p.text}
                  </Tag>
                )
              }
              if (p.type === 'img') {
                const ref = imageByPara.get(p.paraIndex)
                if (!ref) {
                  return (
                    <figure key={p.paraIndex} data-para={p.paraIndex} className="doc-figure">
                      <div className="figure-missing">
                        <span>这一段的图片引用缺失</span>
                      </div>
                    </figure>
                  )
                }
                return (
                  <LazyImage
                    key={p.paraIndex}
                    docId={docId}
                    imageId={ref.imageId}
                    alt={ref.alt ?? ''}
                    hasRemote={!!ref.imageUrl}
                    scrollRoot={rootRef}
                    keepResident={ra.playing}
                    dataPara={p.paraIndex}
                  />
                )
              }
              return (
                <p key={p.paraIndex} data-para={p.paraIndex} className="doc-p">
                  {(byPara.get(p.paraIndex) ?? []).map((s) => (
                    <span
                      key={s.sentenceIndex}
                      data-sentence={s.sentenceIndex}
                      className={'sent' + (s.sentenceIndex === ra.cursor ? ' sent-active' : '')}
                      onClick={() => ra.seek(s.sentenceIndex)}
                    >
                      {s.text}
                    </span>
                  ))}
                </p>
              )
            })}
            {virtual && (
              <div
                style={{
                  height: Math.max(0, totalHeight(geom) - geom.offsets[win.end + 1]),
                }}
                aria-hidden="true"
                data-spacer="bottom"
              />
            )}
          </article>
        </div>

        {/* 收起控制条后浮在正文底部的胶囊，也是唯一的恢复入口。
            挂在 .reader-body 里而不是 .reader-page 下：.reader-page 没有
            position:relative，absolute 会去找更外层的定位祖先、跑到页面外边去；
            .reader-body 才是最近的定位祖先，bottom 也就落在正文区底部。
            .toast 是 fixed 的 z-80 / bottom:96px，与这里既不重叠也不抢层；
            .reader-scroll 底部自带 60px 内边距，正文最后一行不会被它盖住 */}
        {barHidden && (
          <button
            ref={restoreBarRef}
            className="pb-restore"
            onClick={() => setBarHidden(false)}
            title="展开朗读控制条"
            aria-label="展开朗读控制条"
          >
            🎧 {ra.playing ? `跟读中 · 第 ${ra.cursor + 1} / ${sentences.length} 句` : '朗读控制条'}
          </button>
        )}
      </div>

      {(ra.error || bms.error) && (
        <div className="resume-hint resume-error">
          {ra.error || bms.error}
          {bms.conflicts.length > 0 && (
            <button className="btn btn-primary btn-sm" onClick={() => setDialogOpen(true)}>
              查看冲突
            </button>
          )}
        </div>
      )}

      {!ra.autoScroll && (
        <div className="resume-hint">
          已暂停自动滚动（当前第 {ra.cursor + 1} 句）
          <button className="btn btn-primary btn-sm" onClick={ra.resume}>继续跟读</button>
        </div>
      )}

      {/* .playbar 是 flex:none 的普通 flex 子项（不是 fixed），抽掉之后
          .reader-body 靠 flex:1 自动补满，不需要动任何 padding */}
      {!barHidden && (
        <PlaybackBar total={sentences.length} ra={ra} onCollapse={() => setBarHidden(true)} />
      )}

      {dialogOpen && bms.conflicts.length > 0 && (
        <ConflictDialog
          conflicts={bms.conflicts}
          onClose={() => setDialogOpen(false)}
          onResolve={(c, choice) => void bms.resolve(c, choice)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
