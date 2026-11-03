import type { CSSProperties } from 'react'

/**
 * 液墨描字（A6）。
 *
 * 思路来自 ThreeUI 的 article-headings，但第一版是「逐字换字符」的解码动画，
 * 快照里能明显看到笔画占位在闪。这一版改成**遮罩擦除**：每个字盖一张斜向渐变的
 * 蒙版，蒙版从左往右退出，字就像被笔尖从纸面扫过一样显出来 —— 边缘带一点墨的软边，
 * 而且完全由 CSS 关键帧驱动，不再有 rAF 和定时器。
 *
 * 只剩一件事要 JS 参与：把 duration / stagger / delay 翻译成 CSS 变量。
 * 系统开了「减少动态效果」时由 app.css 末尾那条全局规则把动画压到 0.001ms，
 * 直接落到终态，不需要在这里判一次。
 */

interface Props {
  text: string
  className?: string
  /** 一个字从隐到显要多久（毫秒） */
  duration?: number
  /** 相邻两个字的起跑间隔（毫秒） */
  stagger?: number
  /** 整段延后多久开始，用来和别的入场动画排节奏 */
  delay?: number
}

export default function InkText({
  text,
  className,
  duration = 560,
  stagger = 110,
  delay = 0,
}: Props) {
  const style = {
    '--ink-dur': `${duration}ms`,
    '--ink-stagger': `${stagger}ms`,
    '--ink-delay': `${delay}ms`,
  } as CSSProperties

  return (
    <span
      className={'ink-text' + (className ? ' ' + className : '')}
      style={style}
      aria-label={text}
    >
      {Array.from(text).map((ch, i) => (
        <span
          className="ink-char"
          key={i}
          // 序号喂给 CSS，用它算每个字的 animation-delay
          style={{ '--i': i } as CSSProperties}
          aria-hidden="true"
        >
          {ch}
        </span>
      ))}
    </span>
  )
}
