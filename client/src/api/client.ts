import type { Book, Paragraph } from '../models/types'
import { authStore, type TokenPair } from './authStore'
import { getDeviceId } from './device'

/**
 * 接口客户端。统一走 /api，开发时由 Vite 代理到 http://localhost:3000。
 * 所有错误都抛 ApiError，message 一定是中文，界面可直接展示。
 *
 * 访问令牌过期（401 AUTH_TOKEN_EXPIRED）时自动刷新一次并重放原请求。
 */

const BASE = '/api'

/** 单个请求的超时（毫秒）。超时按网络错误处理，界面给中文提示 */
const REQUEST_TIMEOUT_MS = 15000

/** 后端 §1 的统一错误信封 */
interface ErrorEnvelope {
  code?: string
  message?: string
  details?: Record<string, unknown>
  requestId?: string
}

export class ApiError extends Error {
  code: string
  status: number
  details: Record<string, unknown>
  requestId: string

  constructor(
    code: string,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
    requestId = '',
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
    this.requestId = requestId
  }
}

async function rawRequest<T>(path: string, init?: RequestInit): Promise<T> {
  // 没有超时的话，一个卡住的请求会让界面永远停在"加载中"，比报错还难查
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(BASE + path, { ...init, signal: ctrl.signal })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new ApiError('TIMEOUT', '请求超时，请检查网络后重试。', 0)
    }
    throw new ApiError(
      'NETWORK_ERROR',
      '无法连接到服务端，请确认服务端已启动（npm run server）。',
      0,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    let env: ErrorEnvelope = {}
    try {
      env = (await res.json()) as ErrorEnvelope
    } catch {
      /* 响应体不是 JSON */
    }
    throw new ApiError(
      env.code ?? `HTTP_${res.status}`,
      env.message ?? '请求失败，请稍后重试。',
      res.status,
      env.details ?? {},
      env.requestId ?? '',
    )
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** 刷新令牌的单飞：并发请求同时撞上 401 时，只刷新一次 */
let refreshing: Promise<boolean> | null = null

async function refreshOnce(): Promise<boolean> {
  if (refreshing) return refreshing
  const rt = authStore.refresh
  if (!rt) return false

  refreshing = (async () => {
    try {
      const pair = await rawRequest<TokenPair>('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt, deviceId: getDeviceId() }),
      })
      authStore.set(pair)
      return true
    } catch {
      authStore.clear()
      return false
    } finally {
      refreshing = null
    }
  })()

  return refreshing
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  retryOnExpired = true,
): Promise<T> {
  const token = authStore.access
  const headers: Record<string, string> = {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    return await rawRequest<T>(path, { ...init, headers })
  } catch (e) {
    const err = e as ApiError
    const expired =
      err.status === 401 &&
      (err.code === 'AUTH_TOKEN_EXPIRED' || err.code === 'AUTH_REQUIRED') &&
      !!authStore.refresh

    if (expired && retryOnExpired && (await refreshOnce())) {
      return request<T>(path, init, false)
    }
    throw err
  }
}

/**
 * 二进制通道：图片读写与原始文件上传走这里，不能复用 JSON 的 request()。
 * 同样带超时，并在 401 过期时刷新一次重放。
 */
async function requestBinary(
  path: string,
  init: RequestInit = {},
  retryOnExpired = true,
): Promise<Response> {
  const token = authStore.access
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(BASE + path, { ...init, headers, signal: ctrl.signal })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new ApiError('TIMEOUT', '请求超时，请检查网络后重试。', 0)
    }
    throw new ApiError('NETWORK_ERROR', '无法连接到服务端，请确认服务端已启动。', 0)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    let env: ErrorEnvelope = {}
    // 二进制接口出错时返回的是 JSON 信封，但成功时是二进制，所以这里按状态码分流
    try {
      env = (await res.json()) as ErrorEnvelope
    } catch {
      /* 不是 JSON，用默认文案 */
    }
    const err = new ApiError(
      env.code ?? `HTTP_${res.status}`,
      env.message ?? '请求失败，请稍后重试。',
      res.status,
      env.details ?? {},
      env.requestId ?? '',
    )

    const expired =
      res.status === 401 &&
      (err.code === 'AUTH_TOKEN_EXPIRED' || err.code === 'AUTH_REQUIRED') &&
      !!authStore.refresh
    if (expired && retryOnExpired && (await refreshOnce())) {
      return requestBinary(path, init, false)
    }
    throw err
  }

  return res
}

/* ------------------------------------------------------------------ 类型 */

export interface UserInfo {
  userId: string
  account: string
  nickname: string
}

export interface LoginResult extends TokenPair {
  user: UserInfo
}

/** 契约 §4.5 的 imageRefs 元素 */
export interface ContentImageRef {
  imageId: string
  paraIndex: number
  src: string | null
  /** 替代文本（契约 §4.1 的 imageRefs 里就有这个字段） */
  alt: string | null
  /** 非空表示服务端上已有这张图；为空表示还没有设备上传过 */
  imageUrl: string | null
}

