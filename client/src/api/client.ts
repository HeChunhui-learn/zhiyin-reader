import type { Book, Paragraph } from '../models/types'
import { authStore, type TokenPair } from './authStore'
import { getDeviceId } from './device'
import { appVersionHeader } from './appVersion'
import { isNativeApp } from './platform'

/**
 * 接口客户端。统一走 /api，开发时由 Vite 代理到 http://localhost:3000。
 * 所有错误都抛 ApiError，message 一定是中文，界面可直接展示。
 *
 * 访问令牌过期（401 AUTH_TOKEN_EXPIRED）时自动刷新一次并重放原请求。
 */

/**
 * 接口基址。
 *
 * 浏览器里默认 `/api`，由 Vite 代理或 nginx 同源转发；打包进 Capacitor 时
 * 由构建参数 `VITE_API_BASE=http://123.56.172.230/api` 写死一个默认值。
 * 原生壳里没有"同源"这回事，WebView 的 `/api` 会打到 localhost 自己身上。
 *
 * 运行时还可以在登录页改（存 localStorage），换服务器 / 换局域网地址不必重新打包。
 */
const ENV_API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '')
  .trim()
  .replace(/\/+$/, '')
const API_BASE_STORAGE_KEY = 'zhiyin.apiBase'

export const DEFAULT_API_BASE = ENV_API_BASE || '/api'

/**
 * 把用户输入整理成可用的基址：补协议头、去掉末尾斜杠、补 `/api`。
 * 输入 `192.168.1.5:3000` 会得到 `http://192.168.1.5:3000/api`。
 */
