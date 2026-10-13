import { describe, expect, it } from 'vitest'
import { buildGeometry, estimateHeight } from '../src/features/render/virtualWindow'
import { PAGE_SAFETY, pageOfPara, paginate, sliceHeight } from '../src/features/render/pagination'
import type { Paragraph } from '../src/models/types'

/**
 * PG-01 ~ PG-10 横向分页的页边界（阅读版面 = 横向分页）。
 *
 * 两条不可让步的性质：
 *   · PG-02/PG-04 —— 正文不能被丢掉，也不能重复。重复的话 DOM 里会出现两个
 *     [data-para="i"]，实测高度回写会取错那个。
 *   · PG-09/PG-10 —— 长段落的切点必须落在**整行**上。按像素随便切会把页底那一行
 *     汉字拦腰截断，屏幕上就是一行缺了下半边的字。
 *
 * PG-05 那条是这套算法存在的理由：实测过一篇 1030 段的网文，有 133 段超过一页、
 * 占总高度 75% —— 长段落若只给一页再裁掉溢出，读者就永远读不到后半截。
 */

function p(i: number, text: string, type: Paragraph['type'] = 'p'): Paragraph {
  return { paraIndex: i, type, text, sentences: [] } as Paragraph
}

/** 造 n 段正文，每段 len 个中文字 */
function doc(n: number, len = 42): Paragraph[] {
  return Array.from({ length: n }, (_, i) => p(i, '甲'.repeat(len)))
}

const LH = 30.4 // 16px × 1.9，与 estimateHeight 的基线一致

/** 一页的总高度（整段页）= 页内各段高度之和 */
function pageHeight(geom: ReturnType<typeof buildGeometry>, s: number, e: number): number {
  let acc = 0
  for (let i = s; i <= e; i++) acc += geom.heights[i]
  return acc
}

describe('PG-01 ~ PG-05 普通段落：切页与页高', () => {
  it('PG-01 空文档切出 0 页；页高不合法时也不炸', () => {
    const empty = buildGeometry([])
    expect(paginate(empty, 800, LH)).toEqual({ starts: [], ends: [], slice: [] })
    expect(paginate(buildGeometry(doc(10)), 0, LH)).toEqual({ starts: [], ends: [], slice: [] })
    expect(paginate(buildGeometry(doc(10)), -100, LH)).toEqual({ starts: [], ends: [], slice: [] })
    expect(paginate(buildGeometry(doc(10)), PAGE_SAFETY, LH)).toEqual({
      starts: [],
      ends: [],
      slice: [],
    })
  })

  it('PG-02 普通文档：每段恰好属于一页，且页与页首尾相接', () => {
    const paras = doc(120)
    const pages = paginate(buildGeometry(paras), 800, LH)
    expect(pages.starts.length).toBeGreaterThan(1)
    expect(pages.starts[0]).toBe(0)
    expect(pages.ends[pages.ends.length - 1]).toBe(paras.length - 1)
    for (let i = 0; i < pages.starts.length; i++) {
      expect(pages.ends[i]).toBeGreaterThanOrEqual(pages.starts[i])
      expect(pages.slice[i]).toBe(-1)
      if (i > 0) expect(pages.starts[i]).toBe(pages.ends[i - 1] + 1)
    }
  })

  it('PG-03 普通页的内容高度不超过页高', () => {
    const geom = buildGeometry(doc(200))
    const pageH = 700
    const pages = paginate(geom, pageH, LH)
    for (let i = 0; i < pages.starts.length; i++) {
      expect(pageHeight(geom, pages.starts[i], pages.ends[i])).toBeLessThanOrEqual(pageH)
    }
  })

  it('★ PG-04 任何一段都能被定位到某一页，没有段落被丢掉', () => {
    const geom = buildGeometry(doc(80))
    const pages = paginate(geom, 600, LH)
    for (let k = 0; k < geom.heights.length; k++) {
      const pg = pageOfPara(pages, k)
      expect(pg).toBeGreaterThanOrEqual(0)
      expect(k).toBeGreaterThanOrEqual(pages.starts[pg])
      expect(k).toBeLessThanOrEqual(pages.ends[pg])
    }
  })

  it('PG-08 安全余量确实吃掉了半行，页高刚好放不下时不会硬塞', () => {
    const geom = buildGeometry(doc(3))
    const one = estimateHeight(p(0, '甲'.repeat(42)))
    // 页高刚好 = 两段之和：减去安全余量后放不下，只能装一段
    const pages = paginate(geom, one * 2, LH)
    expect(pages.ends[0] - pages.starts[0] + 1).toBe(1)
    // 给足余量就能装下两段
    const roomy = paginate(geom, one * 2 + PAGE_SAFETY + 1, LH)
    expect(roomy.ends[0] - roomy.starts[0] + 1).toBe(2)
  })
})

