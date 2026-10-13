import { useRef } from 'react'
import {
  FONT_SIZES,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type Layout,
  type PageTurn,
  type ReaderPrefs,
  type ReaderTheme,
} from '../features/settings/prefs'

/**
 * 阅读设置面板（R7-3）。
 *
 * 只管展示与回调，状态与落盘都在 features/settings 里 ——
 * 这样主题、字号这些在阅读界面之外也拿得到，不必从一个页面组件里往外套。
 */

interface Props {
  prefs: ReaderPrefs
  setPrefs: (patch: Partial<ReaderPrefs>) => void
  bgName: string
  bgError: string
  onPickBackground: (file: File) => void
  onClearBackground: () => void
  onClose: () => void
}

const THEMES: { value: ReaderTheme; label: string }[] = [
  { value: 'light', label: '白天' },
  { value: 'dark', label: '夜晚' },
]

const LAYOUTS: { value: Layout; label: string; hint: string }[] = [
  { value: 'scroll', label: '纵向滚动', hint: '像网页一样上下滚动' },
  { value: 'paged', label: '横向分页', hint: '正文按屏幕高度切成页，左右翻页' },
]

const PAGE_TURNS: { value: PageTurn; label: string; hint: string }[] = [
  { value: 'slide', label: '左右平移', hint: '翻页时正文横向平移过渡' },
  { value: 'snap', label: '整屏跳转', hint: '翻页时直接切到下一页，没有过渡' },
]

export default function ReaderSettingsPanel({
  prefs,
  setPrefs,
  bgName,
  bgError,
  onPickBackground,
  onClearBackground,
  onClose,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)

  /** 字号按档位表走，不直接加减 2 —— 免得手改出来的值落不到档位上 */
  const stepFont = (dir: -1 | 1) => {
    const i = (FONT_SIZES as readonly number[]).indexOf(prefs.fontSize)
    const at = i < 0 ? (FONT_SIZES as readonly number[]).indexOf(16) : i
    const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, at + dir))]
    if (next !== undefined) setPrefs({ fontSize: next })
  }

  return (
    <aside className="toc-panel drawer-right">
      <div className="toc-head toc-head-row">
        <span>阅读设置</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          收起
        </button>
      </div>

      <div className="set-group">
        <div className="set-label">主题</div>
        <div className="set-seg">
          {THEMES.map((t) => (
            <button
              key={t.value}
              className={prefs.theme === t.value ? 'on' : ''}
              onClick={() => setPrefs({ theme: t.value })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="set-group">
        <div className="set-label">
          字号
          <span className="set-value">{prefs.fontSize}px</span>
        </div>
        <div className="set-seg">
          <button onClick={() => stepFont(-1)} disabled={prefs.fontSize <= MIN_FONT_SIZE}>
            A－
          </button>
          <button onClick={() => stepFont(1)} disabled={prefs.fontSize >= MAX_FONT_SIZE}>
            A＋
          </button>
        </div>
      </div>

      <div className="set-group">
        <div className="set-label">阅读版面</div>
        <div className="set-seg">
          {LAYOUTS.map((m) => (
            <button
              key={m.value}
              className={prefs.layout === m.value ? 'on' : ''}
              title={m.hint}
              onClick={() => setPrefs({ layout: m.value })}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="set-note">
          {LAYOUTS.find((m) => m.value === prefs.layout)?.hint}
          。滚轮与键盘在两种版面下都能用。
        </p>
      </div>

      <div className="set-group">
        <div className="set-label">翻页方式</div>
        <div className="set-seg">
          {PAGE_TURNS.map((m) => (
            <button
              key={m.value}
              className={prefs.pageTurn === m.value ? 'on' : ''}
              title={m.hint}
              onClick={() => setPrefs({ pageTurn: m.value })}
              // 置灰而不是隐藏：选择留着，切回横向分页时不用重新选一遍
              disabled={prefs.layout !== 'paged'}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="set-note">
          {prefs.layout === 'paged'
            ? PAGE_TURNS.find((m) => m.value === prefs.pageTurn)?.hint
            : '仅在「横向分页」版面下生效。'}
        </p>
      </div>

      <div className="set-group">
        <div className="set-label">阅读背景</div>
        <div className="set-seg">
          <button onClick={() => fileRef.current?.click()}>选择图片</button>
          <button onClick={onClearBackground} disabled={!prefs.bgImageId}>
            移除
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) onPickBackground(f)
          }}
        />
        {bgError ? (
          <p className="set-note set-note-err">{bgError}</p>
        ) : (
          <p className="set-note">
            {prefs.bgImageId ? `当前：${bgName || '已设置'}` : '未设置背景图，用默认底色。'}
          </p>
        )}
        <p className="set-note">背景图只存在这台设备的浏览器里，不会上传。</p>
      </div>
    </aside>
  )
}
