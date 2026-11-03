import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { auth, closeApp, importBody, makeApp, registerAndLogin, type Session } from './helpers'

/**
 * SY-01 ~ SY-36 跨设备同步、书签与冲突（契约 §6 / §7 / §8）。
 *
 * 这是整个项目里分支最多、也最容易静默出错的一块：D-11（两端改同一书签
 * 根本不触发冲突）与 D-12（只改名会把书签位置冲成第 0 段）两个缺陷都出在这里，
 * 而且都不会报错，只是行为悄悄不对。所以这组用例尽量往"实际形状"上打。
 */

let app: FastifyInstance
beforeAll(async () => {
  app = await makeApp()
})
afterAll(async () => {
  await closeApp(app)
})

let seq = 0
const uniq = () => `bm_${Date.now().toString(36)}_${seq++}`

/** 建一个读者 + 一篇文档，返回常用的上下文 */
async function setupReader(opts: { paragraphs?: string[] } = {}) {
  const s = await registerAndLogin(app)
  const texts = opts.paragraphs ?? ['第一段。', '第二段。', '第三段。', '第四段。', '第五段。']
  const imp = await app.inject({
    method: 'POST',
    url: '/api/documents',
    headers: auth(s),
    payload: importBody({
      paragraphs: texts.map((t) => ({ text: t })),
      title: '同步测试书',
    }),
  })
  if (imp.statusCode !== 201) throw new Error(`导入失败 ${imp.statusCode}: ${imp.body}`)
  return { s, docId: imp.json().docId as string }
}

function anchorOf(paragraphIndex: number, sentenceIndex = 0) {
  return { chapterIndex: 0, paragraphIndex, sentenceIndex, charOffset: 0, scrollOffset: 0 }
}

/* ========================================================== 契约 §6 进度 */

