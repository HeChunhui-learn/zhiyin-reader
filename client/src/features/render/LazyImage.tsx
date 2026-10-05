import { useEffect, useRef, useState, type RefObject } from 'react'
import { ApiError, api } from '../../api/client'
import { cacheGet, cachePut, objectUrl, releaseObjectUrl } from './imageCache'

/**
 * 单张图片的按需加载。
 *
 * 依据 04 §4.1.3：
 *   1. 图片未进入视口时不发起任何网络请求（IntersectionObserver 控制）
 *   2. 缓存命中直接读本地 Blob；未命中才向服务端取
 *   3. 图片离开视口时清空对象地址、释放 Blob，但 IndexedDB 里的副本保留
 *
 * 依据契约 §4.3：图片是**懒上传**的 —— 服务端还没有这张图（imageUrl 为空或
 * 取回 404）而本地有 Blob 时，先上传再由服务端提供给其他设备。
 */

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; fromCache: boolean }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

interface Props {
  docId: string
  imageId: string
  alt: string
  /** 服务端上已有这张图（来自 /content 的 imageRefs.imageUrl） */
  hasRemote: boolean
  /** 滚动容器，作为 IntersectionObserver 的 root */
  scrollRoot: RefObject<HTMLDivElement>
  /** 已进过视口就不再释放，避免来回滚动反复请求 */
  keepResident?: boolean
  /** 段落号，供目录跳转用 */
  dataPara?: number
}

export default function LazyImage({
  docId,
  imageId,
  alt,
  hasRemote,
  scrollRoot,
  keepResident = false,
  dataPara,
}: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const holderRef = useRef<HTMLDivElement>(null)
  const uploadedRef = useRef(hasRemote)
  const startedRef = useRef(false)

  /* 懒加载：进入视口（提前 200px）才开始取图 */
  useEffect(() => {
    const el = holderRef.current
    if (!el) return

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !startedRef.current) {
            startedRef.current = true
            void load()
          } else if (!e.isIntersecting && startedRef.current && !keepResident) {
            // 离开视口：释放对象地址（IndexedDB 副本保留）
            releaseObjectUrl(imageId)
          }
        }
      },
      { root: scrollRoot.current ?? null, rootMargin: '200px 0px', threshold: 0.01 },
    )
    io.observe(el)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, imageId, keepResident])

  async function load() {
    setState({ kind: 'loading' })
    try {
      // 1) 本地缓存
      const cached = await cacheGet(imageId)
      if (cached) {
        setState({ kind: 'ready', url: objectUrl(imageId, cached), fromCache: true })
        void ensureUploaded(cached)
        return
      }

      // 2) 服务端
      try {
        const blob = await api.getImage(docId, imageId)
        await cachePut(docId, imageId, blob)
        setState({ kind: 'ready', url: objectUrl(imageId, blob), fromCache: false })
        return
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NOT_FOUND') {
          // 服务端还没有，本地也没有 —— 契约 §4.3 的"图片不可用"占位
          setState({ kind: 'missing' })
          return
        }
        throw e
      }
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof ApiError ? e.message : '图片加载失败',
      })
    }
  }

  /** 本地有、服务端没有时补传一次（失败不影响显示） */
  async function ensureUploaded(blob: Blob) {
    if (uploadedRef.current) return
    uploadedRef.current = true
    try {
      await api.putImage(docId, imageId, blob)
    } catch {
      // 补传失败就把标记放回去，下次进入视口再试
      uploadedRef.current = false
    }
  }

  // 组件卸载时释放
  useEffect(() => () => releaseObjectUrl(imageId), [imageId])

  const retry = () => {
    startedRef.current = false
    void load()
  }

  return (
    <figure className="doc-figure" data-para={dataPara}>
      <div className="figure-holder" ref={holderRef}>
        {state.kind === 'ready' && (
          <img className="figure-img" src={state.url} alt={alt} />
        )}

        {(state.kind === 'idle' || state.kind === 'loading') && (
          <div className="figure-skeleton" aria-label="图片加载中">
            <span className="figure-spinner" />
          </div>
        )}

        {state.kind === 'missing' && (
          <div className="figure-missing">
            <span>图片不可用</span>
            <span className="figure-missing-hint">
              这张图还没有被任何设备上传到服务端
            </span>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="figure-missing">
            <span>{state.message}</span>
            <button className="btn btn-ghost btn-sm" onClick={retry}>
              重试
            </button>
          </div>
        )}
      </div>
      {alt && <figcaption>{alt}</figcaption>}
    </figure>
  )
}
