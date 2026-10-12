/**
 * 书签的默认名。
 *
 * 由系统**自动**按书签位置的正文取前 N 个字 —— 读者不该为了记个位置先想名字。
 * 纯 TS、无框架依赖，和 anchor.ts 一样单独放，好验证也好复用。
 */

/** 书签默认名取正文的前 10 个字 */
export const BOOKMARK_NAME_LEN = 10

/**
 * 从锚点所在段落的文本里取书名。
 *
 * - 先把空白归一（解析出来的段落可能带换行，不归一的话前 10 个字会被一个换行吃掉）
 * - 去掉句末标点：书签名末尾挂个句号读着别扭
 * - 不足 len 个字就整段返回，**不加省略号**（省略号只在真的截断时才加）
 * - 按**码点**切而不是 String.slice：后者会把代理对劈成两半，emoji 会变成乱码
 * - 实在取不到文本（图片段、空段）退回「第 N 段」，而不是留一个空名字 ——
 *   空名字在书签列表里根本认不出是哪一条
 */
export function bookmarkNameFrom(
  text: string,
  paraIndex: number,
  len = BOOKMARK_NAME_LEN,
): string {
  const t = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。．.！!？?；;…]+$/, '')

  if (!t) return `第 ${paraIndex + 1} 段`

  const cps = Array.from(t)
  return cps.length > len ? cps.slice(0, len).join('') + '…' : t
}
