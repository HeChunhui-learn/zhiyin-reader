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

/**
 * 朗读控制条。
 *
 * 布局按"手放到哪里最顺"分三段：左边三个走句按钮（主按钮最大、居中，
 * 拇指一停就能按到），中间是进度（句子序号 + 百分比 + 顶部一条墨线进度），
 * 右边是语速／音色这些"调一次就不常动"的设置。
 */
export default function PlaybackBar({ total, ra, onCollapse }: Props) {
  const noSentence = total === 0
  const busy = !ra.ready

  // 渲染用完整目录；万一目录没取到（服务端 §9.4 那条挂了），退回可用音色，界面照常能用
  const catalog = ra.voiceCatalog.length > 0 ? ra.voiceCatalog : ra.voiceOptions
  const missing = catalog.filter((v) => v.available === false)
  const zhVoices = catalog.filter(isChinese)
  const otherVoices = catalog.filter((v) => !isChinese(v))

  const percent = noSentence ? 0 : Math.round(((ra.cursor + 1) / total) * 100)
  /* 长篇（剑来 8.7 万句）刚开读时百分比是 0，墨线会一根都看不见，
     所以给一个最小可见宽度，让「已开始」这件事有反馈 */
  const railWidth = noSentence ? 0 : Math.max(percent, 0.8)
  const percentText = noSentence ? '' : percent < 1 ? '不足 1%' : `${percent}%`

  return (
    <footer className="playbar">
      {/* 顶部一条极细的墨线进度：不占高度，扫一眼就知道读到哪儿了 */}
      <span className="pb-rail" aria-hidden="true">
        <i style={{ width: `${railWidth}%` }} />
      </span>

      <div className="pb-transport">
        <button
          className="pb-btn pb-step"
          onClick={ra.prev}
          disabled={busy || noSentence || ra.cursor <= 0}
          title="回到上一句"
        >
          上一句
        </button>

        <button
          className={'pb-btn pb-btn-main' + (ra.playing ? ' is-playing' : '')}
          onClick={ra.toggle}
          disabled={busy || noSentence}
          title={ra.playing ? '暂停跟读' : '从当前句开始跟读'}
        >
          {ra.playing ? '暂停' : '跟读'}
          {/* 发声时才有的声纹，紧贴在按钮文字后面（纯装饰，不进无障碍名） */}
          {ra.playing && (
            <span className="pb-wave" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
        </button>

        <button
          className="pb-btn pb-step"
          onClick={ra.next}
          disabled={busy || noSentence || ra.cursor >= total - 1}
          title="跳到下一句"
        >
          下一句
        </button>
      </div>

      <div className="pb-progress">
        <span className="pb-counter">{noSentence ? '无正文' : `第 ${ra.cursor + 1} / ${total} 句`}</span>
        {!noSentence && <span className="pb-percent">{percentText}</span>}
      </div>

      {/* 灰色音色得有个说法，否则读者不知道那几条为什么点不动（契约 §9.4） */}
      {(missing.length > 0 || ra.degraded) && (
        <div className="pb-flags">
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
        </div>
      )}

      <div className="pb-options">
        <label className="pb-field">
          <span>语速</span>
          <select
            className="select"
            value={ra.rate}
            onChange={(e) => ra.setRate(Number(e.target.value))}
            title="跟读速度"
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
            title="朗读音色"
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
              title="发声引擎"
            >
              {ra.engineOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

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
