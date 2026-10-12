import { useId } from 'react'

/**
 * 「高山流水」写意山水，挂在登录页左栏。
 *
 * 内联 SVG，没有依赖也没有图片文件。
 *
 * **为什么是"墨在纸上"而不是"白墨在蓝底上"** —— 这是试出来的，记下来免得改回去：
 *
 *   前两版把白墨直接画在品牌蓝的渐变上，都不成立。白墨要拉出远近就得压低透明度，
 *   压低了整幅糊成一片、只剩几团灰斑；提亮又变成三块死白的几何体，
 *   加上模糊溢出画布被裁，屏幕上出现一个灰矩形，像没加载出来的占位块。
 *
 *   改成一整块**宣纸底**、墨色落上去之后，问题一次性消失：纸与墨的对比是天然的，
 *   远淡近浓的层次按墨色透明度给就行，瀑布也回到水墨本来的画法 ——
 *   不是画一条白色的水，而是**在墨块之间留白**。
 *
 * 造型取「知音」的典：一重高山，一道瀑布落进溪里，溪上一叶扁舟，天边两笔飞鸟，
 * 右下角一枚朱印。
 */

interface Props {
  width?: number
  className?: string
}

/** 墨色分三档：远山淡、中景中、近处浓 */
const INK = '#16294a'

