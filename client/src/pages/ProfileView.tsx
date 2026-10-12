import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api/client'
import { invalidateAvatar, default as UserAvatar } from '../features/profile/UserAvatar'
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

  const fileRef = useRef<HTMLInputElement>(null)

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

  return (
    <div className="shelf-page">
      <header className="shelf-topbar">
        <button className="btn btn-ghost" onClick={() => navigate('/shelf')}>
          返回书架
        </button>
        <div className="shelf-brand">个人主页</div>
      </header>

      <main className="shelf-main profile-main">
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
