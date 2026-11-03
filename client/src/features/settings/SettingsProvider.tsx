import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { applyTheme, applyThemeWithRipple, readPrefs, writePrefs, type ReaderPrefs } from './prefs'

/**
 * 阅读偏好的全局容器。
 *
 * 挂在 SessionProvider **外面**（见 main.tsx）：主题跟登录态无关，
 * 挂里面的话引导页和登录页吃不到，切到夜晚模式后进这些页面会突然变回白的。
 */

interface SettingsValue {
  prefs: ReaderPrefs
  setPrefs: (patch: Partial<ReaderPrefs>) => void
}

const Ctx = createContext<SettingsValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<ReaderPrefs>(readPrefs)

  /**
   * 用 useLayoutEffect 而不是 useEffect：后者要等浏览器绘制完才跑，
   * 夜晚模式下每次刷新都会先闪一下白底。
   */
  /** 这一轮主题变更已经交给墨滴过场去改了，别在这里抢先写 data-theme */
  const rippleRef = useRef(false)

  useLayoutEffect(() => {
    // 关键：View Transition 的旧快照是在这一帧之后才抓的，
    // 要是这里先把 data-theme 改了，旧快照就已经是暗色，圆推过去看不出边界
    if (rippleRef.current) {
      rippleRef.current = false
      return
    }
    applyTheme(prefs.theme)
  }, [prefs.theme])

  /* 落盘。放在 effect 里而不是 setState 的更新函数里 ——
     更新函数在 StrictMode 下会被调用两次，副作用不该写在那儿 */
  useEffect(() => {
    writePrefs(prefs)
  }, [prefs])

  /**
   * 换主题时墨团从哪儿晕开（B7）。记的是「上一次按下鼠标的位置」，
   * 因为点「夜晚」这个动作本身就是一次 pointerdown —— 到这里读到的正好是那一下。
   */
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('pointerdown', onDown, { passive: true, capture: true })
    return () => window.removeEventListener('pointerdown', onDown, { capture: true })
  }, [])

  const setPrefs = useCallback((patch: Partial<ReaderPrefs>) => {
    // 主题单独走「墨滴扩散」这条路：其余偏好不需要过场
    if (patch.theme) {
      const p = pointerRef.current
      rippleRef.current = applyThemeWithRipple(patch.theme, p?.x, p?.y)
    }
    setPrefsState((prev) => ({ ...prev, ...patch }))
  }, [])

  const value = useMemo(() => ({ prefs, setPrefs }), [prefs, setPrefs])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSettings(): SettingsValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSettings 必须在 SettingsProvider 内使用')
  return v
}
