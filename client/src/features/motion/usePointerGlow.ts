import type { PointerEvent as ReactPointerEvent } from 'react'
import { hasFinePointer } from './motionEnv'

/**
 * 指针跟随。
 *
 * ThreeUI 那批卡片/按钮都有一层跟着光标走的高光，这里用 CSS 变量实现：
 * 事件里只写 --gx / --gy（光斑位置）和 --rx / --ry（倾斜角），
 * 具体怎么画全交给 app.css，组件上不出现任何内联样式。
 */

/** 光斑：光标位置写进 --gx / --gy，样式里用 radial-gradient 画一圈墨晕 */
export function usePointerGlow() {
  // 触屏没有悬停：手指划过只会在滚动时白写 CSS 变量、白重绘一层渐变
  if (!hasFinePointer()) return {}

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
