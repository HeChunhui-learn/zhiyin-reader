import { expect, it, vi } from 'vitest'
import { ReaderCache } from '../src/features/cache/readerCache'

it('同一键合并加载并复用结果，版本和账号变化重新读取', async () => {
  const cache = new ReaderCache<string>(100, 1000)
  const fetch = vi.fn(async () => '正文')
  expect(await Promise.all([cache.load('a/doc', 'v1', fetch), cache.load('a/doc', 'v1', fetch)])).toEqual(['正文', '正文'])
  await cache.load('a/doc', 'v1', fetch)
  expect(fetch).toHaveBeenCalledTimes(1)
  await cache.load('b/doc', 'v1', fetch)
  await cache.load('a/doc', 'v2', fetch)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('失败后允许重试，容量超限不驻留，过期后重新加载', async () => {
  let now = 0
  const cache = new ReaderCache<string>(8, 100, () => now)
  await expect(cache.load('a', 'v1', async () => { throw new Error('断网') })).rejects.toThrow('断网')
  const fetch = vi.fn(async () => '书')
  await cache.load('a', 'v1', fetch)
  now = 101
  await cache.load('a', 'v1', fetch)
  expect(fetch).toHaveBeenCalledTimes(2)
  const large = vi.fn(async () => '超过容量的正文')
  await cache.load('big', 'v1', large)
  await cache.load('big', 'v1', large)
  expect(large).toHaveBeenCalledTimes(2)
})


it('超出总容量淘汰最久未访问条目', async () => {
  const cache = new ReaderCache<string>(12, 1000)
  const fetch = vi.fn(async () => '书')
  await cache.load('a', 'v1', fetch)
  await cache.load('b', 'v1', fetch)
  await cache.load('a', 'v1', fetch)
  await cache.load('c', 'v1', fetch)
  expect(fetch).toHaveBeenCalledTimes(3)
  await cache.load('b', 'v1', fetch)
  expect(fetch).toHaveBeenCalledTimes(4)
})
