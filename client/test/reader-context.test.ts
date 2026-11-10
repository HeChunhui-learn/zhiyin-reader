import { expect, it, vi } from 'vitest'
import { loadReaderDocument } from '../src/features/cache/readerDocument'

const state = vi.hoisted(() => ({ base: '/server-a', userId: 'reader-a', release: () => {}, contentCalls: 0 }))
vi.mock('../src/api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api/client')>()
  return { ...actual, getApiBase: () => state.base, api: {
    getDocument: () => new Promise(resolve => { state.release = () => resolve({ docId: 'book', importedAt: 'v1', paragraphCount: 1, imageCount: 0, fileSize: 1 }) }),
    getContent: async () => { state.contentCalls++; return { paragraphs: [], imageRefs: [] } },
  } }
})
vi.mock('../src/api/authStore', () => ({ authStore: { get userId() { return state.userId } } }))
vi.mock('../src/features/cache/db', () => ({ STORE_DOCUMENTS: 'documents', tx: async () => undefined, openCacheDb: async () => null }))

it('加载期间切换服务器或账号必须中止，不能将新环境正文写入旧缓存键', async () => {
  const first = loadReaderDocument('server-switch')
  state.base = '/server-b'
  state.release()
  await expect(first).rejects.toThrow('已切换')
  expect(state.contentCalls).toBe(0)
  const second = loadReaderDocument('account-switch')
  state.userId = 'reader-b'
  state.release()
  await expect(second).rejects.toThrow('已切换')
  expect(state.contentCalls).toBe(0)
})
