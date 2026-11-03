import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, DEFAULT_API_BASE, api, getApiBase, setApiBase } from '../api/client'
import { invalidateAvatar, default as UserAvatar } from '../features/profile/UserAvatar'
import ThemeToggle from '../features/settings/ThemeToggle'
import { useSession } from '../state/session'

/**
 * 个人主页（R7-5）：头像上传、改昵称、看账号信息。
 *
 * 只做"读者自己的"资料 —— 没有公开主页、没有别人的页面，
 * 服务端的头像接口也只认 /users/me。
 */

/** 与服务端 resources.ts 的 MAX_AVATAR_BYTES 对齐 */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024

export default function ProfileView() {
  const navigate = useNavigate()
  const { user, ready, refreshUser } = useSession()

  const [nickname, setNickname] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'done' | 'failed'; text: string } | null>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  /* 服务器地址是「装成客户端才用得上」的高级项，默认折叠，不占读者视线 */
  const [serverOpen, setServerOpen] = useState(false)
  const [serverDraft, setServerDraft] = useState(getApiBase())
  const [serverMsg, setServerMsg] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)

  /** 原生壳里换服务器地址用。浏览器端默认同源，一般用不到，但改错了也能改回来 */
  function saveServer() {
    const next = setApiBase(serverDraft)
    setServerDraft(next)
    setServerMsg(`已保存：${next}`)
  }

  function resetServer() {
    setApiBase(null)
    setServerDraft(DEFAULT_API_BASE)
    setServerMsg(`已恢复默认：${DEFAULT_API_BASE}`)
  }

  useEffect(() => {
    if (ready && !user) navigate('/login', { replace: true })
  }, [ready, user, navigate])

  /* 用户信息到位后填进输入框 */
  useEffect(() => {
    if (user) setNickname(user.nickname ?? '')
  }, [user])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 3200)
    return () => window.clearTimeout(t)
  }, [notice])

  const onPickAvatar = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setNotice({ kind: 'failed', text: '只能选图片文件（png / jpg / webp 等）。' })
        return
      }
      if (file.size > MAX_AVATAR_BYTES) {
        setNotice({ kind: 'failed', text: '头像不能超过 2MB。' })
        return
      }
      setAvatarBusy(true)
      try {
        await api.uploadAvatar(file)
        invalidateAvatar()
        await refreshUser()
        setNotice({ kind: 'done', text: '头像已更新。' })
      } catch (e) {
        setNotice({
          kind: 'failed',
          text: e instanceof ApiError ? e.message : '上传头像失败，请稍后重试。',
        })
      } finally {
        setAvatarBusy(false)
      }
    },
    [refreshUser],
  )

  const onRemoveAvatar = useCallback(async () => {
    setAvatarBusy(true)
    try {
      await api.deleteAvatar()
      invalidateAvatar()
      await refreshUser()
      setNotice({ kind: 'done', text: '头像已移除。' })
    } catch (e) {
      setNotice({
        kind: 'failed',
        text: e instanceof ApiError ? e.message : '移除头像失败，请稍后重试。',
      })
    } finally {
      setAvatarBusy(false)
    }
  }, [refreshUser])

  async function onSaveNickname() {
    const n = nickname.trim()
    if (!user || n === (user.nickname ?? '')) {
      setNotice({ kind: 'failed', text: '昵称没有变化。' })
      return
    }
    setSaving(true)
    try {
      await api.updateMe({ nickname: n })
      await refreshUser()
      setNotice({ kind: 'done', text: '昵称已保存。' })
    } catch (e) {
      setNotice({
        kind: 'failed',
        text: e instanceof ApiError ? e.message : '保存昵称失败，请稍后重试。',
      })
    } finally {
      setSaving(false)
    }
  }

  if (!ready || !user) {
    return (
      <div className="shelf-page">
        <div className="shelf-empty">正在恢复登录状态…</div>
      </div>
    )
  }

  /* 「/api」这种同源默认值对读者没有信息量，直接写成看得懂的默认态 */
  const serverShown = getApiBase() === DEFAULT_API_BASE ? '默认（同源）' : getApiBase()

  return (
    <div className="shelf-page">
      <header className="shelf-topbar">
        <button className="btn btn-ghost" onClick={() => navigate('/shelf')}>
          返回书架
        </button>
        <div className="shelf-brand">个人主页</div>
        <div className="topbar-end">
          <ThemeToggle />
        </div>
      </header>

      <main className="shelf-main profile-main">
        {/* 纸上的墨晕：和书架一处，别让书架的动效成孤岛 */}
        <div className="shelf-wash" aria-hidden="true">
          <i />
          <i />
        </div>
        <div className="profile-card">
          <div className="profile-avatar-row">
            <UserAvatar avatarUrl={user.avatarUrl} name={user.nickname || user.account} size={88} />
            <div className="profile-avatar-actions">
              <button
                className="btn btn-primary btn-sm"
                disabled={avatarBusy}
                onClick={() => fileRef.current?.click()}
              >
                {avatarBusy ? '处理中…' : '上传头像'}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={avatarBusy || !user.avatarUrl}
                onClick={() => void onRemoveAvatar()}
              >
                移除头像
              </button>
              <p className="muted profile-hint">
                支持 png / jpg / webp，不超过 2MB。
              </p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void onPickAvatar(f)
              }}
            />
          </div>

          <div className="profile-field">
            <label className="profile-label" htmlFor="profile-nickname">
              昵称
            </label>
            <div className="profile-row">
              <input
                id="profile-nickname"
                className="input"
                maxLength={32}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onSaveNickname()
                }}
              />
              <button
                className="btn btn-primary"
                disabled={saving}
                onClick={() => void onSaveNickname()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
            <p className="muted profile-hint">最多 32 个字，留空则显示账号。</p>
          </div>

          <dl className="profile-meta">
            <dt>账号</dt>
            <dd>{user.account}</dd>
            <dt>读者编号</dt>
            <dd className="profile-mono">{user.userId}</dd>
          </dl>

          <div className="profile-advanced">
            <div className="login-server">
              <button
                type="button"
                className="login-server-toggle"
                onClick={() => { setServerOpen((v) => !v); setServerMsg('') }}
              >
                服务器地址：<span>{serverShown}</span>
                <i>{serverOpen ? '收起' : '修改'}</i>
              </button>

              {serverOpen && (
                <div className="login-server-box">
                  <label className="field">
                    <span className="field-label">API 基址（留空恢复默认）</span>
                    <input
                      className="input"
                      value={serverDraft}
                      placeholder={DEFAULT_API_BASE}
                      onChange={(e) => { setServerDraft(e.target.value); setServerMsg('') }}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </label>
                  <div className="login-server-actions">
                    <button type="button" className="btn" onClick={saveServer}>保存</button>
                    <button type="button" className="btn btn-ghost" onClick={resetServer}>恢复默认</button>
                  </div>
                  {serverMsg && <p className="login-server-msg">{serverMsg}</p>}
                </div>
              )}
            </div>
            <p className="muted profile-hint">
              只有装成本机客户端、要连自建服务器时才需要改；浏览器版保持默认即可。
            </p>
          </div>

          {notice && (
            <div
              className={'parse-bar' + (notice.kind === 'done' ? ' done' : ' failed')}
              role="status"
            >
              <span>{notice.text}</span>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
