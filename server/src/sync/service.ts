import { randomUUID } from 'node:crypto'
import { dal, now, newId, type BookmarkRow, type ReadingProgressRow } from '../dao'
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
  /** keep_both 时新生成的那条记录（服务端分配 id，CLAUDE.md 裁决 3） */
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
        // ★ 软删除也要刷新 updated_at，否则墓碑拉不到（材料审查 E15）
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
      return {
        applied: true,
        version: after.version,
        row: after,
        conflict: decision.conflict
          ? { ...decision.conflict, resolved: bookmarkToDto(after) }
          : undefined,
      }
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
      return {
        applied: true,
        version: copy.version,
        row: copy,
        extra: copy,
        conflict: decision.conflict
          ? { ...decision.conflict, resolved: bookmarkToDto(copy) }
          : undefined,
      }
    }

    default:
      return { applied: false, version: 0 }
  }
}
