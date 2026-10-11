import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ApiError, api, type ContentImageRef, type DocumentDetail } from '../api/client'
import type { Paragraph } from '../models/types'
import { splitSentences, type Sentence } from '../features/readalong/splitSentences'
import { useReadAlong } from '../features/readalong/useReadAlong'
import { useProgress } from '../features/sync/useProgress'
import { useBookmarks } from '../features/sync/useBookmarks'
import { anchorAt, clampToParagraphs } from '../features/sync/anchor'
import {
  buildGeometry,
  computeWindow,
  offsetOf,
  paragraphAt,
  recomputeFrom,
  totalHeight,
} from '../features/render/virtualWindow'

/**
 * 超过这个段落数才启用窗口化渲染。
 * 演示书只有十几段，走原来的"全部渲染"路径，行为与之前完全一致 ——
 * 不该为了长文档的性能把已经跑通的短文档体验换掉。
 */
const VIRTUAL_THRESHOLD = 150
import LazyImage from '../features/render/LazyImage'
import { useSession } from '../state/session'
import PlaybackBar from './PlaybackBar'
import ConflictDialog from './ConflictDialog'
import BookmarkPanel from './BookmarkPanel'

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

  const [tocOpen, setTocOpen] = useState(false)
  const [marksOpen, setMarksOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [toast, setToast] = useState('')

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
  const geom = useMemo(() => buildGeometry(paragraphs), [paragraphs])
  const [win, setWin] = useState({ start: 0, end: VIRTUAL_THRESHOLD })

  /** 跳到某一段。窗口化时不能靠 querySelector —— 目标段落可能还没渲染 */
  const gotoParagraph = useCallback(
    (index: number, smooth = true) => {
      const root = rootRef.current
      if (!root) return
      if (!virtual) {
        root
          .querySelector(`[data-para="${index}"]`)
          ?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' })
        return
      }
      root.scrollTo({ top: offsetOf(geom, index), behavior: smooth ? 'smooth' : 'auto' })
      setWin(computeWindow(geom, offsetOf(geom, index), root.clientHeight || 600, index))
    },
    [virtual, geom],
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
        prog.report(anchorAt(idx, ra.cursor))
      }, 16)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (pending) window.clearTimeout(pending)
    }
  }, [prog, ra.cursor, virtual, geom])

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

  const tocItems = paragraphs.filter((p) => p.type === 'h1' || p.type === 'h2')

  /** 书签默认名（B4 的「章节标题 · 首句片段」）。Task 9 给出真正的命名规则 */
  const defaultNameFor = (_paraIndex: number) => ''

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
        <button className="btn btn-ghost" onClick={() => setTocOpen((v) => !v)}>目录</button>
        <button className="btn btn-ghost" onClick={() => setMarksOpen((v) => !v)}>
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
        {tocOpen && (
          <aside className="toc-panel">
            <div className="toc-head">目录</div>
            {tocItems.map((p) => (
              <button
                key={p.paraIndex}
                className={'toc-item' + (p.type === 'h2' ? ' lv2' : '')}
                onClick={() => {
                  gotoParagraph(p.paraIndex)
                  ra.stopAutoScroll()
                }}
              >
                {p.text}
              </button>
            ))}
          </aside>
        )}

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
            onAdd={(name) => void bms.add(anchorAt(currentParaRef.current, ra.cursor), name)}
            onRename={(id, name) => void bms.rename(id, name)}
            onRemove={(id) => void bms.remove(id)}
            onReorder={(ids) => void bms.reorder(ids)}
            onJump={(paraIndex) => {
              gotoParagraph(paraIndex)
              ra.stopAutoScroll()
            }}
          />
        )}

        <div className="reader-scroll" ref={rootRef}>
          <article className="reader-content">
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

      <PlaybackBar total={sentences.length} ra={ra} />

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
