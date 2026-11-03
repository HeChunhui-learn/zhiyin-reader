import { compareAnchor, type Anchor } from './anchor'

/**
 * 合并判定（契约 §8.5）。
 *
 * 这个文件只放纯函数，不碰数据库 —— 合并语义是 R5 里最容易出错的部分，
 * 单独拎出来才方便逐条对着文档核。
 */

export type Resolution = 'keep_both' | 'require_user_choice' | 'superseded'

export interface ConflictEnvelope {
  scope: 'progress' | 'bookmark'
  key: string
  baseVersion: number
  serverVersion: number
  local: unknown
  remote: unknown
  resolution: Resolution
  /** 服务端已落库的结果；require_user_choice 时为 null */
  resolved: unknown | null
  /** 给人看的一句话说明，界面直接展示 */
  note?: string
  /** 删改冲突时用：哪个设备删过它（删改冲突需要知道来源设备） */
  deletedByDevice?: string
}

/** 契约 §8.5：双方 updatedAt 差值小于这个值时，改用 serverReceivedAt 判定先后 */
export const CLOCK_SKEW_MS = 5000

/**
 * 判定两条记录谁更新。
 *
 * 先用客户端提供的 updatedAt；两者相差不到 5 秒时，改以服务端接收时间判定，
 * 以免客户端时钟有偏时判错先后。
 */
export function isNewer(
  a: { updatedAt: string; serverReceivedAt?: string },
  b: { updatedAt: string; serverReceivedAt?: string },
): boolean {
  const at = Date.parse(a.updatedAt)
  const bt = Date.parse(b.updatedAt)
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return false

  if (Math.abs(at - bt) >= CLOCK_SKEW_MS) return at > bt

  const as = a.serverReceivedAt ? Date.parse(a.serverReceivedAt) : NaN
  const bs = b.serverReceivedAt ? Date.parse(b.serverReceivedAt) : NaN
  if (Number.isFinite(as) && Number.isFinite(bs)) return as > bs
  return at > bt
}

/* ------------------------------------------------------------ 书签合并 */

export interface BookmarkPayload {
  bookmarkId: string
  docId: string
  /** 可以不传：契约 §8.1 的 updated / deleted 条目里没有这个字段，缺省沿用库里的 */
  anchor: Anchor
  name: string | null
  updatedAt: string
  deletedAt?: string | null
}

export interface BookmarkServerState {
  bookmarkId: string
  docId: string
  anchor: Anchor
  name: string | null
  updatedAt: string
  deletedAt: string | null
  version: number
}

export type BookmarkAction =
  /** 直接落库 */
  | { kind: 'insert' }
  | { kind: 'update' }
  | { kind: 'idempotent' }
  /** keep_both：原件保留服务端内容，另存一份带上「（本机）」后缀的本机版本 */
  | { kind: 'keep_both' }
  /** 删改冲突：保留修改、不执行删除，只标注谁删过 */
  | { kind: 'keep_modified' }

export interface BookmarkDecision {
  action: BookmarkAction
  conflict?: ConflictEnvelope
}

/** 内容是否等价（用于幂等判定，看名字与锚点位置） */
function sameContent(
  a: Pick<BookmarkPayload, 'name' | 'anchor'>,
  b: Pick<BookmarkServerState, 'name' | 'anchor'>,
): boolean {
  return (a.name ?? null) === (b.name ?? null) && compareAnchor(a.anchor, b.anchor) === 0
}

/**
 * 决定一条书签变更怎么落库。
 *
 * @param op       客户端声明的意图：新增 / 修改 / 删除
 * @param local    本机提交的内容
 * @param remote   服务端当前的内容（不存在则为 null）
 * @param baseVersion 本机所基于的版本（删除与新增时可能没有）
 */
