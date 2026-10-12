import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Sentence } from './splitSentences'
import {
  createEngine,
  isAbort,
  loadEngines,
  type EngineOption,
  type EnginesLoadResult,
  type TtsEngine,
} from './engines'
import { readReadAlongPrefs, writeReadAlongPrefs } from './readAlongPrefs'

/**
 * 逐句跟读的编排。
 *
 * 核心是一条循环：**念完一句才推进游标**。
 * R0–R3 用的是 setInterval 假推进，这里换成由引擎的"播放结束"事件驱动，
 * 所以"高亮位置与音频严格对应"这条验收要求才真正成立。
 *
 * 预加载、缓存、降级都在引擎里，这里只管游标与状态。
 */

export interface ReadAlongApi {
  /** 引擎清单是否已就绪 */
  ready: boolean
  playing: boolean
  cursor: number
  /** 是否处于"自动滚动跟随"状态；读者手动点过句子后为 false */
  autoScroll: boolean
  error: string
  rate: number
  voice: string
  engineId: string
  engineOptions: EngineOption[]
  /** 可选的音色 */
  voiceOptions: EngineOption['voices']
  /**
   * 界面渲染用的完整音色目录，**含本机没装的**（available=false，置灰）。
   * 契约 §9.4：让读者分得清"这个引擎没这个音色"和"我还没装这个离线包"。
   */
  voiceCatalog: EngineOption['voices']
  /** 当前引擎是否有真实音频事件（false = 浏览器原生降级） */
  realAudio: boolean
  /** 服务端有引擎但不可用，界面上要说明为什么降级了 */
  degraded: boolean

  toggle: () => void
  pause: () => void
  seek: (index: number) => void
  prev: () => void
  next: () => void
  /** 从当前位置继续，并恢复自动滚动 */
  resume: () => void
  /** 只停自动滚动，不动游标（目录跳转用） */
  stopAutoScroll: () => void
  setRate: (r: number) => void
  setVoice: (v: string) => void
  setEngine: (id: string) => void
}

