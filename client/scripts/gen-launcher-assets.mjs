/**
 * 生成 Android 启动图标与启动图，再交给 @capacitor/assets 落到各个 mipmap / drawable。
 *
 * 图案与 src/features/brand/AppLogo.tsx 保持一致（纸卡 + 墨蓝圆景：白山、朱日、流水），
 * 只是放大成 1024/2732 的位图。改图标时两边一起改。
 *
 * 用法：node scripts/gen-launcher-assets.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = path.join(root, 'assets')

/** AppLogo 的 48×48 纸卡版本，抽出来好复用 */
const LOGO_GROUP = `
  <rect width="48" height="48" rx="12.5" fill="url(#card)"/>
  <rect x="0.65" y="0.65" width="46.7" height="46.7" rx="12.1" fill="none" stroke="#1d3f8f" stroke-opacity="0.09" stroke-width="1.1"/>

  <circle cx="24" cy="24" r="16.2" fill="url(#disc)"/>
  <circle cx="24" cy="24" r="15.2" fill="none" stroke="#ffffff" stroke-opacity="0.13" stroke-width="0.9"/>

  <g clip-path="url(#discClip)">
    <circle cx="24" cy="24" r="16.2" fill="url(#glow)"/>
    <circle cx="31.4" cy="14.9" r="3.4" fill="url(#sun)" opacity="0.95"/>
    <path d="M6.5 30.8 L14 22.6 L19.6 28.4 L24.2 21.2 L30 27.4 L33.8 23.2 L41.5 30.8 Z" fill="#ffffff" opacity="0.22"/>
    <path d="M8.2 33.7 L18.2 21.4 L24.2 28.3 L29.6 22.7 L39.8 33.7 Z" fill="url(#rock)"/>
    <path d="M24.2 28.3 L29.6 22.7 L39.8 33.7 L24.2 33.7 Z" fill="#d7e5f5" opacity="0.72"/>
    <path d="M10.4 36.5 q3.1 -1.9 6.2 0 t6.2 0 t6.2 0" fill="none" stroke="url(#wave)" stroke-width="1.5" stroke-linecap="round" opacity="0.94"/>
    <path d="M13.2 40.4 q2.7 -1.6 5.4 0 t5.4 0 t5.4 0" fill="none" stroke="#9dc2e7" stroke-width="1.1" stroke-linecap="round" opacity="0.42"/>
  </g>
`

const DEFS = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#1b3f8f"/>
      <stop offset="1" stop-color="#0f2a63"/>
    </linearGradient>
    <linearGradient id="card" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#fffdf8"/>
      <stop offset="0.55" stop-color="#f5f8fd"/>
      <stop offset="1" stop-color="#e4edf9"/>
    </linearGradient>
    <linearGradient id="disc" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#3064a3"/>
      <stop offset="0.52" stop-color="#1a3e7b"/>
      <stop offset="1" stop-color="#0d2345"/>
    </linearGradient>
    <linearGradient id="rock" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.7" stop-color="#f2f8ff"/>
      <stop offset="1" stop-color="#dbe8f7"/>
    </linearGradient>
    <linearGradient id="wave" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f2f8ff"/>
      <stop offset="1" stop-color="#8fb9e2"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.35" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#e79a78"/>
      <stop offset="1" stop-color="#b5472e"/>
    </radialGradient>
    <radialGradient id="glow" cx="0.28" cy="0.18" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="discClip">
      <circle cx="24" cy="24" r="16.2"/>
    </clipPath>
  </defs>
`

/** 把 48×48 图元居中放进 size×size 的方框 */
function centeredLogo(canvas, size) {
  const scale = size / 48
  const offset = (canvas - size) / 2
  return `<g transform="translate(${offset} ${offset}) scale(${scale})">${LOGO_GROUP}</g>`
}

function svg(canvas, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">${DEFS}${body}</svg>`
}

const files = {
  // 传统图标：整块蓝底 + 宣纸卡，圆角由启动器决定
  'icon-only.png': svg(1024, `<rect width="1024" height="1024" fill="url(#bg)"/>${centeredLogo(1024, 760)}`),
  // 自适应图标：前景透明，卡片收进 66% 安全区，避免被圆形/方形蒙版切到
  'icon-foreground.png': svg(1024, centeredLogo(1024, 620)),
  'icon-background.png': svg(1024, `<rect width="1024" height="1024" fill="url(#bg)"/>`),
  'splash.png': svg(2732, `<rect width="2732" height="2732" fill="#f6f7f9"/>${centeredLogo(2732, 720)}`),
  'splash-dark.png': svg(2732, `<rect width="2732" height="2732" fill="#14171c"/>${centeredLogo(2732, 720)}`),
}

await mkdir(assetsDir, { recursive: true })
for (const [name, markup] of Object.entries(files)) {
  const out = path.join(assetsDir, name)
  await sharp(Buffer.from(markup)).png().toFile(out)
  console.log('generated', out)
}

// 顺带留一份可编辑的矢量源文件
await writeFile(path.join(assetsDir, 'icon.svg'), files['icon-only.png'], 'utf8')
console.log('done')
