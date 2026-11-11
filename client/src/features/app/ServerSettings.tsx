import { useState } from 'react'
import { DEFAULT_API_BASE, getApiBase, setApiBase } from '../../api/client'
import { isNativeApp } from '../../api/platform'

/**
 * 服务器地址设置（登录页与个人主页共用）。
 *
 * 为什么登录页也要有：
 *   APK 里打包的是**编译时写死的默认地址**（VITE_API_BASE）。服务端一旦换机器、
 *   换端口，或者演示服务器下线，安装包里的默认值就失效了 —— 而登录页又是在
 *   登录成功之前唯一能操作的界面。入口只在个人主页的话，用户会卡在登录页
 *   出不去：连不上 → 登不了 → 进不去个人主页改地址。所以登录页必须能改。
 *
 * 浏览器里默认同源 `/api`，一般不用动；改错了也能在同一个地方恢复默认。
 */
interface Props {
  /** 默认折叠。登录页给 true（不占视线），个人主页给 false */
  collapsed?: boolean
}

export default function ServerSettings({ collapsed = true }: Props) {
  /*
   * 打包时没注入 VITE_API_BASE 时，DEFAULT_API_BASE 是 `/api`。
   * 这在浏览器里是同源、正确；在原生壳里却会打到 WebView 自己的 localhost 上，
   * 必然连不上。CI 现在就是不注入（没有固定服务器可写），所以这种包装上去
   * 必须先让用户填地址 —— 默认直接把面板展开，别让人对着「连不上」发呆。
   */
  const needsConfig = isNativeApp() && DEFAULT_API_BASE === '/api'

  const [open, setOpen] = useState(!collapsed || needsConfig)
  /* needsConfig 时默认值 `/api` 填进去只会被拼成 http:///api，干脆留空让提示当前导 */
  const [draft, setDraft] = useState(needsConfig ? '' : getApiBase())
  const [msg, setMsg] = useState('')

  const shown = needsConfig
    ? '未设置（必填）'
    : getApiBase() === DEFAULT_API_BASE ? '默认' : getApiBase()

  function save() {
    /* 空输入等于"恢复默认"，但原生壳里默认值不可用，这时候要拦住 */
    if (!draft.trim() && needsConfig) {
      setMsg('请先填写服务端地址，例如 http://192.168.1.5:3000/api')
      return
    }
    const next = setApiBase(draft)
    setDraft(next)
    setMsg(`已保存：${next}`)
  }

  function reset() {
    setApiBase(null)
    setDraft(DEFAULT_API_BASE)
    setMsg(`已恢复默认：${DEFAULT_API_BASE}`)
  }

  return (
    <div className="login-server">
      <button
        type="button"
        className="login-server-toggle"
        onClick={() => { setOpen((v) => !v); setMsg('') }}
      >
        服务器地址：<span>{shown}</span>
        <i>{open ? '收起' : '修改'}</i>
      </button>

      {open && (
        <div className="login-server-box">
          <label className="field">
            <span className="field-label">API 基址（留空恢复默认）</span>
            <input
              className="input"
              value={draft}
              placeholder={needsConfig ? 'http://192.168.1.5:3000/api' : DEFAULT_API_BASE}
              onChange={(e) => { setDraft(e.target.value); setMsg('') }}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <div className="login-server-actions">
            <button type="button" className="btn" onClick={save}>保存</button>
            <button type="button" className="btn btn-ghost" onClick={reset}>恢复默认</button>
          </div>
          {msg && <p className="login-server-msg">{msg}</p>}
          <p className="login-server-msg">
            {needsConfig
              ? '这个安装包没有内置服务器地址，请填服务端的 API 地址，例如 http://192.168.1.5:3000/api。'
              : isNativeApp()
                ? '填服务端的 API 地址，例如 http://192.168.1.5:3000/api。'
                : '浏览器版默认同源，通常不用改。'}
          </p>
        </div>
      )}
    </div>
  )
}
