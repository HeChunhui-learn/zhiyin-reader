import { useState } from 'react'
import type { Anchor, ConflictEnvelope } from '../api/client'

export type Resolution = 'local' | 'remote' | 'both'

interface Props {
  conflicts: ConflictEnvelope[]
  onClose: () => void
  onResolve: (conflict: ConflictEnvelope, choice: Resolution) => void
}

const CHOICES: { key: Resolution; label: string }[] = [
  { key: 'local', label: '保留本机' },
  { key: 'remote', label: '保留云端' },
  { key: 'both', label: '两份都保留' },
]

function anchorText(a: unknown): string {
  const x = a as Anchor | undefined
  if (!x || typeof x.paragraphIndex !== 'number') return '—'
  return `第 ${x.paragraphIndex + 1} 段`
}

/** 把冲突双方的差异压成一句话，界面直接展示 */
function describe(c: ConflictEnvelope): { local: string; remote: string } {
  if (c.scope === 'progress') {
    return {
      local: anchorText((c.local as { anchor?: Anchor })?.anchor),
      remote: anchorText((c.remote as { anchor?: Anchor })?.anchor),
    }
  }
  const l = c.local as { name?: string | null; anchor?: Anchor }
  const r = c.remote as { name?: string | null; anchor?: Anchor }
  const name = (v: { name?: string | null } | undefined) =>
    v?.name ? `「${v.name}」` : '（无名）'
  return {
    local: `${name(l)} ${anchorText(l?.anchor)}`.trim(),
    remote: `${name(r)} ${anchorText(r?.anchor)}`.trim(),
  }
}

const SCOPE_LABEL: Record<string, string> = {
  progress: '阅读进度冲突',
  bookmark: '书签冲突',
}

export default function ConflictDialog({ conflicts, onClose, onResolve }: Props) {
  const [choices, setChoices] = useState<Record<string, Resolution>>({})

  const keyOf = (c: ConflictEnvelope) => `${c.scope}:${c.key}:${c.serverVersion}`
  const choiceOf = (c: ConflictEnvelope) => choices[keyOf(c)] ?? 'both'

  return (
    <div className="modal-mask">
      <div className="modal" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>发现 {conflicts.length} 处同步冲突</h2>
          <p className="modal-sub">
            服务端已按「不静默丢弃」原则保留了双方的数据，下面是它给出的裁决与差异。
          </p>
        </header>

        <div className="modal-body">
          {conflicts.map((c) => {
            const d = describe(c)
            const k = keyOf(c)
            return (
              <section className="conflict" key={k}>
                <div className="conflict-type">
                  {SCOPE_LABEL[c.scope] ?? c.scope}
                  {c.note && <span className="conflict-note">{c.note}</span>}
                </div>

                <div className="conflict-diff">
                  <div className="diff-col">
                    <div className="diff-device">本机</div>
                    <div className="diff-value">{d.local}</div>
                  </div>
                  <div className="diff-col">
                    <div className="diff-device">云端</div>
                    <div className="diff-value">{d.remote}</div>
                  </div>
                </div>

                {c.scope === 'bookmark' ? (
                  <div className="conflict-choice">
                    {CHOICES.map((ch) => (
                      <label key={ch.key} className="radio">
                        <input
                          type="radio"
                          name={k}
                          checked={choiceOf(c) === ch.key}
                          onChange={() => setChoices((p) => ({ ...p, [k]: ch.key }))}
                        />
                        <span>{ch.label}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="muted conflict-progress-note">
                    进度冲突由服务端按「不回退保护」自动裁决，不需要你做选择 ——
                    这一条只是告诉你两端当时各读到哪。
                  </p>
                )}
              </section>
            )
          })}

          <p className="muted modal-note">
            选「两份都保留」时，第二条记录的标识由服务端生成；选「保留本机」或「保留云端」，
            被舍弃的那一份会被软删除。
          </p>
        </div>

        <footer className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            稍后处理
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              for (const c of conflicts) {
                if (c.scope === 'bookmark') onResolve(c, choiceOf(c))
              }
              onClose()
            }}
          >
            应用
          </button>
        </footer>
      </div>
    </div>
  )
}
