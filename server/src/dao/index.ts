import { randomUUID } from 'node:crypto'
import { getDb } from '../db'

/**
 * DataAccessLibrary —— 业务逻辑层访问数据层的唯一入口。
 * 上层不得直接写 SQL，也不得直接持有 better-sqlite3 的连接。
 *
 * R1 只实现骨架需要的这几个方法；R2 起按 04 §4.3.2 的方法清单逐个补齐。
 */

/* ------------------------------------------------------------------ 行类型 */

export interface UserRow {
  user_id: string
  account: string
  password_hash: string
  salt: string
  nickname: string | null
  fail_count: number
  locked_until: string | null
  created_at: string
  last_login: string | null
}

export interface DocumentRow {
  doc_id: string
  owner_id: string
  file_name: string
  file_format: string
  file_size: number | null
  title: string | null
  author: string | null
  content_hash: string | null
  resource_url: string | null
  imported_at: string
}

export interface ParagraphRow {
  para_id: string
  doc_id: string
  para_index: number
  para_type: string
  text: string
}

export interface SentenceRow {
  sentence_id: string
  para_id: string
  sentence_index: number
  start_offset: number
  end_offset: number
}

export interface ImageRow {
  image_id: string
  doc_id: string
  para_index: number
  src: string | null
  alt: string | null
  cache_key: string | null
  local_url: string | null
  remote_url: string | null
}

export interface ReadingProgressRow {
  progress_id: string
  user_id: string
  doc_id: string
  device_id: string
  chapter_index: number
  paragraph_index: number
  char_offset: number
  scroll_offset: number
  last_sentence_index: number | null
  updated_at: string
  server_received_at: string
  version: number
}

export interface BookmarkRow {
  bookmark_id: string
  user_id: string
  doc_id: string
  anchor_json: string
  name: string | null
  version: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface SyncRecordRow {
  record_id: string
  user_id: string
  doc_id: string
  device_id: string | null
  state: string
  local_delta: string | null
  remote_changes: string | null
  conflict_json: string | null
  version: number
  updated_at: string
}

export interface TokenRow {
  token_id: string
  user_id: string
  device_id: string | null
  refresh_hash: string
  expires_at: string
  created_at: string
  revoked_at: string | null
}

export interface IdempotencyRow {
  user_id: string
  idem_key: string
  scope: string
  response_json: string
  created_at: string
}

/* -------------------------------------------------------------- 工具 */

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

export function now(): string {
  return new Date().toISOString()
}

/* ------------------------------------------------------- DataAccessLibrary */

export class DataAccessLibrary {
  /* ---- 用户 ---- */

  getUserByAccount(account: string): UserRow | undefined {
    return getDb()
      .prepare('SELECT * FROM T_User WHERE account = ?')
      .get(account) as UserRow | undefined
  }

  getUserById(userId: string): UserRow | undefined {
    return getDb()
      .prepare('SELECT * FROM T_User WHERE user_id = ?')
      .get(userId) as UserRow | undefined
  }

  insertUser(u: Omit<UserRow, 'fail_count' | 'locked_until' | 'last_login'>): UserRow {
    getDb()
      .prepare(
        `INSERT INTO T_User
           (user_id, account, password_hash, salt, nickname, fail_count, locked_until, created_at, last_login)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, NULL)`,
      )
      .run(u.user_id, u.account, u.password_hash, u.salt, u.nickname, u.created_at)
    return this.getUserById(u.user_id)!
  }

  /* ---- 登录失败与锁定（契约 §2：连续 5 次锁 15 分钟） ---- */

  recordLoginFailure(userId: string, maxFail: number, lockMs: number): string | null {
    const db = getDb()
    const u = this.getUserById(userId)
    if (!u) return null
    const next = u.fail_count + 1
    const lockedUntil =
      next >= maxFail ? new Date(Date.now() + lockMs).toISOString() : u.locked_until
    db.prepare('UPDATE T_User SET fail_count = ?, locked_until = ? WHERE user_id = ?')
      .run(next, lockedUntil, userId)
    return next >= maxFail ? lockedUntil : null
  }

  updateUserNickname(userId: string, nickname: string | null): void {
    getDb().prepare('UPDATE T_User SET nickname = ? WHERE user_id = ?').run(nickname, userId)
  }