export function normalizeApiBase(input: string): string {
  let v = input.trim().replace(/\/+$/, '')
  if (!v) return ''
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`
  if (!/\/api$/i.test(v)) v = `${v}/api`
  return v
}

export function getApiBase(): string {
  try {
    const saved = localStorage.getItem(API_BASE_STORAGE_KEY)
    if (saved?.trim()) return saved.trim().replace(/\/+$/, '')
  } catch {
    /* localStorage 不可用（隐私模式等）就走默认 */
  }
  return DEFAULT_API_BASE
}

/** 传空值表示恢复默认。返回最终生效的基址 */
export function setApiBase(input: string | null): string {
  const normalized = input ? normalizeApiBase(input) : ''
  try {
    if (normalized) localStorage.setItem(API_BASE_STORAGE_KEY, normalized)
    else localStorage.removeItem(API_BASE_STORAGE_KEY)
  } catch {
    /* 存不进去也不耽误本次会话 */
  }
  return normalized || DEFAULT_API_BASE
}

/** 拼出完整接口地址。所有请求（包括 keepalive 的裸 fetch）都必须走这里 */
export function apiUrl(path: string): string {
  return getApiBase() + path
}

/** 单个请求的超时（毫秒）。超时按网络错误处理，界面给中文提示 */
const REQUEST_TIMEOUT_MS = 15000
/**
 * 语音合成单独放宽超时。
 * 服务端遇到 Edge 429 会退避重试，单句最坏要十几秒；用 15s 会在
 * 服务端还在重试时提前断开，客户端只能再发一次，反而加剧限流。
 */
const TTS_REQUEST_TIMEOUT_MS = 60000

/**
 * 导入相关请求的超时（R7-4 引入，本次随上传上限一起放宽）。
 *
 * 正文 JSON 与原始文件都可能几百 MB，还夹着前端解析的耗时。15 秒、
 * 乃至 R7-4 的 120 秒对 500MB 都不够 —— 120 秒等于要求约 33Mbps 的
 * 持续有效带宽，局域网一抖就超时，而服务端其实已经收下了。取 5 分钟：
 * 本机与百兆局域网都有数倍余量，又不至于真出问题时让界面僵死太久。
 *
 * 服务端那边没有对应的时限可以调 —— Fastify 的 requestTimeout 默认 0，
 * 会把 Node 默认的 300 秒请求超时也一并关掉，所以这里就是唯一的时限。
 * 只放宽导入这两个请求，其余维持 15 秒，免得一个卡住的普通接口
 * 把界面永远吊在"加载中"。
 */
const UPLOAD_TIMEOUT_MS = 300000

/** 后端 §1 的统一错误信封 */
interface ErrorEnvelope {
  code?: string
  message?: string
  details?: Record<string, unknown>
  requestId?: string
}

/**
 * 服务端判定"必须更新"时抛出的 426。更新弹窗监听这个事件，
 * 不用在每个页面里各写一次错误分支。
 */
function notifyUpdateRequired(env: ErrorEnvelope): void {
  if (typeof window === 'undefined') return
  if (env.code !== 'APP_UPDATE_REQUIRED') return
  window.dispatchEvent(new CustomEvent('zhiyin:update-required', { detail: env }))
}

/**
 * 连不上时给用户的话。
 *
 * 浏览器里是「自己没起服务端」，说 npm run server 最有用；但装成 APK 之后
 * 服务端在别人的机器上，用户能做且该做的只有"改服务器地址"这一件事，
 * 所以原生壳要指向登录页底部的那个入口。服务端下线以后这更是唯一的出路。
 */
function offlineHint(): string {
  return isNativeApp()
    ? '连不上服务器。请点登录页下方的「服务器地址」填写可用的 API 基址，或稍后再试。'
    : '无法连接到服务端，请确认服务端已启动（npm run server）。'
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

async function rawRequest<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  // 没有超时的话，一个卡住的请求会让界面永远停在"加载中"，比报错还难查
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  // 版本头由这里统一补：调用方（包括 refreshOnce）不必逐个记得
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
    ...appVersionHeader(),
  }

  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers, signal: ctrl.signal })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new ApiError('TIMEOUT', '请求超时，请检查网络后重试。', 0)
    }
    throw new ApiError('NETWORK_ERROR', offlineHint(), 0)
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
    if (res.status === 426) notifyUpdateRequired(env)
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
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const token = authStore.access
  const headers: Record<string, string> = {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    return await rawRequest<T>(path, { ...init, headers }, timeoutMs)
  } catch (e) {
    const err = e as ApiError
    const expired =
      err.status === 401 &&
      (err.code === 'AUTH_TOKEN_EXPIRED' || err.code === 'AUTH_REQUIRED') &&
      !!authStore.refresh

    if (expired && retryOnExpired && (await refreshOnce())) {
      // 重放时把加长的超时一并带上，否则大文件刷新令牌后重发又会超时
      return request<T>(path, init, false, timeoutMs)
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
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const token = authStore.access
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
    ...appVersionHeader(),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers, signal: ctrl.signal })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new ApiError('TIMEOUT', '请求超时，请检查网络后重试。', 0)
    }
    throw new ApiError('NETWORK_ERROR', offlineHint(), 0)
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
    if (res.status === 426) notifyUpdateRequired(env)
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
      return requestBinary(path, init, false, timeoutMs)
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
  /** 有头像时是 /api/users/me/avatar，没有则为 null。图片本体要另取（见 getAvatar） */
  avatarUrl: string | null
}

/** 阅读时长总览（R7-5）。与契约 §6.4 的 GET /api/reading-time/summary 对应 */
export interface ReadingSummary {
  totalMs: number
  totalMinutes: number
  todayMs: number
  todayMinutes: number
  weekMs: number
  weekMinutes: number
  books: { docId: string; title: string; totalMs: number; totalMinutes: number }[]
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

/** 阅读位置锚点。字段名以 docs/system-design.md 第 4 节为准（见 §7 裁决 2） */
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
  /** ★ B4：章节标题 */
  chapterTitle?: string | null
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
  /** ★ B1：同文档内排序位。§7.4 的增量同步响应不带它，故可选 */
  sortOrder?: number
  /** ★ B4：书签所在章节标题。§7.4 的增量同步响应不带它，故可选 */
  chapterTitle?: string | null
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
  /** 一键同步不消费 changes；服务端据此跳过全量增量扫描 */
  includeChanges?: boolean
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
    bookmarks: {
      created: number
      updated: number
      deleted: number
      /** 文档已删除 / 不属于当前读者 / 缺 docId 的条目，客户端据此清队列 */
      skipped?: string[]
    }
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

/**
 * 音色目录里的一项（契约 §9.4）。
 *
 * 与 TtsVoice 的区别：那个是"上游此刻能合成的音色"，这个是"这个引擎有哪些音色、
 * 本机装了哪些"。available=false 的是目录里有、但本机没装离线包的，界面上置灰。
 */
export interface TtsVoiceDetail extends TtsVoice {
  gender?: 'female' | 'male'
  chinese: boolean
  available: boolean
  note?: string
}

export interface TtsVoicesResponse {
  engine: string
  engineLabel: string
  /** 上游引擎本身通不通。false = 本地推理服务没起来，整条目录都不可用 */
  engineAvailable: boolean
  voices: TtsVoiceDetail[]
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

  /** 改昵称 / 改密码（契约 §3.5）。昵称改了之后要重新取一次 me() 才能刷新会话里的副本 */
  updateMe: (body: { nickname?: string; oldPassword?: string; newPassword?: string }) =>
    request<UserInfo & { createdAt: string; lastLogin: string | null }>('/users/me', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  /* 头像（契约 §3.6） */

  uploadAvatar: (blob: Blob): Promise<{ avatarUrl: string; bytes: number }> =>
    requestBinary('/users/me/avatar', {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    }).then((r) => r.json()),

  deleteAvatar: () => request<{ avatarUrl: string | null }>('/users/me/avatar', { method: 'DELETE' }),

  /** 取头像二进制。没有头像时抛 NOT_FOUND 的 ApiError，调用方回退到文字头像 */
  getAvatar: async (): Promise<Blob> => (await requestBinary('/users/me/avatar')).blob(),

  /* 阅读时长（契约 §6.4） */

  getReadingSummary: () => request<ReadingSummary>('/reading-time/summary'),

  getReadingTime: (docId: string) =>
    request<{ docId: string; totalMs: number; totalMinutes: number }>(
      `/documents/${docId}/reading-time`,
    ),

  postReadingTime: (
    docId: string,
    body: {
      deviceId: string
      clientId: string
      durationMs: number
      startedAt: string
      endedAt: string
    },
  ) =>
    request<{ docId: string; totalMs: number }>(`/documents/${docId}/reading-time`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 用 localStorage 里的刷新令牌静默换一个新访问令牌（刷新页面后用） */
  silentLogin: () => refreshOnce(),

  /* 文档 */
  listDocuments: (opts: { keyword?: string; category?: string; page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.page) q.set('page', String(opts.page))
    if (opts.pageSize) q.set('pageSize', String(opts.pageSize))
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

  // 导入的正文 JSON 可能上百 MB，用放宽后的超时
  importDocument: (payload: ImportPayload) =>
    request<ImportResult>(
      '/documents',
      { method: 'POST', body: JSON.stringify(payload) },
      true,
      UPLOAD_TIMEOUT_MS,
    ),

  deleteDocument: (docId: string) =>
    request<void>(`/documents/${docId}`, { method: 'DELETE' }),

  /* 收藏（R7-4）。两个方向都幂等，重复调用不会出错 */

  // 显式发一个空对象：Fastify 见到 Content-Type: application/json 却没有 body 会直接
  // 400（FST_ERR_CTP_EMPTY_JSON_BODY）。这里带上 {} 就不必依赖"客户端恰好没设这个头"
  addFavorite: (docId: string) =>
    request<{ docId: string; isFavorite: boolean }>(`/documents/${docId}/favorite`, {
      method: 'PUT',
      body: '{}',
    }),

  removeFavorite: (docId: string) =>
    request<{ docId: string; isFavorite: boolean }>(`/documents/${docId}/favorite`, {
      method: 'DELETE',
    }),

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
    // 原始文件可以很大，和 importDocument 用同一档放宽后的超时
    requestBinary(
      `/documents/${docId}/file`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      },
      true,
      UPLOAD_TIMEOUT_MS,
    ).then((r) => r.json()),

  /* TTS（契约 §9.1 / §9.2 / §9.4） */

  listTtsEngines: () => request<TtsEnginesResponse>('/tts/engines'),

  /** 音色目录（契约 §9.4）：含本机没装的，供界面置灰展示 */
  listTtsVoices: () => request<TtsVoicesResponse>('/tts/voices'),

  /** 合成单句音频。服务端失败时抛 ApiError（UPSTREAM_TTS_FAILED 等），调用方降级 */
  synthesizeSpeech: (body: {
    text: string
    voice: string
    rate: number
    format?: string
    engine?: string
  }) =>
    requestBinary(
      '/tts/synthesize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'mp3', ...body }),
      },
      true,
      TTS_REQUEST_TIMEOUT_MS,
    ).then((r) => r.blob()),

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

  /**
   * §7.5 分页列表（B1/B3）。界面列表走这里。
   * §7.4 的 listBookmarks 保持原样，只服务增量同步。
   */
  listBookmarksPaged: (opts: {
    docId: string
    sort?: 'order' | 'createdAt' | 'chapter'
    order?: 'asc' | 'desc'
    page?: number
    pageSize?: number
  }) => {
    const q = new URLSearchParams({ docId: opts.docId })
    if (opts.sort) q.set('sort', opts.sort)
    if (opts.order) q.set('order', opts.order)
    if (opts.page) q.set('page', String(opts.page))
    if (opts.pageSize) q.set('pageSize', String(opts.pageSize))
    return request<{ total: number; page: number; pageSize: number; items: BookmarkDto[] }>(
      `/bookmarks/page?${q.toString()}`,
    )
  },

  /** §7.7 拖动排序：一次提交整批新顺序 */
  reorderBookmarks: (body: {
    docId: string
    items: { bookmarkId: string; sortOrder: number; baseVersion: number }[]
    updatedAt: string
  }) =>
    request<{
      docId: string
      applied: number
      items: { bookmarkId: string; sortOrder: number; version: number }[]
    }>('/bookmarks/reorder', { method: 'POST', body: JSON.stringify(body) }),

  /** §7.6 跨文档书签总览（B2）：按文档分组 */
  listBookmarksOverview: (opts: { page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.page) q.set('page', String(opts.page))
    if (opts.pageSize) q.set('pageSize', String(opts.pageSize))
    const qs = q.toString()
    return request<{
      total: number
      page: number
      pageSize: number
      groups: {
        docId: string
        docTitle: string
        bookmarkCount: number
        items: BookmarkDto[]
      }[]
    }>(`/bookmarks/overview${qs ? '?' + qs : ''}`)
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
