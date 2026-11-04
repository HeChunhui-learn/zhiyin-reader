import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppLogo from '../features/brand/AppLogo'
import LineIcon, { type LineIconName } from '../features/brand/LineIcon'
import InkField from '../features/motion/InkField'
import InkBrush from '../features/motion/InkBrush'
import InkSeal from '../features/motion/InkSeal'
import InkText from '../features/motion/InkText'
import GuidePeaks from '../features/motion/GuidePeaks'
import { hasFinePointer } from '../features/motion/motionEnv'
import guideMountain from '../assets/guide-mountain.jpg'

interface Slide {
  title: string
  subtitle: string
  accent: string
  cards: { icon: LineIconName; title: string; desc: string }[]
}

const SLIDES: Slide[] = [
  {
    title: '知音漫卷',
    subtitle: '把插图放回文字里，把朗读对上句子',
    accent: '#3B6EA5',
    cards: [
      { icon: 'image', title: '图文一体', desc: '插图内联在引用位置，滚动到才加载' },
      { icon: 'headphones', title: '逐句跟读', desc: '读一句、亮一句，位置永远对得上' },
      { icon: 'bookmark', title: '书签定位', desc: '随手标记，回到上次读的地方' },
    ],
  },
  {
    title: '视听同步',
    subtitle: '听一句，看一句',
    accent: '#7C5CBF',
    cards: [
      { icon: 'clock', title: '句子级切分', desc: '按中文标点切句，索引稳定' },
      { icon: 'headphones', title: '语音合成', desc: '默认本地引擎，可切换云端音色' },
      { icon: 'sliders', title: '播放控制', desc: '语速、音色、上下一句随手切换' },
    ],
  },
  {
    title: '多端续读',
    subtitle: '换设备，接着读',
    accent: '#3E8E6E',
    cards: [
      { icon: 'cloud', title: '进度同步', desc: '阅读位置在多端之间保持一致' },
      { icon: 'puzzle', title: '冲突保留', desc: '两端改同一处时，两份都留下' },
      { icon: 'wifi', title: '离线可用', desc: '断网继续读，联网自动补报' },
    ],
  },
]

