import { beforeAll, afterAll, it, expect } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { makeApp, closeApp, registerAndLogin, auth, importBody } from './helpers'

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await closeApp(app) })

it('昵称校验失败时不能部分修改密码', async () => {
  const s = await registerAndLogin(app)
  const r = await app.inject({ method: 'PATCH', url: '/api/users/me', headers: auth(s), payload: {
    oldPassword: 'test12345', newPassword: 'changed12345', nickname: '长'.repeat(33),
  } })
  expect(r.statusCode).toBe(400)
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
    account: s.account, password: 'test12345',
  } })
  expect(login.statusCode).toBe(200)
})

it('改密撤销旧刷新令牌', async () => {
  const s = await registerAndLogin(app)
  expect((await app.inject({ method: 'PATCH', url: '/api/users/me', headers: auth(s), payload: {
    oldPassword: 'test12345', newPassword: 'changed12345',
  } })).statusCode).toBe(200)
  expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {
    refreshToken: s.refreshToken,
  } })).statusCode).toBe(401)
})

it('导入字段类型错误应返回 400', async () => {
  const s = await registerAndLogin(app)
  const body = importBody({ paragraphs: [{ text: '正文' }] })
  expect((await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s),
    payload: { ...body, fileFormat: 123 },
  })).statusCode).toBe(400)
})

it('删除文档清理已上传的原始文件和插图', async () => {
  const { existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { DB_PATH } = await import('../src/db')
  const s = await registerAndLogin(app)
  const created = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload:
    importBody({ paragraphs: [{ text: '正文' }], imageRefs: [{ imageId: 'cover', paraIndex: 0, src: 'cover.png' }] }),
  })
  const id = created.json().docId
  for (const [url, mime] of [[`/api/documents/${id}/file`, 'application/octet-stream'], [`/api/documents/${id}/images/cover`, 'image/png']]) {
    expect((await app.inject({ method: 'PUT', url, headers: { ...auth(s), 'content-type': mime }, payload: Buffer.from('测试内容') })).statusCode).toBe(200)
  }
  const file = join(dirname(DB_PATH), 'files', `${id}.txt`)
  const image = join(dirname(DB_PATH), 'images', `${id}_cover.png`)
  expect(existsSync(file)).toBe(true)
  expect(existsSync(image)).toBe(true)
  expect((await app.inject({ method: 'DELETE', url: `/api/documents/${id}`, headers: auth(s) })).statusCode).toBe(204)
  expect(existsSync(file)).toBe(false)
  expect(existsSync(image)).toBe(false)
})


it('并发改密不能同时使用同一份旧密码快照覆盖', async () => {
  const s = await registerAndLogin(app)
  const change = (newPassword: string) => app.inject({ method: 'PATCH', url: '/api/users/me', headers: auth(s), payload: { oldPassword: 'test12345', newPassword } })
  const results = await Promise.all([change('changed11111'), change('changed22222')])
  expect(results.map(r => r.statusCode).sort()).toEqual([200, 409])
})


it('同名并发注册返回一次成功和一次冲突', async () => {
  const payload = { account: 'concurrent@example.com', password: 'test12345' }
  const results = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/auth/register', payload })))
  expect(results.map(r => r.statusCode).sort()).toEqual([201, 409])
})


it('并发上传和删除不会遗留原始文件', async () => {
  const { existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { DB_PATH } = await import('../src/db')
  const s = await registerAndLogin(app)
  const doc = (await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: importBody({ paragraphs: [{ text: '正文' }] }) })).json().docId
  const [upload, deletion] = await Promise.all([
    app.inject({ method: 'PUT', url: `/api/documents/${doc}/file`, headers: { ...auth(s), 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(1024 * 1024, 1) }),
    app.inject({ method: 'DELETE', url: `/api/documents/${doc}`, headers: auth(s) }),
  ])
  expect([200, 404]).toContain(upload.statusCode)
  expect(deletion.statusCode).toBe(204)
  expect(existsSync(join(dirname(DB_PATH), 'files', `${doc}.txt`))).toBe(false)
})
