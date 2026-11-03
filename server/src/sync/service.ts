import { randomUUID } from 'node:crypto'
import {
  dal,
  now,
  newId,
  type BookmarkRow,
  type ReadingProgressRow,
  type SyncRecordRow,
} from '../dao'
import { DEFAULT_ANCHOR, normalizeAnchor, type Anchor } from './anchor'
import {
  bothSuffix,
  decideBookmark,
  decideProgress,
  type BookmarkPayload,
  type BookmarkServerState,
  type ConflictEnvelope,
  type ProgressPayload,
  type ProgressServerState,
} from './merge'

/**
 * 把合并判定落到数据库。
 * 判定本身在 merge.ts（纯函数），这里只负责读写与组装响应。
 */

/* ------------------------------------------------------------ 冲突落库 */

/**
 * 把冲突写进 T_SyncRecord，保证"未决冲突不丢失"（契约 §2.2.6 的可靠性要求）。
 *
 * 放在 service 层而不是路由层，是因为**三条写入路径**都要落库：
 * `POST /api/sync`（批量）、`PATCH /api/bookmarks/:id`（单项，演示脚本走的正是这条）、
 * `PUT /api/documents/:id/progress`。R5 只在批量那条上落了库，所以"两个窗口改名"
 * 制造出来的冲突一直只活在响应体里，刷新页面就没了 —— 这正是 A4 要修的。
 */
export function persistConflict(
  userId: string,
  docId: string,
  deviceId: string,
  conflict: ConflictEnvelope,
): SyncRecordRow {
  const row: SyncRecordRow = {
    record_id: newId('sr'),
    user_id: userId,
    doc_id: docId,
    device_id: deviceId || null,
    state: '冲突',
    local_delta: JSON.stringify(conflict.local),
    remote_changes: JSON.stringify(conflict.remote),
    conflict_json: JSON.stringify(conflict),
    version: 1,
    updated_at: now(),
  }
  dal.insertSyncRecord(row)
  return row
}

/**
 * 这条冲突要不要落库。
 *
 * `superseded`（进度冲突）**不落**：服务端已按"不回退保护"当场裁决完毕，
 * 契约 §8.5 的语义就是"以较新者为准"，读者无事可做。
 * 把它也写成"冲突"记录，会让每次换设备阅读都攒下一条永远没人裁决、
 * 于是每次打开阅读页都要重弹一遍的幽灵冲突。
 *
 * 书签的 `keep_both` 则要落：服务端只是"两份都留着"，到底留哪一份得读者点，
 * 在读者点之前它就是未决的（见 ConflictDialog 的三选一说明）。
 */
function needsReaderChoice(conflict: ConflictEnvelope): boolean {
  return conflict.resolution !== 'superseded'
}

/**
 * T_SyncRecord 里的一行 → 冲突信封（A4 的读回路径）。
 *
 * 行里存的就是当初整份信封的 JSON，直接还原；解析不出来说明这行是坏的，
 * 返回 null 让调用方跳过，别把整个接口带崩。
 */
