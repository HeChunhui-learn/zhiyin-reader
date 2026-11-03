import { useEffect, useRef } from 'react'

/**
 * 纸上落墨（A1 毛笔拖墨 + A2 墨滴落纸 + A7 浮尘）。
 *
 * 三个效果都是「墨离开画笔、落在纸上」这一类，共用一块 canvas 画最划算：
 * 一次 rAF、一次 clearRect，比叠三个 canvas 省一半合成开销。
 *
 * 层级：盖在正文之上（pointer-events: none）。墨是半透明的，划过文字时会
 * 把字染上一点墨色 —— 这正是「墨在纸上」而不是「墨在字下面」的感觉。
 * 颜色从 CSS 变量 --ink-rgb 取，深浅主题各一份。
 */

interface Props {
  className?: string
  /** A1：光标划过留下一道会自己干掉的墨痕 */
  trail?: boolean
  /** A2：点击时墨滴落下炸开 */
  splash?: boolean
  /** A7：十几粒带视差的浮尘 */
  dust?: boolean
}

const TAU = Math.PI * 2

/** 墨痕寿命。再长会糊成一片，再短看不出「慢慢干掉」 */
const TRAIL_LIFE = 3200
/** 墨滴从炸开到散尽的时长 */
const SPLASH_LIFE = 1300
const DUST_COUNT = 16
/** canvas 最多留多少个墨点：鼠标狂划时不让数组无限长 */
const DAB_LIMIT = 1200

interface Dab {
  x: number
  y: number
  r: number
  born: number
}

interface Splash {
  x: number
  y: number
  born: number
  seed: number
}

interface Mote {
  nx: number
  ny: number
  z: number
  phase: number
}

/** 稳定伪随机：同一粒浮尘每一帧都在同一条轨迹上，不会乱跳 */
function hash(n: number): number {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return v - Math.floor(v)
}

