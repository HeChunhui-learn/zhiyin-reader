import type { ConflictItem } from '../models/types'

/**
 * R1 起，书架与正文都走真实接口（见 src/api/client.ts）。
 * 这个文件里只剩下 R1 还没接上的那部分假数据。
 */

/** R5 接入 T_SyncRecord 后删除。冲突界面先靠它撑起来。 */
export const CONFLICTS: ConflictItem[] = [
  {
    conflictId: 'cf_01',
    type: '同一书签被两端重命名',
    localDevice: '本机 · 何的笔记本',
    localValue: '「境界说」三段',
    remoteDevice: '平板 · iPad',
    remoteValue: '「三种境界」',
  },
  {
    conflictId: 'cf_02',
    type: '同一书签被一端移动、另一端改名',
    localDevice: '本机 · 何的笔记本',
    localValue: '位置：卷二 第 7 段',
    remoteDevice: '平板 · iPad',
    remoteValue: '名称：「有我之境」',
  },
]
