import { describe, expect, it } from 'vitest'
import {
  CLOCK_SKEW_MS,
  bothSuffix,
  decideBookmark,
  decideProgress,
  isNewer,
  type BookmarkPayload,
  type BookmarkServerState,
  type ProgressServerState,
} from '../../server/src/sync/merge'
import { DEFAULT_ANCHOR, compareAnchor, normalizeAnchor, samePosition, type Anchor } from '../../server/src/sync/anchor'

/**
 * SY-04 / SY-08 / SY-11 / SY-17 ~ SY-24：同步合并的纯判定。
 *
 * `server/src/sync/merge.ts` 的注释写着"合并语义是 R5 里最容易出错的部分"，
 * 而 D-11 / D-12 两个缺陷正是出在这里（两端改同一书签不触发冲突、
 * 只改名会把书签位置冲成第 0 段）。这套用例逐个钉住那些分支。
 */

function anchor(paragraphIndex: number, sentenceIndex = 0): Anchor {
  return { chapterIndex: 0, paragraphIndex, sentenceIndex, charOffset: 0, scrollOffset: 0 }
}

function local(over: Partial<BookmarkPayload> = {}): BookmarkPayload {
  return {
    bookmarkId: 'bm_1',
    docId: 'doc_1',
    anchor: anchor(5),
    name: '本机名',
    updatedAt: '2026-10-12T10:00:00.000Z',
    ...over,
  }
}

function remote(over: Partial<BookmarkServerState> = {}): BookmarkServerState {
  return {
    bookmarkId: 'bm_1',
    docId: 'doc_1',
    anchor: anchor(5),
    name: '服务端名',
    updatedAt: '2026-10-12T09:00:00.000Z',
    deletedAt: null,
    version: 3,
    ...over,
  }
}

describe('SY-04 锚点：字段名与比较口径', () => {
  it('normalizeAnchor 缺字段补 0，非法值也补 0', () => {
    expect(normalizeAnchor(undefined)).toEqual(DEFAULT_ANCHOR)
    expect(normalizeAnchor({})).toEqual(DEFAULT_ANCHOR)
    expect(normalizeAnchor({ paragraphIndex: NaN })).toEqual(DEFAULT_ANCHOR)
    expect(normalizeAnchor({ paragraphIndex: Infinity })).toEqual(DEFAULT_ANCHOR)
    expect(normalizeAnchor({ paragraphIndex: '5' })).toEqual(DEFAULT_ANCHOR)
  })

  it('normalizeAnchor 保留 docVersion，非字符串则丢弃', () => {
    expect(normalizeAnchor({ docVersion: 'sha256:abc' }).docVersion).toBe('sha256:abc')
    expect(normalizeAnchor({ docVersion: 123 }).docVersion).toBeUndefined()
  })

  it('compareAnchor 逐级比较：章节 → 段落 → 句子 → 偏移', () => {
    expect(compareAnchor(anchor(0), anchor(1))).toBeLessThan(0)
    expect(compareAnchor(anchor(1), anchor(0))).toBeGreaterThan(0)
    expect(compareAnchor(anchor(1, 0), anchor(1, 1))).toBeLessThan(0)
    expect(compareAnchor({ ...anchor(1, 1), charOffset: 3 }, { ...anchor(1, 1), charOffset: 5 })).toBeLessThan(0)
  })

  it('★ compareAnchor 不看 scrollOffset（滚动微调不是"读到哪了"）', () => {
    expect(compareAnchor({ ...anchor(3), scrollOffset: 0 }, { ...anchor(3), scrollOffset: 9999 })).toBe(0)
  })

  it('★ compareAnchor 不看 docVersion（文档哈希不是位置）', () => {
    expect(compareAnchor({ ...anchor(3), docVersion: 'a' }, { ...anchor(3), docVersion: 'b' })).toBe(0)
  })

  it('samePosition 与 compareAnchor === 0 等价', () => {
    expect(samePosition(anchor(3), anchor(3))).toBe(true)
    expect(samePosition(anchor(3), anchor(4))).toBe(false)
  })

  it('chapterIndex 优先于 paragraphIndex', () => {
    expect(compareAnchor({ ...anchor(1), chapterIndex: 2 }, { ...anchor(9), chapterIndex: 0 })).toBeGreaterThan(0)
  })
})

