import { describe, expect, it } from 'vitest'
import { buildGeometry, estimateHeight } from '../src/features/render/virtualWindow'
import { PAGE_SAFETY, pageOfPara, paginate } from '../src/features/render/pagination'
import type { Paragraph } from '../src/models/types'

/**
 * PG-01 ~ PG-07 横向分页的页边界（阅读版面 = 横向分页）。
 *
 * 这个算法唯一不可让步的性质是 **PG-02：每段恰好属于一页、且页与页首尾相接**。
 * 它保证了两件事：页面之间不会漏字、也不会重复渲染同一段
 * （重复的话 DOM 里会出现两个 [data-para="i"]，实测高度回写会取错那个）。
 *
 * PG-04 是"对齐段落边界"这个决定的直接后果，也是它相对"按像素硬切"的全部价值：
 * 任何一页都不会把某一段拦腰截断。
 */

function p(i: number, text: string, type: Paragraph['type'] = 'p'): Paragraph {
  return { paraIndex: i, type, text, sentences: [] } as Paragraph
}

/** 造 n 段正文，每段 len 个中文字 */
function doc(n: number, len = 42): Paragraph[] {
  return Array.from({ length: n }, (_, i) => p(i, '甲'.repeat(len)))
}

describe('PG-01 ~ PG-07 横向分页的页边界', () => {
  it('PG-01 空文档切出 0 页；页高不合法时也不炸', () => {
    const empty = buildGeometry([])
    expect(paginate(empty, 800)).toEqual({ starts: [], ends: [] })
    expect(paginate(buildGeometry(doc(10)), 0)).toEqual({ starts: [], ends: [] })
    expect(paginate(buildGeometry(doc(10)), -100)).toEqual({ starts: [], ends: [] })
    // 页高比安全余量还小时也没有合法页 —— 不能返回一个 limit 为负的页表
    expect(paginate(buildGeometry(doc(10)), PAGE_SAFETY)).toEqual({ starts: [], ends: [] })
  })

  it('PG-02 每段恰好属于一页，且页与页首尾相接', () => {
    const paras = doc(120)
    const pages = paginate(buildGeometry(paras), 800)
    expect(pages.starts.length).toBeGreaterThan(1)
    expect(pages.starts[0]).toBe(0)
    expect(pages.ends[pages.ends.length - 1]).toBe(paras.length - 1)
    for (let i = 0; i < pages.starts.length; i++) {
      expect(pages.ends[i]).toBeGreaterThanOrEqual(pages.starts[i])
      if (i > 0) expect(pages.starts[i]).toBe(pages.ends[i - 1] + 1)
    }
  })

  it('PG-03 每页的内容高度不超过页高', () => {
    const geom = buildGeometry(doc(200))
    const pageH = 700
    const pages = paginate(geom, pageH)
    for (let i = 0; i < pages.starts.length; i++) {
      const h = geom.offsets[pages.ends[i] + 1] - geom.offsets[pages.starts[i]]
      expect(h).toBeLessThanOrEqual(pageH)
    }
  })

  it('★ PG-04 页边界落在段与段之间，不切断任何一段', () => {
    const geom = buildGeometry(doc(80))
    const pages = paginate(geom, 600)
    // 每一段的起点要么是某页的第一段，要么紧跟在同页上一段之后 ——
    // 也就是不存在"某段跨在两页之间"的情况
    for (let i = 0; i < pages.starts.length; i++) {
      for (let k = pages.starts[i]; k <= pages.ends[i]; k++) {
        expect(k).toBeGreaterThanOrEqual(pages.starts[i])
        expect(k).toBeLessThanOrEqual(pages.ends[i])
      }
    }
    // 反过来说：任何一段都能被 pageOfPara 唯一地定位到一页
    for (let k = 0; k < geom.heights.length; k++) {
      const pg = pageOfPara(pages, k)
      expect(pg).toBeGreaterThanOrEqual(0)
      expect(k).toBeGreaterThanOrEqual(pages.starts[pg])
      expect(k).toBeLessThanOrEqual(pages.ends[pg])
    }
  })

  it('★ PG-05 单段高于一页时独占一页，不与邻段挤在一起', () => {
    // 中间塞一段超长的：它自己就比一页还高
    const paras = [p(0, '甲'.repeat(42)), p(1, '乙'.repeat(42 * 60)), p(2, '丙'.repeat(42))]
    const geom = buildGeometry(paras)
    const pages = paginate(geom, 600)
    const big = pageOfPara(pages, 1)
    expect(pages.starts[big]).toBe(1)
    expect(pages.ends[big]).toBe(1)
    // 前后两段各自落在别的页上
    expect(pageOfPara(pages, 0)).not.toBe(big)
    expect(pageOfPara(pages, 2)).not.toBe(big)
  })

  it('PG-06 pageOfPara 往返一致，边界值正确', () => {
    const geom = buildGeometry(doc(150))
    const pages = paginate(geom, 700)
    for (let i = 0; i < pages.starts.length; i++) {
      expect(pageOfPara(pages, pages.starts[i])).toBe(i)
      expect(pageOfPara(pages, pages.ends[i])).toBe(i)
    }
  })

  it('PG-07 页表为空时 pageOfPara 返回 -1（pageH 还没量出来时就是这个状态）', () => {
    expect(pageOfPara(paginate(buildGeometry([]), 800), 0)).toBe(-1)
    const pages = paginate(buildGeometry(doc(50)), 700)
    // 比第一段还靠前（负段号、或段号小于第一页起点）一律 -1，让调用方跳过而不是跳到第 0 页
    expect(pageOfPara(pages, -1)).toBe(-1)
    expect(pageOfPara({ starts: [5], ends: [9] }, 3)).toBe(-1)
  })

  it('PG-08 安全余量确实吃掉了半行，页高刚好放不下时不会硬塞', () => {
    const geom = buildGeometry(doc(3))
    const one = estimateHeight(p(0, '甲'.repeat(42)))
    // 页高刚好 = 两段之和：减去安全余量后放不下，只能装一段
    const pages = paginate(geom, one * 2)
    expect(pages.ends[0] - pages.starts[0] + 1).toBe(1)
    // 给足余量就能装下两段
    const roomy = paginate(geom, one * 2 + PAGE_SAFETY + 1)
    expect(roomy.ends[0] - roomy.starts[0] + 1).toBe(2)
  })
})
