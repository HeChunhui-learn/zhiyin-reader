import { useEffect, useRef } from 'react'

/**
 * 墨点阵背景。
 *
 * 参考 ThreeUI 的 dot-matrix 背景（一张会随光标起伏的点阵），
 * 那边是 three.js 的 shader；这里用 canvas 2D 重画成「纸上的一层墨点」。
 *
 * ⚠️ 这一版的重点是「不常驻」：
 *   · 雾和点阵本身不再呼吸 —— 它们画一次就缓存进离屏 canvas
 *   · 每帧只贴一次底图，再补画光标 190px 内的那几十个点，
 *     不再每帧遍历全屏一千多个 arc
 *   · 光标不动、涟漪放完就停帧；没有输入时这个组件完全不占 CPU
 * 保留的是「光标过处墨点浮起 + 两圈涟漪」这条交互反馈。
 *
 * 三条自我约束：
 *   · 颜色从 CSS 变量 --ink-field 取，深浅色主题各自换值，画布里不写死颜色
 *   · 元素滚出视口、标签页切到后台就停帧，不留一个空转的 rAF
 *   · 系统开了「减少动态效果」就只画一帧静态的点阵
 */

/** 点阵间距。26px 在 1280 宽下是 49 列，够密但不吵 */
const CELL = 26
const TAU = Math.PI * 2
/** 光标影响半径：这个圆以外的点一个都不用重画 */
const NEAR = 190
/** 重画间隔：墨点浮起和涟漪都是慢动作，30fps 看不出差别 */
const FRAME_GAP = 32
/** 涟漪寿命 */
const RIPPLE_LIFE = 1400
const RIPPLE_MAX = 228
/**
 * 光标附近的点按亮度分档批量画：
 * 以前每个点都要单独 fill 一次（每帧一两百次 draw call），
 * 分 6 档后每帧只提交 6 次，肉眼完全看不出档位。
 */
const DOT_BUCKETS = 6

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

/** 一块要重画的矩形区域 */
interface Rect {
  x: number
  y: number
  w: number
  h: number
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
    let lastRippleX = 0
    let lastRippleY = 0
    let lastDraw = 0

    // 静止的底图（雾 + 点阵）缓存一份，尺寸/主题变了才重画
    const layer = document.createElement('canvas')
    const layerCtx = layer.getContext('2d')
    if (!layerCtx) return
    const lg: CanvasRenderingContext2D = layerCtx

    function readInk() {
      const v = getComputedStyle(el).getPropertyValue('--ink-field').trim()
      if (v) ink = v
      fill = `rgb(${ink})`
    }

