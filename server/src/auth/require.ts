import type { FastifyRequest } from 'fastify'
import { E } from '../errors'
import { verifyAccessToken } from './jwt'

/**
 * 从 Authorization: Bearer <accessToken> 里取出 userId。
 * 契约 §1：除注册/登录/刷新外，所有接口均需携带。
 */
export function requireUserId(req: FastifyRequest): string {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) throw E.authRequired()
  const token = h.slice('Bearer '.length).trim()
  if (!token) throw E.authRequired()
  return verifyAccessToken(token).sub
}
