import { abortError } from './engines/types'

/**
 * 音频播放器。
 *
 * docs/system-design.md §6.3 的设计要求：
 *   · **全程复用同一个音频元素**，避免重复创建带来的解码器初始化开销与资源泄漏
 *   · 播放的是压缩音频（不是 Web Audio 解码后的采样数据），播完释放对象地址
 *
 * 所以这里只持有一个 <audio>，每次播放换 src；播放结束或被打断立刻 revoke 上一个 URL。
 */
export class AudioPlayer {
  private el: HTMLAudioElement | null = null
  private url: string | null = null
  /** 当前这次播放的收尾函数，幂等；同一时刻最多一个 */
  private settle: ((e?: Error) => void) | null = null

  private ensure(): HTMLAudioElement {
    if (!this.el) {
      // 用 createElement 而不是 new Audio()：后者依赖全局 Audio 构造函数，
      // 不是所有环境都有（jsdom 就没有），createElement 到处都成立
      const el = document.createElement('audio')
      el.preload = 'auto'
      this.el = el
    }
    return this.el
  }

  /** 播放一段音频，播完 resolve；被 signal 打断或调 stop() 时 reject(AbortError) */
  play(blob: Blob, signal: AbortSignal): Promise<void> {
    // 先把上一次结掉，否则那条 promise 会一直悬着
    this.stop()

    return new Promise<void>((resolve, reject) => {
      const el = this.ensure()
      const url = URL.createObjectURL(blob)
      this.url = url

      let done = false
      const settle = (err?: Error) => {
        if (done) return
        done = true
        el.removeEventListener('ended', onEnded)
        el.removeEventListener('error', onError)
        signal.removeEventListener('abort', onAbort)
        // 播完即释放对象地址；IndexedDB 里的副本还在，下次还能取
        URL.revokeObjectURL(url)
        if (this.url === url) this.url = null
        if (this.settle === settle) this.settle = null
        if (err) reject(err)
        else resolve()
      }
      this.settle = settle

      const onEnded = () => settle()
      const onError = () =>
        settle(new Error('音频播放失败，可能是不支持的音频格式'))
      const onAbort = () => {
        try {
          el.pause()
        } catch {
          /* 元素可能还没加载 */
        }
        settle(abortError())
      }

      el.addEventListener('ended', onEnded)
      el.addEventListener('error', onError)
      signal.addEventListener('abort', onAbort)

      el.src = url
      void el.play().catch((e) => {
        settle(e instanceof Error ? e : new Error('音频播放被浏览器拒绝'))
      })
    })
  }

  /** 立即停止；正在等待的 play() 会收到 AbortError */
  stop(): void {
    if (this.el) {
      try {
        this.el.pause()
      } catch {
        /* 忽略 */
      }
    }
    this.settle?.(abortError())
  }

  dispose(): void {
    this.stop()
    if (this.el) {
      this.el.src = ''
      this.el = null
    }
  }
}
