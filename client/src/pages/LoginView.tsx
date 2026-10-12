import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useSession } from '../state/session'
import AppLogo from '../features/brand/AppLogo'
import InkLandscape from '../features/brand/InkLandscape'

type Tab = 'login' | 'register'

export default function LoginView() {
  const [tab, setTab] = useState<Tab>('login')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [remember, setRemember] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { login, register } = useSession()
  const navigate = useNavigate()

  /** 把服务端的错误码翻成更好懂的提示（密码错、锁定、重复注册等） */
  function friendly(e: unknown): string {
    if (!(e instanceof ApiError)) return '操作失败，请稍后重试。'
    switch (e.code) {
      case 'ACCOUNT_LOCKED': {
        const until = e.details?.lockedUntil as string | undefined
        if (!until) return '账号已被临时锁定，请稍后再试。'
        const left = Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 60000))
        return `连续输错多次，账号已锁定，请 ${left} 分钟后重试。`
      }
      case 'CONFLICT_ACCOUNT_EXISTS':
        return '该账号已被注册，请直接登录或换一个账号。'
      case 'AUTH_INVALID_CREDENTIAL':
        return '账号或密码错误。'
      case 'VALIDATION_FAILED': {
        const fields = (e.details?.fields as string[]) ?? []
        if (fields.includes('account')) return '账号需为手机号或邮箱。'
        if (fields.includes('password')) return '密码长度不得少于 8 位。'
        return '输入的内容不合法。'
      }
      default:
        return e.message
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!account.trim() || !password) {
      setError('请输入账号与密码')
      return
    }
    if (tab === 'register' && password.length < 8) {
      setError('密码长度不得少于 8 位')
      return
    }

    setLoading(true)
    try {
      if (tab === 'login') {
        await login(account.trim(), password)
      } else {
        await register(account.trim(), password, nickname.trim() || undefined)
      }
      navigate('/shelf')
    } catch (err) {
      setError(friendly(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-brand">
        <div className="login-brand-head">
          <AppLogo size={56} />
          <div>
            <div className="login-brand-logo">知音漫卷</div>
            <p className="login-brand-sub">图文混排 · 逐句跟读 · 跨设备续读</p>
          </div>
        </div>

        <p className="login-brand-slogan">高山流水遇知音</p>
        <p className="login-brand-slogan-note">写意山水 · 与君共读</p>

        <InkLandscape width={380} />
      </div>

      <div className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <div className="tabs">
            <button
              type="button"
              className={'tab' + (tab === 'login' ? ' active' : '')}
              onClick={() => { setTab('login'); setError('') }}
            >
              登录
            </button>
            <button
              type="button"
              className={'tab' + (tab === 'register' ? ' active' : '')}
              onClick={() => { setTab('register'); setError('') }}
            >
              注册
            </button>
          </div>

          <label className="field">
            <span className="field-label">账号</span>
            <input
              className="input"
              placeholder="手机号／邮箱"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              autoComplete="username"
            />
          </label>

          {tab === 'register' && (
            <label className="field">
              <span className="field-label">昵称（可留空）</span>
              <input
                className="input"
                placeholder="读者甲"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </label>
          )}

          <label className="field">
            <span className="field-label">
              密码{tab === 'register' && <span className="muted">（至少 8 位）</span>}
            </span>
            <input
              className="input"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
            />
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>记住我</span>
          </label>

          {error && <div className="alert alert-error">{error}</div>}

          <button className="btn btn-primary btn-block" disabled={loading}>
            {loading
              ? tab === 'login' ? '登录中…' : '注册中…'
              : tab === 'login' ? '登录' : '注册并登录'}
          </button>

          <div className="divider"><span>或</span></div>

          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => setError('第三方登录尚未接入（课程设计范围内不实现）')}
          >
            使用第三方账号登录
          </button>

          <p className="login-note">
            演示账号 <b>demo@example.com</b> ／ <b>demo12345</b>
            <br />
            也可以自行注册，账号填手机号或邮箱、密码至少 8 位。
          </p>
        </form>
      </div>
    </div>
  )
}
