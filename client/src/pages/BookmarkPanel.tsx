import { useRef, useState } from 'react'
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
    order0: string[]
    heightById: Map<string, number>
  } | null>(null)

  const byId = new Map(items.map((i) => [i.bookmarkId, i]))
  const shown = previewIds
    ? previewIds.map((id) => byId.get(id)).filter((i): i is BookmarkDto => !!i)
    : items

  /** 按指针纵向位置算出目标下标，实时重排预览 */
  function applyDragMove(clientY: number) {
    const d = dragRef.current
    const g = geomRef.current
    if (!d || !g || g.order0.length === 0) return

    const cur = previewIds ?? g.order0
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
    setPreviewIds(next)
  }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>, bookmarkId: string) {
    // 只在书签多于 1 条时允许拖动
    if (items.length < 2) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, bookmarkId, startY: e.clientY, moved: false }
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return
      const list = listRef.current
      if (!list) return
      // 拖动真正开始时快照一次几何：行高按 id 记，并连同当时的顺序一起固定下来
      const nodes = Array.from(list.querySelectorAll<HTMLElement>('[data-bm-id]'))
      geomRef.current = {
        top: list.getBoundingClientRect().top,
        order0: nodes.map((n) => n.dataset.bmId ?? ''),
        heightById: new Map(
          nodes.map((n) => [n.dataset.bmId ?? '', n.getBoundingClientRect().height]),
        ),
      }
      d.moved = true
      setDraggingId(d.bookmarkId)
      setPreviewIds(items.map((i) => i.bookmarkId))
    }
    applyDragMove(e.clientY)
  }

  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current
    dragRef.current = null
    geomRef.current = null
    if (!d || d.pointerId !== e.pointerId) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDraggingId('')

    if (!d.moved) {
      setPreviewIds(null)
      return
    }
    const ids = previewIds ?? items.map((i) => i.bookmarkId)
    setPreviewIds(null)
    onReorder(ids)
  }

  /** 取消拖动（Escape 或指针被系统抢走） */
  function cancelDrag() {
    dragRef.current = null
    geomRef.current = null
    setDraggingId('')
    setPreviewIds(null)
  }

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
    <aside className="toc-panel" onKeyDown={(e) => e.key === 'Escape' && cancelDrag()}>
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
              onPointerDown={(e) => onPointerDown(e, b.bookmarkId)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={cancelDrag}
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
              disabled={index === 0}
              onClick={() => moveBy(b.bookmarkId, -1)}
            >
              ↑
            </button>
            <button
              className="mark-act"
              title="下移"
              disabled={index === shown.length - 1}
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
    </aside>
  )
}
