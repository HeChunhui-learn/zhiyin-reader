import { dal, now, type IdempotencyRow } from './dao'

/**
 * 幂等键（契约 §1）。
 *
 * 「批量同步与二进制上传接口支持 `Idempotency-Key` 请求头（客户端生成 UUID）；
 *  服务端在 24 小时内对相同键返回首次结果，用于抵御重复提交。」
 *
 * R5 的实现是 routes/sync.ts 里一个进程内存的 Map —— 服务端一重启，键就没了，
 * 而契约要求 24 小时内有效。A2 把它换成 T_Idempotency 表。
 *
 * 这一份是**通用工具**，不绑死 /api/sync：第二轮 A3 要把幂等套到书签与进度
 * 这些可能被离线队列重放的单项接口上，届时只需换一个 scope 调 withIdempotency。
 */

/** 契约 §1：24 小时 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 清理节流：最多每小时扫一次。
 *
 * 契约要求的是「过期的定期清理」，但为了一个定时器去动 server/src/index.ts
 * （不在本轮可改文件清单里）不划算，也没必要 —— 改成在写入路径上机会式清理，
 * 用时间戳节流，效果一样，且完全内聚在本模块内。
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

let lastSweepAt = 0

/** 哪些接口在用幂等键。存进表里，清理与排查时能分清来源 */
export type IdempotencyScope = 'sync' | 'bookmark' | 'progress'

/**
 * T_Idempotency 里的一行 → 有没有命中。
 *
 * 注意这里**同时**按 TTL 判一次，而不是只信清理任务：清理是节流的，两次清理
 * 之间表里可能存在刚过期的行。读取时判掉，24 小时这条语义才是准的。
 */
function toHit(row: IdempotencyRow, ttlMs: number): unknown | null {
  if (Date.now() - Date.parse(row.created_at) > ttlMs) return null
  try {
    return JSON.parse(row.response_json)
  } catch {
    // 行坏了（理论上不会）：当作没有命中最安全，让请求照常执行
    return null
  }
}

/** 命中首次结果则返回它，否则返回 null */
export function readIdempotent(
  userId: string,
  scope: IdempotencyScope,
  key: string,
  ttlMs: number = IDEMPOTENCY_TTL_MS,
): unknown | null {
  const row = dal.getIdempotency(userId, scope, key)
  if (!row) return null

  const hit = toHit(row, ttlMs)
  if (hit === null) {
    // 已过期：顺手删掉，别留着占位（也可能只是 JSON 坏了，一并清）
    dal.deleteIdempotency(userId, scope, key)
  }
  return hit
}

/** 记下首次请求的结果 */
export function rememberIdempotent(
  userId: string,
  scope: IdempotencyScope,
  key: string,
  body: unknown,
): void {
  const row: IdempotencyRow = {
    user_id: userId,
    idem_key: key,
    scope,
    response_json: JSON.stringify(body),
    created_at: now(),
  }
  dal.putIdempotency(row)
  maybeSweep()
}

/** 删除超过 TTL 的记录，返回条数。force = true 时忽略节流立即扫 */
export function sweepExpiredIdempotency(force = false): number {
  if (!force && Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return 0
  lastSweepAt = Date.now()
  const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString()
  return dal.deleteIdempotencyBefore(cutoff)
}

function maybeSweep(): void {
  sweepExpiredIdempotency(false)
}

/** 只认非空字符串。空串与缺省一律当"没带键"处理 */
export function idempotencyKeyOf(headers: Record<string, unknown>): string | null {
  const v = headers['idempotency-key']
  return typeof v === 'string' && v ? v : null
}

export interface IdempotentOutcome<T> {
  body: T
  /** true = 这是重放，返回的是首次结果，业务逻辑没有执行 */
  replayed: boolean
}

/**
 * 把一段**同步**的业务逻辑包成幂等的。
 *
 * @param headers 请求头（Fastify 的 req.headers）
 * @param scope   哪个接口在用
 * @param run     真正干活的函数；只在没有命中时才被调用
 *
 * 单进程内这是原子的：better-sqlite3 是同步 API，`run()` 里不会 await，
 * 所以从"查"到"写"之间没有别的请求能插进来（Node 单线程）。
 * 多进程部署需要把查+写放进一个事务里，课程设计是单进程，就不上这个复杂度了。
 */
export function withIdempotency<T>(
  headers: Record<string, unknown>,
  scope: IdempotencyScope,
  userId: string,
  run: () => T,
): IdempotentOutcome<T> {
  const key = idempotencyKeyOf(headers)
  if (!key) return { body: run(), replayed: false }

  const hit = readIdempotent(userId, scope, key)
  if (hit !== null) return { body: hit as T, replayed: true }

  const body = run()
  rememberIdempotent(userId, scope, key, body)
  return { body, replayed: false }
}
