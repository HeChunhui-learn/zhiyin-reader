import { useEffect, useRef } from 'react'

/**
 * 墨点阵背景。
 *
 * 参考 ThreeUI 的 dot-matrix 背景（一张会随光标起伏的点阵），
 * 那边是 three.js 的 shader；这里用 canvas 2D 重画成「纸上的一层墨点」：
 * 点会缓慢呼吸，光标过处浮起来，并荡开两圈涟漪。
 *
 * 三条自我约束：
 *   · 颜色从 CSS 变量 --ink-field 取，深浅色主题各自换值，画布里不写死颜色
 *   · 元素滚出视口、标签页切到后台就停帧，不留一个空转的 rAF
 *   · 系统开了「减少动态效果」就只画一帧静态的点阵
 */

/** 点阵间距。26px 在 1280 宽下是 49 列，够密但不吵 */
const CELL = 26
const TAU = Math.PI * 2

/** 稳定的伪随机：点位的抖动只跟坐标有关，重绘之间不会跳 */
function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

interface Ripple {
  x: number
  y: number
  born: number
}

interface Props {
  className?: string
}

export default function InkField({ className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 后面几层闭包一律用这两个别名：声明类型已经是非空的，
    // 不会因为跨出函数作用域被重新当成「可能是 null」
    const el: HTMLCanvasElement = canvas
    const g: CanvasRenderingContext2D = ctx

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const startedAt = performance.now()

    let w = 1
    let h = 1
    /** 墨色，形如 "45, 100, 145"，从 --ink-field 读 */
    let ink = '45, 100, 145'
    let fill = 'rgb(45, 100, 145)'
    let raf = 0
    let onScreen = true
    let alive = true
    const pointer = { x: -9999, y: -9999, active: false }
    let ripples: Ripple[] = []
    let lastRipple = 0

    function readInk() {
      const v = getComputedStyle(el).getPropertyValue('--ink-field').trim()
      if (v) ink = v
      fill = `rgb(${ink})`
    }

    function paint(now: number) {
      const t = (now - startedAt) / 1000
      g.clearRect(0, 0, w, h)

      // 两团极慢漂移的墨雾：给整齐的点阵垫一层不匀的底，免得像网格纸
      for (let i = 0; i < 2; i++) {
        const cx = w * (0.3 + 0.26 * Math.sin(t * 0.11 + i * 2.1))
        const cy = h * (0.34 + 0.24 * Math.cos(t * 0.09 + i * 1.3))
        const rad = Math.max(w, h) * 0.46
        const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad)
        grad.addColorStop(0, `rgba(${ink}, 0.05)`)
        grad.addColorStop(1, `rgba(${ink}, 0)`)
        g.fillStyle = grad
        g.fillRect(0, 0, w, h)
      }

      g.fillStyle = fill
      const cols = Math.ceil(w / CELL) + 1
      const rows = Math.ceil(h / CELL) + 1

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const id = r * 131 + c
          const x = c * CELL + (hash(id) - 0.5) * 7
          const y = r * CELL + (hash(id + 7.3) - 0.5) * 7
          const breathe = 0.5 + 0.5 * Math.sin(t * 0.9 + hash(id + 1.7) * TAU)

          // 光标附近的点浮起来、变亮、变大，像墨被吸过去聚成一小片
          let near = 0
          if (pointer.active && !reduce) {
            const d = Math.hypot(x - pointer.x, y - pointer.y)
            if (d < 190) near = 1 - d / 190
          }

          g.globalAlpha = Math.min(0.8, 0.05 + breathe * 0.055 + near * 0.42)
          g.beginPath()
          g.arc(x, y, 0.85 + breathe * 0.5 + near * 1.9, 0, TAU)
          g.fill()
        }
      }

      // 涟漪：两圈同心环，由内向外淡出
      g.strokeStyle = fill
      g.lineWidth = 1
      ripples = ripples.filter((rp) => now - rp.born < 1400)
      for (const rp of ripples) {
        const age = (now - rp.born) / 1400
        const radius = 8 + age * 220
        g.globalAlpha = (1 - age) * 0.24
        g.beginPath()
        g.arc(rp.x, rp.y, radius, 0, TAU)
        g.stroke()
        g.globalAlpha = (1 - age) * 0.1
        g.beginPath()
        g.arc(rp.x, rp.y, radius * 0.62, 0, TAU)
        g.stroke()
      }
      g.globalAlpha = 1
    }

    function loop(now: number) {
      raf = 0
      paint(now)
      if (alive && onScreen && !document.hidden && !reduce) raf = requestAnimationFrame(loop)
    }

    function sync() {
      const want = alive && onScreen && !document.hidden && !reduce
      if (want && !raf) raf = requestAnimationFrame(loop)
      if (!want && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    function resize() {
      const rect = el.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = Math.max(1, Math.round(rect.width))
      h = Math.max(1, Math.round(rect.height))
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      readInk()
      // 静止模式下的唯一一帧
      if (reduce) paint(performance.now())
    }

    function onPointerMove(e: PointerEvent) {
      if (reduce) return
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      pointer.x = x
      pointer.y = y
      pointer.active = x > -90 && y > -90 && x < rect.width + 90 && y < rect.height + 90

      const now = performance.now()
      if (pointer.active && now - lastRipple > 240) {
        lastRipple = now
        ripples.push({ x, y, born: now })
        // 手快的时候涟漪会叠成一片，留最近 6 个就够
        if (ripples.length > 6) ripples.shift()
      }
    }

    function onPointerLeave() {
      pointer.active = false
    }

    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((en) => en.isIntersecting)
      sync()
    })
    io.observe(el)

    const onVisibility = () => sync()
    const onTheme = () => {
      readInk()
      if (reduce) paint(performance.now())
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerleave', onPointerLeave)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', resize)
    const mo = new MutationObserver(onTheme)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    if (!reduce) sync()

    return () => {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      mo.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={'ink-field' + (className ? ' ' + className : '')}
      aria-hidden="true"
    />
  )
}
