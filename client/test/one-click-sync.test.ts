import { describe, expect, it } from 'vitest'
import {
  countPendingForUser,
  runOneClickSync,
  type PendingLike,
  type SyncDeps,
} from '../src/features/sync/oneClickSyncCore'

/**
 * 一键同步的编排逻辑。
 *
 * 真实实现读 IndexedDB、发 HTTP；这里注入假的 deps，只验编排本身：
 *   · 只补报当前读者的队列；
 *   · 同一批书签合并成一次请求，不按文档串行；
 *   · 某一组失败不拖垮其余组；
 *   · 404（文档已删）的行要清掉，5xx 的行要留着。
 */

let seq = 0
function row(over: Partial<PendingLike> = {}): PendingLike {
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

function progress(docId: string, paragraphIndex: number, updatedAt: string): PendingLike {
  return row({
    kind: 'progress',
    docId,
    payload: {
      docId,
      anchor: { chapterIndex: 0, paragraphIndex, sentenceIndex: 0, charOffset: 0, scrollOffset: 0 },
      lastSentenceIndex: 0,
      updatedAt,
      baseVersion: 1,
    },
  })
}

function bookmark(docId: string, bookmarkId: string): PendingLike {
  return row({
    kind: 'bookmark',
    docId,
    payload: {
      kind: 'created',
      bookmarkId,
      docId,
      anchor: { chapterIndex: 0, paragraphIndex: 1, sentenceIndex: 0, charOffset: 0, scrollOffset: 0 },
      name: bookmarkId,
      chapterTitle: '第三章',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  })
}

interface Deps extends SyncDeps {
  calls: { body: any; key: string }[]
  cleared: string[]
}

function makeDeps(
  rows: PendingLike[],
  syncImpl?: (body: any) => Promise<{ conflicts: unknown[]; applied?: unknown }>,
): Deps {
  const calls: { body: any; key: string }[] = []
  const cleared: string[] = []
  return {
    userId: 'u_a',
    deviceId: 'dev_a',
    calls,
    cleared,
    listPending: async () => rows,
    clearPending: async (ids) => { cleared.push(...ids) },
    sync: async (body, key) => {
      calls.push({ body, key })
      if (syncImpl) return syncImpl(body)
      return { conflicts: [], applied: { bookmarks: { skipped: [] } } }
    },
    listConflicts: async () => ({ items: [] }),
  }
}

describe('一键同步编排（oneClickSyncCore）', () => {
  it('只统计当前读者的 progress / bookmark 队列，readingTime 不算', () => {
    const rows = [
      row({ id: 'a-p', userId: 'u_a', kind: 'progress' }),
      row({ id: 'a-b', userId: 'u_a', kind: 'bookmark' }),
      row({ id: 'a-t', userId: 'u_a', kind: 'readingTime' }),
      row({ id: 'b-p', userId: 'u_b', kind: 'progress' }),
    ]
    expect(countPendingForUser(rows, 'u_a')).toBe(2)
    expect(countPendingForUser(rows, 'u_b')).toBe(1)
  })

  it('多本书的待同步书签合并成一次请求，不按文档逐本发', async () => {
    const rows = [
      bookmark('doc_1', 'bm_1'),
      bookmark('doc_2', 'bm_2'),
      bookmark('doc_3', 'bm_3'),
    ]
    const deps = makeDeps(rows)

    const r = await runOneClickSync(deps)

    expect(deps.calls).toHaveLength(1)
    expect(deps.calls[0].body.bookmarks.created).toHaveLength(3)
    expect(deps.calls[0].body.bookmarks.created[0].chapterTitle).toBe('第三章')
    expect(r.flushed).toBe(3)
    expect(deps.cleared.sort()).toEqual(rows.map((x) => x.id).sort())
  })

  it('进度按文档分组，同一本只补报最后一条', async () => {
    const older = progress('doc_1', 1, '2026-01-01T00:00:00.000Z')
    const newer = progress('doc_1', 4, '2026-01-02T00:00:00.000Z')
    const other = progress('doc_2', 2, '2026-01-01T00:00:00.000Z')
    const deps = makeDeps([older, newer, other])

    const r = await runOneClickSync(deps)

    expect(deps.calls).toHaveLength(2)
    const doc1 = deps.calls.find((c) => c.body.progress?.docId === 'doc_1')
    expect(doc1?.body.progress.anchor.paragraphIndex).toBe(4)
    expect(r.flushed).toBe(3)
    expect(deps.cleared.sort()).toEqual([older.id, newer.id, other.id].sort())
  })

  it('某一组 5xx 不拖垮其余组：失败组保留队列，成功组照常清掉', async () => {
    const bad = progress('doc_1', 1, '2026-01-01T00:00:00.000Z')
    const good = progress('doc_2', 2, '2026-01-01T00:00:00.000Z')
    const deps = makeDeps([bad, good], async (body) => {
      if (body.progress?.docId === 'doc_1') {
        throw Object.assign(new Error('服务器错误'), { status: 500 })
      }
      return { conflicts: [] }
    })

    const r = await runOneClickSync(deps)

    expect(deps.calls).toHaveLength(2)
    expect(r.failed).toBe(1)
    expect(deps.cleared).toEqual([good.id])
  })

  it('404（文档已删除）的组清掉队列，不计失败', async () => {
    const gone = progress('doc_1', 1, '2026-01-01T00:00:00.000Z')
    const deps = makeDeps([gone], async () => {
      throw Object.assign(new Error('文档不存在'), { status: 404 })
    })

    const r = await runOneClickSync(deps)

    expect(r.failed).toBe(0)
    expect(r.flushed).toBe(0)
    expect(deps.cleared).toEqual([gone.id])
  })

  it('服务端的未决冲突数是权威值', async () => {
    const deps = makeDeps([], async () => ({ conflicts: [{}] }))
    deps.listConflicts = async () => ({ items: [{}, {}] })

    const r = await runOneClickSync(deps)
    expect(r.conflicts).toBe(2)
  })
})