describe('SY-08 时间先后判定与时钟偏差（契约 §8.5）', () => {
  it('CLOCK_SKEW_MS 常量是 5000', () => {
    expect(CLOCK_SKEW_MS).toBe(5000)
  })

  it('差值超过 5 秒时按 updatedAt 判', () => {
    expect(isNewer({ updatedAt: '2026-10-12T10:00:10Z' }, { updatedAt: '2026-10-12T10:00:00Z' })).toBe(true)
    expect(isNewer({ updatedAt: '2026-10-12T10:00:00Z' }, { updatedAt: '2026-10-12T10:00:10Z' })).toBe(false)
  })

  it('★ 差值不足 5 秒时改用 serverReceivedAt 判（客户端时钟可能有偏）', () => {
    const a = { updatedAt: '2026-10-12T10:00:00Z', serverReceivedAt: '2026-10-12T10:00:09Z' }
    const b = { updatedAt: '2026-10-12T10:00:03Z', serverReceivedAt: '2026-10-12T10:00:01Z' }
    // updatedAt 上 a 更旧，但 serverReceivedAt 上 a 更新 —— 应当判 a 新
    expect(isNewer(a, b)).toBe(true)
  })

  it('两边都没有 serverReceivedAt 时退回 updatedAt', () => {
    expect(isNewer({ updatedAt: '2026-10-12T10:00:03Z' }, { updatedAt: '2026-10-12T10:00:00Z' })).toBe(true)
  })

  it('只有一边有 serverReceivedAt 时退回 updatedAt（避免把 NaN 当新）', () => {
    const a = { updatedAt: '2026-10-12T10:00:00Z', serverReceivedAt: '2026-10-12T10:00:09Z' }
    const b = { updatedAt: '2026-10-12T10:00:03Z' }
    expect(isNewer(a, b)).toBe(false)
  })

  it('时间无法解析时返回 false（不把坏数据当新）', () => {
    expect(isNewer({ updatedAt: '不是时间' }, { updatedAt: '2026-10-12T10:00:00Z' })).toBe(false)
    expect(isNewer({ updatedAt: '' }, { updatedAt: '' })).toBe(false)
  })
})

describe('SY-09 / SY-10 书签新增与幂等', () => {
  it('服务端没有这条时新增', () => {
    expect(decideBookmark('created', local(), null, undefined).action).toEqual({ kind: 'insert' })
  })

  it('本机是「改」而服务端没有时也按新增落库（离线补报）', () => {
    expect(decideBookmark('updated', local(), null, undefined).action).toEqual({ kind: 'insert' })
  })

  it('本机是「删」而服务端没有时幂等返回（没什么可删）', () => {
    expect(decideBookmark('deleted', local(), null, undefined).action).toEqual({ kind: 'idempotent' })
  })

  it('SY-10 版本匹配且内容相同 → 幂等，不产生新版本', () => {
    const r = decideBookmark('updated', local({ name: '服务端名' }), remote(), 3)
    expect(r.action).toEqual({ kind: 'idempotent' })
    expect(r.conflict).toBeUndefined()
  })

  it('版本匹配但内容变了 → 正常更新', () => {
    expect(decideBookmark('updated', local(), remote(), 3).action).toEqual({ kind: 'update' })
  })

  it('版本匹配且是删除 → 正常落墓碑', () => {
    expect(decideBookmark('deleted', local(), remote(), 3).action).toEqual({ kind: 'update' })
  })
})

describe('SY-24 两端都删：幂等，不构成冲突', () => {
  it('服务端已有墓碑时本机再删 → 幂等', () => {
    const r = decideBookmark('deleted', local(), remote({ deletedAt: '2026-10-12T09:30:00Z' }), 3)
    expect(r.action).toEqual({ kind: 'idempotent' })
    expect(r.conflict).toBeUndefined()
  })
})