export function decideBookmark(
  op: 'created' | 'updated' | 'deleted',
  local: BookmarkPayload,
  remote: BookmarkServerState | null,
  baseVersion: number | undefined,
  deletingDeviceId?: string,
): BookmarkDecision {
  // —— 服务端还没有这条：新增；若本机是"改/删"，视为把它建出来（离线补报的常见情形）
  if (!remote) {
    return { action: op === 'deleted' ? { kind: 'idempotent' } : { kind: 'insert' } }
  }

  // 两边都删：幂等，不构成冲突（§8.5）
  if (op === 'deleted' && remote.deletedAt) {
    return { action: { kind: 'idempotent' } }
  }

  // 一端删除、另一端修改：保留修改后的书签，不执行删除（§8.5）
  if (remote.deletedAt && op !== 'deleted') {
    return {
      action: { kind: 'keep_modified' },
      conflict: {
        scope: 'bookmark',
        key: local.bookmarkId,
        baseVersion: baseVersion ?? 0,
        serverVersion: remote.version,
        local,
        remote,
        resolution: 'keep_both',
        // 修改胜出，原样恢复；resolved 就是恢复后的记录
        resolved: { ...remote, deletedAt: null, version: remote.version + 1 },
        note: '该设备曾删除此书签，已保留修改后的版本',
        deletedByDevice: deletingDeviceId,
      },
    }
  }

  // 版本对得上：正常落库
  if (baseVersion !== undefined && baseVersion === remote.version) {
    if (op === 'deleted') return { action: { kind: 'update' } }
    if (sameContent(local, remote)) return { action: { kind: 'idempotent' } }
    return { action: { kind: 'update' } }
  }

  // 版本对不上 = 并发修改
  if (op === 'deleted') {
    // 本机要删，服务端已改 —— 交给上面的"删改冲突"分支处理过了；
    // 走到这里说明服务端没删、本机要删且版本对不上，属于"删除撞上修改"
    return {
      action: { kind: 'keep_modified' },
      conflict: {
        scope: 'bookmark',
        key: local.bookmarkId,
        baseVersion: baseVersion ?? 0,
        serverVersion: remote.version,
        local,
        remote,
        resolution: 'keep_both',
        resolved: { ...remote, version: remote.version + 1 },
        note: '另一端已修改该书签，本次删除未执行',
      },
    }
  }

  if (sameContent(local, remote)) {
    return { action: { kind: 'idempotent' } }
  }

  // 双方都改了同一条：两份都保留，服务端生成第二条记录的 id（docs/system-design.md §7 裁决 3）
  return {
    action: { kind: 'keep_both' },
    conflict: {
      scope: 'bookmark',
      key: local.bookmarkId,
      baseVersion: baseVersion ?? 0,
      serverVersion: remote.version,
      local,
      remote,
      resolution: 'keep_both',
      // 原件保留服务端内容；本机版本另存为一条新记录，名字加后缀便于区分。
      // resolved 指向**本机那条新记录**（它有服务端生成的 id）。
      resolved: null,
      note: '两端都改过这条书签，两份都保留了',
    },
  }
}

/** keep_both 时给本机那份的名字加后缀，让读者在列表里分得清（契约 §8.2 的例子就是这么写的） */
export function bothSuffix(name: string | null): string {
  const base = (name ?? '').trim() || '书签'
  return `${base}（本机）`
}

/* ------------------------------------------------------------ 进度合并 */

export interface ProgressPayload {
  docId: string
  anchor: Anchor
  lastSentenceIndex: number | null
  updatedAt: string
  baseVersion: number
}

export interface ProgressServerState {
  progressId: string
  anchor: Anchor
  lastSentenceIndex: number | null
  updatedAt: string
  serverReceivedAt: string
  version: number
}

/**
 * 进度合并的结果。
 * 注意没有 'insert' —— 服务端还没有这条记录属于"首次上报"，在 service 层就处理掉了，
 * 走不到合并判定这里。
 */
export type ProgressDecision =
  | { action: 'update' }
  | { action: 'keep_remote'; conflict: ConflictEnvelope }
  | { action: 'take_local'; conflict: ConflictEnvelope }

/**
 * 决定进度怎么合并（契约 §8.5 的阅读进度那一节）。
 *
 * 契约原文的两条规则是：
 *   1. 取 updatedAt 较新者；
 *   2. 施加不回退保护 ——「若较新记录的位置早于本机已读位置，保留较前的位置」。
 *
 * 第 2 条原文是循环表述（原文「较新」与「较前」互相指涉），
 * 这里把它落成一条能写成代码的规则：**位置靠后的一方胜出**。
 * 也就是说，只有当"时间上更新的一方"其位置反而更靠后时，位置规则才推翻时间规则 ——
 * 那正是会造成阅读进度倒退的情形，也正是这条保护想防的。
 */
export function decideProgress(
  local: ProgressPayload,
  remote: ProgressServerState,
): ProgressDecision {
  if (remote.version === local.baseVersion) return { action: 'update' }

  const localNewer = isNewer(local, remote)
  const localBehind = compareAnchor(local.anchor, remote.anchor) < 0

  // 时间上本机更新，但位置反而更靠前 —— 正常情况下采纳本机
  if (localNewer && !localBehind) {
    return {
      action: 'take_local',
      conflict: {
        scope: 'progress',
        key: local.docId,
        baseVersion: local.baseVersion,
        serverVersion: remote.version,
        local,
        remote,
        resolution: 'superseded',
        resolved: { ...local, version: remote.version + 1 },
        note: '另一端的进度较旧，已采用本机进度',
      },
    }
  }

  // 本机时间更新但位置更靠后：不能倒退，保留服务端那条（不回退保护）
  if (localNewer && localBehind) {
    return {
      action: 'keep_remote',
      conflict: {
        scope: 'progress',
        key: local.docId,
        baseVersion: local.baseVersion,
        serverVersion: remote.version,
        local,
        remote,
        resolution: 'superseded',
        resolved: remote,
        note: '本机进度晚于另一端的阅读位置，为避免倒退保留了较前的位置',
      },
    }
  }

  // 本机时间更旧：保留服务端
  return {
    action: 'keep_remote',
    conflict: {
      scope: 'progress',
      key: local.docId,
      baseVersion: local.baseVersion,
      serverVersion: remote.version,
      local,
      remote,
      resolution: 'superseded',
      resolved: remote,
      note: '另一端的进度更新，已采用',
    },
  }
}
