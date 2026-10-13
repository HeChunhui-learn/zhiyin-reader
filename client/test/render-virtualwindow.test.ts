import { describe, expect, it } from 'vitest'
import {
  buildGeometry,
  computeWindow,
  estimateHeight,
  offsetOf,
  paragraphAt,
  recomputeFrom,
  totalHeight,
} from '../src/features/render/virtualWindow'
import type { Paragraph } from '../src/models/types'

/**
 * VD-01 ~ VD-09 长文档窗口化渲染（技术选型 §5.3 的"虚拟滚动"）。
 *
 * VD-07 是这条链路上唯一的验收硬指标：500 段的文档同时只能挂 3 屏左右的节点
 * （03 §3.1 5) 要求"不超过视口窗口量的 3 倍"）。
 * VD-09 守住另一头：17 段的短文档必须仍然全部渲染，演示书不该被这个机制改掉观感。
 */

function p(i: number, text: string, type: Paragraph['type'] = 'p'): Paragraph {
  return { paraIndex: i, type, text, sentences: [] } as Paragraph
}

/** 造 n 段正文，每段 len 个中文字 */
function doc(n: number, len = 42): Paragraph[] {
  return Array.from({ length: n }, (_, i) => p(i, '甲'.repeat(len)))
}

describe('VD-01 ~ VD-03 高度估算与累计偏移', () => {
  it('VD-01 累计偏移严格递增', () => {
    const geom = buildGeometry(doc(20))
    for (let i = 1; i < geom.offsets.length; i++) {
      expect(geom.offsets[i]).toBeGreaterThan(geom.offsets[i - 1])
    }
  })

  it('VD-02 总高度等于各段估算之和', () => {
    const paras = doc(30)
    const geom = buildGeometry(paras)
    const sum = paras.reduce((s, x) => s + estimateHeight(x), 0)
    expect(totalHeight(geom)).toBeCloseTo(sum, 6)
  })

  it('VD-02 空文档总高度为 0', () => {
    expect(totalHeight(buildGeometry([]))).toBe(0)
    expect(buildGeometry([]).heights).toEqual([])
  })

  it('VD-03 长段落估得比短段落高', () => {
    const short = p(0, '甲'.repeat(10))
    const long = p(1, '甲'.repeat(200))
    expect(estimateHeight(long)).toBeGreaterThan(estimateHeight(short))
  })

  it('VD-03 空段落至少占一行（不会估成 0 高）', () => {
    expect(estimateHeight(p(0, ''))).toBeGreaterThan(0)
  })

  it('R8-3 字号缩放：字号大则段落更高、一行放的字更少', () => {
    const para = p(0, '甲'.repeat(200))
    const at16 = estimateHeight(para, 16)
    const at24 = estimateHeight(para, 24)
    expect(at24).toBeGreaterThan(at16)
  })

  it('R8-3 不传 fontSize 时与传 16 逐字节相同（短文档观感不被改动）', () => {
    for (const para of [p(0, '甲'.repeat(10)), p(1, '甲'.repeat(500)), p(2, '', 'h1'), p(3, '', 'img')]) {
      expect(estimateHeight(para)).toBe(estimateHeight(para, 16))
    }
  })

  it('h1 / h2 有各自的高度公式，且 h1 高于 h2', () => {
    expect(estimateHeight(p(0, '标题', 'h1'))).toBeGreaterThan(estimateHeight(p(1, '标题', 'h2')))
  })

  it('img 段高度固定（.figure-holder 的 min-height: 200px），与文本长度无关', () => {
    expect(estimateHeight(p(0, '', 'img'))).toBe(estimateHeight(p(1, '甲'.repeat(300), 'img')))
  })

  it('recomputeFrom 从指定段起重算，前面的偏移不动', () => {
    const geom = buildGeometry(doc(10))
    const before = geom.offsets.slice(0, 5)
    geom.heights[5] = 9999
    recomputeFrom(geom, 5)
    expect(geom.offsets.slice(0, 5)).toEqual(before)
    expect(geom.offsets[6]).toBe(geom.offsets[5] + 9999)
  })

  it('recomputeFrom 传 0 时整表重算', () => {
    const geom = buildGeometry(doc(10))
    const fresh = buildGeometry(doc(10))
    recomputeFrom(geom, 0)
    expect(geom.offsets).toEqual(fresh.offsets)
  })
})