export function useReadAlong(docId: string, sentences: Sentence[]): ReadAlongApi {
  /** 上次用的引擎/音色/语速，只在挂载时读一次；之后以 state 为准 */
  const stored = useMemo(readReadAlongPrefs, [])

  const [engines, setEngines] = useState<EnginesLoadResult | null>(null)
  const [engineId, setEngineId] = useState('')
  // 初值取上次用的音色/语速（R7-1）；state 名保持 setRateState，
  // 因为对外暴露的 setRate 是下面那个 useCallback（C3）
  const [voice, setVoice] = useState(stored.voice)
  const [rate, setRateState] = useState(stored.rate)
  const [playing, setPlaying] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)
  const [error, setError] = useState('')
  /** 每次"跳转/重播"都 +1，让播放循环从新位置重启 */
  const [runId, setRunId] = useState(0)

  /**
   * C3：语速走 ref，**不进播放循环的依赖数组**。
   *
   * 旧写法把 rate 放进依赖数组，于是改一次语速就 abort + stop + 从游标处
   * 重启循环，当前句被打断从头念。现在：
   *   · 正在播的那一句已按旧语速合成完毕，让它念完（不打断）
   *   · 循环里每次 speak() / preload() 都现读 rateRef.current，
   *     所以新语速从**下一句**开始生效
   */
  const rateRef = useRef(rate)

  const cursorRef = useRef(0)
  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  /* ---- 引擎清单 ---- */
  useEffect(() => {
    let alive = true
    void loadEngines().then((res) => {
      if (!alive) return
      setEngines(res)
      // 上次用的引擎这次还在，就接着用；不在（换机器、离线包卸了）才退回默认
      setEngineId(
        res.options.some((o) => o.id === stored.engineId) ? stored.engineId : res.defaultId,
      )
    })
    return () => {
      alive = false
    }
  }, [stored])

  const engineOptions = engines?.options ?? []
  const currentOption = engineOptions.find((o) => o.id === engineId)
  const voiceOptions = currentOption?.voices ?? []
  const voiceCatalog = currentOption?.voiceCatalog ?? []

  /* 换引擎后如果原来的音色不在新引擎里，退到第一个 */
  useEffect(() => {
    if (!currentOption) return
    if (currentOption.voices.some((v) => v.voice === voice)) return
    setVoice(currentOption.voices[0]?.voice ?? '')
  }, [currentOption, voice])

  /* 记住选择，下次进阅读界面不用重挑。voice 为空说明清单还没落定，先别写 */
  useEffect(() => {
    if (!engineId || !voice) return
    writeReadAlongPrefs({ engineId, voice, rate })
  }, [engineId, voice, rate])

  const engine: TtsEngine | null = useMemo(
    () => (engineId ? createEngine(engineId, docId, engineOptions) : null),
    // engineOptions 只在引擎清单变化时换身份，这里不会反复重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engineId, docId, engines],
  )

  /* 引擎被替换时停掉旧的 */
  useEffect(() => {
    return () => {
      engine?.stop()
    }
  }, [engine])

  /* ---- 播放循环：念完一句推进一步 ---- */
  useEffect(() => {
    if (!playing || !engine || sentences.length === 0) return

    const ac = new AbortController()
    const start = cursorRef.current

    void (async () => {
      for (let i = start; i < sentences.length; i++) {
        if (ac.signal.aborted) return

        try {
          await engine.speak(
            sentences[i].text,
            { voice, rate: rateRef.current },
            ac.signal,
          )
        } catch (e) {
          if (ac.signal.aborted || isAbort(e)) return
          setError(e instanceof Error ? e.message : '朗读失败，请重试。')
          setPlaying(false)
          return
        }

        if (ac.signal.aborted) return

        // 念完最后一句后游标要停在最后一句上，不能越过末尾 —— 否则计数会显示
        // "第 N+1 / N 句"，高亮也会整个消失
        const nextIdx = Math.min(i + 1, sentences.length - 1)
        cursorRef.current = nextIdx
        setCursor(nextIdx)
        setError('')

        // 提前合成后面几句，减少句间停顿（04 §4.1.4：不少于 2 句）
        if (i + 1 < sentences.length) {
          engine.preload(
            sentences.slice(i + 1, i + 4).map((s) => s.text),
            { voice, rate: rateRef.current },
          )
        }
      }
      // 全文念完
      if (!ac.signal.aborted) setPlaying(false)
    })()

    return () => {
      ac.abort()
      engine.stop()
    }
    // 注意：rate 刻意不在依赖里（C3）—— 改语速不重启循环，从下一句生效。
    // 改引擎/音色仍然会重启，那是有意的：换了声音就该立刻听到新声音。
  }, [playing, runId, engine, voice, sentences])

  /* ---- 对外操作 ---- */

  const pause = useCallback(() => setPlaying(false), [])

  /**
   * 改语速（C3）：只写 ref + 刷新界面状态，**不触碰播放循环**。
   * 先写 ref 是关键 —— 正在跑的那次循环下一次调 speak() 就能读到新值，
   * 而当前这句不受影响。
   */
  const setRate = useCallback((r: number) => {
    rateRef.current = r
    setRateState(r)
  }, [])

  const seek = useCallback(
    (index: number) => {
      if (sentences.length === 0) return
      const clamped = Math.max(0, Math.min(sentences.length - 1, index))
      cursorRef.current = clamped
      setCursor(clamped)
      setRunId((n) => n + 1) // 正在播的话，循环从新位置重启
    },
    [sentences.length],
  )

  const toggle = useCallback(() => {
    setError('')
    setAutoScroll(true)
    setPlaying((p) => {
      if (!p) setRunId((n) => n + 1)
      return !p
    })
  }, [])

  /** 读者手动接管：停在当前句，暂停自动滚动 */
  const holdAt = useCallback(
    (index: number) => {
      setAutoScroll(false)
      seek(index)
    },
    [seek],
  )

  const resume = useCallback(() => {
    setAutoScroll(true)
    setRunId((n) => n + 1)
    setPlaying(true)
  }, [])

  const stopAutoScroll = useCallback(() => setAutoScroll(false), [])

  const changeEngine = useCallback((id: string) => {
    setEngineId(id)
    setError('')
    setPlaying(false)
  }, [])

  return {
    ready: engines !== null,
    playing,
    cursor,
    autoScroll,
    error,
    rate,
    voice,
    engineId,
    engineOptions,
    voiceOptions,
    voiceCatalog,
    realAudio: currentOption?.realAudio ?? false,
    degraded: engines?.serverEngineDown ?? false,

    toggle,
    pause,
    seek: holdAt,
    prev: () => holdAt(cursorRef.current - 1),
    next: () => holdAt(cursorRef.current + 1),
    resume,
    stopAutoScroll,
    setRate,
    setVoice,
    setEngine: changeEngine,
  }
}
