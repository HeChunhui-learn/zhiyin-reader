import { authStore } from '../../api/authStore'
import { api, type SyncRequest } from '../../api/client'
import { getDeviceId } from '../../api/device'
import { clearPending, listPending } from './pendingQueue'
import {
  countPendingForUser,
  runOneClickSync,
  type OneClickSyncResult,
} from './oneClickSyncCore'

export type { OneClickSyncResult }

/**
 * 一键同步的真实入口。
 *
 * 平时的进度 / 书签是各写各的：成功的即时落库，失败的进 IndexedDB 待同步队列。
 * 这个入口把当前读者攒下的变更一次性补报，再读回未决冲突。
 *
 * 编排逻辑在 oneClickSyncCore.ts（纯函数、可单测）；这里只负责注入
 * IndexedDB、api 与当前读者。队列**按读者隔离**，见 pendingQueue.ts。
 */

/** 待补报的进度 / 书签条数，用于徽标显示 */
export async function pendingSyncCount(): Promise<number> {
  const userId = authStore.userId
  if (!userId) return 0
  const all = await listPending(userId)
  return countPendingForUser(all, userId)
}

export async function syncAllPending(): Promise<OneClickSyncResult> {
  const userId = authStore.userId
  if (!userId) throw new Error('未登录，无法同步')

  return runOneClickSync({
    userId,
    deviceId: getDeviceId(),
    listPending: () => listPending(userId),
    clearPending,
    sync: (body, idemKey) => api.sync(body as SyncRequest, idemKey),
    listConflicts: () => api.listConflicts(),
  })
}
