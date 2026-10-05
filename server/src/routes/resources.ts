import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal } from '../dao'
import { SERVER_ROOT } from '../db'
import { ApiError, E } from '../errors'

/**
 * 二进制资源：图片（契约 §4.3 / §5）与原始文件（契约 §4.2）。
 * 落盘到 server/data/，这里模拟"对象存储／CDN"那一层，
 * 前端始终通过服务端取，不直接接触存储（CLAUDE.md 不做的事：不引入对象存储）。
 */

const IMAGE_DIR = join(SERVER_ROOT, 'data', 'images')
const FILE_DIR = join(SERVER_ROOT, 'data', 'files')

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

export default async function resourceRoutes(app: FastifyInstance) {
  /* ------------------------------- 契约 §4.3 上传单张图片（懒上传） */
  app.put<{ Params: { docId: string; imageId: string } }>(
    '/api/documents/:docId/images/:imageId',
    async (req, reply) => {
      const { docId, imageId } = req.params
      requireOwnDocument(req, docId)

      const row = dal.getImageById(docId, imageId)
      if (!row) throw E.notFound()

      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw E.validation(['body'])
      }
      if (body.length > MAX_IMAGE_BYTES) throw E.payloadTooLarge()

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
      // 重新上传时扩展名可能变了，先把旧的删掉
      const old = findImageFile(key)
      if (old) unlinkSync(old.path)

      writeFileSync(join(IMAGE_DIR, `${key}${ext}`), body)

      const imageUrl = `/api/documents/${docId}/images/${imageId}`
      dal.setImageRemoteUrl(imageId, imageUrl)

      return {
        imageId,
        imageUrl,
        bytes: body.length,
      }
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

      const bytes = readFileSync(found.path)
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
      const doc = requireOwnDocument(req, docId)

      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) throw E.validation(['body'])

      ensureDir(FILE_DIR)
      const ext = extname(doc.file_name) || '.bin'
      const target = join(FILE_DIR, `${docId}${ext}`)
      writeFileSync(target, body)

      const fileUrl = `/api/documents/${docId}/file`
      dal.setDocumentResourceUrl(docId, fileUrl)
      return { docId, fileUrl, fileSize: body.length }
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
      return reply.send(readFileSync(found))
    },
  )

  /* ------------------------------- 启动时确保目录存在 */
  ensureDir(IMAGE_DIR)
  ensureDir(FILE_DIR)
}
