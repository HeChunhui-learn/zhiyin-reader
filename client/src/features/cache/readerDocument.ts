import { ApiError, api, getApiBase, type ContentPage, type DocumentDetail } from '../../api/client'
import { authStore } from '../../api/authStore'
import { STORE_DOCUMENTS, tx } from './db'
import { ReaderCache } from './readerCache'
import { splitSentences, type Sentence } from '../readalong/splitSentences'

const TTL_MS = 24 * 60 * 60 * 1000
const MAX_BYTES = 64 * 1024 * 1024
interface PreparedContent { content: ContentPage; sentences: Sentence[] }
interface StoredContent { key: string; revision: string; value: string; bytes: number; accessedAt: number; expires: number }
const memory = new ReaderCache<PreparedContent>(32 * 1024 * 1024, 5 * 60 * 1000)
const pending = new Map<string, Promise<{ doc: DocumentDetail } & PreparedContent>>()

async function persist(row: StoredContent): Promise<void> {
  if (row.bytes > MAX_BYTES) return
  await tx(STORE_DOCUMENTS, 'readwrite', store => store.put(row))
  // 游标逐条处理，淘汰列表仅保留容量元数据，避免同时持有所有正文。
  const { openCacheDb } = await import('./db')
  const db = await openCacheDb()
  if (!db) return
  await new Promise<void>(resolve => {
    try {
      const transaction = db.transaction(STORE_DOCUMENTS, 'readwrite')
      const store = transaction.objectStore(STORE_DOCUMENTS)
      let total = 0
      const entries: { key: string; bytes: number; accessedAt: number }[] = []
      const cursor = store.openCursor()
      cursor.onsuccess = () => {
        const current = cursor.result
        if (!current) {
          for (const entry of entries.sort((a, b) => a.accessedAt - b.accessedAt)) {
            if (total <= MAX_BYTES) break
            store.delete(entry.key)
            total -= entry.bytes
          }
          return
        }
        const entry = current.value as StoredContent
        if (entry.expires <= Date.now()) current.delete()
        else { total += entry.bytes; entries.push({ key: entry.key, bytes: entry.bytes, accessedAt: entry.accessedAt }) }
        current.continue()
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => resolve()
      transaction.onerror = () => resolve()
    } catch { resolve() }
  })
}

/** 每次先校验详情的授权/存在性，正文及切句结果才允许复用。 */
export function loadReaderDocument(docId: string): Promise<{ doc: DocumentDetail } & PreparedContent> {
  const scope = () => JSON.stringify([getApiBase(), authStore.userId, docId])
  const key = scope()
  const assertScope = () => {
    if (scope() !== key) throw new ApiError('READER_CONTEXT_CHANGED', '账号或服务端已切换，请重新打开书籍。', 409)
  }
  const existing = pending.get(key)
  if (existing) return existing
  const task = (async () => {
    let doc: DocumentDetail
    try { doc = await api.getDocument(docId) }
    catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        memory.invalidate(key)
        void tx(STORE_DOCUMENTS, 'readwrite', store => store.delete(key))
      }
      throw error
    }
    assertScope()
    const revision = JSON.stringify(['reader-v2', doc.importedAt, doc.fileSize, doc.paragraphCount, doc.imageCount])
    const value = await memory.load(key, revision, async () => {
      assertScope()
      const stored = await tx<StoredContent | undefined>(STORE_DOCUMENTS, 'readonly', store => store.get(key))
      assertScope()
      if (stored && stored.revision === revision && stored.expires > Date.now()) {
        try {
          const value = JSON.parse(stored.value) as PreparedContent
          if (!Array.isArray(value.content?.paragraphs) || !Array.isArray(value.sentences)) throw new Error('缓存损坏')
          void tx(STORE_DOCUMENTS, 'readwrite', store => store.put({ ...stored, accessedAt: Date.now() }))
          return value
        } catch { /* 缓存损坏时重新读取服务端 */ }
      }
      const content = await api.getContent(docId)
      assertScope()
      const value = { content, sentences: splitSentences(content.paragraphs) }
      const serialized = JSON.stringify(value)
      const row = { key, revision, value: serialized, bytes: serialized.length * 2, accessedAt: Date.now(), expires: Date.now() + TTL_MS }
      void persist(row).catch(() => {})
      return value
    })
    assertScope()
    return { doc, ...value }
  })().finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}