  updateUserPassword(userId: string, passwordHash: string, salt: string): void {
    getDb()
      .prepare('UPDATE T_User SET password_hash = ?, salt = ? WHERE user_id = ?')
      .run(passwordHash, salt, userId)
  }

  clearLoginFailure(userId: string): void {
    getDb()
      .prepare(
        'UPDATE T_User SET fail_count = 0, locked_until = NULL, last_login = ? WHERE user_id = ?',
      )
      .run(now(), userId)
  }

  /* ---- 刷新令牌 ---- */

  insertToken(t: Omit<TokenRow, 'revoked_at'>): void {
    getDb()
      .prepare(
        `INSERT INTO T_Token
           (token_id, user_id, device_id, refresh_hash, expires_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(t.token_id, t.user_id, t.device_id, t.refresh_hash, t.expires_at, t.created_at)
  }

  findTokenByHash(refreshHash: string): TokenRow | undefined {
    return getDb()
      .prepare('SELECT * FROM T_Token WHERE refresh_hash = ? AND revoked_at IS NULL')
      .get(refreshHash) as TokenRow | undefined
  }

  /** 契约 §3.4：退出登录删除该令牌记录 */
  deleteToken(tokenId: string): void {
    getDb().prepare('DELETE FROM T_Token WHERE token_id = ?').run(tokenId)
  }

  /** 轮换：旧令牌立即失效（契约 §3.3） */
  revokeToken(tokenId: string): void {
    getDb()
      .prepare('UPDATE T_Token SET revoked_at = ? WHERE token_id = ?')
      .run(now(), tokenId)
  }

  countActiveTokens(userId: string): number {
    const row = getDb()
      .prepare(
        'SELECT COUNT(*) AS n FROM T_Token WHERE user_id = ? AND revoked_at IS NULL',
      )
      .get(userId) as { n: number }
    return row.n
  }

  /* ---- 文档 ---- */

  listDocumentsByUser(userId: string): DocumentRow[] {
    return getDb()
      .prepare(
        'SELECT * FROM T_Document WHERE owner_id = ? ORDER BY imported_at DESC',
      )
      .all(userId) as DocumentRow[]
  }

  getDocumentById(docId: string): DocumentRow | undefined {
    return getDb()
      .prepare('SELECT * FROM T_Document WHERE doc_id = ?')
      .get(docId) as DocumentRow | undefined
  }

  getOwnDocumentByHash(ownerId: string, contentHash: string): DocumentRow | undefined {
    return getDb()
      .prepare(
        'SELECT * FROM T_Document WHERE owner_id = ? AND content_hash = ?',
      )
      .get(ownerId, contentHash) as DocumentRow | undefined
  }

  insertDocument(d: DocumentRow): DocumentRow {
    getDb()
      .prepare(
        `INSERT INTO T_Document
           (doc_id, owner_id, file_name, file_format, file_size, title, author,
            content_hash, resource_url, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.doc_id, d.owner_id, d.file_name, d.file_format, d.file_size,
        d.title, d.author, d.content_hash, d.resource_url, d.imported_at,
      )
    return this.getDocumentById(d.doc_id)!
  }

  /** 04 §4.3.2：级联删除该文档的段落、句子、图片引用、书签与各设备阅读进度 */
  deleteDocument(docId: string): boolean {
    // 外键声明了 ON DELETE CASCADE，子表由数据库自动清理
    const r = getDb().prepare('DELETE FROM T_Document WHERE doc_id = ?').run(docId)
    return r.changes > 0
  }

  /* ---- 段落 ---- */

  listParagraphsByDocument(docId: string): ParagraphRow[] {
    return getDb()
      .prepare(
        'SELECT * FROM T_Paragraph WHERE doc_id = ? ORDER BY para_index ASC',
      )
      .all(docId) as ParagraphRow[]
  }

  countParagraphs(docId: string): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM T_Paragraph WHERE doc_id = ?')
      .get(docId) as { n: number }
    return row.n
  }