export default function InkLandscape({ width = 340, className }: Props) {
  const uid = useId().replace(/:/g, '')
  const paper = `paper-${uid}`
  const gFar = `far-${uid}`
  const gMid = `mid-${uid}`
  const gNear = `near-${uid}`
  const gMist = `mist-${uid}`
  const gFall = `fall-${uid}`
  const soft = `soft-${uid}`
  const softFall = `softfall-${uid}`

  return (
    <svg
      width={width}
      height={(width * 320) / 480}
      viewBox="0 0 480 320"
      className={'ink-landscape' + (className ? ' ' + className : '')}
      role="img"
      aria-label="高山流水"
    >
      <defs>
        {/* 宣纸：微微泛黄，四角略深，像装裱过的画心 */}
        <linearGradient id={paper} x1="0.1" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#fbf8f0" />
          <stop offset="1" stopColor="#eee9dc" />
        </linearGradient>

        {/* 每档墨：脊线处浓，往下化开 —— 形状的下缘因此没有硬边 */}
        <linearGradient id={gFar} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={INK} stopOpacity="0.26" />
          <stop offset="0.6" stopColor={INK} stopOpacity="0.1" />
          <stop offset="1" stopColor={INK} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={gMid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={INK} stopOpacity="0.42" />
          <stop offset="0.55" stopColor={INK} stopOpacity="0.16" />
          <stop offset="1" stopColor={INK} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={gNear} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={INK} stopOpacity="0.78" />
          <stop offset="0.5" stopColor={INK} stopOpacity="0.34" />
          <stop offset="1" stopColor={INK} stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id={gMist} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f7f4ea" stopOpacity="0" />
          <stop offset="0.35" stopColor="#f7f4ea" stopOpacity="0.85" />
          <stop offset="0.7" stopColor="#f7f4ea" stopOpacity="0.85" />
          <stop offset="1" stopColor="#f7f4ea" stopOpacity="0" />
        </linearGradient>

        {/* 瀑布用的是"留白"，但留白也得有浓淡 —— 上端是纸色、下端化掉，
            否则就是一条硬边的白棍子 */}
        <linearGradient id={gFall} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#faf7ef" stopOpacity="0.95" />
          <stop offset="0.62" stopColor="#faf7ef" stopOpacity="0.72" />
          <stop offset="1" stopColor="#faf7ef" stopOpacity="0" />
        </linearGradient>

        <filter id={soft} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
        {/* 瀑布单独走一档更轻的模糊，好让它与两侧岩壁咬合得更自然 */}
        <filter id={softFall} x="-40%" y="-10%" width="180%" height="120%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>

      {/* 画心 */}
      <rect width="480" height="320" rx="10" fill={`url(#${paper})`} />
      <rect
        x="9"
        y="9"
        width="462"
        height="302"
        rx="6"
        fill="none"
        stroke={INK}
        strokeOpacity="0.14"
        strokeWidth="1"
      />

      {/* 天边两笔飞鸟 */}
      <g fill="none" stroke={INK} strokeLinecap="round" strokeOpacity="0.5">
        <path d="M146 84 q7 -7 14 0 q7 -7 14 0" strokeWidth="1.8" />
        <path d="M196 66 q5 -5 10 0 q5 -5 10 0" strokeWidth="1.5" strokeOpacity="0.35" />
      </g>

      {/* 远山：一条起伏的脊线，好几个峰 */}
      <path
        d="M4 300 L4 186
           C34 170 54 142 82 148 C108 154 122 180 144 184
           C170 189 186 148 214 140 C242 132 258 166 282 176
           C308 187 326 150 354 156 C382 162 400 184 424 190
           C446 196 464 182 476 188 L476 300 Z"
        fill={`url(#${gFar})`}
        filter={`url(#${soft})`}
      />

      {/* 中景山峦 */}
      <path
        d="M4 300 L4 244
           C30 234 52 206 80 198 C110 190 130 218 158 226
           C188 234 206 204 234 200 C262 196 280 224 308 230
           C336 236 356 208 384 206 C412 204 434 230 458 236
           C470 239 474 236 476 237 L476 300 Z"
        fill={`url(#${gMid})`}
        filter={`url(#${soft})`}
      />

      {/* 主峰：左侧一笔立起来 */}
      <path
        d="M4 300 L4 232
           C34 228 52 194 74 176 C94 160 112 180 128 206
           C144 232 162 252 186 264 C208 275 226 288 238 300 Z"
        fill={`url(#${gNear})`}
      />

      {/* 右侧近石 */}
      <path
        d="M476 300 L476 242
           C454 246 436 266 422 282 C412 293 404 300 398 300 Z"
        fill={`url(#${gNear})`}
      />

      {/* 瀑布：不画水，在水墨里"留白" —— 两山之间空出一线纸色。
          上宽下窄、略微拐弯，下端化掉，这样才像水不像棍子 */}
      <path
        d="M225 150 C231 188 233 222 230 258 C229 268 228 276 227 284
           L245 284 C244 276 243 268 242 258 C239 222 245 188 253 150 Z"
        fill={`url(#${gFall})`}
        filter={`url(#${softFall})`}
      />
      {/* 岩壁的墨骨收口，别让白边直接切在山体上 */}
      <g fill="none" stroke={INK} strokeLinecap="round">
        <path d="M226 156 C232 192 234 226 231 262" strokeOpacity="0.34" strokeWidth="1.6" />
        <path d="M252 154 C246 192 245 226 243 262" strokeOpacity="0.22" strokeWidth="1.2" />
      </g>
      {/* 中段横一块石矶，把瀑布打断成两叠 —— 水墨里画瀑布常用这一手 */}
      <path
        d="M219 208 C226 204 236 203 246 205 C251 206 254 209 254 212
           C247 216 232 217 222 214 C218 213 217 210 219 208 Z"
        fill={INK}
        opacity="0.55"
        filter={`url(#${soft})`}
      />

      {/* 山脚水汽：把山与溪隔开 */}
      <rect x="0" y="212" width="480" height="20" fill={`url(#${gMist})`} />
      <rect x="0" y="246" width="480" height="16" fill={`url(#${gMist})`} />

      {/* 溪流：三道横纹，越近越淡 */}
      <g fill="none" stroke={INK} strokeLinecap="round">
        <path
          d="M30 286 C92 279 148 293 208 286 C268 279 324 293 386 286 C428 281 456 288 474 285"
          strokeOpacity="0.34"
          strokeWidth="2.2"
        />
        <path
          d="M58 296 C118 290 172 300 232 295 C292 290 348 300 406 295 C438 292 458 297 474 295"
          strokeOpacity="0.22"
          strokeWidth="1.7"
        />
        <path
          d="M98 306 C150 302 196 309 250 305 C304 301 350 308 400 305"
          strokeOpacity="0.14"
          strokeWidth="1.3"
        />
      </g>

      {/* 一叶扁舟 —— 「高山流水」说的就是遇知音，水面上留个人影 */}
      <g opacity="0.82">
        <path d="M296 288 C306 295 324 295 334 288 C324 292 306 292 296 288 Z" fill={INK} />
        <path d="M315 287 L315 274" stroke={INK} strokeWidth="1.6" strokeLinecap="round" />
        <path
          d="M315 275 q8 1 10 6"
          fill="none"
          stroke={INK}
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </g>

      {/* 朱印：右下角一枚，落款的意思 */}
      <g opacity="0.9">
        <rect x="404" y="256" width="42" height="42" rx="4" fill="#b8443a" />
        <text
          x="425"
          y="274"
          textAnchor="middle"
          fill="#fdf6f2"
          fontSize="15"
          fontWeight="600"
          letterSpacing="1"
        >
          知音
        </text>
        <text x="425" y="290" textAnchor="middle" fill="#fdf6f2" fontSize="11" letterSpacing="2">
          漫卷
        </text>
      </g>
    </svg>
  )
}
