/**
 * 网页版构建号。
 *
 * index.html 里的 `<meta name="zhiyin-build">` 由 vite.config.ts 在每次构建时注入。
 * 页面运行中重新请求 index.html，解析出服务器上的构建号，和当前页面里的一致
 * 就说明是最新版本，不一致就提示刷新。
 *
 * 这里只放纯函数，方便在 node 环境里直接测；DOM 与 fetch 在 WebUpdateBanner 里。
 */

/** 从 index.html 文本里取出 zhiyin-build 的 content；取不到返回空串 */
export function parseBuildId(html: string): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (!/\bname\s*=\s*["']zhiyin-build["']/i.test(tag)) continue
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)
    if (content) return content[1]
  }
  return ''
}

/** 手机 / 平板：触摸屏，或窄窗口。桌面端不弹网页更新提示 */
export function isPhoneOrTablet(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia?.('(pointer: coarse)').matches === true ||
    window.innerWidth <= 1024
  )
}

/** 拉取服务器上最新的 index.html 并解析构建号；失败返回空串，不打断阅读 */
export async function fetchLatestBuildId(): Promise<string> {
  try {
    const base = import.meta.env.BASE_URL || '/'
    const res = await fetch(`${base}index.html?ts=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return ''
    return parseBuildId(await res.text())
  } catch {
    return ''
  }
}