export function syncRecordToConflict(row: SyncRecordRow): ConflictEnvelope | null {
  if (!row.conflict_json) return null
  try {
    return JSON.parse(row.conflict_json) as ConflictEnvelope
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ 序列化 */

export function progressToDto(row: ReadingProgressRow, currentDeviceId: string) {
  return {
    progressId: row.progress_id,
    deviceId: row.device_id,
    anchor: {
      chapterIndex: row.chapter_index,
      paragraphIndex: row.paragraph_index,
      sentenceIndex: row.last_sentence_index ?? 0,
      charOffset: row.char_offset,
      scrollOffset: row.scroll_offset,
    } satisfies Anchor,
    lastSentenceIndex: row.last_sentence_index,
    updatedAt: row.updated_at,
    serverReceivedAt: row.server_received_at,
    version: row.version,
    isCurrentDevice: row.device_id === currentDeviceId,
  }
}

export function bookmarkToDto(row: BookmarkRow) {
  return {
    bookmarkId: row.bookmark_id,
    docId: row.doc_id,
    name: row.name,
    anchor: JSON.parse(row.anchor_json) as Anchor,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

function toServerState(row: BookmarkRow): BookmarkServerState {
  return {
    bookmarkId: row.bookmark_id,
    docId: row.doc_id,
    anchor: JSON.parse(row.anchor_json) as Anchor,
    name: row.name,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.version,
  }
}

/* ------------------------------------------------------------ 进度 */

export interface ProgressApplyResult {
  progressId: string
  version: number
  updatedAt: string
  serverReceivedAt: string
  outcome: 'applied' | 'conflict'
  conflict?: ConflictEnvelope
}

export function applyProgress(
  userId: string,
  deviceId: string,
  payload: ProgressPayload,
): ProgressApplyResult {
  const receivedAt = now()
  const anchor = normalizeAnchor(payload.anchor)

  const existing = dal.getProgressByDocAndDevice(userId, payload.docId, deviceId)

  // 该设备在这篇文档上还没有记录：直接建
  if (!existing) {
    const row: ReadingProgressRow = {
      progress_id: newId('pg'),
      user_id: userId,
      doc_id: payload.docId,
      device_id: deviceId,
      chapter_index: anchor.chapterIndex,
      paragraph_index: anchor.paragraphIndex,
      char_offset: anchor.charOffset,
      scroll_offset: anchor.scrollOffset,
      last_sentence_index: payload.lastSentenceIndex ?? null,
      updated_at: payload.updatedAt,
      server_received_at: receivedAt,
      version: 1,
    }
    dal.insertProgress(row)
    return {
      progressId: row.progress_id,
      version: 1,
      updatedAt: row.updated_at,
      serverReceivedAt: receivedAt,
      outcome: 'applied',
    }
  }

  const remote: ProgressServerState = {
    progressId: existing.progress_id,
    anchor: {
      chapterIndex: existing.chapter_index,
      paragraphIndex: existing.paragraph_index,
      sentenceIndex: existing.last_sentence_index ?? 0,
      charOffset: existing.char_offset,
      scrollOffset: existing.scroll_offset,
    },
    lastSentenceIndex: existing.last_sentence_index,
    updatedAt: existing.updated_at,
    serverReceivedAt: existing.server_received_at,
    version: existing.version,
  }

  const decision = decideProgress({ ...payload, anchor }, remote)

  if (decision.action === 'update') {
    const ok = dal.updateProgressIfVersion(existing.progress_id, payload.baseVersion, {
      chapter_index: anchor.chapterIndex,
      paragraph_index: anchor.paragraphIndex,
      char_offset: anchor.charOffset,
      scroll_offset: anchor.scrollOffset,
      last_sentence_index: payload.lastSentenceIndex ?? null,
      updated_at: payload.updatedAt,
      server_received_at: receivedAt,
    })
    return {
      progressId: existing.progress_id,
      version: existing.version + (ok ? 1 : 0),
      updatedAt: payload.updatedAt,
      serverReceivedAt: receivedAt,
      outcome: 'applied',
    }
  }

  if (decision.action === 'take_local') {
    dal.forceProgress(existing.progress_id, {
      chapter_index: anchor.chapterIndex,
      paragraph_index: anchor.paragraphIndex,
      char_offset: anchor.charOffset,
      scroll_offset: anchor.scrollOffset,
      last_sentence_index: payload.lastSentenceIndex ?? null,
      updated_at: payload.updatedAt,
      server_received_at: receivedAt,
    })
    // 注意：进度冲突**不落 T_SyncRecord**。decideProgress 只会产出
    // resolution = 'superseded' 的信封，那是服务端当场就裁决完的（"不回退保护"），
    // 读者无事可做；写成"冲突"记录只会让每次换设备阅读都攒一条永远没人处理的
    // 幽灵冲突，每次打开阅读页都要重弹一遍。需要落库的是书签冲突，见 applyBookmark。
    return {
      progressId: existing.progress_id,
      version: existing.version + 1,
      updatedAt: payload.updatedAt,
      serverReceivedAt: receivedAt,
      outcome: 'applied',
      conflict: decision.conflict,
    }
  }

  // keep_remote：本机这条被舍弃，服务端记录保持不动
  return {
    progressId: existing.progress_id,
    version: existing.version,
    updatedAt: existing.updated_at,
    serverReceivedAt: existing.server_received_at,
    outcome: 'conflict',
    conflict: decision.conflict,
  }
}

/* ------------------------------------------------------------ 书签 */

export interface BookmarkApplyResult {
  applied: boolean
  version: number
  row?: BookmarkRow
  conflict?: ConflictEnvelope
  /** keep_both 时新生成的那条记录（服务端分配 id，docs/system-design.md §7 裁决 3） */
  extra?: BookmarkRow
}

export function applyBookmark(
  userId: string,
  op: 'created' | 'updated' | 'deleted',
  payload: BookmarkPayload,
  baseVersion: number | undefined,
  deviceId: string,
): BookmarkApplyResult {
  const existing = dal.getBookmarkById(payload.bookmarkId)

  // 不属于当前用户的 id 一律当作不存在，避免跨用户改别人的书签
  const remote = existing && existing.user_id === userId ? existing : null
  if (existing && !remote) {
    return { applied: false, version: 0 }
  }

  // 契约 §8.1 的 updated / deleted 条目**不带 anchor**（只有 created 带）。
  // 所以锚点缺省时必须沿用库里已有的，不能 normalize 成 (0,0,0,0,0) 把位置冲掉。
  const anchor: Anchor =
    payload.anchor === undefined || payload.anchor === null
      ? remote
        ? (JSON.parse(remote.anchor_json) as Anchor)
        : DEFAULT_ANCHOR
      : normalizeAnchor(payload.anchor)

  const local: BookmarkPayload = { ...payload, anchor }
  const decision = decideBookmark(
    op,
    local,
    remote ? toServerState(remote) : null,
    baseVersion,
    deviceId,
  )

  const occurredAt = payload.updatedAt || now()

  /**
   * 只有 keep_modified / keep_both 两个分支会带冲突（insert / update / idempotent
   * 都是版本对得上或首次落库，无冲突可言），所以只在这两处出口调它。
   */
  const done = (r: BookmarkApplyResult): BookmarkApplyResult => {
    if (r.conflict && needsReaderChoice(r.conflict)) {
      persistConflict(userId, payload.docId, deviceId, r.conflict)
    }
    return r
  }

  switch (decision.action.kind) {
    case 'idempotent':
      return { applied: false, version: remote?.version ?? 0, row: remote ?? undefined }

    case 'insert': {
      const row: BookmarkRow = {
        bookmark_id: payload.bookmarkId,
        user_id: userId,
        doc_id: payload.docId,
        anchor_json: JSON.stringify(anchor),
        name: payload.name ?? null,
        version: 1,
        created_at: occurredAt,
        updated_at: occurredAt,
        deleted_at: null,
      }
      dal.insertBookmark(row)
      return { applied: true, version: 1, row }
    }

    case 'update': {
      if (!remote) return { applied: false, version: 0 }
      const isDelete = op === 'deleted'
      const ok = dal.updateBookmarkIfVersion(payload.bookmarkId, baseVersion ?? remote.version, {
        anchor_json: JSON.stringify(anchor),
        name: payload.name ?? null,
        updated_at: isDelete ? (payload.deletedAt ?? occurredAt) : occurredAt,
        // ★ 软删除也要刷新 updated_at，否则墓碑拉不到（docs/system-develop.md §4.6 第 3 条）
        ...(isDelete ? { deleted_at: payload.deletedAt ?? occurredAt } : {}),
      })
      const fresh = dal.getBookmarkById(payload.bookmarkId)!
      return { applied: ok, version: fresh.version, row: fresh }
    }

    case 'keep_modified': {
      // 保留修改、不执行删除；同时把墓碑清掉（因为裁决结果就是"不删了"）
      dal.forceUpdateBookmark(payload.bookmarkId, {
        anchor_json: JSON.stringify(anchor),
        name: payload.name ?? null,
        updated_at: occurredAt,
        deleted_at: null,
      })
      const after = dal.getBookmarkById(payload.bookmarkId)!
      return done({
        applied: true,
        version: after.version,
        row: after,
        conflict: decision.conflict
          ? { ...decision.conflict, resolved: bookmarkToDto(after) }
          : undefined,
      })
    }

    case 'keep_both': {
      if (!remote) return { applied: false, version: 0 }
      // 原件保留服务端内容不动；本机版本另存一条新记录，id 由服务端生成（裁决 3）
      const newIdValue = `bm_${randomUUID().replace(/-/g, '')}`
      const copy: BookmarkRow = {
        bookmark_id: newIdValue,
        user_id: userId,
        doc_id: payload.docId,
        anchor_json: JSON.stringify(anchor),
        name: bothSuffix(payload.name),
        version: 1,
        created_at: occurredAt,
        updated_at: occurredAt,
        deleted_at: null,
      }
      dal.insertBookmark(copy)
      return done({
        applied: true,
        version: copy.version,
        row: copy,
        extra: copy,
        conflict: decision.conflict
          ? { ...decision.conflict, resolved: bookmarkToDto(copy) }
          : undefined,
      })
    }

    default:
      return { applied: false, version: 0 }
  }
}