describe('SY-22 / SY-23 一端删、另一端改：保留修改', () => {
  it('★ 服务端已删、本机改 → keep_modified，墓碑被清空', () => {
    const r = decideBookmark('updated', local(), remote({ deletedAt: '2026-10-12T09:30:00Z' }), 3, 'dev_other')
    expect(r.action).toEqual({ kind: 'keep_modified' })
    expect(r.conflict).toBeDefined()
    expect(r.conflict!.resolution).toBe('keep_both')
    expect((r.conflict!.resolved as BookmarkServerState).deletedAt).toBeNull()
    expect(r.conflict!.serverVersion).toBe(3)
    expect(r.conflict!.deletedByDevice).toBe('dev_other')
  })

  it('SY-23 说明里点明"曾删除"', () => {
    const r = decideBookmark('updated', local(), remote({ deletedAt: '2026-10-12T09:30:00Z' }), 3)
    expect(r.conflict!.note).toContain('删除')
  })

  it('本机要删、服务端已改（版本对不上）→ 删除不执行，保留修改', () => {
    const r = decideBookmark('deleted', local(), remote(), 2) // base 2 ≠ server 3
    expect(r.action).toEqual({ kind: 'keep_modified' })
    expect(r.conflict!.note).toContain('删除未执行')
  })

  it('keep_modified 时 resolved 是恢复后的记录，版本递增', () => {
    const r = decideBookmark('updated', local(), remote({ deletedAt: 'x', version: 7 }), 7)
    expect((r.conflict!.resolved as BookmarkServerState).version).toBe(8)
  })
})

describe('SY-17 ~ SY-21 两端都改：两份都保留（裁决 3）', () => {
  it('★ 版本对不上且内容不同 → keep_both', () => {
    const r = decideBookmark('updated', local({ name: '本机改的' }), remote({ name: '服务端改的' }), 2)
    expect(r.action).toEqual({ kind: 'keep_both' })
    expect(r.conflict!.resolution).toBe('keep_both')
  })

  it('SY-20 冲突项同时给出双方内容', () => {
    const r = decideBookmark('updated', local({ name: '本机改的' }), remote({ name: '服务端改的' }), 2)
    expect((r.conflict!.local as BookmarkPayload).name).toBe('本机改的')
    expect((r.conflict!.remote as BookmarkServerState).name).toBe('服务端改的')
  })

  it('SY-18 resolved 为 null（新记录 id 由服务端生成，不在这里编）', () => {
    const r = decideBookmark('updated', local({ name: 'a' }), remote({ name: 'b' }), 2)
    expect(r.conflict!.resolved).toBeNull()
  })

  it('SY-19 本机那份名字带「（本机）」后缀', () => {
    expect(bothSuffix('我的书签')).toBe('我的书签（本机）')
  })

  it('SY-19 名字为空时用「书签」兜底，不留空名', () => {
    expect(bothSuffix(null)).toBe('书签（本机）')
    expect(bothSuffix('')).toBe('书签（本机）')
    expect(bothSuffix('   ')).toBe('书签（本机）')
  })

  it('SY-16 两端各新增不同书签 → 并集，无冲突', () => {
    const r = decideBookmark('created', local({ bookmarkId: 'bm_new' }), null, undefined)
    expect(r.action).toEqual({ kind: 'insert' })
    expect(r.conflict).toBeUndefined()
  })

  it('版本对不上但内容相同 → 幂等（不造重复副本）', () => {
    const r = decideBookmark('updated', local({ name: '服务端名' }), remote(), 999)
    expect(r.action).toEqual({ kind: 'idempotent' })
  })

  it('★ D-12 只改名不改位置：内容判定只看名字与锚点，锚点相同则不动位置', () => {
    // 锚点缺省时由 service 层沿用库里的值；这里验证"只改名"不会被当成 keep_both
    const r = decideBookmark('updated', local({ name: '新名', anchor: anchor(5) }), remote({ name: '旧名', anchor: anchor(5) }), 3)
    expect(r.action).toEqual({ kind: 'update' })
    expect(r.conflict).toBeUndefined()
  })

  it('锚点不同但名字相同 → 内容不同，走冲突（位置确实变了）', () => {
    const r = decideBookmark('updated', local({ name: '同一个名字', anchor: anchor(9) }), remote({ name: '同一个名字', anchor: anchor(5) }), 2)
    expect(r.action).toEqual({ kind: 'keep_both' })
  })
})

