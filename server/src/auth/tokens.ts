import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { dal, now } from '../dao'
import { E } from '../errors'
import { ACCESS_TTL_SEC, REFRESH_TTL_SEC, signAccessToken } from './jwt'

/**
 * 刷新令牌：服务端生成的 256 位随机串，以哈希形式存于 T_Token（契约 §1）。
 * 每次刷新即轮换，旧的立即失效。
 */

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export function issueTokenPair(
  userId: string,
  deviceId: string | null,
): TokenPair {
  const refreshToken = `rt_${randomBytes(32).toString('hex')}`

  dal.insertToken({
    token_id: `tk_${randomUUID().replace(/-/g, '')}`,
    user_id: userId,
    device_id: deviceId,
    refresh_hash: sha256(refreshToken),
    expires_at: new Date(Date.now() + REFRESH_TTL_SEC * 1000).toISOString(),
    created_at: now(),
  })

  return {
    accessToken: signAccessToken(userId),
    refreshToken,
    expiresIn: ACCESS_TTL_SEC,
  }
}

export function rotateRefreshToken(
  raw: string,
  deviceId?: string | null,
): TokenPair {
  if (typeof raw !== 'string' || !raw.startsWith('rt_')) throw E.refreshInvalid()

  const row = dal.findTokenByHash(sha256(raw))
  if (!row) throw E.refreshInvalid()

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    dal.deleteToken(row.token_id)
    throw E.refreshInvalid()
  }

  // 轮换：旧记录直接删掉，重放旧令牌会落到上面那个分支
  dal.deleteToken(row.token_id)
  return issueTokenPair(row.user_id, deviceId ?? row.device_id)
}

/** 契约 §3.4：退出登录删除该令牌记录 */
export function revokeRefreshToken(raw: string): void {
  if (typeof raw !== 'string') return
  const row = dal.findTokenByHash(sha256(raw))
  if (row) dal.deleteToken(row.token_id)
}
