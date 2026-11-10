import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * 口令加盐哈希。
 * 用 Node 自带的 scrypt（node:crypto），不引入 bcrypt/argon2 —— 少一个原生依赖，
 * 交付时少一处要装编译环境的地方。参数用 Node 默认的 N=16384 / r=8 / p=1，
 * 单次约 50–100ms，对登录接口够用，也足以抵御离线爆破。
 */

const KEY_LEN = 64
const SALT_BYTES = 16

export function makeSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex')
}

export function hashPassword(password: string, salt = makeSalt()): string {
  return scryptSync(password, salt, KEY_LEN).toString('hex')
}

/** 定长比较，避免按字节提前返回带来的时序侧信道 */
export function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): boolean {
  let given: Buffer
  let expected: Buffer
  try {
    given = scryptSync(password, salt, KEY_LEN)
    expected = Buffer.from(expectedHash, 'hex')
  } catch {
    return false
  }
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

/** 契约：密码长度 ≥ 8 */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return '密码长度不得少于 8 位'
  }
  if (password.length > 128) return '密码过长'
  return null
}

/** 账号：手机号或邮箱 */
export function validateAccount(account: unknown): string | null {
  if (typeof account !== 'string') return '账号不能为空'
  const s = account.trim()
  if (s.length < 3 || s.length > 64) return '账号长度应在 3–64 位之间'
  const isPhone = /^1[3-9]\d{9}$/.test(s)
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
  if (!isPhone && !isEmail) return '账号需为手机号或邮箱'
  return null
}

/** 在线认证交给线程池，避免口令计算阻塞其他读者的请求。 */
export async function hashPasswordAsync(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, (error, key) => error ? reject(error) : resolve(key.toString('hex')))
  })
}

export async function verifyPasswordAsync(password: string, salt: string, expectedHash: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 128) return false
  const given = Buffer.from(await hashPasswordAsync(password, salt), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
