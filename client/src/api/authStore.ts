/**
 * 令牌存放处。
 *
 * accessToken 只放内存 —— 刷新页面即失效，靠 refreshToken 静默换新的。
 * refreshToken 放 localStorage（契约 §3.2 让它随响应体下发）。
 * 说明：localStorage 里的刷新令牌挡不住 XSS，生产环境应改为 httpOnly Cookie；
 * 本项目是局域网内的课程设计，取实现简单，这一点在文档里已记录。
 */

const REFRESH_KEY = 'zhiyin.refreshToken'

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

let accessToken: string | null = null
// localStorage 在纯 Node 测试环境里不存在；这里兜一层，别让 import 就炸
let refreshToken: string | null =
  typeof localStorage === 'undefined' ? null : localStorage.getItem(REFRESH_KEY)

/**
 * 当前读者 id。
 *
 * 离线队列要按读者隔离（同一浏览器可能先后登录不同账号），
 * 而 `oneClickSync` 不是 hook，拿不到 Session context，所以在这里留一份。
 * 内存态即可：刷新页面后由 SessionProvider 静默登录重新写入。
 */
let currentUserId: string | null = null

export const authStore = {
  get access(): string | null {
    return accessToken
  },
  get refresh(): string | null {
    return refreshToken
  },
  get userId(): string | null {
    return currentUserId
  },
  setUser(userId: string | null): void {
    currentUserId = userId
  },
  set(pair: TokenPair): void {
    accessToken = pair.accessToken
    refreshToken = pair.refreshToken
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(REFRESH_KEY, pair.refreshToken)
    }
  },
  clear(): void {
    accessToken = null
    refreshToken = null
    currentUserId = null
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(REFRESH_KEY)
    }
  },
}
