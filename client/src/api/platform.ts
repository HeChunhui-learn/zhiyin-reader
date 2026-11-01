/**
 * 运行环境判断。
 *
 * Capacitor 会在 WebView 里注入全局 `Capacitor`，`isNativePlatform()` 在原生命中为 true。
 * 浏览器里没有这个对象，按 false 处理。
 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean
}

export function isNativeApp(): boolean {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform()
}
