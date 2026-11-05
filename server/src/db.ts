import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** server/ 目录 */
export const SERVER_ROOT = join(here, '..')
/** 数据库文件位置，可用环境变量覆盖 */
export const DB_PATH =
  process.env.ZHIYIN_DB ?? join(SERVER_ROOT, 'data', 'zhiyin.db')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    const dir = dirname(DB_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

/**
 * 把旧库的 T_ImageResource 主键从 image_id 迁移为 (doc_id, image_id)。
 *
 * 旧表 image_id 是全库主键：两本书只要都有 images/cover.jpg，第二本导入就撞
 * UNIQUE。客户端算 imageId 时只含 src + paraIndex、不含 docId，所以隔离必须
 * 落在服务端。新库由 schema.sql 直接建成复合主键；这里只处理已经存在的旧表。
 */
function migrateImageResourcePrimaryKey(database: Database.Database): void {
  const cols = database.pragma('table_info(T_ImageResource)') as Array<{
    name: string
    pk: number
  }>
  const doc = cols.find((c) => c.name === 'doc_id')
  const image = cols.find((c) => c.name === 'image_id')

  // 新表：doc_id 是复合主键的第一列（pk=1）；旧表：doc_id 不在主键里（pk=0）
  if (!doc || !image || doc.pk > 0) return

  console.log('[db] 迁移 T_ImageResource 主键为 (doc_id, image_id)…')
  database.pragma('foreign_keys = OFF')
  try {
    database.exec(`
      BEGIN;
      DROP TABLE IF EXISTS T_ImageResource__pk_migration;
      CREATE TABLE T_ImageResource__pk_migration (
        image_id   TEXT NOT NULL,
        doc_id     TEXT NOT NULL REFERENCES T_Document(doc_id) ON DELETE CASCADE,
        para_index INTEGER NOT NULL,
        src        TEXT,
        alt        TEXT,
        cache_key  TEXT,
        local_url  TEXT,
        remote_url TEXT,
        PRIMARY KEY (doc_id, image_id)
      );
      INSERT INTO T_ImageResource__pk_migration
        (image_id, doc_id, para_index, src, alt, cache_key, local_url, remote_url)
      SELECT image_id, doc_id, para_index, src, alt, cache_key, local_url, remote_url
      FROM T_ImageResource;
      DROP TABLE T_ImageResource;
      ALTER TABLE T_ImageResource__pk_migration RENAME TO T_ImageResource;
      CREATE INDEX IF NOT EXISTS ix_image_doc
        ON T_ImageResource(doc_id, para_index);
      COMMIT;
    `)
    console.log('[db] T_ImageResource 主键迁移完成')
  } catch (e) {
    try {
      database.exec('ROLLBACK;')
    } catch {
      /* 事务可能已经结束 */
    }
    throw e
  } finally {
    database.pragma('foreign_keys = ON')
  }
}

/**
 * 建库：表不存在时执行 sql/schema.sql。
 * schema.sql 里全部是 CREATE ... IF NOT EXISTS，重复执行是安全的。
 */
export function initDb(): void {
  const schema = readFileSync(join(SERVER_ROOT, 'sql', 'schema.sql'), 'utf8')
  const database = getDb()
  database.exec(schema)
  migrateImageResourcePrimaryKey(database)
}

/** 库里有没有数据（种子脚本用它判断要不要灌） */
export function isEmpty(): boolean {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM T_User')
    .get() as { n: number }
  return row.n === 0
}

export function closeDb(): void {
  db?.close()
  db = null
}
