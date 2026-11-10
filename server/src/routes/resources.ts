import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, createReadStream, createWriteStream } from 'node:fs'
import { readFile, unlink, readdir, rename, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal, now } from '../dao'
import { DB_PATH } from '../db'
import { ApiError, E } from '../errors'

/**
 * 二进制资源：图片（契约 §4.3 / §5）与原始文件（契约 §4.2）。
 * 落盘到 server/data/，这里模拟"对象存储／CDN"那一层，
 * 前端始终通过服务端取，不直接接触存储（AGENTS.md 不做的事：不引入对象存储）。
 */

const IMAGE_DIR = join(dirname(DB_PATH), 'images')
const FILE_DIR = join(dirname(DB_PATH), 'files')
/** 头像（R7-5）。按 userId 命名，一人一份 */
const AVATAR_DIR = join(dirname(DB_PATH), 'avatars')

/** 契约 §3.6：头像上限比正文插图小一档 —— 它是个几十像素的圆，用不着 10MB */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** 只允许这些图片类型，避免变成任意文件上传 */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

/** 契约 §5：单张图片上限 10MB */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * 原始文件上限（R7-4）。以前这里**完全没有上限**，实际能传多大
 * 完全取决于 Fastify 的 bodyLimit —— 那是全局值，改它会连带放宽
 * 所有接口。这里补一条自己的，与 server/src/app.ts 的 BODY_LIMIT 对齐。
 *
 * 两边**必须同值**：bodyLimit 在进 handler 之前生效，若是它更小，
 * 这里的 413 永远轮不到发，读者拿到的是 Fastify 那条不带 details 的 413。
 * 有一条测试盯着这个等式（test/documents-resources.test.ts 的「上限一致性」）。
 * 客户端另有一份预检常量 client/src/features/parse/index.ts，也要一起改。
 */
export const MAX_FILE_BYTES = 500 * 1024 * 1024

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

/** 落盘文件名：docId 与 imageId 拼在一起，避免不同文档的同名图片互相覆盖 */
function imageKey(docId: string, imageId: string): string {
  return `${docId}_${imageId}`
}

/** 按 key 找已存在的图片文件（上传时用的是当时那个扩展名） */
function findImageFile(key: string): { path: string; mime: string } | null {
  for (const ext of Object.keys(EXT_MIME)) {
    const p = join(IMAGE_DIR, `${key}${ext}`)
    if (existsSync(p)) return { path: p, mime: EXT_MIME[ext] }
  }
  return null
}

function requireOwnDocument(req: FastifyRequest, docId: string) {
  const userId = requireUserId(req)
  const doc = dal.getDocumentById(docId)
  if (!doc) throw E.notFound()
  if (doc.owner_id !== userId) throw E.forbiddenNotOwner()
  return doc
}

/** 使用同目录临时文件原子替换；失败时清理半成品。 */
async function storeBody(body: unknown, target: string, limit: number): Promise<number> {
  if (!(body instanceof Readable)) throw E.validation(['body'])
  let bytes = 0
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await pipeline(body, new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length
      callback(bytes > limit ? E.payloadTooLarge() : null, chunk)
    } }), createWriteStream(temporary))
    if (!bytes) throw E.validation(['body'])
    await rename(temporary, target)
    return bytes
  } finally {
    await rm(temporary, { force: true })
  }
}

const documentWrites = new Map<string, Promise<void>>()

