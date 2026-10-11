import { useEffect, useRef, useState } from 'react'
import type { BookmarkDto } from '../api/client'

/**
 * 书签面板（B1）。从 ReaderView 抽出来独立成文件 —— ReaderView 已是全项目最大的
 * 页面（459 行），拖动逻辑再塞进去会让它无法一次读完。
 *
 * 拖动用手写 pointer 事件，不用 HTML5 drag & drop：后者在触控设备上行为不一致，
 * 而且 jsdom 里根本没有 DataTransfer，验收时无法自动化。
 */

interface Props {
  items: BookmarkDto[]
  /** 当前位置的默认名（B4：「章节标题 · 首句片段」），留空时用它 */
  defaultAddName: string
  onAdd: (name: string) => void
  onRename: (bookmarkId: string, name: string) => void
  onRemove: (bookmarkId: string) => void
  onReorder: (orderedIds: string[]) => void
  onJump: (paragraphIndex: number) => void
  /** B3：分页与排序。状态都在 useBookmarks 里，面板只负责显示与回传 */
  total: number
  page: number
  pageSize: number
  sort: 'order' | 'createdAt' | 'chapter'
  onSortChange: (s: 'order' | 'createdAt' | 'chapter') => void
  onPageChange: (p: number) => void
}

/** 超过这个像素数才算拖动，避免把手柄上的单击误判成拖拽 */
const DRAG_THRESHOLD = 4

