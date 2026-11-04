import { describe, expect, it } from 'vitest'
import {
  MAX_SENTENCE_LEN,
  normalize,
  splitParagraph,
  splitSentences,
  speaksInReadAlong,
} from '../src/features/readalong/splitSentences'

/**
 * C1 的句子切分规则 R1–R10（依据 docs/system-design.md §6.3）。
 *
 * 这套用例守着三件在演示现场会直接发作的事：
 *   · 偏移量与 text 必须逐字节一致 —— 不一致的话高亮范围会偏一位（修正 5）
 *   · 纯标点片段不能入表 —— 否则跟读会停下来"念" `------------`（修正 6）
 *   · 同一输入重复切分结果必须相同 —— 否则每次导入的句子表都不同（R10）
 */
describe('句子切分 R1–R10', () => {
  /* ---------------------------------------------------------- R1 / R2 */
  describe('R1 句末标点切分', () => {
    it('。！？… 四种都作边界', () => {
      expect(splitParagraph('甲。乙！丙？丁…', 0).map((s) => s.text)).toEqual([
        '甲。', '乙！', '丙？', '丁…',
      ])
    })

    it('标点归属前一句，不留给下一句', () => {
      const out = splitParagraph('第一句。第二句。', 0)
      expect(out[0].text).toBe('第一句。')
      expect(out[1].text).toBe('第二句。')
    })

    it('段末没有句末标点时，残余部分整段作为最后一句', () => {
      const out = splitParagraph('有标点。没有标点', 0)
      expect(out.map((s) => s.text)).toEqual(['有标点。', '没有标点'])
    })
  })

  describe('R2 分号冒号不切分', () => {
    it('；与：都不是边界', () => {
      const out = splitParagraph('甲；乙：丙。', 0)
      expect(out).toHaveLength(1)
      expect(out[0].text).toBe('甲；乙：丙。')
    })
  })

  /* -------------------------------------------------------------- R3 */
  describe('R3 配对收尾符号归属前一句', () => {
    it('右引号并入前一句', () => {
      const out = splitParagraph('他说：“你好。”然后走了。', 0)
      expect(out[0].text).toBe('他说：“你好。”')
    })

    it('下一句不以收尾符号开头', () => {
      const out = splitParagraph('（甲。）乙。', 0)
      for (let i = 1; i < out.length; i++) {
        expect(out[i].text[0]).not.toBe('）')
      }
    })

    it('各种收尾符号都认：』」）】》〉"\'', () => {
      for (const c of ['』', '」', '）', ')', '】', '》', '〉', '"', "'"]) {
        const out = splitParagraph(`甲。${c}乙。`, 0)
        expect(out[0].text, c).toBe(`甲。${c}`)
      }
    })
  })

  /* -------------------------------------------------------------- R4 */
  describe('R4 连续句末标点只算一次边界', () => {
    it('省略号 …… 不被切碎', () => {
      const out = splitParagraph('他走了……然后呢。', 0)
      expect(out[0].text).toBe('他走了……')
    })

    it('混合连续标点 ．．．． 也归一为一个边界', () => {
      const out = splitParagraph('甲．．．．乙．', 0)
      expect(out[0].text.startsWith('甲')).toBe(true)
      expect(out[0].text).toContain('．')
      expect(out.every((s) => s.text.length > 0)).toBe(true)
    })

    it('多个句末标点合并后紧接的收尾符号也并入（收尾符号用双引号 ）', () => {
      const out = splitParagraph('真的吗？！”他说。', 0)
      expect(out[0].text).toBe('真的吗？！”')
    })

    it('★ 单引号弯引号 ’ 不在 CLOSERS 表内，会被留在下一句', () => {
      // CLOSERS 里有 ASCII \' 与 "，但没有 U+2019（’）与 U+2018（‘）。
      // 现状如实钉住；是否补进表由项目组定（见测试报告的缺陷表 D-T04）
      const out = splitParagraph('真的吗？！’他说。', 0)
      expect(out.map((s) => s.text)).toEqual(['真的吗？！', '’他说。'])
    })
  })

  /* -------------------------------------------------------------- R5 */
  describe('R5 句点落在小数/编号/缩写语境时不切分', () => {
    it('小数 3.14 不切', () => {
      const out = splitParagraph('圆周率是 3.14 左右。', 0)
      expect(out).toHaveLength(1)
      expect(out[0].text).toBe('圆周率是 3.14 左右。')
    })

    it('多级编号 1.2.3 不切', () => {
      const out = splitParagraph('见 1.2.3 节。', 0)
      expect(out).toHaveLength(1)
    })

    it('全角句点 ． 同样按句点处理', () => {
      const out = splitParagraph('圆周率是 3．14 左右。', 0)
      expect(out).toHaveLength(1)
    })

    it('缩写 Mr. 不切', () => {
      const out = splitParagraph('Mr. Smith is here.', 0)
      expect(out).toHaveLength(1)
      expect(out[0].text).toBe('Mr. Smith is here.')
    })

    it('缩写 No. 不切（"No. 5 is ready."）', () => {
      const out = splitParagraph('No. 5 is ready.', 0)
      expect(out).toHaveLength(1)
    })

    it('缩写在句中也不切', () => {
      const out = splitParagraph('See Fig. 2 for details.', 0)
      expect(out).toHaveLength(1)
    })

    it('缩写大小写不敏感', () => {
      expect(splitParagraph('DR. Wang is here.', 0)).toHaveLength(1)
    })

    it('不在白名单的 etc. 会切（刻意的取舍）', () => {
      // 文档注释里写明：etc. 句末用法极常见，收进白名单会把真实断句吞掉
      expect(splitParagraph('apples, etc. Next.', 0).length).toBeGreaterThan(1)
    })

    it('真正的句子末尾句点仍然切分', () => {
      const out = splitParagraph('First one. Second one.', 0)
      expect(out.map((s) => s.text)).toEqual(['First one.', 'Second one.'])
    })

    it('句点两侧只有一个数字时不保护（"版本 2. 下一句"会切）', () => {
      const out = splitParagraph('版本 2. 下一句。', 0)
      expect(out.length).toBeGreaterThan(1)
    })
  })

  /* -------------------------------------------------------------- R6/R7 */
  describe('R6 / R7 归一化', () => {
    it('R6 段内换行、制表符、连续空白归一为单个空格', () => {
      expect(normalize('甲\n\n乙')).toBe('甲 乙')
      expect(normalize('甲\t乙')).toBe('甲 乙')
      expect(normalize('甲    乙')).toBe('甲 乙')
    })

    it('R6 全角空格也归一', () => {
      expect(normalize('甲　　乙')).toBe('甲 乙')
    })

    it('R7 零宽字符被剔除', () => {
      expect(normalize('甲\u200b乙')).toBe('甲乙')
      expect(normalize('\ufeff甲')).toBe('甲')
    })

    it('R7 首尾空白被 trim', () => {
      expect(normalize('  甲  ')).toBe('甲')
      expect(normalize('\n\n甲\n\n')).toBe('甲')
    })

    it('R7 偏移量以归一化后的文本为准', () => {
      const out = splitParagraph('  第一句。第二句。  ', 0)
      const s = normalize('  第一句。第二句。  ')
      for (const sent of out) {
        expect(s.slice(sent.startOffset, sent.endOffset)).toBe(sent.text)
      }
    })
  })

  /* -------------------------------------------------------------- R8 */
  describe('R8 超长句在软标点处强制切分', () => {
    it('上限常量是 200', () => {
      expect(MAX_SENTENCE_LEN).toBe(200)
    })

    it('超过 200 字且逗号在范围内的，在逗号后切开', () => {
      // 180 字 + 逗号 + 40 字：切点落在逗号后
      const long = '甲'.repeat(180) + '，' + '乙'.repeat(40) + '。'
      const out = splitParagraph(long, 0)
      expect(out.length).toBeGreaterThan(1)
      expect(out[0].endOffset).toBeLessThanOrEqual(200)
    })

    it('回溯范围内没有软标点时按 200 字硬切', () => {
      const long = '甲'.repeat(500) + '。'
      const out = splitParagraph(long, 0)
      expect(out.length).toBeGreaterThanOrEqual(3)
      // 第一段恰好 200 字（硬切）
      expect(out[0].text.length).toBe(200)
    })

    it('顿号 、 同样算软标点', () => {
      const long = '甲'.repeat(180) + '、' + '乙'.repeat(60) + '。'
      const out = splitParagraph(long, 0)
      expect(out.length).toBeGreaterThan(1)
      expect(out[0].text.endsWith('、')).toBe(true)
    })

    it('每段都不超过 200 字', () => {
      const long = '甲'.repeat(1000) + '。'
      for (const s of splitParagraph(long, 0)) {
        expect(s.text.length).toBeLessThanOrEqual(MAX_SENTENCE_LEN)
      }
    })

    it('恰好 200 字不切', () => {
      const out = splitParagraph('甲'.repeat(200), 0)
      expect(out).toHaveLength(1)
    })
  })

  /* -------------------------------------------------------------- R9 */
  describe('R9 纯空白、纯标点、零长片段不入表', () => {
    it('空段返回空数组', () => {
      expect(splitParagraph('', 0)).toEqual([])
      expect(splitParagraph('   ', 0)).toEqual([])
      expect(splitParagraph('\n\t ', 0)).toEqual([])
    })

    it('★ 纯标点片段被丢弃（整段就是分隔线时切出零句）', () => {
      const out = splitParagraph('------------', 0)
      expect(out).toEqual([])
    })

    it('分隔线紧贴正文时并入前一句（R1 的边界在句末标点处，分隔线落在下一句区间里）', () => {
      // 现状如实钉住：`------------` 本身不含句末标点，所以它不会被单独切出来，
      // 而是与后面的正文同属一个区间。见测试报告缺陷表 D-T03。
      const out = splitParagraph('正文一。------------正文二。', 0)
      expect(out.map((s) => s.text)).toEqual(['正文一。', '------------正文二。'])
    })

    it('★ 单独的省略号片段被丢弃', () => {
      const out = splitParagraph('甲。 ……', 0)
      expect(out.map((s) => s.text)).toEqual(['甲。'])
    })

    it('省略号紧贴前句时并入前句（R1：… 本身即边界且归前一句）', () => {
      const out = splitParagraph('甲。……乙。', 0)
      expect(out.map((s) => s.text)).toEqual(['甲。……', '乙。'])
    })

    it('标点加空格的片段也丢弃', () => {
      const out = splitParagraph('甲。  ！ 乙。', 0)
      expect(out.map((s) => s.text)).toEqual(['甲。', '乙。'])
    })

    it('字母、数字、表意文字都算有内容', () => {
      expect(splitParagraph('abc', 0)).toHaveLength(1)
      expect(splitParagraph('123', 0)).toHaveLength(1)
      expect(splitParagraph('汉字', 0)).toHaveLength(1)
    })

    it('中文标点包着的汉字仍算有内容', () => {
      expect(splitParagraph('「甲」', 0)).toHaveLength(1)
    })
  })

  /* ------------------------------------------------- 偏移量一致性（修正 5） */
  describe('修正 5：text 与 slice(startOffset, endOffset) 必须逐字节一致', () => {
    it('★ 句末边界后紧跟空格时，下一句不带前导空格', () => {
      // 这是真实英文正文的形状："The end. Next one."
      const src = 'The end. Next one.'
      const out = splitParagraph(src, 0)
      expect(out.map((s) => s.text)).toEqual(['The end.', 'Next one.'])
      expect(out[1].startOffset).toBe(src.indexOf('Next'))
    })

    it('多空格分隔时同样对齐（偏移量相对**归一化后**的文本，这是 R7 明写的口径）', () => {
      const src = '甲。   乙。'
      const norm = normalize(src) // '甲。 乙。' —— 连续空白先收成一个
      const out = splitParagraph(src, 0)
      for (const s of out) {
        expect(norm.slice(s.startOffset, s.endOffset)).toBe(s.text)
      }
      expect(out[1].text).toBe('乙。')
      expect(out[1].startOffset).toBe(norm.indexOf('乙'))
    })
    it('每个片段都满足 slice 一致（随机长文本）', () => {
      const src =
        'First sentence here. Second one! Third? Then a long run of text ' +
        'that keeps going for a while, with commas, and stops. Done.'
      const out = splitParagraph(src, 0)
      for (const s of out) {
        expect(src.slice(s.startOffset, s.endOffset)).toBe(s.text)
      }
    })

    it('偏移量严格递增且不重叠', () => {
      const out = splitParagraph('甲。乙。丙。丁。', 0)
      for (let i = 1; i < out.length; i++) {
        expect(out[i].startOffset).toBeGreaterThanOrEqual(out[i - 1].endOffset)
      }
    })

    it('paraIndex 被原样带下来', () => {
      const out = splitParagraph('甲。乙。', 7)
      expect(out.every((s) => s.paraIndex === 7)).toBe(true)
    })
  })

  /* -------------------------------------------------------------- R10 */
  describe('R10 纯函数：同一输入重复切分逐字节相同', () => {
    it('连切三次结果一致', () => {
      const src = '第一句。第二句！第三句？还有一句没有标点'
      const a = JSON.stringify(splitParagraph(src, 0))
      const b = JSON.stringify(splitParagraph(src, 0))
      const c = JSON.stringify(splitParagraph(src, 0))
      expect(a).toBe(b)
      expect(b).toBe(c)
    })

    it('缩写表与正则的 lastIndex 不残留状态（跨调用不串味）', () => {
      // 正则带 /g 时 lastIndex 会残留，导致第二次调用结果不同。
      // 这里连打两次同样的输入，中间插一次别的输入，结果必须一样。
      const first = splitParagraph('Mr. Smith is here.', 0)
      splitParagraph('别的内容。', 0)
      const second = splitParagraph('Mr. Smith is here.', 0)
      expect(second).toEqual(first)
    })
  })

  /* ------------------------------------------------- speaksInReadAlong */
  describe('speaksInReadAlong —— 标题与图片段不跟读', () => {
    it('h1 / h2 / img 不参与跟读', () => {
      expect(speaksInReadAlong('h1')).toBe(false)
      expect(speaksInReadAlong('h2')).toBe(false)
      expect(speaksInReadAlong('img')).toBe(false)
    })

    it('正文段落参与跟读', () => {
      expect(speaksInReadAlong('p')).toBe(true)
    })

    it('未知类型默认参与（宽松兜底）', () => {
      expect(speaksInReadAlong('whatever')).toBe(true)
    })
  })

  /* -------------------------------------------------------- 整篇切分 */
  describe('splitSentences —— 整篇切分与全局句序', () => {
    it('标题段与图片段被跳过，不占句序', () => {
      const out = splitSentences([
        { paraIndex: 0, type: 'h1', text: '第一章' },
        { paraIndex: 1, type: 'p', text: '甲。乙。' },
        { paraIndex: 2, type: 'img', text: '' },
        { paraIndex: 3, type: 'p', text: '丙。' },
      ])
      expect(out.map((s) => s.text)).toEqual(['甲。', '乙。', '丙。'])
    })

    it('sentenceIndex 全局连续递增，从 0 起', () => {
      const out = splitSentences([
        { paraIndex: 0, type: 'p', text: '甲。乙。' },
        { paraIndex: 1, type: 'p', text: '丙。' },
      ])
      expect(out.map((s) => s.sentenceIndex)).toEqual([0, 1, 2])
    })

    it('paraIndex 保留原段落号（跳过的段落不影响）', () => {
      const out = splitSentences([
        { paraIndex: 0, type: 'h1', text: '章名' },
        { paraIndex: 5, type: 'p', text: '甲。' },
      ])
      expect(out[0].paraIndex).toBe(5)
      expect(out[0].sentenceIndex).toBe(0)
    })

    it('空文档切出零句', () => {
      expect(splitSentences([])).toEqual([])
    })

    it('全是标题的文档切出零句（不会误判成正文）', () => {
      const out = splitSentences([
        { paraIndex: 0, type: 'h1', text: '第一章' },
        { paraIndex: 1, type: 'h2', text: '第一节' },
      ])
      expect(out).toEqual([])
    })

    it('★ 演示书的形状：17 段中文正文能切出稳定句数', () => {
      const paras = Array.from({ length: 17 }, (_, i) => ({
        paraIndex: i,
        type: i === 0 ? 'h1' : 'p',
        text: i === 0 ? '人间词话' : `第${i}段的第一句。第${i}段的第二句。`,
      }))
      const out = splitSentences(paras)
      expect(out).toHaveLength(16 * 2)
      expect(out[0].sentenceIndex).toBe(0)
      expect(out[out.length - 1].sentenceIndex).toBe(31)
    })
  })
})