/** 同一文档的上传与删除串行，避免目录扫描后又写入孤儿文件。 */
export async function withDocumentResourceLock<T>(docId: string, action: () => Promise<T>): Promise<T> {
  const previous = documentWrites.get(docId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  documentWrites.set(docId, current)
  await previous
  try { return await action() }
  finally {
    release()
    if (documentWrites.get(docId) === current) documentWrites.delete(docId)
  }
}

export async function cleanupDocumentResources(docId: string): Promise<void> {
  // docId 由服务端生成，仅删除该文档的资源，不进行递归目录操作。
  for (const dir of [IMAGE_DIR, FILE_DIR]) {
    if (!existsSync(dir)) continue
    for (const name of await readdir(dir)) {
      if (name.startsWith(`${docId}_`) || name.startsWith(`${docId}.`)) await unlink(join(dir, name))
    }
  }
}

export default async function resourceRoutes(app: FastifyInstance) {
  /* ------------------------------- 契约 §4.3 上传单张图片（懒上传） */
  app.put<{ Params: { docId: string; imageId: string } }>(
    '/api/documents/:docId/images/:imageId',
    async (req, reply) => {
      const { docId, imageId } = req.params
      return withDocumentResourceLock(docId, async () => {
        requireOwnDocument(req, docId)

        const row = dal.getImageById(docId, imageId)
        if (!row) throw E.notFound()


        if (!(req.body instanceof Readable)) throw E.validation(['body'])
      const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim()
        const ext = MIME_EXT[mime]
        if (!ext) {
          throw new ApiError(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            `不支持的图片类型：${mime || '未知'}`,
            { mime },
          )
        }

        ensureDir(IMAGE_DIR)
        const key = imageKey(docId, imageId)
        // 写入成功后再清理旧扩展名，失败时保留原图
        const old = findImageFile(key)
        const target = join(IMAGE_DIR, `${key}${ext}`)
        const bytes = await storeBody(req.body, target, MAX_IMAGE_BYTES)
        if (old && old.path !== target) await unlink(old.path)

        const imageUrl = `/api/documents/${docId}/images/${imageId}`
        dal.setImageRemoteUrl(docId, imageId, imageUrl)

        return {
          imageId,
          imageUrl,
          bytes,
        }
      })
    },
  )

  /* ------------------------------- 契约 §5 读取图片（服务端代理） */
  app.get<{ Params: { docId: string; imageId: string } }>(
    '/api/documents/:docId/images/:imageId',
    async (req, reply) => {
      const { docId, imageId } = req.params
      requireOwnDocument(req, docId)

      const row = dal.getImageById(docId, imageId)
      if (!row) throw E.notFound()

      const found = findImageFile(imageKey(docId, imageId))
      if (!found) {
        // 这张图还没被任何设备上传过，前端据此展示"图片不可用"占位（契约 §4.3）
        throw E.notFound()
      }

      const bytes = await readFile(found.path)
      const etag = `"${createHash('sha1').update(bytes).digest('hex').slice(0, 20)}"`

      if (req.headers['if-none-match'] === etag) {
        return reply.code(304).send()
      }
      reply
        .header('Content-Type', found.mime)
        .header('ETag', etag)
        .header('Cache-Control', 'private, max-age=604800')
      return reply.send(bytes)
    },
  )

  /* ------------------------------- 契约 §4.2 上传 / 读取原始文件 */
  app.put<{ Params: { docId: string } }>(
    '/api/documents/:docId/file',
    async (req, reply) => {
      const { docId } = req.params
      return withDocumentResourceLock(docId, async () => {
        const doc = requireOwnDocument(req, docId)


        ensureDir(FILE_DIR)
        const ext = extname(doc.file_name) || '.bin'
        const target = join(FILE_DIR, `${docId}${ext}`)
        const bytes = await storeBody(req.body, target, MAX_FILE_BYTES)

        const fileUrl = `/api/documents/${docId}/file`
        dal.setDocumentResourceUrl(docId, fileUrl)
        return { docId, fileUrl, fileSize: bytes }
      })
    },
  )

  app.get<{ Params: { docId: string } }>(
    '/api/documents/:docId/file',
    async (req, reply) => {
      const { docId } = req.params
      const doc = requireOwnDocument(req, docId)

      const dir = FILE_DIR
      const candidates = ['.epub', '.txt', '.md', extname(doc.file_name)]
      let found: string | null = null
      for (const ext of candidates) {
        const p = join(dir, `${docId}${ext}`)
        if (existsSync(p)) {
          found = p
          break
        }
      }
      if (!found) throw E.notFound()

      reply
        .header('Content-Type', 'application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
        )
      return reply.send(createReadStream(found))
    },
  )

  /* ------------------------------- 契约 §3.6 头像上传 / 读取 / 移除 */

  /** 换头像时旧扩展名可能还在，按 key 找现有的那份 */
  function findAvatar(userId: string): { path: string; mime: string } | null {
    for (const ext of Object.keys(EXT_MIME)) {
      const p = join(AVATAR_DIR, `${userId}${ext}`)
      if (existsSync(p)) return { path: p, mime: EXT_MIME[ext] }
    }
    return null
  }

  app.put('/api/users/me/avatar', async (req, reply) => {
    const userId = requireUserId(req)


    if (!(req.body instanceof Readable)) throw E.validation(['body'])
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim()
    const ext = MIME_EXT[mime]
    if (!ext) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `不支持的图片类型：${mime || '未知'}`, {
        mime,
      })
    }

    ensureDir(AVATAR_DIR)
    const old = findAvatar(userId)
    const target = join(AVATAR_DIR, `${userId}${ext}`)
    const bytes = await storeBody(req.body, target, MAX_AVATAR_BYTES)
    if (old && old.path !== target) await unlink(old.path)

    const avatarUrl = '/api/users/me/avatar'
    dal.setUserAvatar(userId, avatarUrl, now())
    return reply.code(200).send({ avatarUrl, bytes })
  })

  app.get('/api/users/me/avatar', async (req, reply) => {
    const userId = requireUserId(req)
    const found = findAvatar(userId)
    if (!found) throw E.notFound()

    // 头像换得勤，用短一点的缓存并带上 ETag 让浏览器自己判重
    const bytes = await readFile(found.path)
    const etag = `"${createHash('sha1').update(bytes).digest('hex').slice(0, 20)}"`
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()

    reply
      .header('Content-Type', found.mime)
      .header('ETag', etag)
      .header('Cache-Control', 'private, no-cache')
    return reply.send(bytes)
  })

  app.delete('/api/users/me/avatar', async (req) => {
    const userId = requireUserId(req)
    const found = findAvatar(userId)
    if (found) await unlink(found.path)
    dal.setUserAvatar(userId, null, now())
    return { avatarUrl: null as string | null }
  })

  /* ------------------------------- 启动时确保目录存在 */
  ensureDir(IMAGE_DIR)
  ensureDir(FILE_DIR)
  ensureDir(AVATAR_DIR)
}
