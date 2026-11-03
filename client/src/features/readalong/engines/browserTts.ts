import { abortError, type SpeakOptions, type TtsEngine, type VoiceOption } from './types'

/**
 * 浏览器原生语音合成（降级路径）。
 *
 * 契约 §9.2：服务端合成失败时前端降级到这里，**不经过服务端**，直接调 Web Speech API。
 * 03 §1.3.1 明确它只能做句子级高亮（原生接口不返回字级时间戳），
 * 所以 realAudio = false，界面上要说明这一点。
 *
 * 各平台的中文音色差别很大，这里只做"能挑一个中文声音"的兜底，
 * 不做音色质量的保证 —— 音色质量由服务端引擎负责。
 */

function synth(): SpeechSynthesis | null {
  return typeof speechSynthesis !== 'undefined' ? speechSynthesis : null
}

function listZhVoices(): VoiceOption[] {
  const s = synth()
  if (!s) return []
  return s
    .getVoices()
    .filter((v) => v.lang?.toLowerCase().startsWith('zh'))
    .map((v) => ({ voice: v.voiceURI, label: v.name, lang: v.lang }))
}

/**
 * 一句话迟迟不开口的时间上限。
 *
 * Chrome 偶发把 `speak()` 吞掉：既不发 `start` 也不发 `end`，promise 就永远悬着。
 * 超过这个时间没听到动静，就当这句话没排上队，重排一次。
 */
const START_TIMEOUT_MS = 1600

/**
 * 估算朗读时长用的**保守**语速（字/秒）。
 *
 * 本机实测 Huihui 约 3.3 字/秒（rate=1），这里取 2.6 留足余量：
 * 宁可让看门狗晚一点收尾，也不能把正常的慢速朗读截断。
 */
const MIN_CHARS_PER_SEC = 2.6

/** 估算时长之外再留的冗余 */
const SETTLE_SLACK_MS = 3000

/* --------------------------------------------------------- 嗓音缓存 */

/**
 * 缓存与监听都放在**模块级**，不能挂在引擎实例上。
 *
 * 原来挂在实例上，结果是："（无可用音色）"那个 bug ——
 * Chrome 的 `getVoices()` **首次调用几乎总是返回空**，要等 `voiceschanged` 才有；
 * 而 `engines/index.ts` 的 `BROWSER_OPTION()` 每次新建一个实例、拷走当时的
 * voices 数组就把实例丢掉，`voiceschanged` 里回写的 `this.cachedVoices` 换的是
 * 一个没人再读的对象的字段 —— 拷出去的那份引用永远停在空数组，
 * 于是降级到浏览器原生时音色下拉框一直是空且 disabled，
 * 哪怕系统里明明装着中文嗓音（这台机器上就有 3 个）。
 */
let cachedVoices: VoiceOption[] = []
let voicesBound = false
/** 等着"嗓音到货"的回调，voiceschanged 一到就全部唤醒 */
const voiceWaiters: (() => void)[] = []

/**
 * 真实嗓音对象（voiceURI → SpeechSynthesisVoice）。
 *
 * 只存字符串 id 不够用 —— 这是"突然变成系统默认机器女声"的根因：
 * `getVoices()` 在刚 `cancel()` 完、`voiceschanged` 还没派发的瞬间会返回**空数组**，
 * 此时按 id 现场查必然查不到，`u.voice` 只能留空，浏览器于是拿默认嗓音去念。
 * 把对象本身缓存住，哪怕列表瞬时为空也照样能把选中的嗓音塞进 utterance。
 */
const realVoices = new Map<string, SpeechSynthesisVoice>()

function refreshVoices(): VoiceOption[] {
  const s = synth()
  if (!s) return cachedVoices
  for (const v of s.getVoices()) {
    if (v.voiceURI) realVoices.set(v.voiceURI, v)
  }
  const zh = listZhVoices()
  if (zh.length > 0) cachedVoices = zh
  return cachedVoices
}

/**
 * 把选中的音色 id 解析成真正的嗓音对象。
 *
 * 依次尝试：当前列表 → 缓存 → 第一个中文嗓音 → 列表第一个。
 * 后两级是兜底：万一读者选的嗓音被系统卸掉了，宁可换一个中文嗓音，
 * 也不要让浏览器用（很可能是英文的）默认嗓音去念中文。
 */
function resolveVoice(wanted: string): SpeechSynthesisVoice | null {
  const s = synth()
  if (!s) return null
  const live = s.getVoices()
  const pool = live.length > 0 ? live : Array.from(realVoices.values())
  const hit =
    (wanted ? pool.find((v) => v.voiceURI === wanted) : undefined) ??
    (wanted ? realVoices.get(wanted) : undefined) ??
    null
  if (hit) return hit
  return pool.find((v) => v.lang?.toLowerCase().startsWith('zh')) ?? pool[0] ?? null
}

function bindVoicesChanged(): void {
  if (voicesBound) return
  const s = synth()
  if (!s) return
  voicesBound = true
  s.addEventListener('voiceschanged', () => {
    refreshVoices()
    // 一次性唤醒：这一轮等的人都在等同一个事件
    while (voiceWaiters.length > 0) voiceWaiters.shift()?.()
  })
}

/**
 * 等浏览器把嗓音列表填上（已就绪则立刻返回）。
 *
 * 带超时兜底，**绝不吊死调用方** —— 万一某个浏览器压根不发 voiceschanged，
 * 宁可少几个音色可选，也不能让阅读界面卡在"正在加载"。
 */
