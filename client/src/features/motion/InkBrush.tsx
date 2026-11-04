import { useEffect, useRef } from 'react'

/**
 * 纸上落墨（A1 毛笔拖墨 + A2 墨滴落纸）。
 *
 * 两种效果都是「墨离开画笔、落在纸上」这一类，共用一块 canvas 画最划算：
 * 一次 rAF、一次 clearRect，比叠两块 canvas 省一半合成开销。
 *
 * 层级：盖在正文之上（pointer-events: none）。墨是半透明的，划过文字时会
 * 把字染上一点墨色 —— 这正是「墨在纸上」而不是「墨在字下面」的感觉。
 * 颜色从 CSS 变量 --ink-rgb 取，深浅主题各一份。
 *
 * ⚠️ 这里**没有**常驻帧。原先的浮尘要求每帧都重画，于是页面一打开就是
 * 一条 60fps 空转的 rAF；浮尘去掉后，墨痕散尽（约 3.2s）就停止，
 * 下一次 pointermove 再重新起帧。
 */

interface Props {
  className?: string
  /** A1：光标划过留下一道会自己干掉的墨痕 */
  trail?: boolean
  /** A2：点击时墨滴落下炸开 */
  splash?: boolean
}

const TAU = Math.PI * 2

/** 墨痕寿命。再长会糊成一片，再短看不出「慢慢干掉」 */
const TRAIL_LIFE = 3200
/** 墨滴从炸开到散尽的时长 */
const SPLASH_LIFE = 1300
/** canvas 最多留多少个墨点：鼠标狂划时不让数组无限长（每点每帧都是一次 fill） */
const DAB_LIMIT = 180
/** 重画间隔：墨是慢慢淡的，25fps 看不出差别，栅格开销却少一半 */
const FRAME_GAP = 50
/** 抬手之后只剩淡出，再降一半帧率也看不出停顿 */
const IDLE_GAP = 100
/**
 * 画布分辨率倍率：墨是软边的半透明色块，按 0.7 栅格化再交给 CSS 放大，
 * 肉眼几乎看不出，栅格化和合成却都省掉一半像素。
 */
const RES_SCALE = 0.8

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

/** 稳定伪随机：墨滴的飞溅方向只跟 seed 有关，重绘之间不会乱跳 */
function hash(n: number): number {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return v - Math.floor(v)
}

