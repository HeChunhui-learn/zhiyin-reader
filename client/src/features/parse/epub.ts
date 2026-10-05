import ePubDefault from 'epubjs'
import { sha256Hex } from './sha256'
import {
  normalizeText,
  stripExt,
  type ParseResult,
  type ParsedImageRef,
  type ParsedParagraph,
} from './types'

/**
 * EPUB 解析。
 *
 * 按技术选型：**epub.js 只承担"解析"**——拿元数据、spine 顺序与每一章的 Document；
 * 渲染层完全自研，不碰 epub.js 的 rendition/iframe。这样 EPUB 与 TXT/Markdown
 * 共用同一条渲染管线（见《技术选型说明》2.2 与 .context/09）。
 *
 * 图片从压缩包里取出 Blob，交给调用方写进 IndexedDB，再按契约 §4.3 懒上传。
 */

export interface EpubParseResult extends ParseResult {
  /** imageId → 图片二进制。调用方负责写进缓存 */
  imageBlobs: Map<string, Blob>
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

/**
 * epub.js 的打包形态因工具而异：package.json 的 `module` 指向 ESM 源码
 * （Vite 走这条，default 就是函数），`main` 指向 Babel 编译后的 CJS
 * （Node/CommonJS 互操作拿到的是命名空间对象，真正的函数在 .default 上）。
 * 这里两种都认，避免"浏览器里好好的、别处就 TypeError"。
 */
const ePub: typeof ePubDefault =
  typeof ePubDefault === 'function'
    ? ePubDefault
    : (ePubDefault as unknown as { default: typeof ePubDefault }).default

function mimeOf(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/**
 * 在压缩包的路径空间里做一次拼接与 .. 折叠。
 *
 * **前导斜杠必须保留**：epub.js 的 Archive.getBlob 实现里是
 * `url.substr(1)`（写死了"去掉第一个字符"），所以它只认 `/OEBPS/images/x.png`
 * 这种带前导斜杠的形式；section.url 本身也是这个形式。
 */
function joinPath(dir: string, rel: string): string {
  const lead = dir.startsWith('/') || rel.startsWith('/') ? '/' : ''
  const parts = (dir ? dir.split('/') : []).concat(rel.split('/'))
  const out: string[] = []
  for (const seg of parts) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return lead + out.join('/')
}

/** epub.js 的 archive 里挂着 JSZip 实例，用它列条目、按后缀兜底匹配 */
function zipEntries(book: unknown): string[] {
  const zip = (book as { archive?: { zip?: { files?: Record<string, unknown> } } })
    .archive?.zip
  if (!zip?.files) return []
  return Object.keys(zip.files).filter((n) => !n.endsWith('/'))
}

/** 一次 DOM 遍历的产出 */
interface WalkOut {
  paragraphs: ParsedParagraph[]
  images: { paraIndex: number; src: string; alt: string }[]
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'FIGURE', 'FIGCAPTION',
])

/**
 * 深度优先遍历一章的 body。
 * 遇到块级元素继续下钻，遇到叶子元素就把文字收成一段；
 * 只含图片的段落记成 img 类型（与 Markdown 解析器的约定一致）。
 */
function walk(node: Element, out: WalkOut): void {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName.toUpperCase()

    if (tag === 'SCRIPT' || tag === 'STYLE') continue

    // 图片直接作为子元素出现（<figure><img/><figcaption/></figure>）。
    // querySelectorAll 查不到元素自己，所以要单独处理，否则会漏图。
    if (tag === 'IMG') {
      const paraIndex = out.paragraphs.length
      out.paragraphs.push({ paraIndex, type: 'img', text: '' })
      out.images.push({
        paraIndex,
        src: child.getAttribute('src') ?? '',
        alt: child.getAttribute('alt') ?? '',
      })
      continue
    }

    const hasBlockChild = Array.from(child.children).some((c) =>
      BLOCK_TAGS.has(c.tagName.toUpperCase()),
    )

    if (hasBlockChild) {
      walk(child, out)
      continue
    }

    // 收集本元素里的文字与图片
    const text = normalizeText(child.textContent ?? '').replace(/\s+/g, ' ').trim()
    const imgs = Array.from(child.querySelectorAll('img'))

    if (imgs.length > 0) {
      const paraIndex = out.paragraphs.length
      out.paragraphs.push({ paraIndex, type: 'img', text: '' })
      for (const img of imgs) {
        out.images.push({
          paraIndex,
          src: img.getAttribute('src') ?? '',
          alt: img.getAttribute('alt') ?? '',
        })
      }
      // 图注之类的文字作为紧随其后的一段
      if (text) {
        out.paragraphs.push({
          paraIndex: out.paragraphs.length,
          type: 'p',
          text,
        })
      }
      continue
    }

    if (!text) continue

    const level = /^H([1-6])$/.exec(tag)
    out.paragraphs.push({
      paraIndex: out.paragraphs.length,
      type: level ? (level[1] === '1' ? 'h1' : 'h2') : 'p',
      text,
    })
  }
}

