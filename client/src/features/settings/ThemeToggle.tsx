import { useSettings } from './SettingsProvider'

/**
 * 顶栏上的日间／夜间开关。
 *
 * 之前换主题的唯一入口藏在阅读器的「设置」抽屉里，书架、阅读时长、个人主页
 * 三个页面都进不去，等于把夜晚模式藏起来了。这里做成一颗小铜钮摆在顶栏。
 *
 * 换主题那一下的墨滴扩散不在这里管 —— SettingsProvider 的 setPrefs
 * 已经接住 theme 的变更，会自动从鼠标按下的位置晕开。
 */
export default function ThemeToggle() {
  const { prefs, setPrefs } = useSettings()
  const dark = prefs.theme === 'dark'
  const label = dark ? '切到日间模式' : '切到夜间模式'

  return (
    <button
      type="button"
      className={'theme-toggle' + (dark ? ' is-dark' : '')}
      onClick={() => setPrefs({ theme: dark ? 'light' : 'dark' })}
      title={label}
      aria-label={label}
      aria-pressed={dark}
    >
      <span className="theme-toggle-track" aria-hidden="true">
        <span className="theme-toggle-thumb">
          {/* 日头与月亮叠在铜钮里，随主题旋转互换 */}
          <span className="theme-toggle-sun" />
          <span className="theme-toggle-moon" />
        </span>
      </span>
    </button>
  )
}
