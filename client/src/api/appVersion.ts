import { isNativeApp } from './platform'

/**
 * 客户端版本号与更新检查。
 *
 * 版本号在**打包时**由 VITE_APP_VERSION_CODE / VITE_APP_VERSION_NAME 注入，
 * 与 android/app/build.gradle 的 versionCode / versionName 手动保持一致。
 * 浏览器里这两个值为 0 / '0.0.0'，不发送版本头、也不做更新检查。
 */
export const APP_VERSION_CODE = Number(import.meta.env.VITE_APP_VERSION_CODE ?? 0)
export const APP_VERSION_NAME = String(import.meta.env.VITE_APP_VERSION_NAME ?? '0.0.0')

/** 原生壳的所有 API 请求都要带这个头，服务端据此拦截旧版本 */
export function appVersionHeader(): Record<string, string> {
  return isNativeApp() && APP_VERSION_CODE > 0
    ? { 'X-App-Version-Code': String(APP_VERSION_CODE) }
    : {}
}

export interface AppVersionInfo {
  versionCode: number
  versionName: string
  apkUrl: string
  minVersionCode: number
  force: boolean
  notes?: string
}

/** 查最新版本。失败时由调用方决定是否阻断（这里不吞异常） */
export async function fetchLatestVersion(apiBase: string): Promise<AppVersionInfo> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`${apiBase}/app/version`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as AppVersionInfo
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 服务端下发的是站内相对路径（/download/xxx.apk），客户端要补成绝对地址。
 * 原生壳里不能用相对路径 —— WebView 的 /download 会打到 localhost 自己身上。
 */
export function resolveApkUrl(apiBase: string, apkUrl: string): string {
  try {
    return new URL(apkUrl, apiBase).href
  } catch {
    return apkUrl
  }
}
