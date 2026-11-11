import type { FastifyInstance } from 'fastify'

/**
 * App 版本与强制更新。
 *
 * 版本信息的**唯一来源是 GitHub Releases**：CI 打一个 `v1.9.0` 这类 tag，
 * `.github/workflows/android.yml` 自动构建签名 APK 并发布到 Release，
 * 这里读 Releases API 就知道最新版是什么、APK 在哪。
 * 发新版不用再登服务器改环境变量。
 *
 * 为什么不让客户端直连 GitHub API：
 *   · GitHub 未登录限流 60 次/小时/**IP**，一个教室的手机共用一个出口 IP，必爆；
 *   · 国内移动网络访问 api.github.com 经常不通，更新检查会静默失败。
 *   服务端代查 + 5 分钟缓存，这些都不再是问题。
 *
 * 查不到（离线、限流、仓库还没发过 Release）时**回落到环境变量**，
 * 保持 1.3.0 以来那套部署方式还能用，不至于因为 GitHub 抽风就把更新链路打断。
 */
export interface AppVersionEnv {
  versionCode: number
  versionName: string
  apkUrl: string
  minVersionCode: number
}

export interface AppVersionInfo extends AppVersionEnv {
  /** 是否强制更新（false 时客户端只提示、不阻断） */
  force: boolean
  notes: string
  /** 版本信息最终来自哪里，排障时一眼能看出是 GitHub 还是本地兜底 */
  source: 'github' | 'env'
}

/** GitHub 上承载 Release 的仓库，可用 APP_RELEASE_REPO 覆盖（如 fork 后自建） */
const DEFAULT_RELEASE_REPO = 'HeChunhui-learn/zhiyin-reader'

/** Releases 查询结果的缓存时长。太短会白白消耗 GitHub 配额，太长发版后要等 */
const CACHE_TTL_MS = 5 * 60 * 1000

/** 单次上游查询的超时。更新检查不值得让读者的请求等太久 */
const FETCH_TIMEOUT_MS = 4000

/** Release 正文里的机读版本号标记，由 CI 写入，见 android.yml */
const VERSION_CODE_MARK = /zhiyin:versionCode=(\d+)/

/**
 * 最低可接受版本（426 门槛）。
 *
 * 这是全模块唯一一处算门槛的地方 —— 接口和闸门必须给出一致的答案，
 * 否则会出现「版本接口说不用更新，请求却被拦成 426」的自相矛盾。
 *
 * 规则：
 *   · 显式配了 MIN_APP_VERSION_CODE 就完全听它的，**包括 0**
 *     （0 = 关掉门槛，维护期间想让所有人都能进时用）；
 *   · 没配时按产品的默认意图：知道最新版本号就要求升到最新（强制更新），
 *     不知道（GitHub 不通且没配 APP_VERSION_CODE）就不拦人 —— 宁可放行，
 *     也不要因为查不到版本把一个正常用户锁在门外。
 */
function resolveMinVersionCode(latestCode: number | null): number {
  const raw = process.env.MIN_APP_VERSION_CODE
  if (raw !== undefined) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  return latestCode ?? 0
}

/**
 * 读环境变量兜底值。这里的默认值只在**没有配置任何环境变量**时生效，
 * 且刻意保持与线上最后一次手工部署一致（1.8.0 / versionCode 9），
 * 避免切到 GitHub 方案当天、GitHub 恰好不通时把读者误判成旧版。
 */
export function getAppVersionEnv(): AppVersionEnv {
  const explicitVersionCode = process.env.APP_VERSION_CODE
  const versionCode = Number(explicitVersionCode ?? 9)
  const versionName = process.env.APP_VERSION_NAME ?? '1.8.0'
  const apkUrl = process.env.APP_APK_URL ?? '/download/zhiyin-1.8.0.apk'
  const hasVersion = explicitVersionCode !== undefined && Number.isFinite(versionCode)
  const minVersionCode = resolveMinVersionCode(hasVersion ? versionCode : null)
  return { versionCode, versionName, apkUrl, minVersionCode }
}

interface GitHubAsset {
  name?: string
  browser_download_url?: string
}

interface GitHubRelease {
  tag_name?: string
  name?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  assets?: GitHubAsset[]
}

export interface ReleaseSnapshot {
  versionCode: number
  versionName: string
  apkUrl: string
}

/**
 * 从 Release 里解析出版本三要素。拿不到必需字段就返回 null，
 * 让调用方回落到环境变量 —— 宁可显示旧版本号，也不要显示一个错的。
 *
 * versionCode 必须由 CI 写进正文：tag 只表达 `1.9.0` 这种语义版本，
 * 而 Android 的 versionCode 是另一个单调递增的整数，两者换算规则一旦
 * 和 APK 里编译进去的值对不上，手机端就会永远认为自己是旧版。
 */
