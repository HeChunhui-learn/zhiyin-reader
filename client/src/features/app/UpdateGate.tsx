import { useEffect, useState, type ReactNode } from 'react'
import { getApiBase } from '../../api/client'
import {
  APP_VERSION_CODE,
  APP_VERSION_NAME,
  fetchLatestVersion,
  resolveApkUrl,
  type AppVersionInfo,
} from '../../api/appVersion'
import { isNativeApp } from '../../api/platform'
import AppLogo from '../brand/AppLogo'

/**
 * 强制更新闸门。
 *
 * 两条路都会把弹窗叫出来：
 *   1. 启动时查 /api/app/version，发现服务端最新版高于本机；
 *   2. 任何接口返回 426 APP_UPDATE_REQUIRED（旧版本没带版本头），
 *      client.ts 会派发 zhiyin:update-required 事件。
 *
 * 弹窗没有关闭按钮 —— "必须更新"就得真的挡住。检查失败时**不阻断**：
 * 离线或服务端暂时抽风时，用户仍可以继续读本地内容；等联网后，
 * 真正发请求时服务端还会再拦一次。
 *
 * 只在 Capacitor 原生壳里生效。网页版没有"装哪个 APK"的概念，
 * 不应该被这个弹窗挡住。
 */
interface UpdateDetails {
  versionCode?: number
  versionName?: string
  minVersionCode?: number
  apkUrl?: string
}

interface Props {
  children: ReactNode
}

export default function UpdateGate({ children }: Props) {
  const [info, setInfo] = useState<AppVersionInfo | null>(null)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    if (!isNativeApp()) return
    let alive = true

    fetchLatestVersion(getApiBase())
      .then((latest) => {
        if (!alive) return
        if (latest.force && latest.versionCode > APP_VERSION_CODE) setInfo(latest)
      })
      .catch(() => {
        /* 查不到就放行：离线阅读不能被更新检查卡死 */
      })

    const onRequired = (event: Event) => {
      const env = (event as CustomEvent<{ details?: UpdateDetails }>).detail
      const d = env?.details ?? {}
      setInfo({
        versionCode: Number(d.versionCode ?? 0),
        versionName: String(d.versionName ?? ''),
        minVersionCode: Number(d.minVersionCode ?? 0),
        apkUrl: String(d.apkUrl ?? ''),
        force: true,
        notes: '当前版本已停止服务，请下载新版本后继续使用。',
      })
    }

    window.addEventListener('zhiyin:update-required', onRequired)
    return () => {
      alive = false
      window.removeEventListener('zhiyin:update-required', onRequired)
    }
  }, [])

  useEffect(() => {
    if (!info) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [info])

  const apkUrl = info?.apkUrl ? resolveApkUrl(getApiBase(), info.apkUrl) : ''

  function download() {
    if (!apkUrl) return
    setOpening(true)
    // Capacitor 的 WebView 支持 _system：交给系统浏览器下载，WebView 自己不会处理 APK
    const win = window.open(apkUrl, '_system')
    if (!win) window.location.href = apkUrl
    window.setTimeout(() => setOpening(false), 1500)
  }

  if (!info) return <>{children}</>

  const current = APP_VERSION_NAME === '0.0.0' ? `#${APP_VERSION_CODE}` : APP_VERSION_NAME
  const latest = info.versionName || `#${info.versionCode}`

  return (
    <>
      {children}
      <div
        className="update-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
      >
        <div className="update-card">
          <div className="update-emblem">
            <AppLogo size={58} />
          </div>
          <h2 className="update-title" id="update-title">
            发现新版本
          </h2>
          <p className="update-meta">
            当前 v{current}　→　最新 v{latest}
          </p>
          <p className="update-note">
            {info.notes || '本次更新包含界面与稳定性改进，更新后才能继续使用。'}
          </p>
          <button
            className="btn btn-primary update-btn"
            onClick={download}
            disabled={opening || !info.apkUrl}
          >
            {opening ? '正在打开下载…' : '立即下载更新'}
          </button>
          {/* 万一系统浏览器没被拉起，至少能长按复制这个地址手动下载 */}
          {apkUrl && <p className="update-url">{apkUrl}</p>}
          <p className="update-hint">下载完成后安装，重新打开应用即可继续使用。</p>
        </div>
      </div>
    </>
  )
}
