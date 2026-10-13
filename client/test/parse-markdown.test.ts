import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../src/features/parse/markdown'

/**
 * PA-06 ~ PA-08、D-01：Markdown 解析。
 *
 * D-01 是本仓库真实踩过的缺陷：图片语法原样出现在正文里，
 * 阅读器把 `![封面](images/cover.jpg)` 当文字显示出来。用例守着它不再回来。
 */
describe('Markdown 解析（PA-06 ~ PA-08 / D-01）', () => {
  it('PA-06 `#` → h1，`##` → h2', () => {
    const r = parseMarkdown('# 卷一\n\n## 第一节\n\n正文。', '书.md')
    expect(r.paragraphs[0]).toMatchObject({ type: 'h1', text: '卷一' })
    expect(r.paragraphs[1]).toMatchObject({ type: 'h2', text: '第一节' })
  })

  it('PA-06 三级以上标题也归 h2', () => {
    const r = parseMarkdown('### 三级\n\n正文。', '书.md')
    expect(r.paragraphs[0].type).toBe('h2')
  })

  it('书名取自第一个一级标题', () => {
    const r = parseMarkdown('# 人间词话\n\n正文。', 'fallback.md')
    expect(r.title).toBe('人间词话')
  })

  it('没有一级标题时书名退回文件名', () => {
    const r = parseMarkdown('## 只有二级\n\n正文。', '人间词话.md')
    expect(r.title).toBe('人间词话')
  })

  it('PA-07 图片抽成 imageRefs，正文里不再保留图片语法', () => {
    const r = parseMarkdown('段落一。\n\n![封面](images/cover.jpg)\n', '书.md')
    expect(r.imageRefs).toHaveLength(1)
    expect(r.imageRefs[0]).toMatchObject({ src: 'images/cover.jpg', alt: '封面' })
  })

  it('D-01 ★ 图片语法绝不漏进正文文字', () => {
    const r = parseMarkdown('![封面](images/cover.jpg)\n', '书.md')
    for (const p of r.paragraphs) {
      expect(p.text).not.toContain('![')
      expect(p.text).not.toContain('images/cover.jpg')
    }
  })

  it('PA-08 纯图片段落记为 img 类型，文字留空', () => {
    const r = parseMarkdown('![封面](images/cover.jpg)\n', '书.md')
    const img = r.paragraphs.find((p) => p.type === 'img')
    expect(img).toBeDefined()
    expect(img!.text).toBe('')
  })

  it('正文里混排的图片只记 imageRefs，段落文字保留图片外的部分', () => {
    const r = parseMarkdown('前文 ![图](a.png) 后文\n', '书.md')
    expect(r.imageRefs).toHaveLength(1)
    expect(r.imageRefs[0].src).toBe('a.png')
    expect(r.paragraphs[0].text).toBe('前文  后文')
  })

  it('imageId 是确定性哈希，同一份文件重复解析结果相同', () => {
    const a = parseMarkdown('![图](a.png)\n', '书.md')
    const b = parseMarkdown('![图](a.png)\n', '书.md')
    expect(a.imageRefs[0].imageId).toBe(b.imageRefs[0].imageId)
    expect(a.imageRefs[0].imageId).toMatch(/^img_[0-9a-f]{12}$/)
  })

  it('同一张图出现在不同段落时 imageId 不同（不会被主键顶掉）', () => {
    const r = parseMarkdown('![图](a.png)\n\n![图](a.png)\n', '书.md')
    expect(r.imageRefs).toHaveLength(2)
    expect(r.imageRefs[0].imageId).not.toBe(r.imageRefs[1].imageId)
  })

  it('段落序号与 imageRefs 的 paraIndex 对得上', () => {
    const r = parseMarkdown('段落。\n\n![图](a.png)\n', '书.md')
    const imgPara = r.paragraphs.findIndex((p) => p.type === 'img')
    expect(r.imageRefs[0].paraIndex).toBe(imgPara)
  })

  it('列表项各成一段', () => {
    const r = parseMarkdown('- 甲\n- 乙\n', '书.md')
    expect(r.paragraphs.map((p) => p.text)).toEqual(['甲', '乙'])
  })

  it('引用块当正文段落', () => {
    const r = parseMarkdown('> 引用的话\n', '书.md')
    expect(r.paragraphs[0]).toMatchObject({ type: 'p', text: '引用的话' })
  })

  it('代码块保留原文', () => {
    const r = parseMarkdown('```\nconst a = 1\n```\n', '书.md')
    expect(r.paragraphs[0].text).toContain('const a = 1')
  })

  it('水平分隔线与空行被忽略', () => {
    const r = parseMarkdown('甲。\n\n---\n\n乙。\n', '书.md')
    expect(r.paragraphs.map((p) => p.text)).toEqual(['甲。', '乙。'])
  })

  it('paraIndex 连续递增，img 段也占一个号', () => {
    const r = parseMarkdown('# 标题\n\n正文。\n\n![图](a.png)\n', '书.md')
    expect(r.paragraphs.map((p) => p.paraIndex)).toEqual([0, 1, 2])
  })

  it('空文档解析出零段落', () => {
    expect(parseMarkdown('', '书.md').paragraphs).toHaveLength(0)
  })
})
