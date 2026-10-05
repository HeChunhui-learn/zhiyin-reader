/**
 * 设备标识。契约 §1：客户端首次启动生成 UUID 并持久化于 localStorage，
 * 登录与同步时作为 deviceId 上送，用于标识来源设备、避免同设备重复同步。
 */

const KEY = 'zhiyin.deviceId'

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '')
  }
  // 老浏览器兜底（http 下的非 localhost 访问，crypto.randomUUID 不可用）
  return 'xxxxxxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  )
}

let cached: string | null = null

export function getDeviceId(): string {
  if (cached) return cached
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = `dev_${uuid()}`
    localStorage.setItem(KEY, id)
  }
  cached = id
  return id
}
