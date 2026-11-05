/**
 * 在真实浏览器里生成一本最小但**结构合法**的 EPUB 3。
 *
 * 为什么在 Playwright 这一层测 EPUB：
 *
 *   `client/src/features/parse/epub.ts` 用的是 epub.js，而 epub.js 的
 *   `section.load()` 依赖 DOM（解析 XHTML 章节）。在 Node 环境里直接跑
 *   `parseEpub` 会**静默挂住**（实测 30s 超时）—— 它没有可以用的 document。
 *   要用 jsdom 补替身才行，但已知的 D-04 / D-05 / D-06 三个缺陷
 *   （object URL 泄漏、包内路径前导斜杠、`<figure><img/></figure>` 漏图）
 *   全是**真机才暴露**的那一类，用替身测等于把这三条重新盖回去。
 *
 *   所以 EPUB 走端到端：真实浏览器 + 真实 ZIP + 完整导入链路。
 *
 * jszip 是 epubjs 的传递依赖，已经在 node_modules 里；这里用它造包，
 * 不新增依赖。
 */
import JSZip from 'jszip'

export interface EpubFixtureOptions {
  title?: string
  author?: string
  /**
   * 图片在 ch1.xhtml 里的相对引用，以及它在包内的实际位置。
   *
   * 默认两者**自洽**：章节在 `OEBPS/ch1.xhtml`、图片在 `OEBPS/images/x.png`，
   * 所以正确的相对引用是 `images/x.png`（**不是** `../images/x.png` ——
   * `..` 会从 OEBPS 上跳到包根，`epub.ts` 的 joinPath 如实折叠成 `/images/x.png`，
   * 那时靠的是 readImage 的"按文件名兜底匹配"才捞回来）。
   * 默认自洽才能真的验到"相对路径解析"这条主路径。
   *
   * 要造"路径写法古怪、只能靠兜底匹配"的场景，显式传不相符的 imageHref / imagePath。
   */
  imageHref?: string
  imagePath?: string
  /** 图片所在的结构。figure = <figure><img/></figure>（D-06 的漏图场景） */
  imageWrap?: 'figure' | 'bare'
  /** 章节正文段落 */
  paragraphs?: string[]
  heading?: string
  /** 显式指定包内图片文件名（不传则自动生成唯一名） */
  imageName?: string
}

/** 1×1 透明 PNG */
export const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export async function makeEpub(opts: EpubFixtureOptions = {}): Promise<Buffer> {
  // 唯一的图片文件名，避开缺陷 D-T01（见 imageHref 的说明）
  const uniq = `fig_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
  const imageName = opts.imageName ?? `${uniq}.png`

  const {
    title = '测试 EPUB',
    author = '测试作者',
    imageHref = `images/${imageName}`,
    imagePath = `OEBPS/images/${imageName}`,
    imageWrap = 'figure',
    paragraphs = ['这是第一段正文。它有第二句话。', '这是第二段。'],
    heading = '第一章 起',
  } = opts

  const zip = new JSZip()

  // mimetype 必须是第一个条目且不压缩（EPUB 规范），jszip 的 store 对应不压缩
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  )

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:zhiyin-e2e-fixture</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="fig1" href="images/${imageName}" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`,
  )

  const body =
    imageWrap === 'figure'
      ? `<figure><img src="${imageHref}" alt="插图说明"/><figcaption>图注文字</figcaption></figure>`
      : `<img src="${imageHref}" alt="插图说明"/>`

  zip.file(
    'OEBPS/ch1.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${heading}</title></head>
<body>
<h1>${heading}</h1>
${paragraphs.map((t) => `<p>${t}</p>`).join('\n')}
${body}
</body>
</html>`,
  )

  zip.file(imagePath, Buffer.from(PNG_1X1_B64, 'base64'))

  const out = await zip.generateAsync({ type: 'nodebuffer' })
  return out as Buffer
}