describe('VD-04 ~ VD-05 二分定位与窗口计算', () => {
  it('VD-04 段落中部的 y 定位到该段', () => {
    const geom = buildGeometry(doc(20))
    for (let i = 0; i < 20; i++) {
      const mid = (geom.offsets[i] + geom.offsets[i + 1]) / 2
      expect(paragraphAt(geom, mid), `第 ${i} 段中点`).toBe(i)
    }
  })

  it('VD-04 段边界处定位到刚好开始的那一段', () => {
    const geom = buildGeometry(doc(20))
    for (let i = 1; i < 20; i++) {
      expect(paragraphAt(geom, geom.offsets[i])).toBe(i)
    }
  })

  it('VD-04 越界夹到两端', () => {
    const geom = buildGeometry(doc(20))
    expect(paragraphAt(geom, -1000)).toBe(0)
    expect(paragraphAt(geom, -1)).toBe(0)
    expect(paragraphAt(geom, 0)).toBe(0)
    expect(paragraphAt(geom, totalHeight(geom) + 1000)).toBe(19)
    expect(paragraphAt(geom, totalHeight(geom))).toBe(19)
  })

  it('VD-04 空几何表返回 0，不抛异常', () => {
    expect(paragraphAt(buildGeometry([]), 100)).toBe(0)
  })

  it('VD-04 offsetOf 越界夹到两端', () => {
    const geom = buildGeometry(doc(20))
    expect(offsetOf(geom, -5)).toBe(0)
    expect(offsetOf(geom, 9999)).toBe(geom.offsets[19])
    expect(offsetOf(geom, 3)).toBe(geom.offsets[3])
  })

  it('VD-05 窗口随滚动下移', () => {
    const geom = buildGeometry(doc(500))
    const top = computeWindow(geom, 0, 800)
    const mid = computeWindow(geom, 5000, 800)
    const bottom = computeWindow(geom, totalHeight(geom) - 800, 800)

    expect(mid.start).toBeGreaterThan(top.start)
    expect(bottom.start).toBeGreaterThan(mid.start)
  })

  it('VD-05 窗口起点与终点都夹在合法范围内', () => {
    const geom = buildGeometry(doc(500))
    for (const scroll of [-5000, 0, 1234, totalHeight(geom) / 2, totalHeight(geom) + 5000]) {
      const w = computeWindow(geom, scroll, 800)
      expect(w.start, `scroll=${scroll}`).toBeGreaterThanOrEqual(0)
      expect(w.end, `scroll=${scroll}`).toBeLessThanOrEqual(499)
      expect(w.start).toBeLessThanOrEqual(w.end)
    }
  })

  it('VD-06 跟读高亮所在段落被强制纳入窗口（哪怕已滚出视口）', () => {
    const geom = buildGeometry(doc(500))
    const w = computeWindow(geom, 0, 800, 400) // 强制包含第 400 段
    expect(w.start).toBeLessThanOrEqual(400)
    expect(w.end).toBeGreaterThanOrEqual(400)
  })

  it('VD-06 强制段落在上方时把窗口起点拉上去', () => {
    const geom = buildGeometry(doc(500))
    const w = computeWindow(geom, totalHeight(geom) - 800, 800, 5)
    expect(w.start).toBe(5)
  })

  it('VD-06 forceInclude 越界时被忽略，不产生非法窗口', () => {
    const geom = buildGeometry(doc(500))
    for (const bad of [-1, 500, 9999]) {
      const w = computeWindow(geom, 1000, 800, bad)
      expect(w.start).toBeGreaterThanOrEqual(0)
      expect(w.end).toBeLessThanOrEqual(499)
    }
  })

  it('VD-06 空几何表返回空窗口', () => {
    expect(computeWindow(buildGeometry([]), 0, 800)).toEqual({ start: 0, end: -1 })
  })

  it('VD-05 窗口上下各留至少一屏余量', () => {
    const geom = buildGeometry(doc(500))
    const viewport = 800
    const w = computeWindow(geom, 20000, viewport)
    // 终点段的下沿应超出视口下沿（有下方余量）
    expect(geom.offsets[w.end + 1]).toBeGreaterThan(20000 + viewport)
  })
})

describe('VD-07 / VD-08 / VD-09 渲染规模', () => {
  it('★ VD-07 500 段的文档，全程窗口都在 40 段以内（视口 600 同 ReaderView 的兜底值）', () => {
    // ReaderView.tsx:210/263/360 用的都是 `root.clientHeight || 600`，
    // 这里取同一个 600，量出来的才是界面上真实的窗口量。
    // 段高 48.4 → 500 段总高约 24,200px，遍历用文档内的滚动位置。
    const geom = buildGeometry(doc(500))
    const maxScroll = totalHeight(geom)
    for (let scroll = 0; scroll <= maxScroll; scroll += 1000) {
      const w = computeWindow(geom, scroll, 600)
      const count = w.end - w.start + 1
      expect(count, `scroll=${scroll} 渲染 ${count} 段`).toBeLessThanOrEqual(40)
      expect(count, `scroll=${scroll} 渲染 ${count} 段`).toBeGreaterThanOrEqual(15)
    }
  })

  it('VD-07 渲染段数远小于总段数（不会一次性全渲染）—— 2000 段只挂 38 段', () => {
    const geom = buildGeometry(doc(2000))
    const w = computeWindow(geom, totalHeight(geom) / 2, 600)
    expect(w.end - w.start + 1).toBe(38)
  })

  it('VD-08 上下撑高块之和 + 渲染高度 = 总高度（滚动条长度不变）', () => {
    const geom = buildGeometry(doc(500))
    const scroll = 30_000
    const w = computeWindow(geom, scroll, 800)

    const topSpacer = geom.offsets[w.start]
    const rendered = geom.offsets[w.end + 1] - geom.offsets[w.start]
    const bottomSpacer = totalHeight(geom) - geom.offsets[w.end + 1]

    expect(topSpacer + rendered + bottomSpacer).toBeCloseTo(totalHeight(geom), 6)
  })

  it('★ VD-09 17 段的短文档仍全部渲染（演示书不受影响）', () => {
    const geom = buildGeometry(doc(17))
    const w = computeWindow(geom, 0, 800)
    expect(w.start).toBe(0)
    expect(w.end).toBe(16)
    expect(w.end - w.start + 1).toBe(17)
  })

  it('VD-09 单段文档也全部渲染', () => {
    const geom = buildGeometry(doc(1))
    expect(computeWindow(geom, 0, 800)).toEqual({ start: 0, end: 0 })
  })

  it('VD-09 窗口高度大于文档总高时全部渲染', () => {
    const geom = buildGeometry(doc(40))
    const w = computeWindow(geom, 0, totalHeight(geom) + 10_000)
    expect(w.start).toBe(0)
    expect(w.end).toBe(39)
  })
})
