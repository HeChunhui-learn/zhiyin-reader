import type { ImportPayload } from '../../api/client'
import { speaksInReadAlong, splitParagraph } from '../readalong/splitSentences'
import { parseEpub } from './epub'
import { parseMarkdown } from './markdown'
import { parseTxt } from './txt'
import { normalizeText, stripExt, type ParseResult } from './types'
import { sha256Hex } from './sha256'

export * from './types'

export type FileFormat = 'TXT' | 'MD' | 'EPUB'

/** 支持的扩展名 → 服务端的 fileFormat 取值 */
export function formatOf(fileName: string): FileFormat | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  if (ext === 'txt') return 'TXT'
  if (ext === 'md' || ext === 'markdown') return 'MD'
  if (ext === 'epub') return 'EPUB'
  return null
}

export interface ParseOutcome {
  payload: ImportPayload
  /** 给界面显示用的一句话摘要 */
  summary: string
  /** EPUB 抽出来的图片，导入成功后由调用方写进 IndexedDB 缓存 */
  imageBlobs?: Map<string, Blob>
}

/**
 * 把一个本地文件解析成可以直接 POST /api/documents 的载荷。
 *
 * CLAUDE.md 裁决 1：解析全部在前端做，服务端只负责存储与分发。
 */
/**
 * 单个文件的大小上限，与服务端的 bodyLimit（index.ts 的 BODY_LIMIT）对齐。
 *
 * 在**读文件之前**就拦下来：超限的文件读进内存再失败，白等半天还占一份内存，
 * 而且那时的报错来自服务端的 413，读者看到的是"上传内容超过大小限制"，
 * 不知道到底是哪个文件、超了多少。
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${n}B`
}

export async function parseFile(file: File): Promise<ParseOutcome> {
  const format = formatOf(file.name)
  if (!format) {
    throw new Error(
      `不支持的文件格式：${file.name}。请选择 EPUB、TXT 或 Markdown 文件。`,
    )
  }

  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `「${file.name}」有 ${formatBytes(file.size)}，超过了 ${formatBytes(MAX_FILE_BYTES)} 的上限，没有导入。`,
    )
  }

  let result: ParseResult
  let imageBlobs: Map<string, Blob> | undefined

  if (format === 'EPUB') {
    const epub = await parseEpub(file)
    result = epub
    imageBlobs = epub.imageBlobs
  } else {
    const raw = await file.text()
    result = format === 'MD' ? parseMarkdown(raw, file.name) : parseTxt(raw, file.name)
  }

  if (result.paragraphs.length === 0) {
    throw new Error('这个文件里没有解析出任何段落，请确认文件内容。')
  }

  const contentHash = `sha256:${hashContent(result)}`

  const payload: ImportPayload = {
    fileName: file.name,
    fileFormat: format,
    fileSize: file.size,
    contentHash,
    title: result.title || stripExt(file.name),
    author: result.author,
    paragraphs: result.paragraphs.map((p) => ({
      paraIndex: p.paraIndex,
      type: p.type,
      text: p.text,
      // 句子也由前端切分，随段落一并上传（契约 §4.1）。
      // 只切"参与跟读"的段落 —— 与阅读器 splitSentences 同一口径，
      // 否则库里会存下阅读器永远用不到的句子（见 speaksInReadAlong 的注释）。
      sentences: speaksInReadAlong(p.type)
        ? splitParagraph(p.text, p.paraIndex).map((s, k) => ({
            sentenceIndex: k,
            startOffset: s.startOffset,
            endOffset: s.endOffset,
          }))
        : [],
    })),
    imageRefs: result.imageRefs,
  }

  const sentenceCount = payload.paragraphs.reduce((n, p) => n + p.sentences.length, 0)
  const imagePart = result.imageRefs.length ? ` · ${result.imageRefs.length} 图` : ''
  const notes = sanityNotes(result.paragraphs)
  const notePart = notes.length ? ` · ⚠ ${notes.join('；')}` : ''

  return {
    payload,
    summary: `${payload.paragraphs.length} 段 · ${sentenceCount} 句${imagePart} · ${format}${notePart}`,
    imageBlobs,
  }
}

/** 标题段的合理长度上限。真实的章节名很少超过这个数 */
const LONG_HEADING = 120

/**
 * 解析结果的自查。
 *
 * parseTxt 只在「格式不支持」和「段落数为 0」时抛错，别的一律静默返回 ——
 * 一份把整章误判成标题的文件照样导入成功，界面上一条提示都没有。
 * 这里挑几个明显不合理的形态兜个底，把话写进导入回执，
 * 免得读者对着一本读不了的书找不到原因（静默解析错比抛异常难查得多）。
 */
function sanityNotes(paragraphs: ParseResult['paragraphs']): string[] {
  const notes: string[] = []

  const longHeadings = paragraphs.filter(
    (p) => (p.type === 'h1' || p.type === 'h2') && p.text.length > LONG_HEADING,
  ).length
  if (longHeadings > 0) notes.push(`${longHeadings} 个标题异常偏长，可能识别有误`)

  return notes
}

/**
 * 内容哈希，用于导入去重（04 §4.1.2、(owner_id, content_hash) 联合唯一）。
 *
 * 文档写的是"EPUB 按 spine 顺序拼接各章节正文与资源内容后计算 SHA-256"。
 * 这里**没有把图片逐字节算进去**，用的是正文 + 图片在包内的路径：
 * 图片是二进制，纯 JS 逐字节哈希大图代价过高，而路径对同一份文件是稳定的，
 * 去重的实际效果不受影响。这一点与 04 §4.1.2 的措辞有出入，已在交付说明里记明。
 */
function hashContent(result: ParseResult): string {
  const text = result.paragraphs.map((p) => normalizeText(p.text).trim()).join('\n')
  if (result.imageRefs.length === 0) return sha256Hex(text)
  const refs = result.imageRefs.map((r) => r.src).sort().join('\n')
  return sha256Hex(`${text}\u0001${refs}`)
}
