import { useId } from 'react'

/**
 * 软件标志。
 *
 * 内联 SVG 而不是图片文件：一个矢量图不占额外请求、任何尺寸都清晰，
 * 也不必往仓库里塞二进制 —— 与项目"不引外部资源"的取向一致。
 *
 * 造型取「知音」的典：一重山（高山）＋一道水（流水），压在纸上。
 * 渐变与滤镜的 id 用 useId() 生成：同一个页面上可能出现两个 logo
 * （登录页 + 引导页），写死 id 会互相串。
 */

interface Props {
  size?: number
  /** 圆角方块底色。默认宣纸白；放在深色底上时保持默认即可 */
  tone?: 'paper' | 'ink'
  title?: string
}

export default function AppLogo({ size = 48, tone = 'paper', title = '知音漫卷' }: Props) {
  const uid = useId().replace(/:/g, '')
  const paperId = `logo-paper-${uid}`
  const inkId = `logo-ink-${uid}`

  // 纸底上用蓝墨；墨底上反过来用纸色，保证任何背景上都看得清
  const ink = tone === 'paper' ? `url(#${inkId})` : '#f3f7ff'
  const inkSoft = tone === 'paper' ? '#2f6fed' : '#f3f7ff'

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label={title}
      className="app-logo"
    >
      <defs>
        <linearGradient id={paperId} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor={tone === 'paper' ? '#ffffff' : '#1b3f8f'} />
          <stop offset="1" stopColor={tone === 'paper' ? '#e8f0fc' : '#0f2a63'} />
        </linearGradient>
        <linearGradient id={inkId} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#3f7ff5" />
          <stop offset="1" stopColor="#1d3f8f" />
        </linearGradient>
      </defs>

      <rect width="48" height="48" rx="13" fill={`url(#${paperId})`} />

      {/* 高山：两重远近，近处压得更实 */}
      <path d="M13 24.5 L20.5 15.5 L26 21.5 L30.5 16.8 L37 24.5 Z" fill={ink} opacity="0.55" />
      <path d="M9 32 L19 20.5 L25.5 27 L31 21.5 L39 32 Z" fill={ink} />

      {/* 流水：底下三道起伏，越远越淡 */}
      <path
        d="M9 35.5 q3.75 -2.4 7.5 0 t7.5 0 t7.5 0 t7.5 0"
        fill="none"
        stroke={inkSoft}
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path
        d="M12 39 q3 -1.9 6 0 t6 0 t6 0 t6 0"
        fill="none"
        stroke={inkSoft}
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  )
}
