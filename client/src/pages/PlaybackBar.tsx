import type { ReadAlongApi } from '../features/readalong/useReadAlong'
import type { VoiceOption } from '../features/readalong/engines'

export const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

/** 中文音色排在前面 —— 本项目的正文都是中文。chinese 未知时退回看 lang */
function isChinese(v: VoiceOption): boolean {
  return v.chinese ?? (v.lang ?? '').toLowerCase().startsWith('zh')
}

/**
 * 选项文字。本机没装的挂上原因（契约 §9.4），
 * 否则读者只会看到一个不能点的灰条，不知道该怎么办。
 */
function voiceLabel(v: VoiceOption): string {
  return v.available === false && v.note ? `${v.label} — ${v.note}` : v.label
}

function VoiceGroup({ label, items }: { label: string; items: VoiceOption[] }) {
  return (
    <optgroup label={label}>
      {items.map((v) => (
        <option
          key={v.voice}
          value={v.voice}
          disabled={v.available === false}
          title={v.available === false ? v.note : v.label}
        >
          {voiceLabel(v)}
        </option>
      ))}
    </optgroup>
  )
}

interface Props {
  total: number
  ra: ReadAlongApi
  /** 收起控制条。状态由 ReaderView 持有 —— 收起后浮出来的那个恢复胶囊
      要渲染在 PlaybackBar 之外，状态自然归共同父级 */
  onCollapse: () => void
}

export default function PlaybackBar({ total, ra, onCollapse }: Props) {
  const noSentence = total === 0
  const busy = !ra.ready

  // 渲染用完整目录；万一目录没取到（服务端 §9.4 那条挂了），退回可用音色，界面照常能用
  const catalog = ra.voiceCatalog.length > 0 ? ra.voiceCatalog : ra.voiceOptions
  const missing = catalog.filter((v) => v.available === false)
  const zhVoices = catalog.filter(isChinese)
  const otherVoices = catalog.filter((v) => !isChinese(v))

  return (
    <footer className="playbar">
      <button
        className="pb-btn"
        onClick={ra.prev}
        disabled={busy || noSentence || ra.cursor <= 0}
      >
        上一句
      </button>

      <button
        className="pb-btn pb-btn-main"
        onClick={ra.toggle}
        disabled={busy || noSentence}
      >
        {ra.playing ? '暂停' : '跟读'}
      </button>

      <button
        className="pb-btn"
        onClick={ra.next}
        disabled={busy || noSentence || ra.cursor >= total - 1}
      >
        下一句
      </button>

      <label className="pb-field">
        <span>语速</span>
        <select
          className="select"
          value={ra.rate}
          onChange={(e) => ra.setRate(Number(e.target.value))}
        >
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r.toFixed(2).replace(/0$/, '')}x
            </option>
          ))}
        </select>
      </label>

      <label className="pb-field">
        <span>音色</span>
        <select
          className="select pb-voice"
          value={ra.voice}
          onChange={(e) => ra.setVoice(e.target.value)}
          disabled={ra.voiceOptions.length === 0}
        >
          {ra.voiceOptions.length === 0 && <option value="">（无可用音色）</option>}
          {zhVoices.length > 0 && <VoiceGroup label="中文音色" items={zhVoices} />}
          {otherVoices.length > 0 && <VoiceGroup label="其他语言" items={otherVoices} />}
        </select>
      </label>

      {/* 只有多个引擎时才给选择器；契约 §9.1 说不可用的引擎不进列表 */}
      {ra.engineOptions.length > 1 && (
        <label className="pb-field">
          <span>引擎</span>
          <select
            className="select"
            value={ra.engineId}
            onChange={(e) => ra.setEngine(e.target.value)}
          >
            {ra.engineOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* 灰色音色得有个说法，否则读者不知道那几条为什么点不动（契约 §9.4） */}
      {missing.length > 0 && (
        <span
          className="pb-note"
          title="这些音色在音色目录里，但这台机器还没装对应的离线音色包"
        >
          {missing.length} 个音色需安装离线音色包
        </span>
      )}

      {ra.degraded && (
        <span className="pb-note" title="服务端的语音合成服务当前不可用">
          已降级为浏览器发声
        </span>
      )}

      <div className="pb-counter">
        {noSentence ? '无正文' : `第 ${ra.cursor + 1} / ${total} 句`}
      </div>

      {/* 放在 .pb-counter 之后：counter 带 margin-left:auto，它和它后面的一切
          都被推到右端，收起按钮自然落位最右侧 */}
      <button
        className="pb-btn pb-collapse"
        onClick={onCollapse}
        title="收起朗读控制条"
        aria-label="收起朗读控制条"
      >
        收起
      </button>
    </footer>
  )
}