export interface ContentPage {
  docId: string
  from: number
  to: number
  totalParagraphs: number
  paragraphs: Paragraph[]
  imageRefs: ContentImageRef[]
}

/** 契约 §4.5 的文档详情 */
export interface DocumentDetail {
  docId: string
  title: string
  author: string
  fileName: string
  fileFormat: string
  fileSize: number | null
  importedAt: string
  paragraphCount: number
  imageCount: number
  bookmarkCount: number
  resourceUrl: string | null
}

export interface ImportPayload {
  fileName: string
  fileFormat: string
  fileSize: number
  contentHash: string
  title: string
  author: string
  paragraphs: {
    paraIndex: number
    type: string
    text: string
    sentences: { sentenceIndex: number; startOffset: number; endOffset: number }[]
  }[]
  imageRefs: {
    imageId: string
    paraIndex: number
    src: string | null
    alt: string | null
  }[]
}

/* --------------------------------------------------------- 同步相关类型 */

/** 阅读位置锚点。字段名以接口契约 §6.1 为准（见 CLAUDE.md 裁决 2） */
export interface Anchor {
  chapterIndex: number
  paragraphIndex: number
  sentenceIndex: number
  charOffset: number
  scrollOffset: number
  docVersion?: string
}

export interface ProgressPayload {
  deviceId: string
  anchor: Anchor
  lastSentenceIndex: number | null
  updatedAt: string
  baseVersion: number
}

export interface ProgressItem {
  progressId: string
  deviceId: string
  anchor: Anchor
  lastSentenceIndex: number | null
  updatedAt: string
  serverReceivedAt: string
  version: number
  isCurrentDevice: boolean
}

export interface BookmarkPayload {
  bookmarkId: string
  docId: string
  anchor: Anchor
  name: string | null
  updatedAt: string
}

