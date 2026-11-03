import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * 指针跟随。
 *
 * ThreeUI 那批卡片/按钮都有一层跟着光标走的高光，这里用 CSS 变量实现：
 * 事件里只写 --gx / --gy（光斑位置）和 --rx / --ry（倾斜角），
 * 具体怎么画全交给 app.css，组件上不出现任何内联样式。
 */

/** 光斑：光标位置写进 --gx / --gy，样式里用 radial-gradient 画一圈墨晕 */
export function usePointerGlow() {
  return {
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const el = e.currentTarget
      const rect = el.getBoundingClientRect()
      el.style.setProperty('--gx', `${e.clientX - rect.left}px`)
      el.style.setProperty('--gy', `${e.clientY - rect.top}px`)
    },
    onPointerLeave(e: ReactPointerEvent<HTMLElement>) {
      const el = e.currentTarget
      el.style.setProperty('--gx', '-999px')
      el.style.setProperty('--gy', '-999px')
    },
  }
}

/**
 * 轻微 3D 倾斜：不改 DOM 结构，只写 --rx / --ry。
 * 幅度默认 5 度 —— 再大就像玩具，水墨的东西要"欲动还静"。
 */
export function useTilt(max = 5) {
  return {
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const el = e.currentTarget
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const px = (e.clientX - rect.left) / rect.width
      const py = (e.clientY - rect.top) / rect.height
      el.style.setProperty('--gx', `${e.clientX - rect.left}px`)
      el.style.setProperty('--gy', `${e.clientY - rect.top}px`)
      el.style.setProperty('--rx', `${(0.5 - py) * max}deg`)
      el.style.setProperty('--ry', `${(px - 0.5) * max}deg`)
    },
    onPointerLeave(e: ReactPointerEvent<HTMLElement>) {
      const el = e.currentTarget
      el.style.setProperty('--rx', '0deg')
      el.style.setProperty('--ry', '0deg')
      el.style.setProperty('--gx', '-999px')
      el.style.setProperty('--gy', '-999px')
    },
  }
}
