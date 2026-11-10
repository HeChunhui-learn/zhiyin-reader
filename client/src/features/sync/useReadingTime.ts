import { useEffect, useRef } from 'react'
import { api, apiUrl } from '../../api/client'
import { appVersionHeader } from '../../api/appVersion'
import { authStore } from '../../api/authStore'
import { getDeviceId } from '../../api/device'
import { clearPending, enqueuePending, listPending } from './pendingQueue'

/**
 * 阅读时长统计（R7-5）。
 *
 * 只统计**页面可见且窗口聚焦**的时长 —— 挂着标签页去吃饭不该算读书。
 *
 * 两条关键设计：
 *
 * 1. `commit()` 把当前这一段**折进累计值**而不是丢弃。这样
 *    `visibilitychange`→hidden 与 `pagehide` 双双触发时天然幂等
 *    （第二次进来 activeSince 已经是 null，加不进去），
 *    反复切窗口回来也不会重复计。
 *
 * 2. 卸载路径上必须 `commit()` **之后立刻** `keepalive` 发一次。
 *    只靠 30 秒定时器的话，读 25 秒就关页面会记成 0 —— 这是这类统计
 *    最常见的错法，而且不会报错，只是数字一直偏小。
 *
 * 刻意**不**挂在 useProgress 的 beacon 上：那个在 latest.current 为空时
 * 直接返回（没滚动过就不发），恰好漏掉"打开书静静地读"这种最该统计的情况；
 * 而且它的上报是"滚动后防抖 1500ms"，阅读时长根本没有触发点。
 */

/** 攒够这么多未上报的时长就发一次 */
const FLUSH_THRESHOLD_MS = 60_000

/** 兜底轮询间隔：上面那些事件一个都没触发时（比如标签页被强杀），最多丢一个间隔的量 */
const TICK_MS = 30_000

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '')
  }
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
}

/** 可见且聚焦才算在读 */
function isActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function useReadingTime(docId: string, enabled: boolean): void {
  const activeSinceRef = useRef<number | null>(null)
  const unsentMsRef = useRef(0)
  const segmentStartRef = useRef<string>('')
  /** 同一批数据只允许有一个上报在飞，避免并发把同一段重复写两次 */
  const inflightRef = useRef(false)

  useEffect(() => {
    if (!enabled || !docId) return

    const deviceId = getDeviceId()
    const userId = authStore.userId

    /** 把正在跑的这一段折进累计值；没在跑就是空操作 */
    const commit = () => {
      const now = Date.now()
      if (activeSinceRef.current === null) return
      unsentMsRef.current += now - activeSinceRef.current
      activeSinceRef.current = isActive() ? now : null
    }

    const flush = (keepalive = false) => {
      const ms = unsentMsRef.current
      if (ms < 1000) return // 不足 1 秒不值得发
      if (inflightRef.current && !keepalive) return

      const now = Date.now()
      const body = {
        deviceId,
        clientId: uuid(),
        durationMs: Math.round(ms),
        startedAt: segmentStartRef.current || new Date(now - ms).toISOString(),
        endedAt: new Date(now).toISOString(),
      }
      // 先记下要发的量：成功后再扣，中途失败也不会把它悄悄抹掉
      unsentMsRef.current = 0
      segmentStartRef.current = ''

      if (keepalive) {
        // 页面正在卸载，普通 fetch 会被掐断
        try {
          void fetch(apiUrl(`/documents/${docId}/reading-time`), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(authStore.access ? { Authorization: `Bearer ${authStore.access}` } : {}),
              ...appVersionHeader(),
            },
            body: JSON.stringify(body),
            keepalive: true,
          }).then((response) => {
            if (!response.ok) throw new Error('上报失败，稍后重试')
          }).catch(() => {
            void enqueuePending(docId, 'readingTime', body, userId)
          })
        } catch {
          void enqueuePending(docId, 'readingTime', body, userId)
        }
        return
      }

      inflightRef.current = true
      api
        .postReadingTime(docId, body)
        .catch(() => {
          // 失败只入队一次，沿用 clientId 补报，不能再折回下一批重复累计
          void enqueuePending(docId, 'readingTime', body, userId)
        })
        .finally(() => {
          inflightRef.current = false
        })
    }

    if (isActive()) {
      activeSinceRef.current = Date.now()
      segmentStartRef.current = new Date().toISOString()
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (activeSinceRef.current === null) {
          activeSinceRef.current = Date.now()
          segmentStartRef.current = new Date().toISOString()
        }
      } else {
        commit()
        flush(true)
      }
    }

    const onBlur = () => {
      commit()
    }
    const onFocus = () => {
      if (activeSinceRef.current === null) {
        activeSinceRef.current = Date.now()
        segmentStartRef.current = new Date().toISOString()
      }
    }

    const onHide = () => {
      commit()
      flush(true)
    }

    /**
     * 补报上次没发出去的那些段。
     *
     * 这些条目不会进 §8 的批量同步（takePendingProgress 按 kind 过滤掉了），
     * 所以必须自己捞回来，否则它们会永远躺在队列里。
     * client_id 是同一个，服务端的唯一索引会把重复的挡掉，补报是安全的。
     */
    const replayPending = async () => {
      const queued = (await listPending(userId, docId)).filter((p) => p.kind === 'readingTime')
      if (queued.length === 0) return
      const done: string[] = []
      for (const q of queued) {
        try {
          await api.postReadingTime(docId, q.payload as Parameters<typeof api.postReadingTime>[1])
          done.push(q.id)
        } catch {
          // 还是发不出去就先留着，下次进阅读界面再试
          break
        }
      }
      if (done.length) await clearPending(done)
    }
    void replayPending()

    const timer = window.setInterval(() => {
      commit()
      if (unsentMsRef.current >= FLUSH_THRESHOLD_MS) flush()
    }, TICK_MS)

    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVisibility)
      // 离开阅读界面也要把最后一段交出去，否则每次读完就丢一截
      commit()
      flush(true)
    }
  }, [docId, enabled])
}