describe('PG-05 ~ PG-10 长段落：切成整行的连续页', () => {
  /** 一段 97 行的长文（≈ 真实网文的一章一整段） */
  const LONG_LINES = 97
  const longDoc = () => [p(0, '甲'.repeat(42)), p(1, '乙'.repeat(42 * LONG_LINES)), p(2, '丙'.repeat(42))]

  it('★ PG-05 超过一页的段落被切成连续几页，而不是裁掉后半截', () => {
    const geom = buildGeometry(longDoc())
    const pageH = 690
    const pages = paginate(geom, pageH, LH)

    const bigPages = pages.starts
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s === 1)
      .map(({ i }) => i)
    expect(bigPages.length).toBeGreaterThan(1) // 确实占了不止一页
    // 段 1 的每一片都在，且下标从 0 连续递增 —— 中途不漏页、不重复
    bigPages.forEach((pi, k) => {
      expect(pages.slice[pi]).toBe(k)
      expect(pages.starts[pi]).toBe(1)
      expect(pages.ends[pi]).toBe(1)
    })
    // 前后两段仍各有自己的页
    expect(pageOfPara(pages, 0)).toBeLessThan(bigPages[0])
    expect(pageOfPara(pages, 2)).toBeGreaterThan(bigPages[bigPages.length - 1])
  })

  it('★ PG-09 切片高度是行高的整数倍（切点落在整行之间）', () => {
    const cut = sliceHeight(690, LH)
    // 不用 cut % LH 判 —— 22×30.4 这种乘法在浮点下余数会算出 30.399…，断言会假红。
    // 按"最接近的整数倍乘回去"比更稳
    expect(Math.round(cut / LH) * LH).toBeCloseTo(cut, 6)
    expect(cut).toBeLessThanOrEqual(690 - PAGE_SAFETY)
    // 行高比可用高度还大时退化成一行，不能返回 0 或负数
    expect(sliceHeight(20, LH)).toBe(LH)
    expect(sliceHeight(690, 0)).toBeGreaterThan(0)
  })

  it('★ PG-10 切片页数刚好覆盖整段的行数，不多不少', () => {
    const geom = buildGeometry(longDoc())
    const pageH = 690
    const cut = sliceHeight(pageH, LH)
    const pages = paginate(geom, pageH, LH)
    const slices = pages.slice.filter((k) => k >= 0)
    const expectCount = Math.max(1, Math.ceil(geom.heights[1] / cut))
    expect(slices.length).toBe(expectCount)
    // 最后一片必须还能装下剩下的行（否则说明少切了一页、末尾会被裁掉）
    expect((expectCount - 1) * cut).toBeLessThan(geom.heights[1])
  })

  it('PG-06 pageOfPara 往返一致，边界值正确', () => {
    const geom = buildGeometry(doc(150))
    const pages = paginate(geom, 700, LH)
    for (let i = 0; i < pages.starts.length; i++) {
      expect(pageOfPara(pages, pages.starts[i])).toBe(i)
      expect(pageOfPara(pages, pages.ends[i])).toBe(i)
    }
  })

  it('PG-07 页表为空时 pageOfPara 返回 -1（pageH 还没量出来时就是这个状态）', () => {
    expect(pageOfPara(paginate(buildGeometry([]), 800, LH), 0)).toBe(-1)
    const pages = paginate(buildGeometry(doc(50)), 700, LH)
    expect(pageOfPara(pages, -1)).toBe(-1)
    expect(pageOfPara({ starts: [5], ends: [9], slice: [-1] }, 3)).toBe(-1)
  })
})
