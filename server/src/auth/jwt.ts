import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { E } from '../errors'
import { SERVER_ROOT } from '../db'

/**
 * 访问令牌：自签 HS256 JWT。
 * 契约 §1 规定载荷含 sub(userId) / jti / iat / exp / typ:"access"。
 *
 * 这里自己实现而不用 jsonwebtoken：HS256 的签名就是 HMAC-SHA256 加一次
 * base64url 编码，用 node:crypto 的原语即可，少一个依赖。
 * 安全性取决于两点，下面都做了：拒绝非 HS256 的 alg（防 alg 混淆/alg:none），
 * 以及用定长比较校验签名。
 */

const HEADER = { alg: 'HS256', typ: 'JWT' }

export const ACCESS_TTL_SEC = 30 * 60 // 30 分钟
export const REFRESH_TTL_SEC = 14 * 24 * 60 * 60 // 14 天

export interface AccessPayload {
  sub: string
  jti: string
  iat: number
  exp: number
  typ: 'access'
}

/** 密钥：优先环境变量；其次落到 server/data/.jwt-secret；都没有就生成一个并存下来 */
function loadSecret(): Buffer {
  if (process.env.JWT_SECRET) return Buffer.from(process.env.JWT_SECRET, 'utf8')

  const p = join(SERVER_ROOT, 'data', '.jwt-secret')
  if (existsSync(p)) return Buffer.from(readFileSync(p, 'utf8').trim(), 'hex')

  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const secret = randomBytes(48).toString('hex')
  writeFileSync(p, secret, 'utf8')
  console.log('已生成新的 JWT 密钥：server/data/.jwt-secret')
  return Buffer.from(secret, 'hex')
}

let cached: Buffer | null = null
function secret(): Buffer {
  if (!cached) cached = loadSecret()
  return cached
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export function signAccessToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: AccessPayload = {
    sub: userId,
    jti: randomUUID().replace(/-/g, ''),
    iat: now,
    exp: now + ACCESS_TTL_SEC,
    typ: 'access',
  }
  const h = b64url(Buffer.from(JSON.stringify(HEADER), 'utf8'))
  const p = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = createHmac('sha256', secret()).update(`${h}.${p}`).digest()
  return `${h}.${p}.${b64url(sig)}`
}

export function verifyAccessToken(token: string): AccessPayload {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw E.authRequired()
  }
  const [h, p, s] = parts

  let header: { alg?: string; typ?: string }
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
  } catch {
    throw E.authRequired()
  }
  // 防 alg 混淆 / alg:none
  if (header.alg !== 'HS256') {
    throw E.authRequired()
  }

  const expected = createHmac('sha256', secret()).update(`${h}.${p}`).digest()
  const given = Buffer.from(s, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw E.authRequired()
  }

  let payload: AccessPayload
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  } catch {
    throw E.authRequired()
  }
  if (payload.typ !== 'access') throw E.authRequired()

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw E.tokenExpired()
  }
  return payload
}