describe('SY-01 ~ SY-07 阅读进度（契约 §6）', () => {
  it('SY-01 首次上报 → applied，version=1，返回 serverReceivedAt', async () => {
    const { s, docId } = await setupReader()
    const r = await app.inject({
      method: 'PUT',
      url: `/api/documents/${docId}/progress`,
      headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(2), updatedAt: new Date().toISOString(), baseVersion: 0 },
    })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.version).toBe(1)
    expect(b.serverReceivedAt).toBeTruthy()
    expect(b.progressId).toMatch(/^pg_/)
  })

  it('SY-02 拉取进度返回 items 数组', async () => {
    const { s, docId } = await setupReader()
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(1), updatedAt: new Date().toISOString(), baseVersion: 0 },
    })
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/progress?deviceId=dev_a`, headers: auth(s),
    })
    expect(r.statusCode).toBe(200)
    expect(Array.isArray(r.json().items)).toBe(true)
    expect(r.json().docId).toBe(docId)
  })

  it('SY-03 本机记录标 isCurrentDevice=true，他端为 false', async () => {
    const { s, docId } = await setupReader()
    for (const dev of ['dev_a', 'dev_b']) {
      await app.inject({
        method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
        payload: { deviceId: dev, anchor: anchorOf(1), updatedAt: new Date().toISOString(), baseVersion: 0 },
      })
    }
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/progress?deviceId=dev_a`, headers: auth(s),
    })
    const items = r.json().items
    const mine = items.filter((i: { isCurrentDevice: boolean }) => i.isCurrentDevice)
    expect(mine).toHaveLength(1)
    expect(mine[0].deviceId).toBe('dev_a')
  })

  it('★ SY-04 anchor 字段名与契约 §6.1 一致（含 paragraphIndex / sentenceIndex）', async () => {
    const { s, docId } = await setupReader()
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: {
        deviceId: 'dev_a',
        anchor: { chapterIndex: 0, paragraphIndex: 3, sentenceIndex: 2, charOffset: 7, scrollOffset: 12 },
        // ★ 裁决 2：anchor.sentenceIndex 在库里对应 last_sentence_index 列
        //（"本机瞬态，不参与跨端同步"），回读时也是从那一列取的。
        lastSentenceIndex: 2,
        updatedAt: new Date().toISOString(), baseVersion: 0,
      },
    })
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/progress?deviceId=dev_a`, headers: auth(s),
    })
    const a = r.json().items[0].anchor
    expect(a).toMatchObject({ chapterIndex: 0, paragraphIndex: 3, sentenceIndex: 2, charOffset: 7, scrollOffset: 12 })
    // 绝不能出现旧名 paraIndex（裁决 2）
    expect(a).not.toHaveProperty('paraIndex')
    // 也绝不能出现 paraId / paragraph_id 这类表内命名
    expect(a).not.toHaveProperty('paraId')
  })

  it('★ SY-04 lastSentenceIndex 与 anchor.sentenceIndex 是同一件事的两处呈现', async () => {
    const { s, docId } = await setupReader()
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: {
        deviceId: 'dev_a', anchor: anchorOf(2, 5), lastSentenceIndex: 5,
        updatedAt: new Date().toISOString(), baseVersion: 0,
      },
    })
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/progress?deviceId=dev_a`, headers: auth(s),
    })
    const item = r.json().items[0]
    expect(item.lastSentenceIndex).toBe(5)
    expect(item.anchor.sentenceIndex).toBe(5)
  })

  it('★ SY-06 拉取能看到**所有设备**的进度（跨设备续读的前提）', async () => {
    const { s, docId } = await setupReader()
    for (const dev of ['dev_a', 'dev_b', 'dev_c']) {
      await app.inject({
        method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
        payload: { deviceId: dev, anchor: anchorOf(1), updatedAt: new Date().toISOString(), baseVersion: 0 },
      })
    }
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/progress?deviceId=dev_a`, headers: auth(s),
    })
    expect(r.json().items).toHaveLength(3)
    expect(r.json().items.map((i: { deviceId: string }) => i.deviceId).sort()).toEqual(['dev_a', 'dev_b', 'dev_c'])
  })

  it('SY-05 版本号匹配时正常更新，version 递增', async () => {
    const { s, docId } = await setupReader()
    const first = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(1), updatedAt: new Date().toISOString(), baseVersion: 0 },
    })
    const v1 = first.json().version

    const second = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(2), updatedAt: new Date().toISOString(), baseVersion: v1 },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().version).toBe(v1 + 1)
  })

  it('SY-07 用过期版本号写入 → 409 SYNC_VERSION_CONFLICT，错误体带 conflict 信封', async () => {
    const { s, docId } = await setupReader()
    const put = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(2), updatedAt: new Date().toISOString(), baseVersion: 0 },
    })
    expect(put.json().version).toBe(1)

    // ★ 进度是**每设备一行**（约定 4）：版本冲突必须发生在同一条设备记录上，
    // 换一台设备写入只会新建一行，永远不冲突。
    const r = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: {
        deviceId: 'dev_a', anchor: anchorOf(4),
        // 时间更旧 → 服务端那条更新，保留服务端
        updatedAt: new Date(Date.now() - 120_000).toISOString(), baseVersion: 0,
      },
    })
    expect(r.statusCode).toBe(409)
    const b = r.json()
    expect(b.code).toBe('SYNC_VERSION_CONFLICT')
    expect(b.details.conflict).toBeDefined()
    expect(b.details.conflict.scope).toBe('progress')
    expect(b.details.conflict.baseVersion).toBe(0)
    expect(b.details.conflict.serverVersion).toBe(1)
  })

  it('★ SY-08 不回退保护：时间更新但位置更靠前的一方被拒，保留较前的位置', async () => {
    const { s, docId } = await setupReader({ paragraphs: Array.from({ length: 20 }, (_, i) => `第${i}段。`) })
    // 服务端先记在第 15 段
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(15), updatedAt: new Date().toISOString(), baseVersion: 0 },
    })

    // 同一条设备记录，时间更晚，但位置在第 3 段 —— 不能让它把进度倒退回去
    const r = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: {
        deviceId: 'dev_a', anchor: anchorOf(3),
        updatedAt: new Date(Date.now() + 120_000).toISOString(), baseVersion: 0,
      },
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().details.conflict.resolution).toBe('superseded')
    expect(r.json().details.conflict.note).toContain('倒退')

    // 服务端那条仍是第 15 段（位置没被冲掉）
    const back = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/progress?deviceId=dev_a`, headers: auth(s),
    })
    const devA = back.json().items.find((i: { deviceId: string }) => i.deviceId === 'dev_a')
    expect(devA.anchor.paragraphIndex).toBe(15)
  })

  it('SY-08 本机时间更新且位置更靠后 → 采纳本机（outcome 仍是 applied，但回带 conflict 信封）', async () => {
    const { s, docId } = await setupReader({ paragraphs: Array.from({ length: 20 }, (_, i) => `第${i}段。`) })
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(3), updatedAt: new Date().toISOString(), baseVersion: 0 },
    })
    const r = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: {
        deviceId: 'dev_a', anchor: anchorOf(18),
        updatedAt: new Date(Date.now() + 120_000).toISOString(), baseVersion: 0,
      },
    })
    // take_local：服务端采纳本机，落库成功 → 200（outcome 叫 applied）
    expect(r.statusCode).toBe(200)
    expect(r.json().version).toBe(2)

    const back = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/progress?deviceId=dev_a`, headers: auth(s),
    })
    expect(back.json().items[0].anchor.paragraphIndex).toBe(18)
  })

  it('缺少 deviceId / updatedAt → 400 VALIDATION_FAILED 且列出字段', async () => {
    const { s, docId } = await setupReader()
    const noDev = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { anchor: anchorOf(1), updatedAt: new Date().toISOString() },
    })
    expect(noDev.statusCode).toBe(400)
    expect(noDev.json().details.fields).toContain('deviceId')

    const noTime = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(1) },
    })
    expect(noTime.statusCode).toBe(400)
    expect(noTime.json().details.fields).toContain('updatedAt')
  })

  it('SY-29 访问他人文档的进度 → 404', async () => {
    const { docId } = await setupReader()
    const other = await registerAndLogin(app)
    const r = await app.inject({
      method: 'GET', url: `/api/documents/${docId}/progress`, headers: auth(other),
    })
    expect(r.statusCode).toBe(404)
  })

  it('不存在的文档 → 404', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({
      method: 'GET', url: '/api/documents/doc_nope/progress', headers: auth(s),
    })
    expect(r.statusCode).toBe(404)
  })

  it('SY-36 书架列表带真实 progress，percent 在 0–1 之间', async () => {
    const { s, docId } = await setupReader()
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(2), updatedAt: new Date().toISOString(), baseVersion: 0 },
    })
    const r = await app.inject({ method: 'GET', url: '/api/documents', headers: auth(s) })
    const item = r.json().items.find((i: { docId: string }) => i.docId === docId)
    expect(item.progress).toBeTruthy()
    expect(item.progress.percent).toBeGreaterThanOrEqual(0)
    expect(item.progress.percent).toBeLessThanOrEqual(1)
    expect(item.progress.paragraphIndex).toBe(2)
  })
})

/* ========================================================== 契约 §7 书签 */

describe('SY-09 ~ SY-15 书签增删改查（契约 §7）', () => {
  it('SY-09 新增书签 → 201，version=1', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    const r = await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '我的书签', updatedAt: new Date().toISOString() },
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().version).toBe(1)
  })

  it('SY-10 同 id 同内容重复提交（离线重发）→ 200，幂等', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    const payload = { bookmarkId: id, docId, anchor: anchorOf(1), name: '重发', updatedAt: new Date().toISOString() }
    const first = await app.inject({ method: 'POST', url: '/api/bookmarks', headers: auth(s), payload })
    expect(first.statusCode).toBe(201)
    const again = await app.inject({ method: 'POST', url: '/api/bookmarks', headers: auth(s), payload })
    expect(again.statusCode).toBe(200)
    expect(again.json().version).toBe(1) // 幂等不该把版本顶上去
  })

  it('SY-11 改名（版本匹配）→ 200，version 递增', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '原名', updatedAt: new Date().toISOString() },
    })
    const r = await app.inject({
      method: 'PATCH', url: `/api/bookmarks/${id}`, headers: auth(s),
      payload: { baseVersion: 1, name: '新名', updatedAt: new Date().toISOString() },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().version).toBe(2)
  })

  it('★ D-12 只改名不带 anchor 时，位置沿用库里的（不能冲成第 0 段）', async () => {
    const { s, docId } = await setupReader({ paragraphs: Array.from({ length: 10 }, (_, i) => `第${i}段。`) })
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(7), name: '在第7段', updatedAt: new Date().toISOString() },
    })
    const r = await app.inject({
      method: 'PATCH', url: `/api/bookmarks/${id}`, headers: auth(s),
      payload: { baseVersion: 1, name: '只改名', updatedAt: new Date().toISOString() },
    })
    expect(r.statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const item = list.json().items.find((i: { bookmarkId: string }) => i.bookmarkId === id)
    expect(item.anchor.paragraphIndex).toBe(7) // 不能被冲成 0
  })

  it('PATCH 缺 baseVersion → 400（条件更新必须带版本号）', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: 'x', updatedAt: new Date().toISOString() },
    })
    const r = await app.inject({
      method: 'PATCH', url: `/api/bookmarks/${id}`, headers: auth(s), payload: { name: 'y' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toContain('baseVersion')
  })

  it('SY-12 删除书签 → 200，带 deletedAt', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '待删', updatedAt: new Date().toISOString() },
    })
    const r = await app.inject({
      method: 'DELETE', url: `/api/bookmarks/${id}?baseVersion=1`, headers: auth(s),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().deletedAt).toBeTruthy()
  })

  it('SY-13 默认不返回墓碑', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '删掉', updatedAt: new Date().toISOString() },
    })
    await app.inject({ method: 'DELETE', url: `/api/bookmarks/${id}?baseVersion=1`, headers: auth(s) })

    const r = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    expect(r.json().items.map((i: { bookmarkId: string }) => i.bookmarkId)).not.toContain(id)
  })

  it('SY-14 includeDeleted=true 返回墓碑', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '删掉', updatedAt: new Date().toISOString() },
    })
    await app.inject({ method: 'DELETE', url: `/api/bookmarks/${id}?baseVersion=1`, headers: auth(s) })

    const r = await app.inject({
      method: 'GET', url: `/api/bookmarks?docId=${docId}&includeDeleted=true`, headers: auth(s),
    })
    const item = r.json().items.find((i: { bookmarkId: string }) => i.bookmarkId === id)
    expect(item).toBeDefined()
    expect(item.deletedAt).toBeTruthy()
  })

  it('★ SY-15 删除事件能被增量拉到（墓碑的 updatedAt 必须刷新 —— docs/system-develop.md §4.6 第 3 条）', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '删掉', updatedAt: new Date().toISOString() },
    })

    const before = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const since = before.json().serverTime

    await new Promise((r) => setTimeout(r, 5)) // 让时间戳拉开，避免同一毫秒
    await app.inject({ method: 'DELETE', url: `/api/bookmarks/${id}?baseVersion=1`, headers: auth(s) })

    const after = await app.inject({
      method: 'GET', url: `/api/bookmarks?docId=${docId}&since=${encodeURIComponent(since)}&includeDeleted=true`,
      headers: auth(s),
    })
    expect(after.json().items.map((i: { bookmarkId: string }) => i.bookmarkId)).toContain(id)
  })

  it('书签列表项的 shape 与契约 §7.4 一致', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '形状', updatedAt: new Date().toISOString() },
    })
    const r = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const item = r.json().items.find((i: { bookmarkId: string }) => i.bookmarkId === id)
    expect(item.bookmarkId).toBe(id)
    expect(item.docId).toBe(docId)
    expect(item.name).toBe('形状')
    expect(item.anchor).toBeDefined()
    expect(item.version).toBe(1)
    expect(item).toHaveProperty('updatedAt')
  })

  it('他人书签不可改也不可删 → 404', async () => {
    const { s, docId } = await setupReader()
    const other = await registerAndLogin(app)
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '我的', updatedAt: new Date().toISOString() },
    })
    const patch = await app.inject({
      method: 'PATCH', url: `/api/bookmarks/${id}`, headers: auth(other),
      payload: { baseVersion: 1, name: '抢改' },
    })
    expect(patch.statusCode).toBe(404)
    const del = await app.inject({ method: 'DELETE', url: `/api/bookmarks/${id}?baseVersion=1`, headers: auth(other) })
    expect(del.statusCode).toBe(404)
  })

  it('给他人文档加书签 → 404', async () => {
    const { docId } = await setupReader()
    const other = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(other),
      payload: { bookmarkId: uniq(), docId, anchor: anchorOf(1), name: '越权', updatedAt: new Date().toISOString() },
    })
    expect(r.statusCode).toBe(404)
  })
})

/* ====================================== 契约 §8 批量同步与冲突 */

describe('SY-16 ~ SY-28 批量同步与冲突（契约 §8）', () => {
  it('SY-16 两端各自新增不同书签 → 并集合并，无冲突', async () => {
    const { s, docId } = await setupReader()
    const a = uniq()
    const b = uniq()

    // A 端新建一条
    const first = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { created: [{ bookmarkId: a, docId, anchor: anchorOf(1), name: 'A 的', updatedAt: new Date().toISOString() }] } },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().conflicts).toEqual([])

    // B 端同步时应当拿到 A 那条的增量，且无冲突
    const second = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_b', bookmarks: { created: [{ bookmarkId: b, docId, anchor: anchorOf(3), name: 'B 的', updatedAt: new Date().toISOString() }] } },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().conflicts).toEqual([])
    expect(second.json().changes.bookmarks.created.map((x: { bookmarkId: string }) => x.bookmarkId)).toContain(a)
  })

  it('★ SY-17 同一书签两端都改名 → 冲突 resolution=keep_both', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()

    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始名', updatedAt: new Date().toISOString() },
    })

    // B 端先改（版本 1 → 2）
    const bChange = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: {
        deviceId: 'dev_b',
        bookmarks: { updated: [{ bookmarkId: id, name: 'B 改的', baseVersion: 1, updatedAt: new Date().toISOString() }] },
      },
    })
    expect(bChange.statusCode).toBe(200)

    // A 端拿着旧版本 1 也改 —— 版本对不上，应当冲突
    const aChange = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: {
        deviceId: 'dev_a',
        bookmarks: { updated: [{ bookmarkId: id, name: 'A 改的', baseVersion: 1, updatedAt: new Date().toISOString() }] },
      },
    })
    expect(aChange.statusCode).toBe(200)
    const conflicts = aChange.json().conflicts
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0].resolution).toBe('keep_both')
  })

  it('★ SY-17 冲突检测不依赖 updated 条目里的 docId（契约 §8.1 里它本来就没有）', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始', updatedAt: new Date().toISOString() },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_b', bookmarks: { updated: [{ bookmarkId: id, name: 'B', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    // 这条 updated 条目**不带 docId**，靠 bookmarkId 反查
    const r = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { updated: [{ bookmarkId: id, name: 'A', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().conflicts.length).toBeGreaterThan(0)
  })

  it('★ SY-20 冲突项同时给出双方内容', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始', updatedAt: new Date().toISOString() },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_b', bookmarks: { updated: [{ bookmarkId: id, name: '服务端那份', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    const r = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { updated: [{ bookmarkId: id, name: '本机那份', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    const c = r.json().conflicts[0]
    expect(c.local.name).toBe('本机那份')
    expect(c.remote.name).toBe('服务端那份')
    expect(c.scope).toBe('bookmark')
    expect(c.key).toBe(id)
    expect(c.baseVersion).toBe(1)
    expect(c.serverVersion).toBe(2)
  })

  it('SY-18 / SY-19 裁决 keep_both 后：新增的记录 id 由服务端生成、名字带「（本机）」', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始', updatedAt: new Date().toISOString() },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_b', bookmarks: { updated: [{ bookmarkId: id, name: '服务端', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { updated: [{ bookmarkId: id, name: '本机', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })

    // 两份都保留：服务端那条 + 新生成的一条
    const list = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const names = list.json().items.map((i: { name: string }) => i.name)
    expect(names).toContain('服务端')
    expect(names.some((n: string) => n.includes('（本机）'))).toBe(true)

    const copyItem = list.json().items.find((i: { name: string }) => i.name.includes('（本机）'))
    expect(copyItem.bookmarkId).toMatch(/^bm_[0-9a-f]{32}$/) // 服务端生成的 id
    expect(copyItem.bookmarkId).not.toBe(id)
  })

  it('SY-21 两份都保留后，库里确实有两条独立记录', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始', updatedAt: new Date().toISOString() },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_b', bookmarks: { updated: [{ bookmarkId: id, name: 'B改', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { updated: [{ bookmarkId: id, name: 'A改', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    const list = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const mine = list.json().items.filter((i: { bookmarkId: string }) => i.bookmarkId === id || i.name.includes('（本机）'))
    expect(mine.length).toBeGreaterThanOrEqual(2)
  })

  it('SY-22 / SY-23 一端删、另一端改 → 保留修改，墓碑被清空，说明点明"曾删除"', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '会活的', updatedAt: new Date().toISOString() },
    })
    // B 端删掉
    await app.inject({ method: 'DELETE', url: `/api/bookmarks/${id}?baseVersion=1&deviceId=dev_b`, headers: auth(s) })
    // A 端改
    const r = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { updated: [{ bookmarkId: id, name: '改过了', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    expect(r.statusCode).toBe(200)
    const c = r.json().conflicts[0]
    expect(c.note).toContain('删除')

    const list = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const item = list.json().items.find((i: { bookmarkId: string }) => i.bookmarkId === id)
    expect(item).toBeDefined() // 墓碑被清空，记录活着
  })

  it('SY-24 两端都删同一条 → 幂等，不构成冲突', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '都删', updatedAt: new Date().toISOString() },
    })
    await app.inject({ method: 'DELETE', url: `/api/bookmarks/${id}?baseVersion=1`, headers: auth(s) })
    const r = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { deleted: [{ bookmarkId: id, updatedAt: new Date().toISOString() }] } },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().conflicts).toEqual([])
  })

  it('SY-25 批量同步返回 conflicts 与 changes 结构', async () => {
    const { s, docId } = await setupReader()
    const r = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { created: [{ bookmarkId: uniq(), docId, anchor: anchorOf(1), name: 'x', updatedAt: new Date().toISOString() }] } },
    })
    const b = r.json()
    expect(b).toHaveProperty('serverTime')
    expect(b).toHaveProperty('conflicts')
    expect(b.applied).toHaveProperty('bookmarks')
    expect(b.changes).toHaveProperty('bookmarks')
    expect(b.changes.bookmarks).toHaveProperty('created')
    expect(b.changes.bookmarks).toHaveProperty('updated')
    expect(b.changes.bookmarks).toHaveProperty('deleted')
  })

  it('★ SY-26 幂等键重放识别：X-Idempotent-Replay: true，返回首次结果', async () => {
    const { s, docId } = await setupReader()
    const key = `idem_${Date.now()}_${seq++}`
    const payload = {
      deviceId: 'dev_a',
      bookmarks: { created: [{ bookmarkId: uniq(), docId, anchor: anchorOf(1), name: '幂等', updatedAt: new Date().toISOString() }] },
    }
    const first = await app.inject({
      method: 'POST', url: '/api/sync',
      headers: { ...auth(s), 'idempotency-key': key }, payload,
    })
    expect(first.statusCode).toBe(200)
    expect(first.headers['x-idempotent-replay']).toBeUndefined()

    const second = await app.inject({
      method: 'POST', url: '/api/sync',
      headers: { ...auth(s), 'idempotency-key': key }, payload,
    })
    expect(second.statusCode).toBe(200)
    expect(second.headers['x-idempotent-replay']).toBe('true')
    expect(second.json().serverTime).toBe(first.json().serverTime)
  })

  it('★ SY-26 幂等键是 (user_id, idem_key) 复合的 —— 换个读者用同一个键不会拿到别人的结果', async () => {
    const { docId } = await setupReader()
    const other = await registerAndLogin(app)
    const key = `shared_${Date.now()}_${seq++}`
    const payload = { deviceId: 'dev_x', bookmarks: { created: [] } }

    const a = await app.inject({
      method: 'POST', url: '/api/sync', headers: { ...auth(other), 'idempotency-key': key }, payload,
    })
    // 另一个读者（他自己也有一篇文档）用同一个 key —— 必须是他自己的结果，不是重放
    const b = await app.inject({
      method: 'POST', url: '/api/sync', headers: { ...auth(other), 'idempotency-key': key }, payload,
    })
    expect(b.headers['x-idempotent-replay']).toBe('true')
    // 用第三个读者来验证不串号
    const third = await registerAndLogin(app)
    const c = await app.inject({
      method: 'POST', url: '/api/sync', headers: { ...auth(third), 'idempotency-key': key }, payload,
    })
    expect(c.headers['x-idempotent-replay']).toBeUndefined()
    void a
    void docId
  })

  it('SY-27 裁决 choice=remote → 保留云端那份，本机副本软删除', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始', updatedAt: new Date().toISOString() },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_b', bookmarks: { updated: [{ bookmarkId: id, name: '云端', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { updated: [{ bookmarkId: id, name: '本机', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })

    const list = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const copy = list.json().items.find((i: { name: string }) => i.name.includes('（本机）'))
    expect(copy).toBeDefined()

    const r = await app.inject({
      method: 'POST', url: '/api/sync/resolve', headers: auth(s),
      payload: { scope: 'bookmark', key: id, choice: 'remote', relatedId: copy.bookmarkId },
    })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.kept).toHaveLength(1)
    expect(b.kept[0].name).toBe('云端')
    expect(b.deleted.name).toContain('（本机）')
  })

  it('SY-27 裁决 choice=local → 保留本机那份（副本），软删除原件', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始', updatedAt: new Date().toISOString() },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_b', bookmarks: { updated: [{ bookmarkId: id, name: '云端', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { updated: [{ bookmarkId: id, name: '本机', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    const list = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const copy = list.json().items.find((i: { name: string }) => i.name.includes('（本机）'))

    const r = await app.inject({
      method: 'POST', url: '/api/sync/resolve', headers: auth(s),
      payload: { scope: 'bookmark', key: id, choice: 'local', relatedId: copy.bookmarkId },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().kept[0].name).toContain('（本机）')
  })

  it('SY-28 裁决 choice=both → 返回两条记录', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始', updatedAt: new Date().toISOString() },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_b', bookmarks: { updated: [{ bookmarkId: id, name: '云端', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { updated: [{ bookmarkId: id, name: '本机', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    const list = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const copy = list.json().items.find((i: { name: string }) => i.name.includes('（本机）'))

    const r = await app.inject({
      method: 'POST', url: '/api/sync/resolve', headers: auth(s),
      payload: { scope: 'bookmark', key: id, choice: 'both', relatedId: copy.bookmarkId },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().kept).toHaveLength(2)
  })

  it('裁决缺 scope / key / choice → 400', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'POST', url: '/api/sync/resolve', headers: auth(s), payload: {} })
    expect(r.statusCode).toBe(400)
    expect(r.json().details.fields).toEqual(['scope', 'key', 'choice'])
  })

  it('SY-29 同步里带他人文档的进度 → 404', async () => {
    const { docId } = await setupReader()
    const other = await registerAndLogin(app)
    const r = await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(other),
      payload: { deviceId: 'dev_a', progress: { docId, anchor: anchorOf(1), updatedAt: new Date().toISOString(), baseVersion: 0 } },
    })
    expect(r.statusCode).toBe(404)
  })

  it('sync 需要令牌', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/sync', payload: { deviceId: 'x' } })
    expect(r.statusCode).toBe(401)
  })
})

/* ======================================== A4：冲突列表读回与销账 */

describe('A4 冲突列表能读回、裁决后销账（迭代第一轮）', () => {
  /** 造一条真实的书签冲突，返回 { docId, id, copyId } */
  async function makeConflict() {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始', updatedAt: new Date().toISOString() },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_b', bookmarks: { updated: [{ bookmarkId: id, name: 'B 改', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(s),
      payload: { deviceId: 'dev_a', bookmarks: { updated: [{ bookmarkId: id, name: 'A 改', baseVersion: 1, updatedAt: new Date().toISOString() }] } },
    })
    const list = await app.inject({ method: 'GET', url: `/api/bookmarks?docId=${docId}`, headers: auth(s) })
    const copy = list.json().items.find((i: { name: string }) => i.name.includes('（本机）'))
    return { s, docId, id, copyId: copy?.bookmarkId as string }
  }

  it('★ 冲突落库了，GET /api/sync/conflicts 能读回来（刷新页面不丢）', async () => {
    const { s, docId, id } = await makeConflict()
    const r = await app.inject({
      method: 'GET', url: `/api/sync/conflicts?docId=${docId}`, headers: auth(s),
    })
    expect(r.statusCode).toBe(200)
    expect(Array.isArray(r.json().items)).toBe(true)
    const c = r.json().items.find((x: { key: string }) => x.key === id)
    expect(c).toBeDefined()
    expect(c.scope).toBe('bookmark')
    expect(c.resolution).toBe('keep_both')
  })

  it('★ 单项接口产生的冲突也要落库（R5 只在批量同步那条路径上落）', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '初始', updatedAt: new Date().toISOString() },
    })
    // 用**单项**接口改名两次：第二次用旧版本号 → 409，且必须落库
    await app.inject({
      method: 'PATCH', url: `/api/bookmarks/${id}`, headers: auth(s),
      payload: { baseVersion: 1, name: 'B 改', updatedAt: new Date().toISOString() },
    })
    const conflict = await app.inject({
      method: 'PATCH', url: `/api/bookmarks/${id}`, headers: auth(s),
      payload: { baseVersion: 1, name: 'A 改', updatedAt: new Date().toISOString() },
    })
    // 版本对不上但内容不同 → keep_both，接口返回 409 带 conflict
    expect(conflict.statusCode).toBe(409)

    const list = await app.inject({ method: 'GET', url: `/api/sync/conflicts?docId=${docId}`, headers: auth(s) })
    expect(list.json().items.some((x: { key: string }) => x.key === id)).toBe(true)
  })

  it('★ 裁决完要销账 —— 再读一次不该又冒出来', async () => {
    const { s, docId, id, copyId } = await makeConflict()

    const before = await app.inject({ method: 'GET', url: `/api/sync/conflicts?docId=${docId}`, headers: auth(s) })
    expect(before.json().items.some((x: { key: string }) => x.key === id)).toBe(true)

    await app.inject({
      method: 'POST', url: '/api/sync/resolve', headers: auth(s),
      payload: { scope: 'bookmark', key: id, choice: 'remote', relatedId: copyId },
    })

    const after = await app.inject({ method: 'GET', url: `/api/sync/conflicts?docId=${docId}`, headers: auth(s) })
    expect(after.json().items.some((x: { key: string }) => x.key === id)).toBe(false)
  })

  it('★ 进度冲突不进未决列表（superseded，服务端已当场裁完）', async () => {
    const { s, docId } = await setupReader({ paragraphs: Array.from({ length: 20 }, (_, i) => `第${i}段。`) })
    const put = await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: { deviceId: 'dev_a', anchor: anchorOf(15), updatedAt: new Date().toISOString(), baseVersion: 0 },
    })
    await app.inject({
      method: 'PUT', url: `/api/documents/${docId}/progress`, headers: auth(s),
      payload: {
        deviceId: 'dev_b', anchor: anchorOf(3),
        updatedAt: new Date(Date.now() + 60_000).toISOString(), baseVersion: put.json().version,
      },
    })
    const r = await app.inject({ method: 'GET', url: `/api/sync/conflicts?docId=${docId}`, headers: auth(s) })
    expect(r.json().items.filter((x: { scope: string }) => x.scope === 'progress')).toEqual([])
  })

  it('冲突列表按 docId 过滤，也支持不带 docId 取全部', async () => {
    const { s, docId, id } = await makeConflict()
    const scoped = await app.inject({ method: 'GET', url: `/api/sync/conflicts?docId=${docId}`, headers: auth(s) })
    expect(scoped.json().items.some((x: { key: string }) => x.key === id)).toBe(true)

    const all = await app.inject({ method: 'GET', url: '/api/sync/conflicts', headers: auth(s) })
    expect(all.json().items.some((x: { key: string }) => x.key === id)).toBe(true)
  })

  it('冲突列表不会被串到别的读者', async () => {
    const { id } = await makeConflict()
    const other = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/sync/conflicts', headers: auth(other) })
    expect(r.json().items.some((x: { key: string }) => x.key === id)).toBe(false)
  })
})

/* ================================ B 迭代：排序 / 分页 / 总览 */

describe('B 迭代 书签排序、分页与跨文档总览（契约 §7.5 / §7.6 / §7.7）', () => {
  it('§7.5 分页列表返回 { total, page, pageSize, items }', async () => {
    const { s, docId } = await setupReader()
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST', url: '/api/bookmarks', headers: auth(s),
        payload: { bookmarkId: uniq(), docId, anchor: anchorOf(i), name: `第${i}条`, updatedAt: new Date().toISOString() },
      })
    }
    const r = await app.inject({ method: 'GET', url: `/api/bookmarks/page?docId=${docId}`, headers: auth(s) })
    expect(r.statusCode).toBe(200)
    expect(r.json().total).toBe(3)
    expect(r.json().page).toBe(1)
    expect(r.json().pageSize).toBe(20)
    expect(r.json().items).toHaveLength(3)
  })

  it('§7.5 列表项带 sortOrder 与 chapterTitle', async () => {
    const { s, docId } = await setupReader()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: {
        bookmarkId: uniq(), docId, anchor: anchorOf(1), name: '带章节',
        chapterTitle: '第一章', sortOrder: 5, updatedAt: new Date().toISOString(),
      },
    })
    const r = await app.inject({ method: 'GET', url: `/api/bookmarks/page?docId=${docId}`, headers: auth(s) })
    expect(r.json().items[0].chapterTitle).toBe('第一章')
    expect(r.json().items[0].sortOrder).toBe(5)
  })

  it('§7.5 分页真的切开了（pageSize=1 时 total 仍是总数）', async () => {
    const { s, docId } = await setupReader()
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST', url: '/api/bookmarks', headers: auth(s),
        payload: { bookmarkId: uniq(), docId, anchor: anchorOf(i), name: `n${i}`, updatedAt: new Date().toISOString() },
      })
    }
    const p1 = await app.inject({ method: 'GET', url: `/api/bookmarks/page?docId=${docId}&pageSize=1&page=1`, headers: auth(s) })
    const p2 = await app.inject({ method: 'GET', url: `/api/bookmarks/page?docId=${docId}&pageSize=1&page=2`, headers: auth(s) })
    expect(p1.json().total).toBe(5)
    expect(p1.json().items).toHaveLength(1)
    expect(p2.json().items).toHaveLength(1)
    expect(p1.json().items[0].bookmarkId).not.toBe(p2.json().items[0].bookmarkId)
  })

  it('§7.5 缺 docId → 400', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/bookmarks/page', headers: auth(s) })
    expect(r.statusCode).toBe(400)
  })

  it('§7.7 拖动排序整表重排，全部成功', async () => {
    const { s, docId } = await setupReader()
    const ids = [uniq(), uniq(), uniq()]
    for (let i = 0; i < ids.length; i++) {
      await app.inject({
        method: 'POST', url: '/api/bookmarks', headers: auth(s),
        payload: { bookmarkId: ids[i], docId, anchor: anchorOf(i), name: `s${i}`, sortOrder: i, updatedAt: new Date().toISOString() },
      })
    }
    const r = await app.inject({
      method: 'POST', url: '/api/bookmarks/reorder', headers: auth(s),
      payload: {
        docId,
        items: [
          { bookmarkId: ids[0], sortOrder: 2, baseVersion: 1 },
          { bookmarkId: ids[1], sortOrder: 0, baseVersion: 1 },
          { bookmarkId: ids[2], sortOrder: 1, baseVersion: 1 },
        ],
      },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().applied).toBe(3)
  })

  it('★ §7.7 有一条版本对不上 → 整体回滚，不接受部分成功', async () => {
    const { s, docId } = await setupReader()
    const ids = [uniq(), uniq(), uniq()]
    for (let i = 0; i < ids.length; i++) {
      await app.inject({
        method: 'POST', url: '/api/bookmarks', headers: auth(s),
        payload: { bookmarkId: ids[i], docId, anchor: anchorOf(i), name: `r${i}`, sortOrder: i, updatedAt: new Date().toISOString() },
      })
    }
    const before = await app.inject({ method: 'GET', url: `/api/bookmarks/page?docId=${docId}`, headers: auth(s) })
    const beforeOrders = before.json().items.map((i: { bookmarkId: string; sortOrder: number }) => [i.bookmarkId, i.sortOrder])

    const r = await app.inject({
      method: 'POST', url: '/api/bookmarks/reorder', headers: auth(s),
      payload: {
        docId,
        items: [
          { bookmarkId: ids[0], sortOrder: 9, baseVersion: 1 },
          { bookmarkId: ids[1], sortOrder: 8, baseVersion: 99 }, // 故意错的版本
          { bookmarkId: ids[2], sortOrder: 7, baseVersion: 1 },
        ],
      },
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().details.conflict.resolution).toBe('superseded')

    const after = await app.inject({ method: 'GET', url: `/api/bookmarks/page?docId=${docId}`, headers: auth(s) })
    const afterOrders = after.json().items.map((i: { bookmarkId: string; sortOrder: number }) => [i.bookmarkId, i.sortOrder])
    expect(afterOrders).toEqual(beforeOrders) // 一条都没改成
  })

  it('§7.7 重复的 bookmarkId → 400', async () => {
    const { s, docId } = await setupReader()
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: 'x', updatedAt: new Date().toISOString() },
    })
    const r = await app.inject({
      method: 'POST', url: '/api/bookmarks/reorder', headers: auth(s),
      payload: { docId, items: [{ bookmarkId: id, sortOrder: 0, baseVersion: 1 }, { bookmarkId: id, sortOrder: 1, baseVersion: 1 }] },
    })
    expect(r.statusCode).toBe(400)
  })

  it('§7.7 空 items → 400', async () => {
    const { s, docId } = await setupReader()
    const r = await app.inject({
      method: 'POST', url: '/api/bookmarks/reorder', headers: auth(s),
      payload: { docId, items: [] },
    })
    expect(r.statusCode).toBe(400)
  })

  it('§7.7 不属于自己文档的书签 → 404（越权防护）', async () => {
    const { s, docId } = await setupReader()
    const other = await registerAndLogin(app)
    const id = uniq()
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(s),
      payload: { bookmarkId: id, docId, anchor: anchorOf(1), name: '我的', updatedAt: new Date().toISOString() },
    })
    const r = await app.inject({
      method: 'POST', url: '/api/bookmarks/reorder', headers: auth(other),
      payload: { docId, items: [{ bookmarkId: id, sortOrder: 0, baseVersion: 1 }] },
    })
    expect(r.statusCode).toBe(404)
  })

  it('★ §7.6 跨文档总览：total 是"有书签的文档数"，bookmarkCount 是真实总数', async () => {
    const s = await registerAndLogin(app)
    const docA = (
      await app.inject({
        method: 'POST', url: '/api/documents', headers: auth(s),
        payload: importBody({ paragraphs: [{ text: '甲。' }], title: '书甲' }),
      })
    ).json().docId
    const docB = (
      await app.inject({
        method: 'POST', url: '/api/documents', headers: auth(s),
        payload: importBody({ paragraphs: [{ text: '乙。' }], title: '书乙' }),
      })
    ).json().docId

    for (const [doc, n] of [[docA, 3], [docB, 2]] as const) {
      for (let i = 0; i < n; i++) {
        await app.inject({
          method: 'POST', url: '/api/bookmarks', headers: auth(s),
          payload: { bookmarkId: uniq(), docId: doc, anchor: anchorOf(0), name: `${doc}-${i}`, updatedAt: new Date().toISOString() },
        })
      }
    }

    const r = await app.inject({ method: 'GET', url: '/api/bookmarks/overview', headers: auth(s) })
    expect(r.statusCode).toBe(200)
    expect(r.json().total).toBe(2) // 两本书，不是 5 条书签
    const counts = Object.fromEntries(
      r.json().groups.map((g: { docId: string; bookmarkCount: number }) => [g.docId, g.bookmarkCount]),
    )
    expect(counts[docA]).toBe(3)
    expect(counts[docB]).toBe(2)
  })

  it('§7.6 没有书签时 total=0、groups 为空', async () => {
    const s = await registerAndLogin(app)
    const r = await app.inject({ method: 'GET', url: '/api/bookmarks/overview', headers: auth(s) })
    expect(r.json().total).toBe(0)
    expect(r.json().groups).toEqual([])
  })

  it('§7.6 总览不含他人的书签', async () => {
    const { docId } = await setupReader()
    const other = await registerAndLogin(app)
    await app.inject({
      method: 'POST', url: '/api/bookmarks', headers: auth(other),
      payload: { bookmarkId: uniq(), docId, anchor: anchorOf(1), name: '偷看', updatedAt: new Date().toISOString() },
    }).then((r) => expect(r.statusCode).toBe(404))

    void docId
    const r = await app.inject({ method: 'GET', url: '/api/bookmarks/overview', headers: auth(other) })
    expect(r.json().total).toBe(0)
  })
})
