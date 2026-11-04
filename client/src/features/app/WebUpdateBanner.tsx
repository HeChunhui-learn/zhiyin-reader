import { useEffect, useState } from 'react'
import { isNativeApp } from '../../api/platform'
import { fetchLatestBuildId, isPhoneOrTablet } from './webBuild'

/**
 * 网页版更新轻提示（手机 / 平板）。
 *
 * 原生壳走 UpdateGate 的强制更新弹窗；网页版没有「装哪个 APK」的概念，
 * 所以这里只做一条不打断阅读的顶部提示：
 *
 *   - 打开页面、回到前台、每 10 分钟各检查一次；
 *   - 比对当前页面与服务器 index.html 里的 zhiyin-build；
 *   - 发现新构建就显示「发现新版本」，点「立即刷新」才重载；
 *   - 点 × 只忽略这一个构建号，下次部署仍会提示。
 *
 * 检查失败一律安静放行：离线或服务端抖动不能让阅读卡住。
 */

const CHECK_INTERVAL_MS = 10 * 60 * 1000
const DISMISS_KEY = 'zhiyin:web-update-dismissed'

function currentBuildId(): string {
  if (typeof document === 'undefined') return ''
  return document.querySelector('meta[name="zhiyin-build"]')?.getAttribute('content') ?? ''
}

function readDismissed(): string {
  try {
    return sessionStorage.getItem(DISMISS_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberDismissed(buildId: string) {
  try {
    sessionStorage.setItem(DISMISS_KEY, buildId)
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用，忽略即可 */
  }
}

/** 带 cache-busting 的刷新：避免浏览器继续用旧的 index.html */
function reloadFresh() {
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('_r', Date.now().toString(36))
    window.location.replace(url.toString())
  } catch {
    window.location.reload()
  }
}

export default function WebUpdateBanner() {
  const [latestBuild, setLatestBuild] = useState('')

  useEffect(() => {
    if (isNativeApp() || !isPhoneOrTablet()) return
    const running = currentBuildId()
    // 构建号没注入（老构建或开发环境异常）就不做比较，避免误报
    if (!running) return

    let alive = true

    const check = async () => {
      const remote = await fetchLatestBuildId()
      if (!alive || !remote || remote === running) return
      if (readDismissed() === remote) return
      setLatestBuild(remote)
    }

    void check()

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS)

    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  if (!latestBuild) return null

  const dismiss = () => {
    rememberDismissed(latestBuild)
    setLatestBuild('')
  }

  return (
    <div className="web-update-banner" role="status" aria-live="polite">
      <span className="web-update-dot" aria-hidden="true" />
      <span className="web-update-text">发现新版本</span>
      <button type="button" className="web-update-action" onClick={reloadFresh}>
        立即刷新
      </button>
      <button
        type="button"
        className="web-update-close"
        aria-label="本次先不更新"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  )
}
