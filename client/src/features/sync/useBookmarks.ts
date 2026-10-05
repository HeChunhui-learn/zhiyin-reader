import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  api,
  type Anchor,
  type BookmarkDto,
  type ConflictEnvelope,
} from '../../api/client'
import { enqueuePending } from './pendingQueue'

/**
 * 书签的读写（契约 §7 的单项接口）。
 *
 * 单项接口是书签管理界面的即时路径；它同时承担冲突发现的职责 ——
 * 版本对不上时服务端返回 409，响应体里带冲突信封，界面据此弹出冲突对话框。
 */

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `bm_${crypto.randomUUID().replace(/-/g, '')}`
  }
  return `bm_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
}

export interface BookmarksApi {
  items: BookmarkDto[]
  loading: boolean
  error: string
  /** 本次会话中遇到的冲突（服务端已经按 §8.5 自动落库，界面用于告知与清理） */
  conflicts: ConflictEnvelope[]
  reload: () => Promise<void>
  add: (anchor: Anchor, name: string) => Promise<void>
  rename: (bookmarkId: string, name: string) => Promise<void>
  remove: (bookmarkId: string) => Promise<void>
  resolve: (conflict: ConflictEnvelope, choice: 'local' | 'remote' | 'both') => Promise<void>
  dismissConflicts: () => void
}

export function useBookmarks(docId: string, enabled: boolean): BookmarksApi {
  const [items, setItems] = useState<BookmarkDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [conflicts, setConflicts] = useState<ConflictEnvelope[]>([])

  const reload = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try {
      const res = await api.listBookmarks({ docId })
      setItems(res.items.filter((i) => !i.deletedAt))
      setError('')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '读取书签失败')
    } finally {
      setLoading(false)
    }
  }, [docId, enabled])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * 冲突一律：记下来 + 刷新列表（服务端可能已经按 keep_both 落了库）。
   *
   * 注意顺序：`reload()` 成功时会清空 error，所以提示语必须**在 reload 之后**再设置，
   * 否则冲突说明会一闪而过。
   */
  const onConflict = useCallback(
    async (e: ApiError) => {
      const conflict = e.details?.conflict as ConflictEnvelope | undefined
      if (conflict) {
        setConflicts((prev) => {
          const key = `${conflict.scope}:${conflict.key}:${conflict.serverVersion}`
          const exists = prev.some((c) => `${c.scope}:${c.key}:${c.serverVersion}` === key)
          return exists ? prev : [...prev, conflict]
        })
      }
      await reload()
      setError(conflict?.note ?? e.message)
    },
    [reload],
  )

  const add = useCallback(
    async (anchor: Anchor, name: string) => {
      const payload = {
        bookmarkId: uuid(),
        docId,
        anchor,
        name,
        updatedAt: new Date().toISOString(),
      }
      try {
        await api.createBookmark(payload)
        await reload()
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) {
          // 断网：入队，等批量同步补报（契约 §6.3 的同一套机制）
          void enqueuePending(docId, 'bookmark', {
            ...payload,
            kind: 'created',
          })
          setItems((prev) => [
            ...prev,
            { ...payload, version: 0, createdAt: payload.updatedAt, deletedAt: null },
          ])
          setError('当前离线，书签已记入待同步队列')
          return
        }
        if (e instanceof ApiError && e.code === 'SYNC_VERSION_CONFLICT') {
          await onConflict(e)
          return
        }
        setError(e instanceof ApiError ? e.message : '添加书签失败')
      }
    },
    [docId, reload, onConflict],
  )

  const rename = useCallback(
    async (bookmarkId: string, name: string) => {
      const cur = items.find((i) => i.bookmarkId === bookmarkId)
      if (!cur) return
      try {
        await api.patchBookmark(bookmarkId, {
          name,
          baseVersion: cur.version,
          updatedAt: new Date().toISOString(),
        })
        await reload()
      } catch (e) {
        if (e instanceof ApiError && e.code === 'SYNC_VERSION_CONFLICT') {
          // 这正是"双窗口改同一书签"的场景：服务端按 keep_both 保留了两份
          await onConflict(e)
          return
        }
        setError(e instanceof ApiError ? e.message : '重命名失败')
      }
    },
    [items, reload, onConflict],
  )

  const remove = useCallback(
    async (bookmarkId: string) => {
      const cur = items.find((i) => i.bookmarkId === bookmarkId)
      if (!cur) return
      try {
        await api.deleteBookmark(bookmarkId, cur.version)
        await reload()
      } catch (e) {
        if (e instanceof ApiError && e.code === 'SYNC_VERSION_CONFLICT') {
          await onConflict(e)
          return
        }
        setError(e instanceof ApiError ? e.message : '删除失败')
      }
    },
    [items, reload, onConflict],
  )

  /** 冲突裁决：both 不动数据；local / remote 删掉另一份 */
  const resolve = useCallback(
    async (conflict: ConflictEnvelope, choice: 'local' | 'remote' | 'both') => {
      try {
        const relatedId = (conflict.resolved as { bookmarkId?: string } | null)?.bookmarkId
        await api.resolveConflict({
          scope: conflict.scope,
          key: conflict.key,
          conflictAt: new Date().toISOString(),
          choice,
          relatedId,
        })
        setConflicts((prev) => prev.filter((c) => c !== conflict))
        await reload()
        setError('')
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '裁决失败')
      }
    },
    [reload],
  )

  return {
    items,
    loading,
    error,
    conflicts,
    reload,
    add,
    rename,
    remove,
    resolve,
    dismissConflicts: () => setConflicts([]),
  }
}
