import { createHash } from 'node:crypto'

/**
 * 合成音频的缓存键，契约 §9.2 规定为 sha256(engine + voice + rate + text)。
 *
 * 与服务端**必须逐字节一致**：客户端那份在
 * client/src/features/readalong/ttsCacheKey.ts，改动时两边一起改，
 * 否则客户端永远命中不了服务端的缓存，等于每句都要重新合成。
 *
 * 加 \u0001 分隔符是为了避免直接拼接的歧义（材料审查 O50）：
 * ("a","b") 与 ("ab","") 拼出来是同一个串。
 */
export function ttsCacheKey(
  engine: string,
  voice: string,
  rate: number,
  text: string,
): string {
  return createHash('sha256')
    .update([engine, voice, String(rate), text].join('\u0001'), 'utf8')
    .digest('hex')
}
