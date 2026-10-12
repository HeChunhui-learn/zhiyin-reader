import { useEffect, useState } from 'react'
import { api } from '../../api/client'

/**
 * 头像。
 *
 * 走接口取二进制而不是直接 `<img src="/api/users/me/avatar">` ——
 * 那个接口要 `Authorization: Bearer`，而 `<img>` 发不出自定义请求头。
 * 这个取舍与正文插图一致（见 features/render/LazyImage.tsx）。
 *
 * 取到之前、以及没有头像时，退化成"昵称首字"的色块 —— 不留空位，
 * 也不会因为一张图没加载出来就把布局顶歪。
 */

/*
 * 模块级的共享缓存。页面上头像可能有好几处（书架顶栏、个人页），
 * 都用同一个 URL，不必各取一份。
 *
 * `avatarUrl` 是个**固定路径**，换了头像它也不变，所以光靠它判不出来 ——
 * 需要一个"第几代"计数器，上传/移除头像后 bump 一下，订阅者据此重取。
 */
let cachedUrl = ''
let cachedFor = ''
let inflight: Promise<string> | null = null
let generation = 0
const listeners = new Set<() => void>()

function release(): void {
  if (cachedUrl) URL.revokeObjectURL(cachedUrl)
  cachedUrl = ''
  cachedFor = ''
}

/** 单飞：同一时刻只发一个取头像的请求，多个组件共用结果 */
function load(url: string): Promise<string> {
  if (cachedFor === url && cachedUrl) return Promise.resolve(cachedUrl)
  if (inflight) return inflight

  inflight = api
    .getAvatar()
    .then((blob) => {
      // 替换时才撤销旧的那份；先撤后建会让另一个正在显示旧 URL 的组件瞬间裂图
      if (cachedUrl) URL.revokeObjectURL(cachedUrl)
      cachedUrl = URL.createObjectURL(blob)
      cachedFor = url
      return cachedUrl
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** 换了头像（上传或移除）之后调用，让所有头像重新取一次 */
export function invalidateAvatar(): void {
  release()
  inflight = null
  generation++
  for (const l of listeners) l()
}

interface Props {
  avatarUrl: string | null
  name: string
  size?: number
}

export default function UserAvatar({ avatarUrl, name, size = 32 }: Props) {
  const [url, setUrl] = useState('')
  const [gen, setGen] = useState(generation)

  useEffect(() => {
    const l = () => setGen(generation)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])

  useEffect(() => {
    let alive = true

    // 没有头像：直接用文字头像，不发请求
    if (!avatarUrl) {
      release()
      setUrl('')
      return
    }

    void load(avatarUrl)
      .then((u) => {
        if (alive) setUrl(u)
      })
      .catch(() => {
        // 取不到（没设过、或者接口出错）：退化成文字头像，不打扰读者
        if (alive) setUrl('')
      })

    return () => {
      alive = false
    }
  }, [avatarUrl, gen])

  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) }

  if (url) {
    return <img className="avatar" style={style} src={url} alt={`${name}的头像`} />
  }
  return (
    <span className="avatar avatar-text" style={style} aria-hidden="true">
      {(name || '读').slice(0, 1)}
    </span>
  )
}