export default function InkBrush({ className, trail = true, splash = true, dust = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const host = canvas.parentElement
    if (!host) return

    // 闭包里一律用别名：TS 对 canvasRef.current 的判空收窄带不进回调
    const el: HTMLCanvasElement = canvas
    const g: CanvasRenderingContext2D = ctx
    const box: HTMLElement = host

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let w = 0
    let h = 0
    let ink = '45 100 145'
    let alive = true
    let visible = true
    let raf = 0

    const dabs: Dab[] = []
    const splashes: Splash[] = []
    const motes: Mote[] = []
    for (let i = 0; i < DUST_COUNT; i++) {
      motes.push({
        nx: hash(i + 1),
        ny: hash(i + 21),
        z: 0.25 + hash(i + 41) * 0.75,
        phase: hash(i + 61) * TAU,
      })
    }

    // 指针位置：pxx/pyy 是原始值，sx/sy 是慢跟随值（视差要跟得慢才像景深）
    let pxx = 0
    let pyy = 0
    let sx = 0
    let sy = 0
    let lastX = 0
    let lastY = 0
    let lastT = 0

    const readInk = () => {
      const v = getComputedStyle(el).getPropertyValue('--ink-rgb').trim()
      if (v) ink = v
    }

    const drawDust = (now: number) => {
      for (const m of motes) {
        const drift = Math.sin(now * 0.00007 * (0.5 + m.z) + m.phase)
        const drift2 = Math.cos(now * 0.00009 * (0.4 + m.z) + m.phase * 1.7)
        // 视差：越"近"的尘飘得越远
        let x = m.nx * w + drift * 26 * m.z + (sx / (w || 1) - 0.5) * 44 * m.z
        let y = m.ny * h + drift2 * 18 * m.z + (sy / (h || 1) - 0.5) * 28 * m.z

        // 光标靠近时被轻轻推开
        const near = 92
        const dx = x - sx
        const dy = y - sy
        const d2 = dx * dx + dy * dy
        if (d2 < near * near && d2 > 0.01) {
          const d = Math.sqrt(d2)
          const push = (1 - d / near) * 30
          x += (dx / d) * push
          y += (dy / d) * push
        }

        g.fillStyle = `rgb(${ink} / ${(0.05 + m.z * 0.12).toFixed(3)})`
        g.beginPath()
        g.arc(x, y, 0.7 + m.z * 1.5, 0, TAU)
        g.fill()
      }
    }

    const drawTrail = (now: number) => {
      let n = 0
      for (const d of dabs) {
        const k = 1 - (now - d.born) / TRAIL_LIFE
        if (k <= 0) continue
        dabs[n++] = d
        // 边淡边稍稍洇开：墨在宣纸上就是这个样子
        // 墨点挨得很密，单个必须画得很淡，叠起来才有墨的浓度
        g.fillStyle = `rgb(${ink} / ${Math.min(0.07, k * k * 0.16).toFixed(3)})`
        g.beginPath()
        g.arc(d.x, d.y, d.r * (1 + (1 - k) * 0.5), 0, TAU)
        g.fill()
      }
      dabs.length = n
    }

    const drawSplashes = (now: number) => {
      let n = 0
      for (const s of splashes) {
        const t = (now - s.born) / SPLASH_LIFE
        if (t >= 1) continue
        splashes[n++] = s

        const ease = 1 - Math.pow(1 - t, 3)
        const R = 8 + ease * 46

        // 主体用三团圆错开画：边缘就不会是个规整的圆
        for (let i = 0; i < 3; i++) {
          const ox = (hash(s.seed + i) - 0.5) * R * 0.9
          const oy = (hash(s.seed + i + 7) - 0.5) * R * 0.9
          g.fillStyle = `rgb(${ink} / ${((1 - t) * 0.12).toFixed(3)})`
          g.beginPath()
          g.arc(s.x + ox, s.y + oy, R * (0.52 - i * 0.08), 0, TAU)
          g.fill()
        }

        // 往外扩的一圈墨晕：很淡，只用来交代"洇出去了"
        g.strokeStyle = `rgb(${ink} / ${((1 - t) * 0.09).toFixed(3)})`
        g.lineWidth = 1
        g.beginPath()
        g.arc(s.x, s.y, R, 0, TAU)
        g.stroke()

        // 飞溅出去的小墨点
        for (let i = 0; i < 6; i++) {
          const ang = hash(s.seed + i * 3.1) * TAU
          const dist = R * (0.75 + hash(s.seed + i * 5.7) * 0.75)
          const rr = Math.max(0.5, (1 - t) * 2.4 * hash(s.seed + i))
          g.fillStyle = `rgb(${ink} / ${((1 - t) * 0.22).toFixed(3)})`
          g.beginPath()
          g.arc(s.x + Math.cos(ang) * dist, s.y + Math.sin(ang) * dist, rr, 0, TAU)
          g.fill()
        }
      }
      splashes.length = n
    }

    const frame = (now: number) => {
      raf = 0
      if (!alive) return

      sx += (pxx - sx) * 0.07
      sy += (pyy - sy) * 0.07

      g.clearRect(0, 0, w, h)
      // 先远后近：浮尘在墨痕底下
      if (dust) drawDust(now)
      if (trail) drawTrail(now)
      if (splash) drawSplashes(now)

      if (alive && visible && !reduce) raf = requestAnimationFrame(frame)
    }

    const start = () => {
      if (raf || !alive || !visible || reduce) return
      raf = requestAnimationFrame(frame)
    }

    const resize = () => {
      const rect = box.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = Math.max(1, Math.round(rect.width))
      h = Math.max(1, Math.round(rect.height))
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      readInk()
      if (reduce) frame(performance.now())
    }

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      pxx = x
      pyy = y
      sx = sx || x
      sy = sy || y

      if (!trail || reduce) return
      const now = performance.now()
      if (lastT) {
        const dt = Math.max(1, now - lastT)
        const dist = Math.hypot(x - lastX, y - lastY)
        // 鼠标从别处"跳"过来（移出再移入、拖出窗口）不该在纸上拖出一道直线
        if (dist > 260) {
          lastX = x
          lastY = y
          lastT = now
          return
        }
        // 慢处粗、快处细：笔扫过去的自然手感
        const r = Math.max(1.4, Math.min(5.5, 5.5 - (dist / dt) * 1.4))
        // 步长比笔宽还小，墨点才会连成一道痕而不是一串点
        const gap = Math.max(1.2, r * 0.5)
        const steps = Math.min(120, Math.max(1, Math.ceil(dist / gap)))
        for (let i = 1; i <= steps; i++) {
          const t = i / steps
          dabs.push({ x: lastX + (x - lastX) * t, y: lastY + (y - lastY) * t, r, born: now })
        }
        if (dabs.length > DAB_LIMIT) dabs.splice(0, dabs.length - DAB_LIMIT)
      }
      lastX = x
      lastY = y
      lastT = now
      start()
    }

    const onDown = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      pxx = e.clientX - rect.left
      pyy = e.clientY - rect.top
      if (splash && !reduce) {
        splashes.push({ x: pxx, y: pyy, born: performance.now(), seed: Math.random() * 1000 })
        if (splashes.length > 6) splashes.shift()
      }
      start()
    }

    const onLeave = () => {
      lastT = 0
    }

    resize()

    // 滚出视口、标签页切到后台都停帧
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((it) => it.isIntersecting)
      if (visible) start()
    })
    io.observe(el)

    const onVis = () => {
      visible = !document.hidden
      if (visible) start()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(box)

    // 切深浅主题时换墨色
    const mo = new MutationObserver(readInk)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    box.addEventListener('pointermove', onMove, { passive: true })
    box.addEventListener('pointerdown', onDown, { passive: true })
    box.addEventListener('pointerleave', onLeave, { passive: true })
    document.addEventListener('visibilitychange', onVis)

    start()

    return () => {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      box.removeEventListener('pointermove', onMove)
      box.removeEventListener('pointerdown', onDown)
      box.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVis)
      io.disconnect()
      ro.disconnect()
      mo.disconnect()
      dabs.length = 0
      splashes.length = 0
    }
  }, [trail, splash, dust])

  return <canvas ref={canvasRef} className={'ink-brush' + (className ? ' ' + className : '')} aria-hidden="true" />
}