export function parseRelease(release: GitHubRelease): ReleaseSnapshot | null {
  const tag = (release.tag_name ?? '').trim()
  if (!tag) return null

  const versionName = tag.replace(/^v/i, '')
  if (!versionName) return null

  const mark = VERSION_CODE_MARK.exec(release.body ?? '')
  const versionCode = mark ? Number(mark[1]) : NaN
  if (!Number.isFinite(versionCode) || versionCode <= 0) return null

  // 优先固定名 zhiyin.apk（下载地址不随版本变），否则退而求其次用第一个 APK 附件
  const assets = release.assets ?? []
  const fixed = assets.find((a) => a.name === 'zhiyin.apk')
  const anyApk = assets.find((a) => (a.name ?? '').toLowerCase().endsWith('.apk'))
  const apkUrl = (fixed ?? anyApk)?.browser_download_url ?? ''
  if (!apkUrl) return null

  return { versionCode, versionName, apkUrl }
}

interface CacheEntry {
  at: number
  value: ReleaseSnapshot | null
}

/**
 * 模块级缓存。刻意不做主动刷新：更新检查是低频操作，
 * 5 分钟内第一个人查过，后面所有人直接命中，够用且不占配额。
 */
let cache: CacheEntry | null = null

/** 仅供测试重置，避免用例之间互相看到对方的缓存 */
export function resetReleaseCache(): void {
  cache = null
}

export interface ReleaseLookupOptions {
  /** 注入 fetch，测试里用来避免真的打网络 */
  fetchImpl?: typeof fetch
  repo?: string
  token?: string
  now?: number
}

/**
 * 查 GitHub 上最新正式 Release。任何异常都返回 null（不抛），
 * 更新检查失败绝不能影响读者正常阅读。
 */
export async function fetchLatestRelease(opts: ReleaseLookupOptions = {}): Promise<ReleaseSnapshot | null> {
  const now = opts.now ?? Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value

  const repo = opts.repo ?? process.env.APP_RELEASE_REPO ?? DEFAULT_RELEASE_REPO
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  // 模块级缓存是进程级共享的，但测试会注入假的 fetch；打了注入标记就不复用缓存，
  // 否则第二个用例会读到第一个用例塞进去的结果，出现"用例顺序一换就红"的假象。
  const useCache = opts.fetchImpl === undefined

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'zhiyin-server',
    'x-github-api-version': '2022-11-28',
  }
  // 私有仓库或想提高配额时用；公开仓库不配也能用
  if (token) headers.authorization = `Bearer ${token}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await doFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      if (useCache) cache = { at: now, value: null }
      return null
    }
    const json = (await res.json()) as GitHubRelease
    const parsed = json.draft || json.prerelease ? null : parseRelease(json)
    if (useCache) cache = { at: now, value: parsed }
    return parsed
  } catch {
    // 超时 / DNS 失败 / 被墙：缓存 null 一小段时间，别让每个请求都去撞墙
    if (useCache) cache = { at: now, value: null }
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 组合：先 GitHub，拿不到再用环境变量兜底 */
export async function resolveAppVersion(opts: ReleaseLookupOptions = {}): Promise<AppVersionInfo> {
  const fallback = getAppVersionEnv()
  const force = process.env.APP_FORCE_UPDATE !== 'false'
  const envNotes = process.env.APP_UPDATE_NOTES ?? '界面视觉与阅读体验升级，更新后才能继续使用。'

  // 显式设成 env 时完全不走网络，排障与离线演示用得上
  if (process.env.APP_UPDATE_SOURCE === 'env') {
    return { ...fallback, force, notes: envNotes, source: 'env' }
  }

  const latest = await fetchLatestRelease(opts)
  if (!latest) {
    return { ...fallback, force, notes: envNotes, source: 'env' }
  }

  return {
    versionCode: latest.versionCode,
    versionName: latest.versionName,
    apkUrl: latest.apkUrl,
    // 最低可接受版本仍由运维决定：GitHub 说最新是 12，不代表 11 必须马上不能用了。
    // 没显式配置时跟着最新版走（强制更新是这功能的默认意图）。
    minVersionCode: resolveMinVersionCode(latest.versionCode),
    force,
    notes: process.env.APP_UPDATE_NOTES ?? `发现新版本 ${latest.versionName}，更新后才能继续使用。`,
    source: 'github',
  }
}

/**
 * 给 426 闸门用的**不联网**版本：只读上面那份缓存，缓存空就直接用环境变量。
 *
 * 闸门挂在每一个请求的 onRequest 上，绝不能在这里发起网络请求 ——
 * GitHub 不通时会让所有接口都多等一次超时。真正的查询发生在
 * `GET /api/app/version`，闸门只是蹭它留下的结果。
 */
export function peekAppVersion(): AppVersionInfo {
  const now = Date.now()
  const fresh = cache && now - cache.at < CACHE_TTL_MS ? cache.value : null
  const base = fresh ?? getAppVersionEnv()
  return {
    ...base,
    // 与接口走同一个函数算门槛，保证两边永远一致
    minVersionCode: resolveMinVersionCode(fresh ? fresh.versionCode : null),
    force: process.env.APP_FORCE_UPDATE !== 'false',
    notes: process.env.APP_UPDATE_NOTES ?? '',
    source: fresh ? 'github' : 'env',
  }
}

export default async function appVersionRoutes(app: FastifyInstance) {
  // 公开接口：不登录也能查，旧版 App 也能拿到下载地址
  app.get('/api/app/version', async () => {
    const { versionCode, versionName, apkUrl, minVersionCode, force, notes, source } =
      await resolveAppVersion()
    return { versionCode, versionName, apkUrl, minVersionCode, force, notes, source }
  })
}
