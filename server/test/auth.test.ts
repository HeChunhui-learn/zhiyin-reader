import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { auth, closeApp, importBody, makeApp, registerAndLogin, type Session } from './helpers'

/**
 * AU-01 ~ AU-19 认证与账号（契约 §3 / §2）。
 *
 * 走 `app.inject()` 直接打真实路由，断言状态码、错误码与响应体结构 ——
 * 也就是 docs/02 里那批用例的可执行版本。
 */

let app: FastifyInstance
beforeAll(async () => {
  app = await makeApp()
})
afterAll(async () => {
  await closeApp(app)
})

const ok = (r: { statusCode: number; body: string }) => {
  if (r.statusCode >= 400) throw new Error(`${r.statusCode}: ${r.body}`)
  return JSON.parse(r.body)
}

describe('AU-01 ~ AU-03 注册', () => {
  it('AU-01 注册合法账号 → 201，返回用户信息，**不下发令牌**', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: 'au01@example.com', password: 'password123', nickname: '甲' },
    })
    expect(r.statusCode).toBe(201)
    const b = r.json()
    expect(b.userId).toMatch(/^u_/)
    expect(b.account).toBe('au01@example.com')
    expect(b.nickname).toBe('甲')
    expect(b.createdAt).toBeTruthy()
    // 契约 §3.1：注册不下发令牌
    expect(b.accessToken).toBeUndefined()
    expect(b.refreshToken).toBeUndefined()
    expect(b.expiresIn).toBeUndefined()
  })

  it('AU-01 未给昵称时用账号 @ 前的部分', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: 'nickname@example.com', password: 'password123' },
    })
    expect(r.json().nickname).toBe('nickname')
  })

  it('AU-02 重复账号 → 409 CONFLICT_ACCOUNT_EXISTS', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: 'au01@example.com', password: 'password123' },
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('CONFLICT_ACCOUNT_EXISTS')
  })

  it('AU-03 账号格式非法 + 密码不足 8 位 → 400，details.fields 列出两个字段', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: 'bad', password: '123' },
    })
    expect(r.statusCode).toBe(400)
    const b = r.json()
    expect(b.code).toBe('VALIDATION_FAILED')
    expect(b.details.fields).toContain('account')
    expect(b.details.fields).toContain('password')
  })

  it('AU-03 密码恰好 8 位可以通过，7 位不行', async () => {
    const seven = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: 'len7@example.com', password: '1234567' },
    })
    expect(seven.statusCode).toBe(400)
    const eight = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: 'len8@example.com', password: '12345678' },
    })
    expect(eight.statusCode).toBe(201)
  })

  it('AU-03 手机号也认', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: '13800138000', password: 'password123' },
    })
    expect(r.statusCode).toBe(201)
  })

  it('AU-19 注册响应也带 X-Request-Id，错误体回显同值', async () => {
    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: 'reqid@example.com', password: 'password123' },
    })
    expect(good.headers['x-request-id']).toMatch(/^req_[0-9a-f]{12}$/)
    expect(good.json().requestId).toBeUndefined() // 成功体不带 requestId

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: 'bad', password: 'x' },
    })
    expect(bad.json().requestId).toBe(bad.headers['x-request-id'])
  })
})

describe('AU-04 ~ AU-08 登录', () => {
  it('AU-04 正确账号密码 → 200，返回 accessToken / refreshToken / expiresIn / user', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { account: 'au04@example.com', password: 'password123', nickname: '乙' },
    })
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { account: 'au04@example.com', password: 'password123', deviceId: 'dev_a' },
    })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.accessToken).toBeTruthy()
    expect(b.refreshToken).toMatch(/^rt_[0-9a-f]{64}$/)
    expect(b.expiresIn).toBe(1800) // 契约：访问令牌 30 分钟
    expect(b.user).toMatchObject({ account: 'au04@example.com', nickname: '乙' })
    expect(b.user.userId).toMatch(/^u_/)
  })

  it('AU-05 密码错误 → 401 AUTH_INVALID_CREDENTIAL', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { account: 'au04@example.com', password: 'wrongpassword' },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().code).toBe('AUTH_INVALID_CREDENTIAL')
  })

  it('AU-06 ★ 不存在的账号与密码错误返回**同一个**错误码（防用户枚举）', async () => {
    const notExist = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { account: 'nobody@example.com', password: 'password123' },
    })
    const wrongPwd = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { account: 'au04@example.com', password: 'wrongpassword' },
    })
    expect(notExist.statusCode).toBe(wrongPwd.statusCode)
    expect(notExist.json().code).toBe(wrongPwd.json().code)
    expect(notExist.json().message).toBe(wrongPwd.json().message)
  })

  it('AU-06 错误信息是中文且不透露账号是否存在', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { account: 'nobody@example.com', password: 'password123' },
    })
    expect(r.json().message).toBe('账号或密码错误。')
  })

  it('AU-07 无令牌访问受保护接口 → 401 AUTH_REQUIRED', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/documents' })
    expect(r.statusCode).toBe(401)
    expect(r.json().code).toBe('AUTH_REQUIRED')
    expect(r.json().message).toBe('请先登录。')
  })

  it('AU-07 只有 Bearer 前缀、令牌为空 → 同样 401', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { authorization: 'Bearer ' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('AU-08 伪造令牌 → 401', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { authorization: 'Bearer not.a.real.token' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('AU-08 篡改过的令牌 → 401（签名校验生效）', async () => {
    const s = await registerAndLogin(app)
    const tampered = s.accessToken.slice(0, -4) + 'aaaa'
    const r = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { authorization: `Bearer ${tampered}` },
    })
    expect(r.statusCode).toBe(401)
  })
})