export interface BookmarkDto {
  bookmarkId: string
  docId: string
  name: string | null
  anchor: Anchor
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** 契约 §8.3 的冲突信封 */
export interface ConflictEnvelope {
  scope: 'progress' | 'bookmark'
  key: string
  baseVersion: number
  serverVersion: number
  local: Record<string, unknown>
  remote: Record<string, unknown>
  resolution: 'keep_both' | 'require_user_choice' | 'superseded'
  resolved: (Record<string, unknown> & { bookmarkId?: string; name?: string }) | null
  note?: string
  deletedByDevice?: string
}

export interface SyncRequest {
  deviceId: string
  since: string | null
  progress?: {
    docId: string
    anchor: Anchor
    lastSentenceIndex: number | null
    updatedAt: string
    baseVersion: number
  } | null
  bookmarks?: {
    created?: (BookmarkPayload & { baseVersion?: number })[]
    updated?: {
      bookmarkId: string
      name?: string | null
      anchor?: Anchor
      updatedAt: string
      baseVersion?: number
    }[]
    deleted?: { bookmarkId: string; deletedAt: string; baseVersion?: number }[]
  }
}

export interface SyncResponse {
  serverTime: string
  applied: {
    progress: { version: number; outcome: string } | null
    bookmarks: { created: number; updated: number; deleted: number }
  }
  conflicts: ConflictEnvelope[]
  changes: {
    progress: (ProgressItem & { deviceId: string }) | null
    bookmarks: {
      created: BookmarkDto[]
      updated: {
        bookmarkId: string
        name: string | null
        anchor: Anchor
        version: number
        updatedAt: string
      }[]
      deleted: { bookmarkId: string; deletedAt: string }[]
    }
  }
}

export interface ResolveResult {
  scope: string
  choice: string
  kept: BookmarkDto[]
  deleted?: BookmarkDto
  note?: string
}

export interface TtsVoice {
  voice: string
  label: string
  lang: string
}

/** 契约 §9.1 的一个引擎 */
export interface TtsEngineInfo {
  engine: string
  label: string
  available: boolean
  voices: TtsVoice[]
}

export interface TtsEnginesResponse {
  default: string
  engines: TtsEngineInfo[]
}

export interface ImportResult {
  docId: string
  title: string
  paragraphCount: number
  imageCount: number
  importedAt: string
}

/* ------------------------------------------------------------------ 接口 */

export const api = {
  /* 认证 */
  register: (body: { account: string; password: string; nickname?: string }) =>
    request<{ userId: string; account: string; nickname: string; createdAt: string }>(
      '/auth/register',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  login: (body: { account: string; password: string }) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ...body, deviceId: getDeviceId() }),
    }),

  logout: (refreshToken: string) =>
    request<void>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),

  me: () => request<UserInfo & { createdAt: string; lastLogin: string | null }>('/users/me'),

  /** 用 localStorage 里的刷新令牌静默换一个新访问令牌（刷新页面后用） */
  silentLogin: () => refreshOnce(),

  /* 文档 */
  listDocuments: (opts: { keyword?: string; category?: string } = {}) => {
    const q = new URLSearchParams()
    if (opts.keyword) q.set('keyword', opts.keyword)
    if (opts.category && opts.category !== 'all') q.set('category', opts.category)
    const qs = q.toString()
    return request<{ total: number; page: number; pageSize: number; items: Book[] }>(
      `/documents${qs ? '?' + qs : ''}`,
    )
  },

  getDocument: (docId: string) => request<DocumentDetail>(`/documents/${docId}`),

  getContent: (docId: string, from = 0, to = 100000) =>
    request<ContentPage>(`/documents/${docId}/content?from=${from}&to=${to}`),

  importDocument: (payload: ImportPayload) =>
    request<ImportResult>('/documents', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteDocument: (docId: string) =>
    request<void>(`/documents/${docId}`, { method: 'DELETE' }),

  /* 图片（契约 §4.3 / §5） */

  /** 服务端上没有这张图时抛 code=NOT_FOUND 的 ApiError，调用方据此回退到本地缓存 */
  getImage: async (docId: string, imageId: string): Promise<Blob> => {
    const res = await requestBinary(`/documents/${docId}/images/${imageId}`)
    return res.blob()
  },

  putImage: (
    docId: string,
    imageId: string,
    blob: Blob,
  ): Promise<{ imageId: string; imageUrl: string; bytes: number }> =>
    requestBinary(`/documents/${docId}/images/${imageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    }).then((r) => r.json()),

  /* 原始文件（契约 §4.2），R3 暂时只用到上传 */

  putOriginalFile: (
    docId: string,
    blob: Blob,
  ): Promise<{ docId: string; fileUrl: string; fileSize: number }> =>
    requestBinary(`/documents/${docId}/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    }).then((r) => r.json()),

  /* TTS（契约 §9.1 / §9.2） */

  listTtsEngines: () => request<TtsEnginesResponse>('/tts/engines'),

  /** 合成单句音频。服务端失败时抛 ApiError（UPSTREAM_TTS_FAILED 等），调用方降级 */
  synthesizeSpeech: (body: {
    text: string
    voice: string
    rate: number
    format?: string
    engine?: string
  }) =>
    requestBinary('/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'mp3', ...body }),
    }).then((r) => r.blob()),

  /* 阅读进度（契约 §6） */

  getProgress: (docId: string, deviceId: string) =>
    request<{ docId: string; items: ProgressItem[] }>(
      `/documents/${docId}/progress?deviceId=${encodeURIComponent(deviceId)}`,
    ),

  putProgress: (docId: string, body: ProgressPayload) =>
    request<{
      progressId: string
      version: number
      updatedAt: string
      serverReceivedAt: string
      outcome: string
    }>(`/documents/${docId}/progress`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /* 书签（契约 §7） */

  createBookmark: (body: BookmarkPayload) =>
    request<{ bookmarkId: string; version: number; name: string | null }>('/bookmarks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  patchBookmark: (
    bookmarkId: string,
    body: { name?: string | null; anchor?: Anchor; baseVersion: number; updatedAt?: string },
  ) =>
    request<{ bookmarkId: string; version: number }>(`/bookmarks/${bookmarkId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteBookmark: (bookmarkId: string, baseVersion: number) =>
    request<{ bookmarkId: string; version: number; deletedAt: string }>(
      `/bookmarks/${bookmarkId}?baseVersion=${baseVersion}&deviceId=${encodeURIComponent(getDeviceId())}`,
      { method: 'DELETE' },
    ),

  listBookmarks: (opts: { docId?: string; since?: string | null; includeDeleted?: boolean } = {}) => {
    const q = new URLSearchParams()
    if (opts.docId) q.set('docId', opts.docId)
    if (opts.since) q.set('since', opts.since)
    if (opts.includeDeleted) q.set('includeDeleted', 'true')
    const qs = q.toString()
    return request<{ serverTime: string; items: BookmarkDto[] }>(
      `/bookmarks${qs ? '?' + qs : ''}`,
    )
  },

  /* 批量增量同步（契约 §8） */

  sync: (body: SyncRequest, idempotencyKey?: string) =>
    request<SyncResponse>('/sync', {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: JSON.stringify(body),
    }),

  resolveConflict: (body: {
    scope: 'progress' | 'bookmark'
    key: string
    conflictAt: string
    choice: 'local' | 'remote' | 'both'
    relatedId?: string
  }) => request<ResolveResult>('/sync/resolve', { method: 'POST', body: JSON.stringify(body) }),

  /**
   * A4 新增：拉取未决冲突。
   *
   * 服务端把冲突写进了 T_SyncRecord（契约 §2.2.6 要求未决冲突不得丢失），
   * 这里把它们读回来，刷新页面后冲突才不会被丢掉。
   */
  listConflicts: (docId?: string) =>
    request<{ serverTime: string; items: ConflictEnvelope[] }>(
      `/sync/conflicts${docId ? `?docId=${encodeURIComponent(docId)}` : ''}`,
    ),
}
