import { describe, expect, it } from 'vitest'
import { normalizeApiBase } from '../src/api/client'

/**
 * 「输入一个地址，能连上」这件事本身就是易错点：
 * 用户会填 `192.168.1.5:3000`、`http://x:3000/`、`https://x/api/`，
 * 甚至只填域名。整理规则错了的表现不是报错，而是"连不上"，
 * 排查起来特别费劲 —— 所以单独钉住它。
 *
 * 只验这个纯函数；getApiBase / setApiBase 依赖 localStorage，
 * 在 node 环境下没有，交给 e2e 覆盖。
 */
describe('API 基址整理（client/normalizeApiBase）', () => {
  it('补协议头', () => {
    expect(normalizeApiBase('192.168.1.5:3000')).toBe('http://192.168.1.5:3000/api')
  })

  it('已经有协议头就不重复补', () => {
    expect(normalizeApiBase('https://read.example.com')).toBe('https://read.example.com/api')
  })

  it('末尾斜杠去掉', () => {
    expect(normalizeApiBase('http://192.168.1.5:3000/')).toBe('http://192.168.1.5:3000/api')
  })

  it('已经有 /api 就不重复拼', () => {
    expect(normalizeApiBase('http://192.168.1.5:3000/api')).toBe('http://192.168.1.5:3000/api')
  })

  it('/api 带末尾斜杠，先去掉斜杠再判断', () => {
    expect(normalizeApiBase('http://192.168.1.5:3000/api/')).toBe('http://192.168.1.5:3000/api')
  })

  it('前后空格不影响结果', () => {
    expect(normalizeApiBase('  http://192.168.1.5:3000/api  ')).toBe('http://192.168.1.5:3000/api')
  })

  it('空串返回空串，调用方据此走"恢复默认"', () => {
    expect(normalizeApiBase('')).toBe('')
    expect(normalizeApiBase('   ')).toBe('')
  })

  it('只填域名也会补成可用的 /api 基址', () => {
    expect(normalizeApiBase('read.example.com')).toBe('http://read.example.com/api')
  })
})