export default function GuidingUI() {
  const [index, setIndex] = useState(0)
  // 切页时从这一处晕开的一团墨（A4）。key 换一次就重播一遍
  const [blot, setBlot] = useState<{ x: number; y: number; key: number } | null>(null)
  const navigate = useNavigate()
  const pageRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const pointerStart = useRef<number | null>(null)
  /**
   * 手机上不挂墨迹层：
   * 手指没有「悬停」，墨点阵、拖墨、山景视差都不会被真正用到，
   * 却要一直占着 canvas 和指针监听。挂载前就判断，干脆一个都不建。
   */
  const finePointer = hasFinePointer()
  const slide = SLIDES[index]

  /** 把视口坐标换算成页面内坐标，墨团才知道该从哪儿晕开 */
  const localOf = (clientX: number, clientY: number) => {
    const rect = pageRef.current?.getBoundingClientRect()
    if (!rect) return undefined
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  const goTo = (next: number, origin?: { x: number; y: number }) => {
    const target = Math.max(0, Math.min(SLIDES.length - 1, next))
    if (target === index) return
    const rect = pageRef.current?.getBoundingClientRect()
    setBlot({
      x: origin ? origin.x : rect ? rect.width * 0.5 : 0,
      y: origin ? origin.y : rect ? rect.height * 0.42 : 0,
      key: Date.now(),
    })
    setIndex(target)
  }

  /**
   * 纸面轻颤（A2）：直接改 DOM 的类，而不是走 state ——
   * 连着点两下时，remove → 强制回流 → add 能把动画从头再放一遍，
   * 用 state 做不到（值没变，React 不会重新挂类）。
   */
  const shake = () => {
    const el = stageRef.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.classList.remove('is-quake')
    void el.offsetWidth
    el.classList.add('is-quake')
  }

  const onPagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 只认左键和真实触点：右键菜单、拖选文字都不该让纸抖
    if (e.button !== 0) return
    shake()
  }

  return (
    <div className="guide-page" ref={pageRef} onPointerDown={onPagePointerDown}>
      {/* 宣纸上的墨点阵：跟着光标浮起来，切页时也只画这一层。
          触屏设备不挂：没有光标可跟，白白整屏重绘 */}
      {finePointer && <InkField className="guide-field" />}
      {/* 三层墨山：鼠标一动就按不同速度错位 */}
      {finePointer && <GuidePeaks className="guide-peaks" />}
      {/* 纸面的光：斜射暖光、暗角、极淡纸纹（都是静态层） */}
      <div className="guide-light" aria-hidden="true" />
      <div className="guide-vignette" aria-hidden="true" />
      <div className="guide-grain" aria-hidden="true" />

      {/* 进页面时盖下的一方大印，随后退成角落里的水印（A8） */}
      <div className="guide-seal-big" aria-hidden="true">
        <span className="guide-seal-ripple" />
        <InkSeal text="知音漫卷" delay={260} />
      </div>

      <div className="guide-stage" ref={stageRef} style={{ ['--accent' as string]: slide.accent }}>
        <div className="guide-emblem">
          <span className="guide-emblem-halo" aria-hidden="true" />
          <AppLogo size={46} />
        </div>

        {/* key 挂着页序号：切页时整个重挂，描字动画自然从头播一遍 */}
        <h1 className="guide-title">
          <InkText key={`title-${index}`} text={slide.title} stagger={130} duration={560} />
        </h1>

        <p className="guide-subtitle" key={`sub-${index}`}>{slide.subtitle}</p>

        <div
          className="guide-figure"
          onPointerDown={(e) => {
            pointerStart.current = e.clientX
          }}
          onPointerUp={(e) => {
            if (pointerStart.current === null) return
            const dx = e.clientX - pointerStart.current
            pointerStart.current = null
            if (Math.abs(dx) > 60) goTo(index + (dx < 0 ? 1 : -1), localOf(e.clientX, e.clientY))
          }}
        >
          <img
            className="guide-figure-photo"
            src={guideMountain}
            alt="云雾中的群山"
            draggable={false}
          />
          <div className="guide-figure-shade" aria-hidden="true" />
          <div className="guide-figure-badge">
            <LineIcon name={slide.cards[0].icon} size={26} />
          </div>
          <InkSeal className="guide-seal" text="知音" delay={180} />
          <span className="guide-figure-hint" aria-hidden="true">拖动切换</span>
        </div>

        <div className="guide-cards" key={`cards-${index}`}>
          {slide.cards.map((c, i) => (
            <div
              className="guide-card"
              key={c.title}
              style={{ animationDelay: `${90 + i * 90}ms` }}
            >
              <div className="guide-card-icon"><LineIcon name={c.icon} size={21} /></div>
              <div className="guide-card-title">{c.title}</div>
              <div className="guide-card-desc">{c.desc}</div>
            </div>
          ))}
        </div>

        <div className="guide-dots">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              className={'guide-dot' + (i === index ? ' active' : '')}
              aria-label={`第 ${i + 1} 页`}
              onClick={(e) => goTo(i, localOf(e.clientX, e.clientY))}
            />
          ))}
        </div>

        <div className="guide-actions">
          <button className="btn btn-primary" onClick={() => navigate('/login')}>
            开始使用
          </button>
          <button className="btn btn-ghost" onClick={() => navigate('/shelf')}>
            直接登录
          </button>
        </div>

        <p className="guide-hint">左右滑动或点击圆点切换引导页</p>
      </div>

      {/* 毛笔拖墨 + 墨滴，盖在最上层，半透明不挡读（触屏不挂，见上） */}
      {finePointer && <InkBrush className="guide-brush" trail splash />}

      {/* 切页的一团墨：key 变了就重新挂，动画从头播 */}
      {blot && (
        <span
          key={blot.key}
          className="guide-blot"
          aria-hidden="true"
          style={{ left: blot.x, top: blot.y }}
        />
      )}
    </div>
  )
}