describe('AU-09 ~ AU-12 刷新与退出', () => {
  it('AU-09 刷新令牌换取新令牌对 → 200', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: s.refreshToken, deviceId: 'dev_a' },
    })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.accessToken).toBeTruthy()
    expect(b.refreshToken).toMatch(/^rt_/)
    expect(b.refreshToken).not.toBe(s.refreshToken) // 每次刷新即轮换
  })

  it('★ AU-10 旧刷新令牌重放 → 401 AUTH_REFRESH_INVALID（轮换后立即失效）', async () => {
    const s = await registerAndLogin(app)
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    })
    expect(first.statusCode).toBe(200)

    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    })
    expect(replay.statusCode).toBe(401)
    expect(replay.json().code).toBe('AUTH_REFRESH_INVALID')
  })

  it('AU-10 刷新出的新令牌可以继续用', async () => {
    const s = await registerAndLogin(app)
    const first = await app.inject({
      method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: s.refreshToken },
    })
    const second = await app.inject({
      method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: first.json().refreshToken },
    })
    expect(second.statusCode).toBe(200)
  })

  it('AU-10 形状不对的刷新令牌（不带 rt_ 前缀）→ 401', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: 'garbage' },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().code).toBe('AUTH_REFRESH_INVALID')
  })

  it('AU-11 退出登录 → 204', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/auth/logout', payload: { refreshToken: s.refreshToken },
    })
    expect(r.statusCode).toBe(204)
    expect(r.body).toBe('')
  })

  it('★ AU-12 退出后再用该刷新令牌 → 401', async () => {
    const s = await registerAndLogin(app)
    await app.inject({
      method: 'POST', url: '/api/auth/logout', payload: { refreshToken: s.refreshToken },
    })
    const r = await app.inject({
      method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: s.refreshToken },
    })
    expect(r.statusCode).toBe(401)
  })
})

describe('AU-13 ~ AU-15 连续失败锁定', () => {
  it('★ AU-13 连续 5 次密码错误 → 第 5 次返回 423 ACCOUNT_LOCKED', async () => {
    const account = `lock_${Math.random().toString(36).slice(2, 8)}@example.com`
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { account, password: 'password123' } })

    const codes: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { account, password: 'wrongpassword' },
      })
      codes.push(r.statusCode)
      if (i < 4) expect(r.statusCode, `第 ${i + 1} 次`).toBe(401)
    }
    expect(codes[4]).toBe(423)
  })

  it('AU-14 锁定期间用正确密码 → 仍然 423，details.lockedUntil 给出解锁时间', async () => {
    const account = `lock2_${Math.random().toString(36).slice(2, 8)}@example.com`
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { account, password: 'password123' } })
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password: 'wrongpassword' } })
    }

    const r = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { account, password: 'password123' },
    })
    expect(r.statusCode).toBe(423)
    expect(r.json().code).toBe('ACCOUNT_LOCKED')
    expect(r.json().details.lockedUntil).toBeTruthy()
    const until = Date.parse(r.json().details.lockedUntil)
    expect(Number.isFinite(until)).toBe(true)
    // 契约：锁 15 分钟
    expect(until - Date.now()).toBeGreaterThan(14 * 60 * 1000)
    expect(until - Date.now()).toBeLessThan(16 * 60 * 1000)
  })

  it('★ AU-15 锁定只影响该账号，另一账号正常登录', async () => {
    const locked = `lock3_${Math.random().toString(36).slice(2, 8)}@example.com`
    const other = `free3_${Math.random().toString(36).slice(2, 8)}@example.com`
    for (const a of [locked, other]) {
      await app.inject({ method: 'POST', url: '/api/auth/register', payload: { account: a, password: 'password123' } })
    }
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account: locked, password: 'wrongpassword' } })
    }

    const r = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { account: other, password: 'password123' },
    })
    expect(r.statusCode).toBe(200)
  })

  it('登录成功会清掉失败计数（不会攒到下次）', async () => {
    const account = `reset_${Math.random().toString(36).slice(2, 8)}@example.com`
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { account, password: 'password123' } })
    for (let i = 0; i < 4; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password: 'wrongpassword' } })
    }
    // 第 5 次用对的 —— 成功
    const good = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { account, password: 'password123' },
    })
    expect(good.statusCode).toBe(200)
    // 计数被清零，再错一次也只是 401
    const again = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { account, password: 'wrongpassword' },
    })
    expect(again.statusCode).toBe(401)
  })
})

