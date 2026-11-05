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

/**
 * 手机 / 平板判断。
 *
 * 不能只看 `maxTouchPoints > 0`：带触摸屏的 Windows 笔记本也有触摸点，
 * 但它配鼠标、有 hover，仍然是桌面。也不能只看宽度：桌面窗口可以被拖到 1000px。
 * 主指针为粗（触摸）**且**没有 hover，才是真正的手机 / 平板。
 *
 * 参数默认取全局 window / navigator，测试可以注入假的；没有 matchMedia
 * 的环境（如纯 Node）一律按桌面处理。
 */
export function isPhoneOrTablet(
  win: Pick<Window, 'innerWidth' | 'matchMedia'> | null =
    typeof window === 'undefined' ? null : window,
  _nav: Pick<Navigator, 'maxTouchPoints'> | null =
    typeof navigator === 'undefined' ? null : navigator,
): boolean {
  if (!win || typeof win.matchMedia !== 'function') return false
  const coarse = win.matchMedia('(pointer: coarse)').matches === true
  const noHover = win.matchMedia('(hover: none)').matches === true
  return coarse && noHover
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
