import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { DB_PATH, SERVER_ROOT } from '../src/db'
import { auth, closeApp, importBody, makeApp, registerAndLogin } from './helpers'

/**
 * 旧库升级：T_ImageResource 主键从 image_id 迁移到 (doc_id, image_id)。
 *
 * 线上库已经在跑，不能只改 schema.sql —— `initDb()` 必须能就地升级且保留
 * 原有图片记录。这个用例先造一个旧结构的库，再启动应用，验证迁移和导入。
 */
let app: FastifyInstance

beforeAll(async () => {
  const db = new Database(DB_PATH)
  db.pragma('foreign_keys = OFF')
  // 先按当前 schema 建全部表，再把图片表换回旧定义
  db.exec(readFileSync(join(SERVER_ROOT, 'sql/schema.sql'), 'utf8'))
  db.exec(`
    DROP TABLE IF EXISTS T_ImageResource;
    CREATE TABLE T_ImageResource (
      image_id   TEXT PRIMARY KEY,
      doc_id     TEXT NOT NULL,
      para_index INTEGER NOT NULL,
      src        TEXT,
      alt        TEXT,
      cache_key  TEXT,
      local_url  TEXT,
      remote_url TEXT
    );
    INSERT INTO T_User
      (user_id, account, password_hash, salt, nickname, fail_count, locked_until, created_at, last_login)
    VALUES
      ('u_migrate', 'migrate@example.com', 'x', 'x', '迁移用户', 0, NULL, '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO T_Document
      (doc_id, owner_id, file_name, file_format, file_size, title, author, content_hash, resource_url, imported_at)
    VALUES
      ('doc_migrate', 'u_migrate', 'old.txt', 'TXT', 10, '旧书', '作者', 'sha256:old', NULL, '2026-01-01T00:00:00.000Z');
    INSERT INTO T_ImageResource (image_id, doc_id, para_index, src, alt)
    VALUES ('img_old', 'doc_migrate', 0, 'old.png', '旧图');
  `)
  db.pragma('foreign_keys = ON')
  db.close()

  // buildApp → initDb → 自动迁移
  app = await makeApp()
})

afterAll(async () => {
  await closeApp(app)
})

it('旧库启动时自动迁移为复合主键，并保留原有图片记录', () => {
  const db = new Database(DB_PATH)
  const cols = db.pragma('table_info(T_ImageResource)') as { name: string; pk: number }[]
  expect(cols.find((c) => c.name === 'doc_id')?.pk).toBe(1)
  expect(cols.find((c) => c.name === 'image_id')?.pk).toBe(2)

  const row = db
    .prepare('SELECT image_id, doc_id, src FROM T_ImageResource')
    .get() as { image_id: string; doc_id: string; src: string }
  expect(row).toEqual({ image_id: 'img_old', doc_id: 'doc_migrate', src: 'old.png' })
  db.close()
})

it('迁移后两本书仍可使用同名 imageId 导入', async () => {
  const s = await registerAndLogin(app)
  const imageId = 'img_same_after_migration'
  const mk = (title: string) =>
    importBody({
      title,
      paragraphs: [{ text: 'x。' }],
      imageRefs: [{ imageId, paraIndex: 0, src: 'OEBPS/images/cover.jpg', alt: '封面' }],
    })

  const one = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk('书一') })
  const two = await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: mk('书二') })
  expect(one.statusCode).toBe(201)
  expect(two.statusCode).toBe(201)
})
