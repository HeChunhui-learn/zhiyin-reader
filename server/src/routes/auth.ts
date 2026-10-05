import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireUserId } from '../auth/require'
import { hashPassword, makeSalt, validateAccount, validatePassword, verifyPassword } from '../auth/password'
import { issueTokenPair, revokeRefreshToken, rotateRefreshToken } from '../auth/tokens'
import { dal, now } from '../dao'
import { ApiError, E } from '../errors'

/** 契约 §2：连续失败 5 次锁 15 分钟 */
const MAX_FAIL = 5
const LOCK_MS = 15 * 60 * 1000

interface RegisterBody {
  account?: string
  password?: string
  nickname?: string
}

interface LoginBody {
  account?: string
  password?: string
  deviceId?: string
}

export default async function authRoutes(app: FastifyInstance) {
  /* ------------------------------------------------ 3.1 注册 */
  app.post<{ Body: RegisterBody }>('/api/auth/register', async (req, reply) => {
    const { account, password, nickname } = req.body ?? {}

    const accErr = validateAccount(account)
    const pwdErr = validatePassword(password)
    if (accErr || pwdErr) {
      const fields: string[] = []
      if (accErr) fields.push('account')
      if (pwdErr) fields.push('password')
      throw new ApiError(400, 'VALIDATION_FAILED', accErr ?? pwdErr!, { fields })
    }

    const acc = (account as string).trim()
    if (dal.getUserByAccount(acc)) throw E.accountExists()

    const salt = makeSalt()
    const user = dal.insertUser({
      user_id: `u_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      account: acc,
      password_hash: hashPassword(password as string, salt),
      salt,
      nickname: (nickname ?? '').trim() || acc.split('@')[0],
      created_at: now(),
    })

    // 契约 §3.1：注册只返回用户信息，不签发令牌；客户端随后调用登录接口
    return reply.code(201).send({
      userId: user.user_id,
      account: user.account,
      nickname: user.nickname,
      createdAt: user.created_at,
    })
  })

  /* ------------------------------------------------ 3.2 登录 */
  app.post<{ Body: LoginBody }>('/api/auth/login', async (req, reply) => {
    const { account, password, deviceId } = req.body ?? {}
    if (typeof account !== 'string' || typeof password !== 'string') {
      throw E.invalidCredential()
    }

    const user = dal.getUserByAccount(account.trim())

    // 账号不存在也返回同一个错误，避免用户枚举（契约 §2）
    if (!user) throw E.invalidCredential()

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      throw E.accountLocked(user.locked_until)
    }

    if (!verifyPassword(password, user.salt, user.password_hash)) {
      const lockedUntil = dal.recordLoginFailure(user.user_id, MAX_FAIL, LOCK_MS)
      if (lockedUntil) throw E.accountLocked(lockedUntil)
      throw E.invalidCredential()
    }

    dal.clearLoginFailure(user.user_id)
    const pair = issueTokenPair(user.user_id, deviceId ?? null)

    return {
      ...pair,
      user: {
        userId: user.user_id,
        account: user.account,
        nickname: user.nickname,
      },
    }
  })

  /* ------------------------------------------------ 3.3 刷新令牌 */
  app.post<{ Body: { refreshToken?: string; deviceId?: string } }>(
    '/api/auth/refresh',
    async (req) => {
      const { refreshToken, deviceId } = req.body ?? {}
      return rotateRefreshToken(refreshToken ?? '', deviceId ?? null)
    },
  )

  /* ------------------------------------------------ 3.4 退出登录 */
  app.post<{ Body: { refreshToken?: string } }>(
    '/api/auth/logout',
    async (req, reply) => {
      revokeRefreshToken(req.body?.refreshToken ?? '')
      return reply.code(204).send()
    },
  )

  /* ------------------------------------------------ 3.5 修改账号信息 */
  app.patch<{ Body: { nickname?: string; oldPassword?: string; newPassword?: string } }>(
    '/api/users/me',
    async (req) => {
      const userId = requireUserId(req)
      const user = dal.getUserById(userId)
      if (!user) throw E.notFound()

      const { nickname, oldPassword, newPassword } = req.body ?? {}

      // 改密码必须同时给原密码与新密码（契约 §3.5）
      const wantsPassword = oldPassword !== undefined || newPassword !== undefined
      if (wantsPassword) {
        if (!oldPassword || !newPassword) {
          throw new ApiError(400, 'VALIDATION_FAILED', '修改密码需同时提供原密码与新密码。', {
            fields: ['oldPassword', 'newPassword'],
          })
        }
        const pwdErr = validatePassword(newPassword)
        if (pwdErr) {
          throw new ApiError(400, 'VALIDATION_FAILED', pwdErr, { fields: ['newPassword'] })
        }
        // 契约 §2：原密码不对时用 401 AUTH_OLD_PASSWORD_WRONG
        if (!verifyPassword(oldPassword, user.salt, user.password_hash)) {
          throw new ApiError(401, 'AUTH_OLD_PASSWORD_WRONG', '原密码不正确。')
        }
        const salt = makeSalt()
        dal.updateUserPassword(user.user_id, hashPassword(newPassword, salt), salt)
      }

      if (nickname !== undefined) {
        const n = String(nickname).trim()
        if (n.length > 32) {
          throw new ApiError(400, 'VALIDATION_FAILED', '昵称不得超过 32 个字。', {
            fields: ['nickname'],
          })
        }
        dal.updateUserNickname(user.user_id, n || null)
      }

      const fresh = dal.getUserById(user.user_id)!
      return {
        userId: fresh.user_id,
        account: fresh.account,
        nickname: fresh.nickname,
        createdAt: fresh.created_at,
        lastLogin: fresh.last_login,
      }
    },
  )

  /* ------------------------------------------------ 3.5 当前用户 */
  app.get('/api/users/me', async (req) => {
    const userId = requireUserId(req)
    const user = dal.getUserById(userId)
    if (!user) throw E.notFound()
    return {
      userId: user.user_id,
      account: user.account,
      nickname: user.nickname,
      createdAt: user.created_at,
      lastLogin: user.last_login,
    }
  })
}
