import type { ReadAlongApi } from '../features/readalong/useReadAlong'

export const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

interface Props {
  total: number
  ra: ReadAlongApi
}

export default function PlaybackBar({ total, ra }: Props) {
  const noSentence = total === 0
  const busy = !ra.ready

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
          {ra.voiceOptions.map((v) => (
            <option key={v.voice} value={v.voice}>
              {v.label}
            </option>
          ))}
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

      {ra.degraded && (
        <span className="pb-note" title="服务端的语音合成服务当前不可用">
          已降级为浏览器发声
        </span>
      )}

      <div className="pb-counter">
        {noSentence ? '无正文' : `第 ${ra.cursor + 1} / ${total} 句`}
      </div>
    </footer>
  )
}
