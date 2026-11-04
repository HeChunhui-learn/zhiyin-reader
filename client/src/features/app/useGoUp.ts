import { useNavigate } from 'react-router-dom'

/**
 * 返回上一级。
 *
 * 手机的系统返回手势走的是浏览器历史，页面里的「返回」也该走同一条路：
 * 之前「返回书架」写死成 push 一条新记录，历史里于是变成
 * 书架 → 正文 → 书架，再退又回到刚读的那本书。
 *
 * 有应用内历史就 `navigate(-1)`；没有（直接从链接打开正文）才 replace 到兜底页，
 * 免得凭空多出一条记录、返回时反而退出应用。
 */
export function useGoUp(fallback = '/shelf') {
  const navigate = useNavigate()
  return () => {
    const state = window.history.state as { idx?: number } | null
    const idx = state?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(fallback, { replace: true })
  }
}