export async function parseEpub(file: File, fileName = file.name): Promise<EpubParseResult> {
  const buffer = await file.arrayBuffer()

  // epub.js 的构造函数收到非字符串（ArrayBuffer/Blob）就按二进制电子书处理。
  //
  // replacements 必须显式关掉：epub.js 在 archived（二进制）模式下默认取 "blobUrl"，
  // 会为书内每一条资源创建一个 object URL 且由它自己持有——我们不用它的渲染层，
  // 也就永远拿不到那些 URL 去 revoke，等于给每张图都留一份泄漏（04 §4.1.3 要求回收）。
  const book = ePub(buffer, { replacements: 'none' })
  await book.ready

  let title = stripExt(fileName)
  let author = '未知'
  try {
    const meta = await book.loaded.metadata
    if (meta?.title?.trim()) title = meta.title.trim()
    if (meta?.creator?.trim()) author = meta.creator.trim()
  } catch {
    /* 元数据缺失就用文件名兜底 */
  }

  const entries = zipEntries(book)
  const paragraphs: ParsedParagraph[] = []
  const imageRefs: ParsedImageRef[] = []
  const imageBlobs = new Map<string, Blob>()

  const sections: ReturnType<typeof book.spine.get>[] = []
  book.spine.each((s: ReturnType<typeof book.spine.get>) => sections.push(s))

  for (const section of sections) {
    // linear="no" 的是封面、版权页这类不参与正文顺序的内容
    if (section.linear === false) continue

    try {
      await section.load(book.load.bind(book))
    } catch {
      continue // 单章读不出来不影响整本书
    }

    const doc = section.document as Document | undefined
    if (!doc?.body) continue

    const out: WalkOut = { paragraphs: [], images: [] }
    walk(doc.body, out)

    // 本章段落接进全书序号
    const offset = paragraphs.length
    for (const p of out.paragraphs) {
      paragraphs.push({ ...p, paraIndex: offset + p.paraIndex })
    }

    // 取图片二进制
    const baseDir = dirOf(section.url ?? '')
    for (const im of out.images) {
      const paraIndex = offset + im.paraIndex
      const rawSrc = decodeURIComponent(im.src)
      if (!rawSrc) continue

      const resolved = joinPath(baseDir, rawSrc)
      const blob = await readImage(book, resolved, entries, rawSrc)
      if (!blob) continue

      // imageId 里带上段落号：同一张图在同一文档里出现多次时不会被主键顶掉
      const imageId = `img_${sha256Hex(`${resolved}#${paraIndex}`).slice(0, 12)}`
      imageRefs.push({ imageId, paraIndex, src: resolved, alt: im.alt })
      imageBlobs.set(imageId, blob)
    }
  }

  return { paragraphs, imageRefs, title, author, imageBlobs }
}

/**
 * 从压缩包里取一张图。
 * 路径先按"章节所在目录 + 图片相对路径"折叠，取不到再按文件名兜底匹配 ——
 * 真实 EPUB 的图片路径写法五花八门，只靠一次精确匹配不够稳。
 */
async function readImage(
  book: ReturnType<typeof ePub>,
  resolved: string,
  entries: string[],
  rawSrc: string,
): Promise<Blob | null> {
  const withSlash = (p: string) => (p.startsWith('/') ? p : `/${p}`)

  const tryPaths = [
    withSlash(resolved),
    withSlash(resolved.replace(/^\.\//, '')),
    rawSrc.startsWith('/') ? rawSrc : '', // 少数 EPUB 直接写包内绝对路径
  ].filter(Boolean)

  for (const p of tryPaths) {
    try {
      const blob = await book.archive.getBlob(p, mimeOf(p))
      if (blob && blob.size > 0) return blob
    } catch {
      /* 换下一个候选 */
    }
  }

  // 兜底：按文件名找唯一匹配（真实 EPUB 的路径写法五花八门）
  const base = resolved.split('/').pop()
  if (base) {
    const hits = entries.filter((e) => e.split('/').pop() === base)
    if (hits.length === 1) {
      try {
        const blob = await book.archive.getBlob(withSlash(hits[0]), mimeOf(hits[0]))
        if (blob && blob.size > 0) return blob
      } catch {
        /* 放弃这张图 */
      }
    }
  }
  return null
}
