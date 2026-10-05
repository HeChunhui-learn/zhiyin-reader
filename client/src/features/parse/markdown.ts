import { marked } from 'marked'
import { sha256Hex } from './sha256'
import {
  normalizeText,
  stripExt,
  type ParseResult,
  type ParsedImageRef,
  type ParsedParagraph,
} from './types'

/**
 * Markdown 解析：用 marked 的 lexer 拿 AST，不走 HTML 渲染。
 * 图片从行内 token 里抽出来单独记成 imageRefs（正文里不再保留图片语法）。
 */

interface MdToken {
  type: string
  depth?: number
  text?: string
  raw?: string
  href?: string
  tokens?: MdToken[]
  items?: MdToken[]
}

/** 把行内 token 拼成纯文本；图片 token 返回空串，它由 collectImages 单独收走 */
function inlineText(tokens: MdToken[] = []): string {
  return tokens
    .map((t) => {
      if (t.type === 'image') return ''
      if (t.type === 'br') return ' '
      if (t.tokens) return inlineText(t.tokens)
      return t.text ?? ''
    })
    .join('')
}

function hasImage(tokens: MdToken[] = []): boolean {
  for (const t of tokens) {
    if (t.type === 'image') return true
    if (t.tokens && hasImage(t.tokens)) return true
  }
  return false
}

/** 兜底用：万一走到 raw text，也得把图片语法剔掉，不能漏进正文 */
function stripImageSyntax(s: string): string {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim()
}

function collectImages(
  tokens: MdToken[] = [],
  paraIndex: number,
  out: ParsedImageRef[],
): void {
  for (const t of tokens) {
    if (t.type === 'image') {
      const src = t.href ?? ''
      out.push({
        // 由 src 与段落号推出的稳定标识（同一份文件重复解析结果不变），
        // 契约说的是"客户端生成的 UUID"，这里取确定性哈希，
        // 好处是懒上传与缓存键在多次解析之间对得上。
        // 带上 paraIndex 是为了让同一张图在同一文档里出现多次时不被主键顶掉。
        imageId: `img_${sha256Hex(`${src}#${paraIndex}`).slice(0, 12)}`,
        paraIndex,
        src,
        alt: t.text ?? '',
      })
    } else if (t.tokens) {
      collectImages(t.tokens, paraIndex, out)
    }
  }
}

export function parseMarkdown(raw: string, fileName: string, author = '未知'): ParseResult {
  const text = normalizeText(raw)
  const tokens = marked.lexer(text) as unknown as MdToken[]

  const paragraphs: ParsedParagraph[] = []
  const imageRefs: ParsedImageRef[] = []
  let title = stripExt(fileName)
  let titleLocked = false

  const push = (type: ParsedParagraph['type'], value: string, from?: MdToken[]) => {
    const body = value.trim()
    // 纯图片段落 text 可以为空（图片信息在 imageRefs 里），其余类型空段落丢弃
    if (!body && type !== 'img') return
    const paraIndex = paragraphs.length
    paragraphs.push({ paraIndex, type, text: body })
    if (from) collectImages(from, paraIndex, imageRefs)
  }

  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const level = (t.depth ?? 1) === 1 ? 'h1' : 'h2'
        const body = inlineText(t.tokens) || stripImageSyntax(t.text ?? '')
        if (level === 'h1' && !titleLocked) {
          title = body.trim() || title
          titleLocked = true
        }
        push(level, body, t.tokens)
        break
      }
      case 'paragraph': {
        const body = inlineText(t.tokens)
        if (!body.trim() && hasImage(t.tokens)) {
          // 整段只有图片：记成 img 段落，文字留空，图片信息进 imageRefs
          push('img', '', t.tokens)
        } else {
          push('p', body || stripImageSyntax(t.text ?? ''), t.tokens)
        }
        break
      }
      case 'blockquote':
      case 'code':
        // 引用与代码块统一当正文段落；代码块保留原文
        push('p', t.type === 'code' ? (t.text ?? '') : inlineText(t.tokens))
        break
      case 'list':
        for (const item of t.items ?? []) {
          push('p', inlineText(item.tokens) || stripImageSyntax(item.text ?? ''), item.tokens)
        }
        break
      default:
        break // space / hr / html 等忽略
    }
  }

  return { paragraphs, imageRefs, title, author }
}