describe('SY-05 / SY-07 / SY-08 进度合并', () => {
  function progLocal(over: Partial<{ anchor: Anchor; updatedAt: string; baseVersion: number }> = {}) {
    return {
      docId: 'doc_1',
      anchor: over.anchor ?? anchor(10),
      lastSentenceIndex: 0,
      updatedAt: over.updatedAt ?? '2026-10-12T10:00:00.000Z',
      baseVersion: over.baseVersion ?? 3,
    }
  }

  function progRemote(over: Partial<ProgressServerState> = {}): ProgressServerState {
    return {
      progressId: 'pg_1',
      anchor: anchor(10),
      lastSentenceIndex: 0,
      updatedAt: '2026-10-12T09:00:00.000Z',
      serverReceivedAt: '2026-10-12T09:00:00.000Z',
      version: 3,
      ...over,
    }
  }

  it('SY-05 版本对得上 → 正常更新', () => {
    expect(decideProgress(progLocal({ baseVersion: 3 }), progRemote({ version: 3 })).action).toBe('update')
  })

  it('SY-07 版本对不上且本机更新、位置更靠后 → take_local', () => {
    const d = decideProgress(
      progLocal({ baseVersion: 2, anchor: anchor(20), updatedAt: '2026-10-12T11:00:00Z' }),
      progRemote({ version: 3, anchor: anchor(10) }),
    )
    expect(d.action).toBe('take_local')
    expect(d.conflict!.resolution).toBe('superseded')
  })

  it('★ SY-08 不回退保护：本机时间更新但位置更靠前 → 保留服务端较前的位置', () => {
    const d = decideProgress(
      progLocal({ baseVersion: 2, anchor: anchor(2), updatedAt: '2026-10-12T11:00:00Z' }),
      progRemote({ version: 3, anchor: anchor(50) }),
    )
    expect(d.action).toBe('keep_remote')
    expect(d.conflict!.note).toContain('倒退')
  })

  it('本机时间更旧 → 保留服务端', () => {
    const d = decideProgress(
      progLocal({ baseVersion: 2, anchor: anchor(99), updatedAt: '2026-10-12T08:00:00Z' }),
      progRemote({ version: 3, anchor: anchor(10) }),
    )
    expect(d.action).toBe('keep_remote')
  })

  it('★ 进度冲突的 resolution 恒为 superseded（不落库，服务端当场裁完）', () => {
    for (const [la, ra, lu] of [
      [20, 10, '2026-10-12T11:00:00Z'],
      [2, 50, '2026-10-12T11:00:00Z'],
      [99, 10, '2026-10-12T08:00:00Z'],
    ] as const) {
      const d = decideProgress(
        progLocal({ baseVersion: 2, anchor: anchor(la), updatedAt: lu }),
        progRemote({ version: 3, anchor: anchor(ra) }),
      )
      expect(d.conflict.resolution).toBe('superseded')
    }
  })

  it('take_local 时 resolved 是本机内容且版本递增', () => {
    const d = decideProgress(
      progLocal({ baseVersion: 2, anchor: anchor(20), updatedAt: '2026-10-12T11:00:00Z' }),
      progRemote({ version: 5, anchor: anchor(10) }),
    )
    expect((d.conflict!.resolved as { version: number }).version).toBe(6)
  })

  it('keep_remote 时 resolved 原样是服务端那条', () => {
    const r = progRemote({ version: 3, anchor: anchor(50) })
    const d = decideProgress(progLocal({ baseVersion: 2, anchor: anchor(2) }), r)
    expect(d.conflict!.resolved).toEqual(r)
  })

  it('位置相同时按时间判（不触发不回退保护）', () => {
    const d = decideProgress(
      progLocal({ baseVersion: 2, anchor: anchor(10), updatedAt: '2026-10-12T11:00:00Z' }),
      progRemote({ version: 3, anchor: anchor(10) }),
    )
    expect(d.action).toBe('take_local')
  })
})
