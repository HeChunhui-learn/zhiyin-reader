import { useEffect, useRef } from 'react'

/**
 * 山峦分层视差（A3）。
 *
 * 三层墨山（远、中、近）叠在引导页底部，鼠标一动就按不同速度错位 —— 像人
 * 微微探身往画里看，远山几乎不动、近山跟着走。SVG 手写的山脊线，比位图轻，
 * 而且随便放大都不糊。
 *
 * 只在根元素上写 --px / --py 两个无单位数值，三层各自的位移完全交给 CSS 算，
 * React 不参与逐帧渲染。
 */
export default function GuidePeaks({ className }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let raf = 0
    let tx = 0
    let ty = 0
    let cx = 0
    let cy = 0

    const tick = () => {
      raf = 0
      cx += (tx - cx) * 0.075
      cy += (ty - cy) * 0.075
      root.style.setProperty('--px', cx.toFixed(4))
      root.style.setProperty('--py', cy.toFixed(4))
      // 没有明确停止，只在这帧还想继续走的时候续帧
      if (Math.abs(tx - cx) > 0.0015 || Math.abs(ty - cy) > 0.0015) raf = requestAnimationFrame(tick)
    }

    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth) * 2 - 1
      ty = (e.clientY / window.innerHeight) * 2 - 1
      if (!raf) raf = requestAnimationFrame(tick)
    }

    const onLeave = () => {
      tx = 0
      ty = 0
      if (!raf) raf = requestAnimationFrame(tick)
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerleave', onLeave)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return (
    <div ref={rootRef} className={'guide-peaks' + (className ? ' ' + className : '')} aria-hidden="true">
      <svg viewBox="0 0 1440 460" preserveAspectRatio="none">
        {/* 远山：几乎不动，只随呼吸挪几个像素 */}
        <g className="peak peak-far">
          <path d="M0 300 C120 240 210 250 300 210 C380 176 430 190 520 160 C600 134 660 168 740 150 C830 130 900 168 980 146 C1070 122 1130 154 1220 132 C1310 112 1370 148 1440 126 L1440 460 L0 460 Z" />
        </g>
        {/* 中景的一道雾：把远山和中景隔开，墨色才有层次 */}
        <g className="peak-mist">
          <ellipse cx="420" cy="286" rx="380" ry="52" />
          <ellipse cx="1080" cy="268" rx="330" ry="46" />
        </g>
        <g className="peak peak-mid">
          <path d="M0 360 C90 320 170 330 260 300 C340 273 400 292 480 268 C560 245 620 268 700 250 C790 230 850 258 940 240 C1030 222 1090 248 1180 232 C1270 216 1350 244 1440 226 L1440 460 L0 460 Z" />
        </g>
        <g className="peak peak-near">
          <path d="M0 420 C110 396 200 404 300 388 C390 373 460 392 560 380 C660 368 730 386 830 376 C930 366 1010 384 1110 374 C1210 364 1330 382 1440 368 L1440 460 L0 460 Z" />
        </g>
      </svg>
    </div>
  )
}
