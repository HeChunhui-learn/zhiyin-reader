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
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY)

export const authStore = {
  get access(): string | null {
    return accessToken
  },
  get refresh(): string | null {
    return refreshToken
  },
  set(pair: TokenPair): void {
    accessToken = pair.accessToken
    refreshToken = pair.refreshToken
    localStorage.setItem(REFRESH_KEY, pair.refreshToken)
  },
  clear(): void {
    accessToken = null
    refreshToken = null
    localStorage.removeItem(REFRESH_KEY)
  },
}
