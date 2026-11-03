import { describe, expect, it } from 'vitest'
import {
  pickSyncedBookmark,
  pickSyncedProgress,
  selectPending,
  type PendingChange,
} from '../src/features/sync/pendingQueue'

/**
 * 离线待同步队列的纯逻辑。
 *
 * 队列存在 IndexedDB 里，读写本身交给端到端去验；这里只测两件会悄悄出错的事：
 *   · 换账号后不能把上一个读者的队列补报到新账号；
 *   · 在线补报成功后，旧队列行必须能被认出来清掉，否则「待同步 N 条」永远不消失。
 */

let seq = 0
function row(over: Partial<PendingChange> = {}): PendingChange {
  return {
    id: `p${seq++}`,
    userId: 'u_a',
    docId: 'd1',
    kind: 'progress',
    payload: {},
    at: seq,
    ...over,
  }
}

describe('待同步队列（pendingQueue）', () => {
  it('selectPending 只返回当前读者的条目，旧版本没有 userId 的行也不认', () => {
    const all = [
      row({ id: 'a1', userId: 'u_a' }),
      row({ id: 'b1', userId: 'u_b' }),
      row({ id: 'legacy', userId: null }),
    ]

    expect(selectPending(all, 'u_a').map((r) => r.id)).toEqual(['a1'])
    expect(selectPending(all, 'u_b').map((r) => r.id)).toEqual(['b1'])
  })

  it('selectPending 可以再按 docId 收窄', () => {
    const all = [
      row({ id: 'd1', userId: 'u_a', docId: 'doc_1' }),
      row({ id: 'd2', userId: 'u_a', docId: 'doc_2' }),
    ]
    expect(selectPending(all, 'u_a', 'doc_2').map((r) => r.id)).toEqual(['d2'])
  })

  it('pickSyncedProgress 只挑同一文档、同一读者、且不晚于已成功上报时间的进度行', () => {
    const rows = [
      row({ id: 'old', docId: 'doc_1', payload: { updatedAt: '2026-01-01T00:00:00.000Z' } }),
      row({ id: 'same', docId: 'doc_1', payload: { updatedAt: '2026-01-02T00:00:00.000Z' } }),
      row({ id: 'newer', docId: 'doc_1', payload: { updatedAt: '2026-01-03T00:00:00.000Z' } }),
      row({ id: 'bookmark', docId: 'doc_1', kind: 'bookmark', payload: { bookmarkId: 'bm_1' } }),
      row({ id: 'otherDoc', docId: 'doc_2', payload: { updatedAt: '2026-01-01T00:00:00.000Z' } }),
    ]

    const done = pickSyncedProgress(rows, 'doc_1', '2026-01-02T00:00:00.000Z')
    expect(done.map((r) => r.id)).toEqual(['old', 'same'])
  })

  it('pickSyncedBookmark 只挑同一 bookmarkId 的 created 行', () => {
    const rows = [
      row({ id: 'bm1', kind: 'bookmark', payload: { kind: 'created', bookmarkId: 'bm_1' } }),
      row({ id: 'bm2', kind: 'bookmark', payload: { kind: 'created', bookmarkId: 'bm_2' } }),
      row({ id: 'progress', kind: 'progress', payload: { updatedAt: '2026-01-01T00:00:00.000Z' } }),
    ]

    expect(pickSyncedBookmark(rows, 'bm_1').map((r) => r.id)).toEqual(['bm1'])
  })
})
