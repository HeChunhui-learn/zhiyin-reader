import { describe, expect, it } from 'vitest'
import { parseTxt } from '../src/features/parse/txt'

/**
 * PA-01 ~ PA-05 TXT 解析。
 *
 * 这里有两处是**踩过坑之后**才定下来的规则，用例专门守着它们：
 *   · 标题行单独成段（D：盗版站导出的 TXT 章节标题与正文之间没有空行，
 *     原先把整块标成 h1，导致整本书一句都读不了）
 *   · 书名取自第一个一级标题
 */
describe('TXT 解析（PA-01 ~ PA-05）', () => {
  it('PA-01 按空行分段，段数等于空行块数', () => {
    const r = parseTxt('第一段。\n\n第二段。\n\n第三段。', '书.txt')
    expect(r.paragraphs.map((p) => p.text)).toEqual(['第一段。', '第二段。', '第三段。'])
  })

  it('没有空行时按单行分段', () => {
    const r = parseTxt('第一行\n第二行\n第三行', '书.txt')
    expect(r.paragraphs.map((p) => p.text)).toEqual(['第一行', '第二行', '第三行'])
  })

  it('PA-02 「第 X 章」判 h1', () => {
    const r = parseTxt('第一章 初识\n\n正文。', '书.txt')
    expect(r.paragraphs[0]).toMatchObject({ type: 'h1', text: '第一章 初识' })
  })

  it('PA-03 「第 X 节」判 h2', () => {
    const r = parseTxt('第一节 引子\n\n正文。', '书.txt')
    expect(r.paragraphs[0]).toMatchObject({ type: 'h2', text: '第一节 引子' })
  })

  it('PA-04 段内换行合并，中文之间不补空格', () => {
    const r = parseTxt('知音\n漫卷\n\n下一段。', '书.txt')
    expect(r.paragraphs[0].text).toBe('知音漫卷')
  })

  it('PA-05 书名取自第一个一级标题', () => {
    const r = parseTxt('人间词话\n\n正文。', 'fallback.txt')
    // 「人间词话」不是标题格式，书名退回文件名
    expect(r.title).toBe('fallback')

    const r2 = parseTxt('第一章 人间词话\n\n正文。', 'fallback.txt')
    expect(r2.title).toBe('第一章 人间词话')
  })

  it('★ 标题行单独成段，剩下的行是正文（盗版 TXT 的典型形状）', () => {
    // 章节标题与正文之间**没有空行** —— 整块不能被吃成一个标题段
    const r = parseTxt('第一章 初识\n这是正文第一句。这是正文第二句。', '书.txt')
    expect(r.paragraphs).toHaveLength(2)
    expect(r.paragraphs[0]).toMatchObject({ type: 'h1', text: '第一章 初识' })
    expect(r.paragraphs[1]).toMatchObject({ type: 'p', text: '这是正文第一句。这是正文第二句。' })
  })

  it('书名不会取到整章（同上的连带后果）', () => {
    const r = parseTxt('第一章 初识\n很长很长的一段正文，足足有几十个字。', '书.txt')
    expect(r.title).toBe('第一章 初识')
  })

  it('只取第一个一级标题当书名，后面的章名不覆盖', () => {
    const r = parseTxt('第一章 甲\n\n第二章 乙', '书.txt')
    expect(r.title).toBe('第一章 甲')
  })

  it('paraIndex 从 0 连续递增', () => {
    const r = parseTxt('第一章 甲\n\n正文一。\n\n正文二。', '书.txt')
    expect(r.paragraphs.map((p) => p.paraIndex)).toEqual([0, 1, 2])
  })

  it('空文件与纯空白文件解析出零段落（对应契约的 422 PARSE_FAILED）', () => {
    expect(parseTxt('', '书.txt').paragraphs).toHaveLength(0)
    expect(parseTxt('   \n\n  \n', '书.txt').paragraphs).toHaveLength(0)
  })

  it('井号标题也认（Markdown 风格的 TXT）', () => {
    const r = parseTxt('# 卷首\n\n正文。', '书.txt')
    expect(r.paragraphs[0]).toMatchObject({ type: 'h1', text: '卷首' })
  })

  it('TXT 解析不产生 imageRefs', () => {
    expect(parseTxt('正文。', '书.txt').imageRefs).toEqual([])
  })

  it('作者缺省为「未知」', () => {
    expect(parseTxt('正文。', '书.txt').author).toBe('未知')
    expect(parseTxt('正文。', '书.txt', '王国维').author).toBe('王国维')
  })

  it('CRLF 换行与 LF 等价', () => {
    const lf = parseTxt('甲。\n\n乙。', '书.txt')
    const crlf = parseTxt('甲。\r\n\r\n乙。', '书.txt')
    expect(crlf.paragraphs).toEqual(lf.paragraphs)
  })
})
