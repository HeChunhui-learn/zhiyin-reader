import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  api,
  apiUrl,
  type Anchor,
  type ConflictEnvelope,
  type ProgressItem,
} from '../../api/client'
import { appVersionHeader } from '../../api/appVersion'
import { authStore } from '../../api/authStore'
import { getDeviceId } from '../../api/device'
import { compareAnchor } from './anchor'
import {
  enqueuePending,
  listPending,
  clearPending,
  pickSyncedProgress,
} from './pendingQueue'

/**
 * 阅读进度的上报与恢复（契约 §6）。
 *
 * 上报时机按 §6.3：
 *   1. 滚动停止 1500ms 后（防抖）
 *   2. 跟读推进到段落边界时（由调用方在游标跨段时调 report）
 *   3. 页面隐藏或卸载时补一次
 * 任一次失败都写进离线队列，交给批量同步补报。
 */

/** 契约 §6.3：滚动停止 1500ms 后上报 */
const DEBOUNCE_MS = 1500

export interface ProgressApi {
  ready: boolean
  /** 本机记录的版本号，上报时作 baseVersion */
  version: number
  /** 打开文档时恢复到的段落号 */
  resumeParagraph: number
  /** 各设备进度（界面上可以显示"另一台设备读到第 N 段"） */
  devices: ProgressItem[]
  error: string
  /** 上报当前位置（内部防抖） */
  report: (anchor: Anchor) => void
  /** 立即上报，用于页面隐藏/卸载 */
  flushBeacon: () => void
}

export function useProgress(docId: string, enabled: boolean): ProgressApi {
  const [ready, setReady] = useState(false)
  const [version, setVersion] = useState(0)
  const [resumeParagraph, setResumeParagraph] = useState(0)
  const [devices, setDevices] = useState<ProgressItem[]>([])
  const [error, setError] = useState('')

  /** 最近一次要上报的位置；防抖期间只保留最后一个 */
  const latest = useRef<Anchor | null>(null)
  const timer = useRef<number | null>(null)
  const versionRef = useRef(0)
  const deviceId = getDeviceId()

  useEffect(() => {
    versionRef.current = version
  }, [version])

  /* ---- 打开文档：拉取所有设备的进度，算出从哪继续 ---- */
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void (async () => {
      try {
        const res = await api.getProgress(docId, deviceId)
        if (!alive) return
        setDevices(res.items)

        const mine = res.items.find((i) => i.isCurrentDevice)
        if (mine) {
          setVersion(mine.version)
          versionRef.current = mine.version
        }

        // 恢复到哪一段：取最近更新的一条；
        // 但**不回退** —— 如果那条的位置还落后于本机已记录的，就保留本机的位置
        // （契约 §8.5 的"不回退保护"）
        let target = 0
        if (res.items.length > 0) {
          const newest = res.items.reduce((a, b) =>
            Date.parse(a.updatedAt) >= Date.parse(b.updatedAt) ? a : b,
          )
          const chosen =
            mine && compareAnchor(mine.anchor, newest.anchor) > 0 ? mine : newest
          target = chosen.anchor.paragraphIndex
        }
        setResumeParagraph(target)
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : '读取阅读进度失败')
      } finally {
        if (alive) setReady(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [docId, deviceId, enabled])

  /**
   * 上报成功后清掉已经补上的旧队列行。
   *
   * 不清的话，一次离线失败就会让「待同步 N 条」一直挂着 ——
   * 后续的防抖上报明明已经成功，徽标却要等到手动点「一键同步」才消失。
   * 只清不晚于这次成功时间的行，请求飞行期间新排进来的那条不能误删。
   */
  const clearSynced = useCallback(
    async (updatedAt: string) => {
      try {
        const done = pickSyncedProgress(
          await listPending(authStore.userId, docId),
          docId,
          updatedAt,
        )
        if (done.length > 0) await clearPending(done.map((r) => r.id))
      } catch {
        /* 清队列失败不影响上报本身 */
      }
    },
    [docId],
  )

  /* ---- 真正发出去 ---- */
  const send = useCallback(
    async (anchor: Anchor): Promise<void> => {
      const updatedAt = new Date().toISOString()
      try {
        const r = await api.putProgress(docId, {
          deviceId,
          anchor,
          lastSentenceIndex: anchor.sentenceIndex,
          updatedAt,
          baseVersion: versionRef.current,
        })
        versionRef.current = r.version
        setVersion(r.version)
        setError('')
        void clearSynced(updatedAt)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'SYNC_VERSION_CONFLICT') {
          // 冲突由服务端按"不回退保护"裁决，这里只把新版本号同步过来，
          // 免得分歧一直卡在旧版本上（契约 §8.3 的 superseded）
          const conflict = e.details?.conflict as ConflictEnvelope | undefined
          const resolved = conflict?.resolved as { version?: number } | undefined
          if (typeof resolved?.version === 'number') {
            versionRef.current = resolved.version
            setVersion(resolved.version)
          }
          setError('阅读进度已被其他设备更新，已按"不回退"合并。')
          return
        }
        // 网络不通：入队，等下次批量同步补报
        void enqueuePending(docId, 'progress', {
          docId,
          anchor,
          lastSentenceIndex: anchor.sentenceIndex,
          updatedAt,
          baseVersion: versionRef.current,
        }, authStore.userId)
        setError(e instanceof ApiError ? e.message : '进度上报失败，已记入待同步队列')
      }
    },
    [docId, deviceId, clearSynced],
  )

  /* ---- 防抖上报 ---- */
  const report = useCallback(
    (anchor: Anchor) => {
      latest.current = anchor
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        const a = latest.current
        if (a) void send(a)
      }, DEBOUNCE_MS)
    },
    [send],
  )

  /**
   * 页面隐藏/卸载时的最后一次上报。
   *
   * 契约 §6.3 写的是 `navigator.sendBeacon`，但那在技术上走不通：
   * 它只能发 POST、且不能设置自定义请求头，而这个接口是 PUT 且要带
   * `Authorization: Bearer`（docs/system-design.md §6.4）。所以改用 fetch 的 keepalive ——
   * 它同样能在页面卸载后把请求发完，且支持请求头。
   */
  const flushBeacon = useCallback(() => {
    const a = latest.current
    if (!a) return
    latest.current = null
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }

    const body = JSON.stringify({
      deviceId,
      anchor: a,
      lastSentenceIndex: a.sentenceIndex,
      updatedAt: new Date().toISOString(),
      baseVersion: versionRef.current,
    })

    try {
      void fetch(apiUrl(`/documents/${docId}/progress`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(authStore.access ? { Authorization: `Bearer ${authStore.access}` } : {}),
          ...appVersionHeader(),
        },
        body,
        keepalive: true,
      }).then((response) => {
        if (!response.ok) throw new Error('上报失败，稍后重试')
      }).catch(() => {
        void enqueuePending(docId, 'progress', JSON.parse(body), authStore.userId)
      })
    } catch {
      void enqueuePending(docId, 'progress', JSON.parse(body), authStore.userId)
    }
  }, [docId, deviceId])

  /* ---- 页面隐藏/卸载 ---- */
  useEffect(() => {
    if (!enabled) return
    const onHide = () => flushBeacon()
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [enabled, flushBeacon])

  return { ready, version, resumeParagraph, devices, error, report, flushBeacon }
}

/** 把离线队列里的进度变更取出，供批量同步使用 */
export async function takePendingProgress(docId: string) {
  const all = await listPending(authStore.userId, docId)
  const progress = all.filter((p) => p.kind === 'progress')
  return { progress, ids: progress.map((p) => p.id) }
}

export { clearPending }
