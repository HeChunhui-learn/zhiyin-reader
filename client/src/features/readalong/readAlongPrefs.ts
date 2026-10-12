/**
 * 跟读偏好（引擎 / 音色 / 语速）的本地记忆。
 *
 * 存 localStorage 而不是 IndexedDB —— 就三个短值，同步读写最省事，
 * 键名沿用项目里 zhiyin. 前缀的惯例（另两个是 zhiyin.refreshToken、zhiyin.deviceId）。
 *
 * 读的时候必须容错：里面可能是先前版本写的、也可能被手改坏，
 * 解析失败一律当作"没存过"，**绝不能把异常抛进渲染**（CLAUDE.md §七.4 不许白屏）。
 */

const KEY = 'zhiyin.readAlongPrefs'

/** 合法语速区间，与服务端 routes/tts.ts 的 MIN_RATE / MAX_RATE 保持一致 */
const MIN_RATE = 0.5
const MAX_RATE = 2.0

export interface ReadAlongPrefs {
  engineId: string
  voice: string
  rate: number
}

export const DEFAULT_PREFS: ReadAlongPrefs = { engineId: '', voice: '', rate: 1 }

export function readReadAlongPrefs(): ReadAlongPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_PREFS
    const o = JSON.parse(raw) as Partial<ReadAlongPrefs> | null
    if (!o || typeof o !== 'object') return DEFAULT_PREFS

    const rate =
      typeof o.rate === 'number' && Number.isFinite(o.rate) && o.rate >= MIN_RATE && o.rate <= MAX_RATE
        ? o.rate
        : DEFAULT_PREFS.rate

    return {
      engineId: typeof o.engineId === 'string' ? o.engineId : '',
      voice: typeof o.voice === 'string' ? o.voice : '',
      rate,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function writeReadAlongPrefs(p: ReadAlongPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // 隐私模式下 localStorage 可能直接抛。记不住偏好不影响跟读本身，静默放过
  }
}