export default function BookmarkPanel({
  items,
  defaultAddName,
  onAdd,
  onRename,
  onRemove,
  onReorder,
  onJump,
  total,
  page,
  pageSize,
  sort,
  onSortChange,
  onPageChange,
}: Props) {
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [renamingId, setRenamingId] = useState('')
  const [renamingText, setRenamingText] = useState('')

  /** 拖动中的预览顺序；null 表示没在拖，直接显示 items */
  const [previewIds, setPreviewIds] = useState<string[] | null>(null)
  const [draggingId, setDraggingId] = useState('')
  const dragRef = useRef<{
    pointerId: number
    bookmarkId: string
    startY: number
    moved: boolean
  } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** 拖动开始时快照的行高与列表顶端。
   *  不能读实时矩形 —— 每次换位都会改变布局，相邻行高不等时命中判定会来回翻，
   *  顺序抖动、落点由最后一次渲染决定。快照法用固定行高累加，结果只取决于指针位置。
   *
   *  order0 是关键：累加必须沿拖动开始时那份**固定**顺序做。若沿实时预览顺序累加，
   *  槽位边界会跟着换位一起移动，行高不等时仍旧会来回翻 —— 这正是本次要修的病。 */
  const geomRef = useRef<{
    top: number
    heightById: Map<string, number>
    order0: string[]
  } | null>(null)
  /** 拖动期间的权威顺序。放 ref 而不是只靠 state —— window 监听器只挂一次，
   *  依赖每次渲染重建的闭包会读到过期的 previewIds。 */
  const orderRef = useRef<string[] | null>(null)

  /** dragActive（不是 draggingId）：指针一按下就挂监听，阈值判定也在监听器里做 */
  const [dragActive, setDragActive] = useState(false)

  const byId = new Map(items.map((i) => [i.bookmarkId, i]))
  const shown = previewIds
    ? previewIds.map((id) => byId.get(id)).filter((i): i is BookmarkDto => !!i)
    : items

  // 三个条件缺一不可：
  //  · 至少两条才有排序可言
  //  · 非"拖动顺序"时顺序由排序决定，拖了也会被下一次 reload 覆盖
  //  · 一页装不下时不能拖 —— 页内下标与全文档 sort_order 不是一回事，会跨页撞车
  //    （useBookmarks.reorder 里也有同一道闸，这里是让控件如实反映）
  const canDrag = items.length > 1 && sort === 'order' && total <= pageSize

  /** 按指针纵向位置算出目标下标，实时重排预览。全部读 ref，不读任何 state */
  function applyDragMoveAt(clientY: number) {
    const d = dragRef.current
    const g = geomRef.current
    const cur = orderRef.current
    if (!d || !g || !cur || g.order0.length === 0) return

    const from = cur.indexOf(d.bookmarkId)
    if (from < 0) return

    // 用快照行高沿固定顺序累加，找指针落在第几个槽位
    let top = g.top
    let target = g.order0.length - 1
    for (let i = 0; i < g.order0.length; i++) {
      const h = g.heightById.get(g.order0[i]) ?? 0
      if (clientY < top + h) {
        target = i
        break
      }
      top += h
    }

    if (target < 0 || target === from) return

    const next = cur.slice()
    next.splice(from, 1)
    next.splice(target, 0, d.bookmarkId)
    orderRef.current = next
    setPreviewIds(next)
  }

  /** 指针按下即进入拖动待命态，并把几何与顺序一次性快照下来 */
  function beginDrag(e: React.PointerEvent<HTMLButtonElement>, bookmarkId: string) {
    // 顺序由排序决定、或一页装不下时都不许拖（原因见 canDrag 上方注释）
    if (!canDrag) return
    if (dragRef.current) return // 多指：已有拖动在进行，忽略第二根手指
    const list = listRef.current
    if (!list) return

    e.currentTarget.setPointerCapture(e.pointerId)

    // 行高按 id 记，并连同当时的顺序一起固定下来（累加只沿 order0，见 applyDragMoveAt）
    const nodes = Array.from(list.querySelectorAll<HTMLElement>('[data-bm-id]'))
    const order0 = nodes.map((n) => n.dataset.bmId ?? '')
    dragRef.current = { pointerId: e.pointerId, bookmarkId, startY: e.clientY, moved: false }
    geomRef.current = {
      top: list.getBoundingClientRect().top,
      heightById: new Map(
        nodes.map((n) => [n.dataset.bmId ?? '', n.getBoundingClientRect().height]),
      ),
      order0,
    }
    orderRef.current = order0
    setDragActive(true)
  }

  /** 结束拖动。commit 为假时只清状态（Escape / pointercancel） */
  function endDrag(commit: boolean) {
    const d = dragRef.current
    const order = orderRef.current
    dragRef.current = null
    geomRef.current = null
    orderRef.current = null
    setDragActive(false)
    setDraggingId('')
    setPreviewIds(null)
    if (commit && d?.moved && order) onReorder(order)
  }

  /**
   * 拖动期间的 move / up / cancel / Escape 一律挂 window。
   *
   * 不能只靠手柄上的 onPointerUp：React 换位会挪动 DOM 节点，浏览器随之隐式释放
   * 指针捕获，之后 pointerup 落到光标下方的任意元素上。手柄只有 18×18px、行高 36px，
   * 在行体上松手就静默不提交 —— 界面看着排好了，刷新即回滚（评审用三种手势隔离验证过）。
   */
  useEffect(() => {
    if (!dragActive) return

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      if (!d.moved) {
        if (Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return
        d.moved = true
        setDraggingId(d.bookmarkId)
        setPreviewIds(orderRef.current)
      }
      applyDragMoveAt(e.clientY)
    }
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      endDrag(true)
    }
    const onCancel = () => endDrag(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endDrag(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
    }
  }, [dragActive, onReorder])

  /** 无鼠标也能排序：上移 / 下移 */
  function moveBy(bookmarkId: string, delta: number) {
    const ids = items.map((i) => i.bookmarkId)
    const from = ids.indexOf(bookmarkId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    onReorder(ids)
  }

  return (
    <aside className="toc-panel">
      <div className="toc-head toc-head-row">
        <span>书签</span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setAddOpen((v) => !v)
            setAddName('')
          }}
        >
          加当前位置
        </button>
      </div>

      {addOpen && (
        <div className="marks-add">
          <input
            className="input mark-rename"
            autoFocus
            placeholder={defaultAddName || '书签名称（留空用默认名）'}
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onAdd(addName.trim())
                setAddOpen(false)
                setAddName('')
              }
              if (e.key === 'Escape') setAddOpen(false)
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              onAdd(addName.trim())
              setAddOpen(false)
              setAddName('')
            }}
          >
            添加
          </button>
        </div>
      )}

      {items.length === 0 && (
        <p className="muted marks-empty">还没有书签。读到某处点「加当前位置」。</p>
      )}

      <div className="marks-list" ref={listRef}>
        {shown.map((b, index) => (
          <div
            className={'mark-item' + (draggingId === b.bookmarkId ? ' dragging' : '')}
            key={b.bookmarkId}
            data-bm-id={b.bookmarkId}
          >
            <button
              className="mark-grip"
              title="按住拖动排序"
              aria-label="拖动排序"
              onPointerDown={(e) => beginDrag(e, b.bookmarkId)}
            >
              ⠿
            </button>

            {renamingId === b.bookmarkId ? (
              <input
                className="input mark-rename"
                autoFocus
                value={renamingText}
                onChange={(e) => setRenamingText(e.target.value)}
                onBlur={() => setRenamingId('')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onRename(b.bookmarkId, renamingText)
                    setRenamingId('')
                  }
                  if (e.key === 'Escape') setRenamingId('')
                }}
              />
            ) : (
              <button
                className="mark-name"
                title="跳到这个书签"
                onClick={() => onJump(b.anchor.paragraphIndex)}
              >
                {b.name || '（无名）'}
                <span className="mark-pos">
                  {b.chapterTitle ? `${b.chapterTitle} · ` : ''}第 {b.anchor.paragraphIndex + 1} 段
                </span>
              </button>
            )}

            <button
              className="mark-act"
              title="上移"
              disabled={index === 0 || !canDrag}
              onClick={() => moveBy(b.bookmarkId, -1)}
            >
              ↑
            </button>
            <button
              className="mark-act"
              title="下移"
              disabled={index === shown.length - 1 || !canDrag}
              onClick={() => moveBy(b.bookmarkId, 1)}
            >
              ↓
            </button>
            <button
              className="mark-act"
              title="重命名"
              onClick={() => {
                setRenamingId(b.bookmarkId)
                setRenamingText(b.name ?? '')
              }}
            >
              ✎
            </button>
            <button className="mark-act" title="删除" onClick={() => onRemove(b.bookmarkId)}>
              ✕
            </button>
          </div>
        ))}
      </div>

      {total > 0 && (
        <div className="marks-pager">
          <select
            className="input marks-sort"
            value={sort}
            onChange={(e) => onSortChange(e.target.value as 'order' | 'createdAt' | 'chapter')}
          >
            <option value="order">拖动顺序</option>
            <option value="createdAt">创建时间</option>
            <option value="chapter">所属章节</option>
          </select>
          <span className="muted">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页 · 共 {total} 条
          </span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            上一页
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={page >= Math.ceil(total / pageSize)}
            onClick={() => onPageChange(page + 1)}
          >
            下一页
          </button>
          {sort === 'order' && total > pageSize && (
            <span className="muted">书签超过一页，暂不支持拖动排序</span>
          )}
        </div>
      )}
    </aside>
  )
}