    /** 雾和点阵画一次就够：去掉呼吸之后它们是完全静止的 */
    function buildBase() {
      lg.clearRect(0, 0, w, h)

      // 两团极慢漂移的墨雾以前每帧重画；静止下来后直接固定在两个位置，
      // 视觉上仍是「垫在点阵下面的一层不匀的底」，看不出差别。
      for (let i = 0; i < 2; i++) {
        const cx = w * (i === 0 ? 0.34 : 0.62)
        const cy = h * (i === 0 ? 0.38 : 0.56)
        const rad = Math.max(w, h) * 0.46
        const grad = lg.createRadialGradient(cx, cy, 0, cx, cy, rad)
        grad.addColorStop(0, `rgba(${ink}, 0.05)`)
        grad.addColorStop(1, `rgba(${ink}, 0)`)
        lg.fillStyle = grad
        lg.fillRect(0, 0, w, h)
      }

      lg.fillStyle = fill
      lg.globalAlpha = 0.08
      const cols = Math.ceil(w / CELL) + 1
      const rows = Math.ceil(h / CELL) + 1
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const id = r * 131 + c
          const x = c * CELL + (hash(id) - 0.5) * 7
          const y = r * CELL + (hash(id + 7.3) - 0.5) * 7
          lg.beginPath()
          lg.arc(x, y, 1.05, 0, TAU)
          lg.fill()
        }
      }
      lg.globalAlpha = 1
    }

    // 只重画「有变化」的那一块。整屏 clear + 贴图一帧要动 130 万像素，
    // 换成光标附近 380px 的方块 + 涟漪圈，鼠标划过一帧只动十几万像素。
    let fullRepaint = true
    /** 上一帧画过的区域：这一帧先把它们擦回底图，否则会留残影 */
    let eraseRects: Rect[] = []

    function glowBox(): Rect {
      return { x: pointer.x - NEAR, y: pointer.y - NEAR, w: NEAR * 2, h: NEAR * 2 }
    }

    function rippleBox(rp: Ripple, now: number): Rect {
      const age = Math.max(0, (now - rp.born) / RIPPLE_LIFE)
      const rr = 8 + age * RIPPLE_MAX + 2
      return { x: rp.x - rr, y: rp.y - rr, w: rr * 2, h: rr * 2 }
    }

    function unionRect(list: Rect[]): Rect | null {
      if (!list.length) return null
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const r of list) {
        if (r.x < x0) x0 = r.x
        if (r.y < y0) y0 = r.y
        if (r.x + r.w > x1) x1 = r.x + r.w
        if (r.y + r.h > y1) y1 = r.y + r.h
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }

    function paint(now: number) {
      ripples = ripples.filter((rp) => now - rp.born < RIPPLE_LIFE)

      const rects = eraseRects
      eraseRects = []
      if (pointer.active && !reduce) rects.push(glowBox())
      for (const rp of ripples) rects.push(rippleBox(rp, now))

      const box = fullRepaint ? { x: 0, y: 0, w, h } : unionRect(rects)
      fullRepaint = false
      if (!box) return

      // 裁到画布内：贴图的源矩形不能越界
      const bx = Math.max(0, Math.floor(box.x))
      const by = Math.max(0, Math.floor(box.y))
      const bw = Math.min(w, Math.ceil(box.x + box.w)) - bx
      const bh = Math.min(h, Math.ceil(box.y + box.h)) - by
      if (bw <= 0 || bh <= 0) return

      g.clearRect(bx, by, bw, bh)
      g.globalAlpha = 1
      g.drawImage(layer, bx, by, bw, bh, bx, by, bw, bh)

      // 光标附近的点单独补画一层：只算这个圆覆盖到的格子。
      // 同档位的点合进一条 Path2D，每帧只 fill 6 次，不再是两百次 draw call。
      if (pointer.active && !reduce) {
        const paths: Path2D[] = []
        for (let i = 0; i < DOT_BUCKETS; i++) paths.push(new Path2D())
        const cols = Math.ceil(w / CELL) + 1
        const rows = Math.ceil(h / CELL) + 1
        const c0 = Math.max(0, Math.floor((pointer.x - NEAR) / CELL) - 1)
        const c1 = Math.min(cols - 1, Math.ceil((pointer.x + NEAR) / CELL) + 1)
        const r0 = Math.max(0, Math.floor((pointer.y - NEAR) / CELL) - 1)
        const r1 = Math.min(rows - 1, Math.ceil((pointer.y + NEAR) / CELL) + 1)

        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const id = r * 131 + c
            const x = c * CELL + (hash(id) - 0.5) * 7
            const y = r * CELL + (hash(id + 7.3) - 0.5) * 7
            const d = Math.hypot(x - pointer.x, y - pointer.y)
            if (d >= NEAR) continue
            const near = 1 - d / NEAR
            const q = Math.min(DOT_BUCKETS - 1, Math.floor(near * DOT_BUCKETS))
            const nq = (q + 0.5) / DOT_BUCKETS
            const rad = 1.05 + nq * 1.9
            const path = paths[q]
            path.moveTo(x + rad, y)
            path.arc(x, y, rad, 0, TAU)
          }
        }

        for (let q = 0; q < DOT_BUCKETS; q++) {
          const nq = (q + 0.5) / DOT_BUCKETS
          g.fillStyle = `rgba(${ink}, ${Math.min(0.8, 0.08 + nq * 0.42).toFixed(3)})`
          g.fill(paths[q])
        }
      }

      // 涟漪：两圈同心环，由内向外淡出
      g.strokeStyle = fill
      g.lineWidth = 1
      for (const rp of ripples) {
        // rAF 的时间戳可能比刚生成的涟漪还早几毫秒，钳一下免得算出负半径
        const age = Math.max(0, (now - rp.born) / RIPPLE_LIFE)
        const radius = 8 + age * RIPPLE_MAX
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

      // 记下这一帧画过的地方，下一帧先擦回底图
      if (pointer.active && !reduce) eraseRects.push(glowBox())
      for (const rp of ripples) eraseRects.push(rippleBox(rp, now))
    }

    function loop(now: number) {
      raf = 0
      if (!alive) return
      // 30fps 封顶：指针跟手不需要 60fps，涟漪本来就慢
      if (now - lastDraw < FRAME_GAP) {
        raf = requestAnimationFrame(loop)
        return
      }
      lastDraw = now
      paint(now)
      // 只有涟漪还在扩散时才继续跑；光标静止时点阵是静的，不需要每帧重画。
      // 下一次 pointermove 会重新 requestPaint()。
      if (ripples.length && alive && onScreen && !document.hidden && !reduce) {
        raf = requestAnimationFrame(loop)
      }
    }

    function requestPaint() {
      if (!alive || !onScreen || document.hidden || reduce) return
      if (!raf) raf = requestAnimationFrame(loop)
    }

    function resize() {
      const rect = el.getBoundingClientRect()
      // 淡墨点阵 + 雾，1x 已经看不出颗粒；2x 会让每帧整屏贴图多花约四倍栅格
      const dpr = 1
      w = Math.max(1, Math.round(rect.width))
      h = Math.max(1, Math.round(rect.height))
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)

      layer.width = el.width
      layer.height = el.height
      lg.setTransform(dpr, 0, 0, dpr, 0, 0)
      readInk()
      buildBase()
      // 缩放的瞬间整屏贴一次新底图；没有输入就不再起帧
      fullRepaint = true
      eraseRects = []
      paint(performance.now())
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
      // 手停在一个地方轻抖时不再不停冒圈：位移超过 24px 才落新的一圈
      const moved = Math.hypot(x - lastRippleX, y - lastRippleY)
      if (pointer.active && now - lastRipple > 240 && moved > 24) {
        lastRipple = now
        lastRippleX = x
        lastRippleY = y
        ripples.push({ x, y, born: now })
        // 手快的时候涟漪会叠成一片，留最近 6 个就够
        if (ripples.length > 6) ripples.shift()
      }
      requestPaint()
    }

    function onPointerLeave() {
      if (!pointer.active) return
      pointer.active = false
      requestPaint()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((en) => en.isIntersecting)
      if (onScreen) requestPaint()
    })
    io.observe(el)

    const onVisibility = () => requestPaint()
    const onTheme = () => {
      readInk()
      buildBase()
      // 换主题等于整张底图都换了，必须整屏重贴，不能只补光标那一块
      fullRepaint = true
      eraseRects = []
      paint(performance.now())
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    // pointerleave 不冒泡，挂在 window 上收不到；挂 document 才能在指针离开视口时清掉高亮
    document.addEventListener('pointerleave', onPointerLeave)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', resize)
    const mo = new MutationObserver(onTheme)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      mo.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
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
