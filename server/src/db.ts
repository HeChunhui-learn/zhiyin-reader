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
 * 建库：表不存在时执行 sql/schema.sql。
 * schema.sql 里全部是 CREATE ... IF NOT EXISTS，重复执行是安全的。
 */
export function initDb(): void {
  const schema = readFileSync(join(SERVER_ROOT, 'sql', 'schema.sql'), 'utf8')
  getDb().exec(schema)
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
