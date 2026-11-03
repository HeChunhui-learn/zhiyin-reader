import { sha256Hex } from '../parse/sha256'

/**
 * 合成音频的缓存键，契约 §9.2 规定为 sha256(engine + voice + rate + text)。
 *
 * 这里**加了分隔符**：直接拼接的话 ("a","b") 与 ("ab","") 会算出同一个键
 * （直接拼接会有歧义）。服务端算同一个键，两边必须保持一致
 * —— 服务端那份在 server/src/tts/cacheKey.ts，改动时两边一起改。
 */
export function ttsCacheKey(
  engine: string,
  voice: string,
  rate: number,
  text: string,
): string {
  return sha256Hex([engine, voice, String(rate), text].join('\u0001'))
}