export function whenBrowserVoicesReady(timeoutMs = 800): Promise<void> {
  if (!synth()) return Promise.resolve()
  bindVoicesChanged()
  if (refreshVoices().length > 0) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    voiceWaiters.push(finish)
    setTimeout(finish, timeoutMs)
  })
}

export class BrowserTtsEngine implements TtsEngine {
  readonly id = 'browser-native'
  readonly label = '浏览器原生（降级）'
  readonly realAudio = false

  get voices(): VoiceOption[] {
    bindVoicesChanged()
    return refreshVoices()
  }

  isSupported(): boolean {
    return synth() !== null
  }

  speak(text: string, opts: SpeakOptions, signal: AbortSignal): Promise<void> {
    const s = synth()
    if (!s) return Promise.reject(new Error('当前浏览器不支持语音合成'))
    const rate = clampRate(opts.rate)
    // 这句话"最多该念多久"：按保守语速估算，超了就是接口把 end 事件吞了
    const budget = Math.max(
      3000,
      Math.min(60000, (text.length / (MIN_CHARS_PER_SEC * rate)) * 1000 + SETTLE_SLACK_MS),
    )

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let started = false
      let retried = false
      /** 看门狗宽限过几次：宽限也有上限，否则卡死时又会永远等下去 */
      let overruns = 0
      let timer: ReturnType<typeof setTimeout> | null = null

      const clearTimer = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }

      const done = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimer()
        signal.removeEventListener('abort', onAbort)
        fn()
      }

      function onAbort() {
        s!.cancel()
        done(() => reject(abortError()))
      }

      /** 排一次队；重试时整条 utterance 重来（同一个对象不能重复 speak） */
      const queue = () => {
        started = false
        overruns = 0
        const u = new SpeechSynthesisUtterance(text)
        u.rate = rate
        u.lang = 'zh-CN'
        const real = resolveVoice(opts.voice)
        // 解析得到就一定塞进去：留空的话浏览器会用系统默认嗓音念中文，
        // 读者听到的就是"突然变成机器女声"
        if (real) u.voice = real

        u.onstart = () => {
          started = true
          clearTimer()
          timer = setTimeout(onTimeUp, budget)
        }
        /*
         * 每念到一个词就续命一次。
         *
         * 光靠"整句估算时长"会误伤：不同嗓音/不同机器念同一句话能差两三倍，
         * 一个长句念到一半被看门狗掐掉，听感比卡死更糟。心跳把"慢"和"卡死"分开：
         * 只要还在往外吐字，就一直等；吐不动了才收尾。
         */
        u.onboundary = () => {
          if (settled) return
          clearTimer()
          timer = setTimeout(onTimeUp, budget)
        }
        u.onend = () => done(resolve)
        u.onerror = (e) => {
          const r = String((e as SpeechSynthesisErrorEvent).error ?? '')
          if (signal.aborted) return done(() => reject(abortError()))
          // 被外部打断（换了句子、切了引擎）算这句话结束，交回上层继续推进，
          // 原来这里当失败抛出，上层一看是 AbortError 就静默 return，
          // 于是界面停在"正在播放"却再也没声音 —— 也就是「一句就停」
          if (r === 'interrupted' || r === 'canceled') return done(resolve)
          if (!started && !retried) {
            retried = true
            queue()
            return
          }
          done(() => reject(new Error(`语音合成失败：${r || '未知原因'}`)))
        }

        /*
         * 只在**真的在说话**时才清队列。
         *
         * 原来每次说话前无条件 `cancel()`：空闲时那一下无害，但一旦上一次的
         * utterance 还有残余，紧接着的 `speak()` 就会被同一次 cancel 打断，
         * 于是这一句不出声、end 事件也不来，整条跟读循环就此停摆。
         */
        if (s.speaking || s.pending) s.cancel()
        // Chrome 偶尔会停在 paused 状态，不 resume 的话后面 all speak 都不出声
        if (s.paused) s.resume()

        clearTimer()
        timer = setTimeout(onTimeUp, START_TIMEOUT_MS)
        s.speak(u)
      }

      const onTimeUp = () => {
        if (settled) return
        const busy = s.speaking || s.pending
        // 还在出声 / 还在排队：那只是比估算的慢，再给一轮，绝不截断正常朗读
        if (busy && overruns < 2) {
          overruns += 1
          timer = setTimeout(onTimeUp, started ? budget : START_TIMEOUT_MS)
          return
        }
        if (!started) {
          // 压根没开口：重排一次；再不行就跳过这句，别把整条循环挂死
          if (retried) return done(resolve)
          retried = true
          queue()
          return
        }
        // 引擎自己都不认为在念了，却始终没有 end —— 这就是"把事件吞了"
        s.cancel()
        done(resolve)
      }

      signal.addEventListener('abort', onAbort)
      queue()
    })
  }

  preload(): void {
    // 浏览器原生引擎没有可预取的音频，它本身就是即时的
  }

  stop(): void {
    synth()?.cancel()
  }
}

function clampRate(rate: number): number {
  // SpeechSynthesis 的 rate 合法区间是 0.1–10，超出会被忽略
  if (!Number.isFinite(rate)) return 1
  return Math.min(10, Math.max(0.1, rate))
}