describe('AU-16 ~ AU-18 修改账号信息（契约 §3.5）', () => {
  it('AU-16 改昵称 → 200，返回更新后的用户信息', async () => {
    const s = await registerAndLogin(app, { nickname: '旧名' })
    const r = await app.inject({
      method: 'PATCH', url: '/api/users/me', headers: auth(s), payload: { nickname: '新名' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().nickname).toBe('新名')

    const me = await app.inject({ method: 'GET', url: '/api/users/me', headers: auth(s) })
    expect(me.json().nickname).toBe('新名')
  })

  it('AU-16 昵称超过 32 字 → 400 VALIDATION_FAILED', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'PATCH', url: '/api/users/me', headers: auth(s), payload: { nickname: '甲'.repeat(33) },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toContain('nickname')
  })

  it('AU-17 改密码时原密码错误 → 401 AUTH_OLD_PASSWORD_WRONG（契约 §2 指定的码）', async () => {
    const s = await registerAndLogin(app, { password: 'password123' })
    const r = await app.inject({
      method: 'PATCH', url: '/api/users/me', headers: auth(s),
      payload: { oldPassword: 'wrongold', newPassword: 'newpassword123' },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json().code).toBe('AUTH_OLD_PASSWORD_WRONG')
  })

  it('AU-17 只给原密码不给新密码 → 400（契约要求同时给）', async () => {
    const s = await registerAndLogin(app, { password: 'password123' })
    const r = await app.inject({
      method: 'PATCH', url: '/api/users/me', headers: auth(s), payload: { oldPassword: 'password123' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toContain('newPassword')
  })

  it('AU-17 新密码不足 8 位 → 400', async () => {
    const s = await registerAndLogin(app, { password: 'password123' })
    const r = await app.inject({
      method: 'PATCH', url: '/api/users/me', headers: auth(s),
      payload: { oldPassword: 'password123', newPassword: 'short' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toContain('newPassword')
  })

  it('★ AU-18 改密码后用新密码登录成功，旧密码失败', async () => {
    const account = `pwd_${Math.random().toString(36).slice(2, 8)}@example.com`
    const s = await registerAndLogin(app, { account, password: 'password123' })

    const change = await app.inject({
      method: 'PATCH', url: '/api/users/me', headers: auth(s),
      payload: { oldPassword: 'password123', newPassword: 'newpassword456' },
    })
    expect(change.statusCode).toBe(200)

    const withNew = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { account, password: 'newpassword456' },
    })
    expect(withNew.statusCode).toBe(200)

    const withOld = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { account, password: 'password123' },
    })
    expect(withOld.statusCode).toBe(401)
  })

  it('AU-16 改昵称与改密码可以一次请求同时做', async () => {
    const account = `both_${Math.random().toString(36).slice(2, 8)}@example.com`
    const s = await registerAndLogin(app, { account, password: 'password123' })
    const r = await app.inject({
      method: 'PATCH', url: '/api/users/me', headers: auth(s),
      payload: { nickname: '两个都改', oldPassword: 'password123', newPassword: 'newpassword456' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().nickname).toBe('两个都改')

    const withNew = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { account, password: 'newpassword456' },
    })
    expect(withNew.json().user.nickname).toBe('两个都改')
  })

  it('GET /api/users/me 返回 avatarUrl 字段（未设头像时为 null）', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/users/me', headers: auth(s) })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toHaveProperty('avatarUrl')
    expect(r.json().avatarUrl).toBeNull()
    expect(r.json().userId).toBe(s.userId)
  })
})

describe('§1 错误信封与 404 兜底', () => {
  it('未注册的接口路径 → 404，中文提示，带 requestId', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/nonexistent' })
    expect(r.statusCode).toBe(404)
    const b = r.json()
    expect(b.code).toBe('NOT_FOUND')
    expect(b.message).toContain('接口不存在')
    expect(b.requestId).toBe(r.headers['x-request-id'])
  })

  it('所有错误体都是 { code, message, details, requestId } 四件套', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/documents' })
    const b = r.json()
    expect(Object.keys(b).sort()).toEqual(['code', 'details', 'message', 'requestId'])
  })

  it('message 一律是中文（不含 ASCII 字母开头的英文句子）', async () => {
    for (const url of ['/api/documents', '/api/users/me', '/api/tts/engines']) {
      const r = await app.inject({ method: 'GET', url })
      expect(/[\u4e00-\u9fa5]/.test(r.json().message), url).toBe(true)
    }
  })

  it('/api/health 真碰数据库，返回 db: ok', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, db: 'ok' })
  })
})
