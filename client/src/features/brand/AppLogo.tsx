import { useId } from 'react'

/**
 * 软件标志。
 *
 * 造型取「知音」的典：一方宣纸卡，中间一枚墨蓝圆景 —— 白山、朱日、流水。
 * 圆景比原来的两座三角山更像"印记"，在 32–56px 的尺寸下也立得住；
 * 纸卡的暖白让它在深蓝登录栏和浅色引导页上都能读出来。
 *
 * 内联 SVG 而不是图片文件：矢量在任意尺寸都清晰，也不必往仓库里塞位图。
 * 渐变与裁剪的 id 用 useId() 生成：同一页面可能出现两个 logo（登录页 + 引导页），
 * 写死 id 会互相串。
 */

interface Props {
  size?: number
  /** 纸卡：浅底深墨；墨卡：深底浅墨。默认纸卡 */
  tone?: 'paper' | 'ink'
  title?: string
}

export default function AppLogo({ size = 48, tone = 'paper', title = '知音漫卷' }: Props) {
  const uid = useId().replace(/:/g, '')
  const id = (name: string) => `logo-${name}-${uid}`

  const c =
    tone === 'paper'
      ? {
          card: ['#fffdf8', '#f5f8fd', '#e4edf9'],
          disc: ['#3064a3', '#1a3e7b', '#0d2345'],
          rock: ['#ffffff', '#f2f8ff', '#dbe8f7'],
          wave: ['#f2f8ff', '#8fb9e2'],
          shade: '#d7e5f5',
          far: '#ffffff',
          farOpacity: 0.22,
          innerWave: '#9dc2e7',
          border: '#1d3f8f',
          borderOpacity: 0.09,
          ring: '#ffffff',
          ringOpacity: 0.13,
        }
      : {
          card: ['#1b3f8f', '#16346c', '#0f2a63'],
          disc: ['#ffffff', '#f3f7fd', '#e2ecf8'],
          rock: ['#2f629f', '#1b4079', '#0f2a52'],
          wave: ['#1b3f8f', '#4f8ac9'],
          shade: '#c9dcef',
          far: '#1b3f8f',
          farOpacity: 0.18,
          innerWave: '#4f8ac9',
          border: '#ffffff',
          borderOpacity: 0.16,
          ring: '#1b3f8f',
          ringOpacity: 0.12,
        }

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
        <linearGradient id={id('card')} x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor={c.card[0]} />
          <stop offset="0.55" stopColor={c.card[1]} />
          <stop offset="1" stopColor={c.card[2]} />
        </linearGradient>
        <linearGradient id={id('disc')} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor={c.disc[0]} />
          <stop offset="0.52" stopColor={c.disc[1]} />
          <stop offset="1" stopColor={c.disc[2]} />
        </linearGradient>
        <linearGradient id={id('rock')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c.rock[0]} />
          <stop offset="0.7" stopColor={c.rock[1]} />
          <stop offset="1" stopColor={c.rock[2]} />
        </linearGradient>
        <linearGradient id={id('wave')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={c.wave[0]} />
          <stop offset="1" stopColor={c.wave[1]} />
        </linearGradient>
        <radialGradient id={id('sun')} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#e79a78" />
          <stop offset="1" stopColor="#b5472e" />
        </radialGradient>
        <radialGradient id={id('glow')} cx="0.28" cy="0.18" r="0.75">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={id('clip')}>
          <circle cx="24" cy="24" r="16.2" />
        </clipPath>
      </defs>

      <rect width="48" height="48" rx="12.5" fill={`url(#${id('card')})`} />
      <rect
        x="0.65"
        y="0.65"
        width="46.7"
        height="46.7"
        rx="12.1"
        fill="none"
        stroke={c.border}
        strokeOpacity={c.borderOpacity}
        strokeWidth="1.1"
      />

      <circle cx="24" cy="24" r="16.2" fill={`url(#${id('disc')})`} />
      <circle
        cx="24"
        cy="24"
        r="15.2"
        fill="none"
        stroke={c.ring}
        strokeOpacity={c.ringOpacity}
        strokeWidth="0.9"
      />

      <g clipPath={`url(#${id('clip')})`}>
        <circle cx="24" cy="24" r="16.2" fill={`url(#${id('glow')})`} />
        <circle cx="31.4" cy="14.9" r="3.4" fill={`url(#${id('sun')})`} opacity="0.95" />

        <path
          d="M6.5 30.8 L14 22.6 L19.6 28.4 L24.2 21.2 L30 27.4 L33.8 23.2 L41.5 30.8 Z"
          fill={c.far}
          opacity={c.farOpacity}
        />
        <path
          d="M8.2 33.7 L18.2 21.4 L24.2 28.3 L29.6 22.7 L39.8 33.7 Z"
          fill={`url(#${id('rock')})`}
        />
        <path
          d="M24.2 28.3 L29.6 22.7 L39.8 33.7 L24.2 33.7 Z"
          fill={c.shade}
          opacity="0.72"
        />

        <path
          d="M10.4 36.5 q3.1 -1.9 6.2 0 t6.2 0 t6.2 0"
          fill="none"
          stroke={`url(#${id('wave')})`}
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.94"
        />
        <path
          d="M13.2 40.4 q2.7 -1.6 5.4 0 t5.4 0 t5.4 0"
          fill="none"
          stroke={c.innerWave}
          strokeWidth="1.1"
          strokeLinecap="round"
          opacity="0.42"
        />
      </g>
    </svg>
  )
}
