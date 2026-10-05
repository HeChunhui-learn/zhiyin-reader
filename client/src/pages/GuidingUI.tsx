import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

interface Slide {
  title: string
  subtitle: string
  accent: string
  cards: { icon: string; title: string; desc: string }[]
}

const SLIDES: Slide[] = [
  {
    title: '知音漫卷',
    subtitle: '把插图放回文字里，把朗读对上句子',
    accent: '#3B6EA5',
    cards: [
      { icon: '🖼', title: '图文一体', desc: '插图内联在引用位置，滚动到才加载' },
      { icon: '🎧', title: '逐句跟读', desc: '读一句、亮一句，位置永远对得上' },
      { icon: '🔖', title: '书签定位', desc: '随手标记，回到上次读的地方' },
    ],
  },
  {
    title: '视听同步',
    subtitle: '听一句，看一句',
    accent: '#7C5CBF',
    cards: [
      { icon: '⏱', title: '句子级切分', desc: '按中文标点切句，索引稳定' },
      { icon: '🔊', title: '语音合成', desc: '默认本地引擎，可切换云端音色' },
      { icon: '🎚', title: '播放控制', desc: '语速、音色、上下一句随手切换' },
    ],
  },
  {
    title: '多端续读',
    subtitle: '换设备，接着读',
    accent: '#3E8E6E',
    cards: [
      { icon: '☁️', title: '进度同步', desc: '阅读位置在多端之间保持一致' },
      { icon: '🧩', title: '冲突保留', desc: '两端改同一处时，两份都留下' },
      { icon: '📶', title: '离线可用', desc: '断网继续读，联网自动补报' },
    ],
  },
]

export default function GuidingUI() {
  const [index, setIndex] = useState(0)
  const navigate = useNavigate()
  const pointerStart = useRef<number | null>(null)
  const slide = SLIDES[index]

  const go = (next: number) => {
    setIndex(Math.max(0, Math.min(SLIDES.length - 1, next)))
  }

  return (
    <div className="guide-page">
      <div className="guide-stage" style={{ ['--accent' as string]: slide.accent }}>
        <h1 className="guide-title">{slide.title}</h1>
        <p className="guide-subtitle">{slide.subtitle}</p>

        <div
          className="guide-figure"
          onPointerDown={(e) => {
            pointerStart.current = e.clientX
          }}
          onPointerUp={(e) => {
            if (pointerStart.current === null) return
            const dx = e.clientX - pointerStart.current
            pointerStart.current = null
            if (Math.abs(dx) > 60) go(index + (dx < 0 ? 1 : -1))
          }}
        >
          <span>{slide.cards[0].icon}</span>
        </div>

        <div className="guide-cards">
          {slide.cards.map((c) => (
            <div className="guide-card" key={c.title}>
              <div className="guide-card-icon">{c.icon}</div>
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
              onClick={() => go(i)}
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
    </div>
  )
}
