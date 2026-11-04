/**
 * 动效的运行环境。
 *
 * 墨迹、点阵、山景视差都是「跟着指针走」的效果：手机上只有手指、没有悬停，
 * 这些效果既没有交互意义，又要整屏重绘。移动端干脆不挂载，
 * 省掉 canvas、事件监听和每帧的栅格化开销。
 *
 * 判断用 `pointer: fine` 而不是屏幕宽度：平板接鼠标时仍然该有墨迹，
 * 而窄窗口的桌面浏览器不该被当成手机。
 */
export function hasFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(pointer: fine)').matches
}
