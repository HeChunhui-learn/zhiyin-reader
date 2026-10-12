/**
 * Kokoro 音色目录。
 *
 * Kokoro 的音色是**随模型包一起离线下载**的（中文音色还要额外的中文语言包），
 * 本机到底装了哪些，只有问上游才知道 —— `GET /audio/voices` 报什么就是什么。
 * 但光有上游那份清单不够用，两个原因：
 *
 *   1. 上游只给 id（zf_xiaobei），界面上没法看；这份目录补上中文名、性别、口音
 *   2. 没装中文包时中文音色一个都不出现，读者分不清是"这个引擎没有"还是"我没装"。
 *      目录把没装的照常列出来，由调用方标成不可选并说明原因
 *
 * **voice 字段是 TTS 缓存键 sha256(engine + voice + rate + text) 的一部分**
 * （契约 §9.2，客户端 client/src/features/readalong/ttsCacheKey.ts 与
 * 服务端 server/src/tts/cacheKey.ts 各有一份实现，必须逐字节一致）。
 * 所以这里必须与上游的 id 一模一样，不要做任何改写、别名或大小写归一。
 */

export interface CatalogVoice {
  voice: string
  /** 界面上的显示名，已含性别与口音 */
  label: string
  lang: string
  gender?: 'female' | 'male'
  /** 是否中文音色。非中文的读中文会走音，界面上要提示 */
  chinese: boolean
}

export const KOKORO_VOICES: CatalogVoice[] = [
  // ---- 中文（普通话）----
  { voice: 'zf_xiaobei', label: '晓北（女·普通话）', lang: 'zh', gender: 'female', chinese: true },
  { voice: 'zf_xiaoni', label: '晓妮（女·普通话）', lang: 'zh', gender: 'female', chinese: true },
  { voice: 'zf_xiaoxiao', label: '晓晓（女·普通话）', lang: 'zh', gender: 'female', chinese: true },
  { voice: 'zf_xiaoyi', label: '晓伊（女·普通话）', lang: 'zh', gender: 'female', chinese: true },
  { voice: 'zm_yunjian', label: '云健（男·普通话）', lang: 'zh', gender: 'male', chinese: true },
  { voice: 'zm_yunxi', label: '云希（男·普通话）', lang: 'zh', gender: 'male', chinese: true },
  { voice: 'zm_yunxia', label: '云夏（男·普通话）', lang: 'zh', gender: 'male', chinese: true },
  { voice: 'zm_zhaoyun', label: '赵云（男·普通话）', lang: 'zh', gender: 'male', chinese: true },

  // ---- 英语（本项目的正文是中文，列出来只为兜底，界面上会标"读中文会走音"）----
  { voice: 'af_heart', label: 'Heart（女·美音）', lang: 'en', gender: 'female', chinese: false },
  { voice: 'af_bella', label: 'Bella（女·美音）', lang: 'en', gender: 'female', chinese: false },
  { voice: 'am_adam', label: 'Adam（男·美音）', lang: 'en', gender: 'male', chinese: false },
  { voice: 'am_michael', label: 'Michael（男·美音）', lang: 'en', gender: 'male', chinese: false },
  { voice: 'bf_emma', label: 'Emma（女·英音）', lang: 'en', gender: 'female', chinese: false },
  { voice: 'bm_george', label: 'George（男·英音）', lang: 'en', gender: 'male', chinese: false },

  // ---- 日语 ----
  { voice: 'jf_alpha', label: 'Alpha（女·日语）', lang: 'ja', gender: 'female', chinese: false },
  { voice: 'jm_kumo', label: 'Kumo（男·日语）', lang: 'ja', gender: 'male', chinese: false },
]

/** 本机没装这个音色包时，界面上给出的说明 */
export const MISSING_VOICE_NOTE = '需安装离线音色包'

export function findCatalogVoice(voiceId: string): CatalogVoice | undefined {
  return KOKORO_VOICES.find((v) => v.voice === voiceId)
}