  /** 整篇文档的段落一次性写入，放在一个事务里 */
  insertParagraphs(rows: ParagraphRow[]): void {
    const stmt = getDb().prepare(
      `INSERT INTO T_Paragraph (para_id, doc_id, para_index, para_type, text)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const tx = getDb().transaction((list: ParagraphRow[]) => {
      for (const r of list) {
        stmt.run(r.para_id, r.doc_id, r.para_index, r.para_type, r.text)
      }
    })
    tx(rows)
  }

  /**
   * 契约 §4.1：在单个事务内写入 T_Document、T_Paragraph、T_Sentence、T_ImageResource，
   * 任一步失败整体回滚。
   */
  insertDocumentWithContent(
    doc: DocumentRow,
    paragraphs: ParagraphRow[],
    sentences: SentenceRow[],
    images: ImageRow[],
  ): void {
    const db = getDb()
    const insDoc = db.prepare(
      `INSERT INTO T_Document
         (doc_id, owner_id, file_name, file_format, file_size, title, author,
          content_hash, resource_url, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insPara = db.prepare(
      `INSERT INTO T_Paragraph (para_id, doc_id, para_index, para_type, text)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const insSent = db.prepare(
      `INSERT INTO T_Sentence (sentence_id, para_id, sentence_index, start_offset, end_offset)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const insImg = db.prepare(
      `INSERT INTO T_ImageResource
         (image_id, doc_id, para_index, src, alt, cache_key, local_url, remote_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    const tx = db.transaction(() => {
      insDoc.run(
        doc.doc_id, doc.owner_id, doc.file_name, doc.file_format, doc.file_size,
        doc.title, doc.author, doc.content_hash, doc.resource_url, doc.imported_at,
      )
      for (const p of paragraphs) {
        insPara.run(p.para_id, p.doc_id, p.para_index, p.para_type, p.text)
      }
      for (const s of sentences) {
        insSent.run(s.sentence_id, s.para_id, s.sentence_index, s.start_offset, s.end_offset)
      }
      for (const i of images) {
        insImg.run(i.image_id, i.doc_id, i.para_index, i.src, i.alt, i.cache_key, i.local_url, i.remote_url)
      }
    })
    tx()
  }

  /**
   * 契约 §4.4：书架列表与检索。
   * keyword 同时匹配标题、作者与正文（正文在 T_Paragraph.text 上做 LIKE）。
   */
  searchDocuments(
    userId: string,
    opts: { keyword?: string; category?: string; page: number; pageSize: number },
  ): { total: number; rows: DocumentRow[] } {
    const db = getDb()
    const params: unknown[] = [userId]
    let where = 'd.owner_id = ?'

    // 书架侧边栏分类（契约 §4.4）
    switch (opts.category) {
      case 'recent': // 有阅读进度记录
        where +=
          ' AND EXISTS (SELECT 1 FROM T_ReadingProgress pr WHERE pr.doc_id = d.doc_id AND pr.user_id = ?)'
        params.push(userId)
        break
      case 'bookmarked': // 有未删除的书签
        where +=
          ' AND EXISTS (SELECT 1 FROM T_Bookmark b WHERE b.doc_id = d.doc_id AND b.user_id = ? AND b.deleted_at IS NULL)'
        params.push(userId)
        break
      case 'offline':
        // "有本地副本"是纯客户端状态，服务端不可知（材料审查 O21），这里返回空集
        where += ' AND 0'
        break
      default:
        break
    }

    if (opts.keyword) {
      where += ` AND (
        d.title LIKE ? OR d.file_name LIKE ? OR d.author LIKE ?
        OR EXISTS (SELECT 1 FROM T_Paragraph p WHERE p.doc_id = d.doc_id AND p.text LIKE ?)
      )`
      const kw = `%${opts.keyword}%`
      params.push(kw, kw, kw, kw)
    }

    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM T_Document d WHERE ${where}`).get(...params) as
        { n: number }
    ).n

    const rows = db
      .prepare(
        `SELECT d.* FROM T_Document d WHERE ${where}
         ORDER BY d.imported_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as DocumentRow[]

    return { total, rows }
  }

  countImages(docId: string): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM T_ImageResource WHERE doc_id = ?')
      .get(docId) as { n: number }
    return row.n
  }

  /* ---- 图片资源（契约 §4.3 懒上传 / §5 服务端代理） ---- */

  listImagesByDocument(docId: string): ImageRow[] {
    return getDb()
      .prepare(
        'SELECT * FROM T_ImageResource WHERE doc_id = ? ORDER BY para_index ASC',
      )
      .all(docId) as ImageRow[]
  }

  getImageById(docId: string, imageId: string): ImageRow | undefined {
    return getDb()
      .prepare(
        'SELECT * FROM T_ImageResource WHERE doc_id = ? AND image_id = ?',
      )
      .get(docId, imageId) as ImageRow | undefined
  }

  /** 上传成功后回写 remote_url */
  setImageRemoteUrl(imageId: string, remoteUrl: string): void {
    getDb()
      .prepare('UPDATE T_ImageResource SET remote_url = ? WHERE image_id = ?')
      .run(remoteUrl, imageId)
  }

  /** 契约 §4.2：原始文件上传成功后回写 T_Document.resource_url */
  setDocumentResourceUrl(docId: string, resourceUrl: string | null): void {
    getDb()
      .prepare('UPDATE T_Document SET resource_url = ? WHERE doc_id = ?')
      .run(resourceUrl, docId)
  }

  /* ---- 阅读进度（契约 §6） ---- */

  /** 契约 §6.1：返回该用户该文档的**所有设备**记录，否则新设备拉不到别端进度 */
  listProgressByDocument(userId: string, docId: string): ReadingProgressRow[] {
    return getDb()
      .prepare(
        `SELECT * FROM T_ReadingProgress
         WHERE user_id = ? AND doc_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(userId, docId) as ReadingProgressRow[]
  }

  getProgressByDocAndDevice(
    userId: string,
    docId: string,
    deviceId: string,
  ): ReadingProgressRow | undefined {
    return getDb()
      .prepare(
        'SELECT * FROM T_ReadingProgress WHERE user_id = ? AND doc_id = ? AND device_id = ?',
      )
      .get(userId, docId, deviceId) as ReadingProgressRow | undefined
  }

  insertProgress(row: ReadingProgressRow): ReadingProgressRow {
    getDb()
      .prepare(
        `INSERT INTO T_ReadingProgress
           (progress_id, user_id, doc_id, device_id, chapter_index, paragraph_index,
            char_offset, scroll_offset, last_sentence_index, updated_at,
            server_received_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.progress_id, row.user_id, row.doc_id, row.device_id,
        row.chapter_index, row.paragraph_index, row.char_offset, row.scroll_offset,
        row.last_sentence_index, row.updated_at, row.server_received_at, row.version,
      )
    return row
  }

  /**
   * 条件更新：只有当前 version 等于 baseVersion 才干。
   * 返回是否真的更新了（false 表示版本不匹配 = 冲突）。
   */
  updateProgressIfVersion(
    progressId: string,
    baseVersion: number,
    fields: {
      chapter_index: number
      paragraph_index: number
      char_offset: number
      scroll_offset: number
      last_sentence_index: number | null
      updated_at: string
      server_received_at: string
    },
  ): boolean {
    const r = getDb()
      .prepare(
        `UPDATE T_ReadingProgress SET
           chapter_index = ?, paragraph_index = ?, char_offset = ?, scroll_offset = ?,
           last_sentence_index = ?, updated_at = ?, server_received_at = ?,
           version = version + 1
         WHERE progress_id = ? AND version = ?`,
      )
      .run(
        fields.chapter_index, fields.paragraph_index, fields.char_offset, fields.scroll_offset,
        fields.last_sentence_index, fields.updated_at, fields.server_received_at,
        progressId, baseVersion,
      )
    return r.changes > 0
  }

  /**
   * 无条件写入（裁决用的强制落库），版本号自增。
   */
  forceProgress(
    progressId: string,
    fields: {
      chapter_index: number
      paragraph_index: number
      char_offset: number
      scroll_offset: number
      last_sentence_index: number | null
      updated_at: string
      server_received_at: string
    },
  ): void {
    getDb()
      .prepare(
        `UPDATE T_ReadingProgress SET
           chapter_index = ?, paragraph_index = ?, char_offset = ?, scroll_offset = ?,
           last_sentence_index = ?, updated_at = ?, server_received_at = ?,
           version = version + 1
         WHERE progress_id = ?`,
      )
      .run(
        fields.chapter_index, fields.paragraph_index, fields.char_offset, fields.scroll_offset,
        fields.last_sentence_index, fields.updated_at, fields.server_received_at, progressId,
      )
  }

  /* ---- 书签（契约 §7） ---- */

  getBookmarkById(bookmarkId: string): BookmarkRow | undefined {
    return getDb()
      .prepare('SELECT * FROM T_Bookmark WHERE bookmark_id = ?')
      .get(bookmarkId) as BookmarkRow | undefined
  }

  listBookmarksByDocument(
    userId: string,
    docId: string,
    includeDeleted: boolean,
  ): BookmarkRow[] {
    const sql = includeDeleted
      ? 'SELECT * FROM T_Bookmark WHERE user_id = ? AND doc_id = ? ORDER BY created_at ASC'
      : 'SELECT * FROM T_Bookmark WHERE user_id = ? AND doc_id = ? AND deleted_at IS NULL ORDER BY created_at ASC'
    return getDb().prepare(sql).all(userId, docId) as BookmarkRow[]
  }

  /**
   * 契约 §7.4：增量拉取。
   *
   * since 用**服务端时间**比较，但拿去比的是 `updated_at`（客户端时间）—— 这正是
   * 材料审查 E15 指出的问题：删除墓碑若不更新 updated_at，删除事件就永远拉不到。
   * 所以这里改成比 `updated_at`，而**软删除时会同时刷新 updated_at**
   * （见 routes/bookmarks.ts 的删除实现），保证墓碑也能被增量拉到。
   */
  listBookmarksSince(
    userId: string,
    docId: string | undefined,
    since: string | null,
    includeDeleted: boolean,
  ): BookmarkRow[] {
    const where: string[] = ['user_id = ?']
    const params: unknown[] = [userId]
    if (docId) {
      where.push('doc_id = ?')
      params.push(docId)
    }
    if (since) {
      where.push('updated_at > ?')
      params.push(since)
    }
    if (!includeDeleted) where.push('deleted_at IS NULL')

    return getDb()
      .prepare(
        `SELECT * FROM T_Bookmark WHERE ${where.join(' AND ')} ORDER BY updated_at ASC`,
      )
      .all(...params) as BookmarkRow[]
  }

  insertBookmark(row: BookmarkRow): void {
    getDb()
      .prepare(
        `INSERT INTO T_Bookmark
           (bookmark_id, user_id, doc_id, anchor_json, name, version, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.bookmark_id, row.user_id, row.doc_id, row.anchor_json, row.name,
        row.version, row.created_at, row.updated_at, row.deleted_at,
      )
  }

  /** 条件更新：改名 / 移动位置 / 删除墓碑都走这里 */
  updateBookmarkIfVersion(
    bookmarkId: string,
    baseVersion: number,
    fields: {
      anchor_json?: string
      name?: string | null
      updated_at?: string
      deleted_at?: string | null
    },
  ): boolean {
    const sets: string[] = ['version = version + 1']
    const params: unknown[] = []
    if (fields.anchor_json !== undefined) {
      sets.push('anchor_json = ?')
      params.push(fields.anchor_json)
    }
    if (fields.name !== undefined) {
      sets.push('name = ?')
      params.push(fields.name)
    }
    if (fields.updated_at !== undefined) {
      sets.push('updated_at = ?')
      params.push(fields.updated_at)
    }
    if (fields.deleted_at !== undefined) {
      sets.push('deleted_at = ?')
      params.push(fields.deleted_at)
    }
    params.push(bookmarkId, baseVersion)

    const r = getDb()
      .prepare(
        `UPDATE T_Bookmark SET ${sets.join(', ')} WHERE bookmark_id = ? AND version = ?`,
      )
      .run(...params)
    return r.changes > 0
  }

  /** 无条件覆盖（keep_both 新增副本、裁决落库时用） */
  forceUpdateBookmark(
    bookmarkId: string,
    fields: {
      anchor_json?: string
      name?: string | null
      updated_at?: string
      deleted_at?: string | null
    },
  ): void {
    const sets: string[] = ['version = version + 1']
    const params: unknown[] = []
    if (fields.anchor_json !== undefined) {
      sets.push('anchor_json = ?')
      params.push(fields.anchor_json)
    }
    if (fields.name !== undefined) {
      sets.push('name = ?')
      params.push(fields.name)
    }
    if (fields.updated_at !== undefined) {
      sets.push('updated_at = ?')
      params.push(fields.updated_at)
    }
    if (fields.deleted_at !== undefined) {
      sets.push('deleted_at = ?')
      params.push(fields.deleted_at)
    }
    params.push(bookmarkId)
    getDb()
      .prepare(`UPDATE T_Bookmark SET ${sets.join(', ')} WHERE bookmark_id = ?`)
      .run(...params)
  }

  /* ---- 同步记录（契约 §2.2.6：未决冲突不得丢失） ---- */

  insertSyncRecord(row: SyncRecordRow): void {
    getDb()
      .prepare(
        `INSERT INTO T_SyncRecord
           (record_id, user_id, doc_id, device_id, state, local_delta,
            remote_changes, conflict_json, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.record_id, row.user_id, row.doc_id, row.device_id, row.state,
        row.local_delta, row.remote_changes, row.conflict_json,
        row.version, row.updated_at,
      )
  }

  /** 未决（state = 冲突）的记录，用于把冲突列表还原给下一次进入的界面 */
  listPendingConflicts(userId: string, docId?: string): SyncRecordRow[] {
    const where = ["user_id = ?", "state = '冲突'"]
    const params: unknown[] = [userId]
    if (docId) {
      where.push('doc_id = ?')
      params.push(docId)
    }
    return getDb()
      .prepare(
        `SELECT * FROM T_SyncRecord WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`,
      )
      .all(...params) as SyncRecordRow[]
  }

  updateSyncState(recordId: string, state: string): void {
    getDb()
      .prepare('UPDATE T_SyncRecord SET state = ?, updated_at = ? WHERE record_id = ?')
      .run(state, now(), recordId)
  }

  countBookmarksByDocument(userId: string, docId: string): number {
    const row = getDb()
      .prepare(
        'SELECT COUNT(*) AS n FROM T_Bookmark WHERE user_id = ? AND doc_id = ? AND deleted_at IS NULL',
      )
      .get(userId, docId) as { n: number }
    return row.n
  }

  /* ---- 幂等键（契约 §1，A2 落表；模块内聚，与同步放一起） ---- */

  getIdempotency(userId: string, scope: string, key: string): IdempotencyRow | undefined {
    return getDb()
      .prepare(
        'SELECT * FROM T_Idempotency WHERE user_id = ? AND scope = ? AND idem_key = ?',
      )
      .get(userId, scope, key) as IdempotencyRow | undefined
  }

  /**
   * 记下首次请求的结果。
   *
   * 用 INSERT OR REPLACE 而不是 INSERT：同一键若并发打进来，后到的那次是
   * 重复提交，覆盖成它自己的结果也无害（内容必然相同或本就该以先到者为准，
   * 而 better-sqlite3 是同步 API，单个进程内不会真的并发），
   * 但用 REPLACE 可以避免键冲突时抛异常打断请求。
   */
  putIdempotency(row: IdempotencyRow): void {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO T_Idempotency
           (user_id, idem_key, scope, response_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.user_id, row.idem_key, row.scope, row.response_json, row.created_at)
  }

  /** 删掉单条（读取时发现已过期，顺手清掉） */
  deleteIdempotency(userId: string, scope: string, key: string): void {
    getDb()
      .prepare('DELETE FROM T_Idempotency WHERE user_id = ? AND scope = ? AND idem_key = ?')
      .run(userId, scope, key)
  }

  /** 删除超过 TTL 的记录，返回删掉的条数（契约 §1 的"过期的定期清理"） */
  deleteIdempotencyBefore(cutoff: string): number {
    return getDb()
      .prepare('DELETE FROM T_Idempotency WHERE created_at < ?')
      .run(cutoff).changes
  }

  /** 表里现有多少条幂等键（健康检查与调试用） */
  countIdempotency(): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM T_Idempotency')
      .get() as { n: number }
    return row.n
  }
}

export const dal = new DataAccessLibrary()