export default function InkBrush({ className, trail = true, splash = true }: Props) {
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

    let lastX = 0
    let lastY = 0
    let lastT = 0
    let lastDraw = 0
    let lastAdd = 0

    const readInk = () => {
      const v = getComputedStyle(el).getPropertyValue('--ink-rgb').trim()
      if (v) ink = v
    }

    const drawTrail = (now: number) => {
      let n = 0
      // 颜色只拼一次，浓淡走 globalAlpha：以前每个点都要拼一遍颜色串再解析
      g.fillStyle = `rgb(${ink})`
      for (const d of dabs) {
        const k = 1 - (now - d.born) / TRAIL_LIFE
        if (k <= 0) continue
        dabs[n++] = d
        // 边淡边稍稍洇开：墨在宣纸上就是这个样子
        // 墨点挨得很密，单个必须画得很淡，叠起来才有墨的浓度
        g.globalAlpha = Math.min(0.145, k * k * 0.32)
        g.beginPath()
        g.arc(d.x, d.y, d.r * (1 + (1 - k) * 0.5), 0, TAU)
        g.fill()
      }
      g.globalAlpha = 1
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

        // 往外扩的一圈墨晕：很淡，只用来交代「洇出去了」
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

    interface Box {
      x: number
      y: number
      w: number
      h: number
    }

    /** 上一帧画过的范围：这一帧先把它擦掉，墨点少了也不会留下旧痕 */
    let lastBox: Box | null = null

    /** 这一帧所有墨迹的外接矩形；全空时返回 null */
    const contentBox = (now: number): Box | null => {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      let has = false

      for (const d of dabs) {
        const k = 1 - (now - d.born) / TRAIL_LIFE
        if (k <= 0) continue
        // 墨点半径最多涨到 1.5r，再留 2px 余量
        const rr = d.r * 1.5 + 2
        has = true
        if (d.x - rr < x0) x0 = d.x - rr
        if (d.y - rr < y0) y0 = d.y - rr
        if (d.x + rr > x1) x1 = d.x + rr
        if (d.y + rr > y1) y1 = d.y + rr
      }

      for (const s of splashes) {
        if ((now - s.born) / SPLASH_LIFE >= 1) continue
        // 主体 R=54，飞溅点最远到 1.5R，留 90 足够
        const rr = 90
        has = true
        if (s.x - rr < x0) x0 = s.x - rr
        if (s.y - rr < y0) y0 = s.y - rr
        if (s.x + rr > x1) x1 = s.x + rr
        if (s.y + rr > y1) y1 = s.y + rr
      }

      return has ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
    }

    const frame = (now: number) => {
      raf = 0
      if (!alive) return
      // 新墨落下时 25fps；只剩淡出时降到 12.5fps，肉眼看不出停顿
      const gap = now - lastAdd < 400 ? FRAME_GAP : IDLE_GAP
      if (now - lastDraw < gap) {
        raf = requestAnimationFrame(frame)
        return
      }
      lastDraw = now

      // 只重画有墨的那一块：整屏 clear + 重绘在连续划动时是纯浪费。
      // 上一帧的范围也要带上，否则指针离开后最后一段旧墨擦不掉。
      const cur = contentBox(now)
      let box = cur
      if (lastBox) {
        if (!box) box = lastBox
        else {
          const x0 = Math.min(box.x, lastBox.x)
          const y0 = Math.min(box.y, lastBox.y)
          const x1 = Math.max(box.x + box.w, lastBox.x + lastBox.w)
          const y1 = Math.max(box.y + box.h, lastBox.y + lastBox.h)
          box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
        }
      }

      if (box) {
        const bx = Math.max(0, Math.floor(box.x))
        const by = Math.max(0, Math.floor(box.y))
        const bw = Math.min(w, Math.ceil(box.x + box.w)) - bx
        const bh = Math.min(h, Math.ceil(box.y + box.h)) - by
        if (bw > 0 && bh > 0) {
          g.clearRect(bx, by, bw, bh)
          if (trail) drawTrail(now)
          if (splash) drawSplashes(now)
        }
      }
      lastBox = cur

      // 墨痕和墨滴都散尽了就停：下一次指针移动会重新起帧。
      // 这一句是本次优化的关键 —— 没有它 rAF 会在页面打开期间一直空转。
      if (alive && visible && !reduce && (dabs.length > 0 || splashes.length > 0)) {
        raf = requestAnimationFrame(frame)
      }
    }

    const start = () => {
      if (raf || !alive || !visible || reduce) return
      raf = requestAnimationFrame(frame)
    }

    const resize = () => {
      const rect = box.getBoundingClientRect()
      // 墨迹本身是半透明的软边，1x 已经看不出来；2x 会让每帧清屏 + 重画
      // 多栅格四倍像素，鼠标一划 GPU 就满
      w = Math.max(1, Math.round(rect.width))
      h = Math.max(1, Math.round(rect.height))
      el.width = Math.max(1, Math.round(w * RES_SCALE))
      el.height = Math.max(1, Math.round(h * RES_SCALE))
      g.setTransform(RES_SCALE, 0, 0, RES_SCALE, 0, 0)
      readInk()
      if (reduce) frame(performance.now())
    }

    const onMove = (e: PointerEvent) => {
      if (!trail || reduce) return
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      const now = performance.now()
      if (lastT) {
        const dt = Math.max(1, now - lastT)
        const dist = Math.hypot(x - lastX, y - lastY)
        // 鼠标从别处「跳」过来（移出再移入、拖出窗口）不该在纸上拖出一道直线
        if (dist > 260) {
          lastX = x
          lastY = y
          lastT = now
          return
        }
        // 慢处粗、快处细：笔扫过去的自然手感
        const r = Math.max(1.4, Math.min(5.5, 5.5 - (dist / dt) * 1.4))
        // 步长比笔宽还小，墨点才会连成一道痕而不是一串点；
        // 1.2 倍是「还连得住」的上限，再密只是白白多刷几倍的 draw call
        const gap = Math.max(2, r * 1.2)
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
      lastAdd = now
      start()
    }

    const onDown = (e: PointerEvent) => {
      if (!splash || reduce) return
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      lastAdd = performance.now()
      splashes.push({ x, y, born: lastAdd, seed: Math.random() * 1000 })
      if (splashes.length > 6) splashes.shift()
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

    // 切深浅主题时换墨色；没有正在淡出的墨痕就只更新颜色，不重新起帧
    const mo = new MutationObserver(() => {
      readInk()
      if (reduce) frame(performance.now())
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    box.addEventListener('pointermove', onMove, { passive: true })
    box.addEventListener('pointerdown', onDown, { passive: true })
    box.addEventListener('pointerleave', onLeave, { passive: true })
    document.addEventListener('visibilitychange', onVis)

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
  }, [trail, splash])

  return <canvas ref={canvasRef} className={'ink-brush' + (className ? ' ' + className : '')} aria-hidden="true" />
}
