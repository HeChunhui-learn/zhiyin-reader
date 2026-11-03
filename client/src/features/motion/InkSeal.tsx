/**
 * 朱印。
 *
 * 参考 ThreeUI 的 spark-badge（一枚带高光扫过的小徽章），做成纸上那方印章：
 * 落下来时先虚焦、再压印、边缘轻微抖，之后每隔几秒有一道高光从侧面扫过。
 * 全部是 CSS 动画（见 app.css 的「朱印」一节），这里只出结构。
 */

interface Props {
  /** 印章上的字。两字方印最好看，多了会挤 */
  text?: string
  className?: string
  /** 落章延迟（毫秒），用来和页面别的入场排节奏 */
  delay?: number
}

export default function InkSeal({ text = '知音', className, delay = 0 }: Props) {
  return (
    <span
      className={'ink-seal' + (className ? ' ' + className : '')}
      style={{ animationDelay: `${delay}ms` }}
      aria-hidden="true"
    >
      <span className="ink-seal-face">{text}</span>
      <span className="ink-seal-sheen" />
    </span>
  )
}
