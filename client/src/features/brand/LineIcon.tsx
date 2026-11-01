/**
 * 线性图标。
 *
 * 原先引导页与书架分类用的是 emoji：同一个图标在不同系统上会渲染成彩色 / 黑白、
 * 粗细不一，跟水墨风的书卷气质也对不上。这里改成内联 SVG，统一 1.6 描边、
 * 跟随 currentColor，深浅色主题都自动适配。
 */

export type LineIconName =
  | 'image'
  | 'headphones'
  | 'bookmark'
  | 'cloud'
  | 'puzzle'
  | 'wifi'
  | 'shelf'
  | 'clock'
  | 'star'
  | 'chart'
  | 'sliders'

interface Props {
  name: LineIconName
  size?: number
  className?: string
}

export default function LineIcon({ name, size = 20, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {name === 'image' && (
        <>
          <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
          <circle cx="8.4" cy="9.6" r="1.5" />
          <path d="M4.4 17.2 9 12.6l3.1 3.1 3.2-2.6 4.3 4.1" />
        </>
      )}
      {name === 'headphones' && (
        <>
          <path d="M4 14.2v-2.1a8 8 0 0 1 16 0v2.1" />
          <rect x="3.2" y="13.4" width="4.2" height="6.2" rx="1.9" />
          <rect x="16.6" y="13.4" width="4.2" height="6.2" rx="1.9" />
        </>
      )}
      {name === 'bookmark' && (
        <path d="M7 4.4h10a1 1 0 0 1 1 1v14.3l-6-3.6-6 3.6V5.4a1 1 0 0 1 1-1Z" />
      )}
      {name === 'cloud' && (
        <>
          <path d="M7.6 18.4h8.8a3.6 3.6 0 0 0 .4-7.18A5.5 5.5 0 0 0 6.4 10a4.2 4.2 0 0 0 1.2 8.4Z" />
          <path d="M12 9.7v4.6M9.9 12.3 12 9.7l2.1 2.6" />
        </>
      )}
      {name === 'puzzle' && (
        <path d="M9.2 4h4v2.1a1.75 1.75 0 1 0 3.5 0V4h3.2v4.1h-2.1a1.75 1.75 0 1 0 0 3.5h2.1v8.2h-8.2v-2.1a1.75 1.75 0 1 0-3.5 0V20H4.2v-8.2h2.1a1.75 1.75 0 1 0 0-3.5H4.2V4h5Z" />
      )}
      {name === 'wifi' && (
        <>
          <path d="M3.4 9.4a13 13 0 0 1 17.2 0" />
          <path d="M6.4 12.8a8.6 8.6 0 0 1 11.2 0" />
          <path d="M9.4 16.2a4.2 4.2 0 0 1 5.2 0" />
          <circle cx="12" cy="19.1" r="1" fill="currentColor" stroke="none" />
        </>
      )}
      {name === 'shelf' && (
        <>
          <rect x="3.5" y="4.5" width="7" height="7" rx="1.4" />
          <rect x="13.5" y="4.5" width="7" height="7" rx="1.4" />
          <rect x="3.5" y="14.5" width="7" height="5" rx="1.4" />
          <rect x="13.5" y="14.5" width="7" height="5" rx="1.4" />
        </>
      )}
      {name === 'clock' && (
        <>
          <circle cx="12" cy="12" r="8.2" />
          <path d="M12 7.6V12l3 1.8" />
        </>
      )}
      {name === 'star' && (
        <path d="m12 4.2 2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 16.18l-4.7 2.48.9-5.23-3.8-3.7 5.25-.77Z" />
      )}
      {name === 'chart' && (
        <>
          <path d="M4 20V4" />
          <path d="M4 20h16" />
          <path d="M7.5 16.5v-5M12 16.5v-8M16.5 16.5v-3" />
        </>
      )}
      {name === 'sliders' && (
        <>
          <path d="M4 7h8M16 7h4M4 12h3M11 12h9M4 17h11M19 17h1" />
          <circle cx="14" cy="7" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="17" cy="17" r="2" />
        </>
      )}
    </svg>
  )
}
