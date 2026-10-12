import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { applyTheme, readPrefs, writePrefs, type ReaderPrefs } from './prefs'

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
  useLayoutEffect(() => {
    applyTheme(prefs.theme)
  }, [prefs.theme])

  /* 落盘。放在 effect 里而不是 setState 的更新函数里 ——
     更新函数在 StrictMode 下会被调用两次，副作用不该写在那儿 */
  useEffect(() => {
    writePrefs(prefs)
  }, [prefs])

  const setPrefs = useCallback((patch: Partial<ReaderPrefs>) => {
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
