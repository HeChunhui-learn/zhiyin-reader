# 知音漫卷 —— 项目约定（每轮开工必读）

## 项目是什么

跨平台的阅读 Web 应用。用户导入 EPUB / TXT / Markdown，系统解析为结构化数据，在浏览器中图文混排滚动阅读，并能逐句高亮跟读；阅读进度与书签跨设备同步。

课程设计项目，**目标是两周内做出可现场演示的桌面 Web 应用**。不是生产级产品，不要过度设计。

**演示当天必须真实跑通的三项**：① 逐句高亮跟读（TTS）② 跨设备同步 + 冲突处理 ③ 图文混排与图片懒加载。

---

## 当前进度（每轮结束时更新这里）

- **R0 已完成**：六个界面 + 路由 + 假数据，纯前端。
- **R1 已完成**：Fastify + SQLite 起服务，九张表建库脚本 `server/sql/schema.sql`，种子数据，书架与阅读器读真实接口。
- **R2 已完成**：注册 / 登录 / 刷新令牌 / 退出、账号锁定；导入文档（前端解析 TXT 与 Markdown → 上传入库）；接口形状全面对齐《接口说明文档》契约。
- **R3 已完成**：EPUB 解析（epub.js 只取解析结果）；图片抽取、IndexedDB 缓存、按需加载与懒上传；正文内联渲染。
- **R4 已完成**：逐句跟读接真实 TTS —— 服务端代理本地 Kokoro（OpenAI 兼容）、服务端与客户端两级缓存、预加载、队列限流；不可用时自动降级为浏览器原生。游标由**真实的播放结束事件**驱动（不再有定时器）。
- **R5 已完成**：跨设备同步与冲突处理 —— 阅读进度按设备分行、版本号条件更新、书签增删改查与软删除墓碑、批量增量同步、冲突检测与「两份都保留」、用户裁决、离线待同步队列。
- **R6 已完成**：长文档窗口化渲染（500 段只渲染 25~38 个节点）；导入时上传原始文件；书架分类接真实数据；改昵称/改密码；一键启动脚本 `start.bat`；三份交付物文档在 `docs/`。
- **R7 进行中**（阅读体验与个人化，分五步做，每步停下验证）：
  - R7-1 已完成：朗读音色可选 —— 服务端新增音色目录 `server/src/tts/voiceCatalog.ts` 与
    `GET /api/tts/voices`（契约 §9.4），已装的标可选、没装的置灰并说明「需安装离线音色包」；
    前端音色下拉按语言分组，并把引擎/音色/语速记进 localStorage `zhiyin.readAlongPrefs`。
  - R7-2 已完成：目录改侧边抽屉（覆盖式，不推开正文）＋当前章节高亮
    （滚动回调里做变化检测闸门，只在跨章时 setState，避免 500 段文档每 16ms 重渲染）；
    书签默认名改为「锚点位置正文的前 10 个字」，规则抽成纯函数
    `client/src/features/sync/bookmarkName.ts`。
  - R7-3 已完成：阅读设置面板（白天/夜晚、字号、翻页方式、阅读背景图）。
    `client/src/features/settings/`（prefs 纯 TS + SettingsProvider + readerBackground）；
    夜晚模式走 `:root[data-theme='dark']` 只重定义变量，`app.css` 里 34 处硬编码浅色块
    全部收成变量（亮色下取值与改前逐字节相同）；
    字号接进窗口化几何 —— `buildGeometry(paragraphs, fontSize)` 按 16px 基线缩放，
    并在字号变化时**重锚定滚动位置**（不做的话跳转落点会静默偏掉几百像素）；
    背景图存 IndexedDB（`zhiyin-cache` 升到 v4，新增 `readerbg` store），只存本地不上传。
  - R7-4 已完成：上传上限 20MB→100MB（`bodyLimit`；`PUT .../file` 此前没有自己的上限，
    现在补了；导入的两个请求超时放宽到 120 秒；前端读文件之前就预检）；
    收藏（新表 `T_Favorite`，`PUT/DELETE /api/documents/{docId}/favorite` 两个方向都幂等，
    书架列表每项带 `isFavorite`，左导航新增「我的收藏」）。
  - R7-5 已完成：阅读时长统计（新表 `T_ReadingSession`，`client_id` 唯一索引 + `INSERT OR IGNORE`
    让离线补报天然幂等；只统计可见且聚焦的时长，卸载路径上 commit 后立刻 keepalive 发一次）；
    个人主页与头像（新表 `T_UserProfile`，`PUT/GET/DELETE /api/users/me/avatar`，
    头像**不能**直接 `<img src>`——接口要 Bearer，必须经接口取二进制）；
    新页面 `/stats` 与 `/profile`，书架左上角头像入口、左导航「阅读时长」。
  - **R7 五步全部完成。**

**六轮全部完成，252 项断言全绿。剩下的是人力活，不是开发活**：
在真机上核一遍（尤其窗口化滚动的观感）、把使用说明书打印出来、补 Kokoro 的实机验证。

启动方式：

```bash
cd server && npm install && npm run seed && npm run server   # 3000
cd client && npm install && npm run dev                       # 5173
```

数据库在 `server/data/zhiyin.db`，JWT 密钥在同目录 `.jwt-secret`（首次启动自动生成）。
重建：`cd server && npm run db:reset && npm run seed`。

**演示账号：`demo@example.com` / `demo12345`**（`sql/seed.ts` 里灌入，持有《人间词话》17 段）。
新增种子数据时用 `src/auth/password.ts` 的 `hashPassword` 生成口令哈希，不要写占位值——否则那个账号登不进去。

### 已落地的实现约定（后续轮次沿用，不要另起一套）

- **认证**：自签 HS256 JWT（`server/src/auth/jwt.ts`，用 node:crypto，没有引入 jsonwebtoken）；口令用 node:crypto 的 scrypt 加盐哈希（`password.ts`）；刷新令牌是 256 位随机串，以 SHA-256 哈希存 `T_Token`，**每次刷新即轮换，旧的立即删除**；访问令牌 30 分钟、刷新令牌 14 天；连续失败 5 次锁 15 分钟。
- **令牌存放**：accessToken 只在内存，refreshToken 在 localStorage，刷新页面后由 `SessionProvider` 静默换新。**这是课程设计下的取舍，生产环境应把 refreshToken 放 httpOnly Cookie。**
- **接口错误**：一律 `{ code, message, details, requestId }`，`message` 必须是中文；响应头带 `X-Request-Id`。前端 `ApiError` 会把 `code` 与 `details` 带出来。
- **前端请求**：`client/src/api/client.ts` 统一封装，15 秒超时，401 且携带刷新令牌时自动刷新一次并重放原请求（刷新做了单飞，避免并发互相顶掉）。
- **解析**：全部在 `client/src/features/parse/`，服务端不做解析（裁决 1）。句子也在前端切分并随段落上传。
- **内容哈希**：`client/src/features/parse/sha256.ts` 是纯 JS 实现，**不要换成 `crypto.subtle`**——平板通过局域网 http 访问时它不可用。
- **图片**：解析阶段抽出的 Blob 只写进 IndexedDB（`features/render/imageCache.ts`），**二进制不随导入上传**；阅读时图片首次进入视口才 `PUT` 上去（契约 §4.3 的懒上传）。服务端把图片落在 `server/data/images/`，前端一律经服务端取，不直连存储。
- **图片上限**：单文档 300 张或总量 200MB（先到者为准），按最后访问时间 LRU 淘汰（04 §4.1.3）。图片离开视口时撤销 object URL，IndexedDB 副本保留。

### 同步与冲突的几条约定（R5 定下来的，改动时别拆掉）

1. **锚点字段名以接口契约 §6.1 为准**（`chapterIndex` / `paragraphIndex` / `sentenceIndex` / `charOffset` / `scrollOffset`），
   服务端 `server/src/sync/anchor.ts` 与客户端 `client/src/features/sync/anchor.ts` 各一份，**必须一致**。
   不要再造 `paraIndex` 版本（裁决 2 已校正）。
2. **契约 §8.1 的 `updated` / `deleted` 条目里没有 `docId`、也没有 `anchor`** —— 只有 `created` 有。
   服务端必须靠 `bookmarkId` 反查 docId；锚点缺省时要**沿用库里已有的**，
   否则一次"只改名"的同步会把书签位置冲成第 0 段。
3. **软删除必须刷新 `updated_at`**。增量拉取是按 `updated_at > since` 比的，
   墓碑不刷新就永远拉不到（材料审查 E15）。
4. **进度是每设备一行**，不是每用户一行。`GET .../progress` 必须返回**所有设备**的记录，
   否则新设备拉不到别端进度，跨设备续读根本不成立。
5. **「不回退保护」的落法**：客户端选恢复位置时，取最近更新的一条，但**若本机已记录的位置更靠前，就用本机的**。
   契约原文那句是循环表述（材料审查 E13），这是把它落成代码后的意思。
6. **`keep_both` 时第二条记录的 id 由服务端生成**（裁决 3）。原件保留服务端内容，
   本机那份另存为新记录、名字加「（本机）」后缀；`conflict.resolved` 指向**新的那条**。
7. **冲突提示要在 `reload()` 之后设置**。`reload()` 成功会清空 error，
   顺序反了的话冲突说明会一闪而过。

### TTS 的几条约定（R4 定下来的，改动时别拆掉）

1. **缓存键客户端与服务端必须逐字节一致**。契约 §9.2 规定为 `sha256(engine + voice + rate + text)`，两边各有一份实现：
   `client/src/features/readalong/ttsCacheKey.ts` 与 `server/src/tts/cacheKey.ts`。
   里面用 `` 作分隔符（直接拼接会有歧义，材料审查 O50）。**改一边必须改另一边**，否则客户端永远命中不了服务端缓存。
2. **播放器一律用 `document.createElement('audio')`，不要用 `new Audio()`**。后者依赖全局 `Audio` 构造函数，不是所有环境都有（jsdom 就没有）。同理见 `audioPlayer.ts` 的注释。
3. **引擎抽象成"朗读一句，念完 resolve"**（`engines/types.ts`）。服务端引擎靠 `<audio>` 的 ended 事件，浏览器引擎靠 `SpeechSynthesisUtterance` 的 onend —— 两条完全不同的路收敛成同一个接口，上层的游标推进只写一份。
4. **游标由真实播放事件驱动，不要再引入定时器**。R0–R3 的 `setInterval` 已经删掉了，那是为了让界面先跑起来。用定时器的话"高亮位置与音频严格对应"这条验收要求就不成立。
5. **降级链是自动的**：`GET /api/tts/engines` 里 `available=false` 的引擎不进前端列表（契约 §9.1）；只剩浏览器原生时界面上要显示"已降级为浏览器发声"，并说明它只支持句子级高亮。

服务端 TTS 的环境变量（`server/src/tts/providers.ts`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TTS_BASE_URL` | `http://127.0.0.1:8880/v1` | 任何 OpenAI 兼容的 `/v1/audio/speech` 都行 |
| `TTS_API_KEY` | 空 | 本地服务一般不需要 |
| `TTS_MODEL` | `kokoro` | |
| `TTS_TIMEOUT_MS` | `20000` | 超时返回 504 `UPSTREAM_TIMEOUT` |

上游失败返回 502 `UPSTREAM_TTS_FAILED`；合成请求同时最多 2 个、最多排 8 个，超了返回 429 `RATE_LIMITED`。

**没装 Kokoro 也能演示**：`/api/tts/engines` 会如实报 `available=false`，前端自动降级到浏览器原生发声，跟读全链路照常可用。

### epub.js 的三个坑（都已在代码里处理，改动时别拆掉）

1. **必须传 `{ replacements: 'none' }`**。epub.js 在二进制（archived）模式下 `replacements` 默认取 `"blobUrl"`，会为书内每条资源创建一个由它自己持有的 object URL——我们不用它的渲染层，永远拿不到那些 URL 去 revoke，等于每张图漏一份（正是 04 §4.1.3 要防的）。
2. **`archive.getBlob` 要求路径带前导斜杠**。它的实现里写死了 `url.substr(1)`（去掉第一个字符），所以只认 `/OEBPS/images/x.png` 这种形式；`section.url` 本身就是这个形式。`joinPath` 里保留前导斜杠是**故意的**。
3. **default 导出有两种打包形态**。`package.json` 的 `module` 指向 ESM 源码（Vite 走这条，default 是函数），`main` 指向 Babel 编译的 CJS（Node 走这条，函数在 `.default` 上）。`epub.ts` 顶部的兼容判断两种都认，不要简化掉。

另外：`querySelectorAll('img')` **查不到元素自己**，所以 `<figure><img/></figure>` 这种图片作为直接子元素的结构要单独分支处理，否则会漏图。

### R5 遗留的占位（后续轮次替换）

- **幂等键存在进程内存里**，重启即失效（契约 §1 要求 24 小时内有效）。要跨重启得建表
- **`Idempotency-Key` 只覆盖 `/api/sync`**，单项接口没做
- **冲突裁决的请求体扩展了 `relatedId` 字段** —— 契约 §8.4 的请求体里没有它，但
  `keep_both` 之后要"二选一"必须知道另一条是谁（材料审查 A25 的模糊点）。客户端从 `conflict.resolved.bookmarkId` 取
- **`POST /api/sync` 每次请求都整体比较所有书签**，书签很多时会慢（没做真正的增量游标）
- 冲突列表只在本次会话内存里，刷新页面后靠 `T_SyncRecord` 里的记录，但界面还没把它读回来
- 书签只做了增删改查，没做**拖动排序**与**跨文档的书签总览**（书架里的"我的书签"分类仍是空页）
- 暂停是"停掉当前句"，不是"从句子中间继续" —— 恢复时该句从头念。真暂停要在引擎里保留位置，收益不大，先不做
- 语速改变会让当前句从头重念（`rate` 在播放循环的依赖里）
- `PATCH /api/users/me`（改昵称/改密码）未实现
- 导入时**没有上传原始文件**，`T_Document.resource_url` 恒为 null。接口已经实现，只是前端还没调
- 图片懒上传只在**阅读时**触发；导入后从没打开过的书，它的图在服务端一张都没有（契约 §4.3 的预期行为）
- 虚拟滚动还没做——正文一次性渲染全部段落，长文档会卡
- `epubjs` 300KB+ 打进了主包，没做代码分割

---

## 一、技术栈（版本已定，不要更换、不要新增）

| 层 | 选型 |
|---|---|
| 前端 | React 18 + Vite + TypeScript；路由 `react-router-dom` |
| 状态 | React 自带 state / context。**不引入 Redux、Zustand、MobX** |
| 样式 | 普通 CSS，一个 `client/src/app.css`。**不引入 Tailwind、Ant Design、MUI** |
| 后端 | Node.js 20 + TypeScript + **Fastify**（不是 Express） |
| 数据库 | SQLite 单文件 `server/data/zhiyin.db`，驱动 `better-sqlite3` |
| 解析 | EPUB 用 `epub.js` **只取解析结果**；Markdown 用 `marked`；TXT 自己解析 |
| 语音合成 | 默认本地 `Kokoro-FastAPI`（OpenAI 兼容），**经服务端代理**；不可用时降级浏览器 `SpeechSynthesis` |
| 端口 | 前端 **5173**，服务端 **3000**，Kokoro **8880** |

**关键设计约束**：正文渲染层用 ref + 直接 DOM 操作实现，不走 React 的差异渲染；句子切分、语音调度、同步引擎实现为无框架依赖的纯 TS 模块。原因见 `.context/02-设计-用例实现方案.md`。

---

## 二、目录结构

```
zhiyin-reader/
  CLAUDE.md
  .context/          # 材料（03/04/05/06/07/08 的正文抽取），按需查阅
  client/            # 前端，Vite 项目
    src/
      pages/         # 界面组件
      api/           # 接口客户端（client.ts / authStore.ts / device.ts）
      models/        # TS 类型定义
      state/         # 会话状态
      features/
        parse/       # 前端解析器（txt / markdown / epub / sha256）
        readalong/   # 句子切分、跟读编排、TTS 引擎、音频缓存
          engines/   # types / browserTts / serverTts / 工厂
        render/      # 图片缓存与懒加载（imageCache.ts / LazyImage.tsx）
        cache/       # IndexedDB 公共层（图片 / 音频 / 待同步队列共用）
        sync/        # 锚点、进度上报、书签读写、离线队列
  server/            # 后端
    src/
      routes/        # health / auth / documents / resources / tts / progress / bookmarks / sync
      tts/           # 语音合成代理（providers / cacheKey / 编排）
      sync/          # 同步与合并（anchor / merge 纯判定 / service 落库）
      dao/           # DataAccessLibrary —— 唯一的数据访问入口
      auth/          # jwt / password / tokens / require
      db.ts          # 连接与建库
      errors.ts      # 统一错误信封
    sql/schema.sql   # 建库脚本
    sql/seed.ts      # 种子数据
    data/            # SQLite、JWT 密钥、images/、files/、tts/（已在 .gitignore 里）
  docs/              # 交付物（使用说明书 / 测试报告 / 演示脚本，均已出 docx）
```

---

## 三、界面清单（类名固定，不许改名）

| 类名 | 中文 | 路由 |
|---|---|---|
| `GuidingUI` | 引导界面 | `/guide` |
| `LoginView` | 登录／注册界面 | `/login` |
| `LibraryView` | 书架界面 | `/shelf` |
| `ReaderView` | 阅读界面 | `/read/:docId` |
| `PlaybackBar` | 播放控制条（嵌入阅读界面底部） | 非独立路由 |
| `ConflictDialog` | 冲突对话框（模态） | 非独立路由，由 `ReaderView` / `LibraryView` 唤起 |

**作废的名字**：设计方案里的「首页 HomeUI」「导入 ImportUI」「阅读 ReaderUI」「播放 PlaybackUI」一律不用。
**导入文档不单独做界面**，在书架界面弹出文件选择框即可。

根路径 `/` 重定向到 `/guide`。

---

## 四、四条已拍板的裁决

> 这几条与 `.context/` 里的文档**不一致**，**以本节为准**。文档里那几处是已知的自相矛盾，不要再纠结。

### 裁决 1：解析放在前端

服务端**只负责存储与分发解析结果，不做文档解析**。

导入流程：前端读文件 → 前端解析成结构化数据 → 一次性 `POST` 给服务端入库。

理由：两周工期下最省事；服务端不必引入 EPUB / Markdown 解析依赖。

### 裁决 2：锚点只有一种定义

全项目只有一种锚点表示。**字段名以接口契约 §6.1 为准**（R5 时校正过一次：R0 写的版本用的是
`paraIndex` 且漏了 `sentenceIndex`，与契约不一致；接口形状按契约走，避免多一层翻译）：

```ts
type Anchor = {
  chapterIndex: number     // 章节序号，0 基
  paragraphIndex: number   // 该章内段落序号，0 基
  sentenceIndex: number    // 段内句子序号，0 基（跟读恢复位置用）
  charOffset: number       // 段内字符偏移，0 基（UTF-16 code unit）
  scrollOffset: number     // 滚动微调，像素
  docVersion?: string      // 文档内容哈希，可选；用于校验锚点是否仍有效
}
```

- 数据库 `T_ReadingProgress` 用 `chapter_index` / `paragraph_index` / `char_offset` / `scroll_offset` **四列展开存储**，
  `sentenceIndex` 对应 `last_sentence_index` 列（本机瞬态，不参与跨端同步）
- 数据库 `T_Bookmark.anchor_json` 存 `Anchor` 的完整 JSON 串
- 04 §4.2 里出现的 `updateAnchor(chapter, paragraph, offset)` 按此结构理解
- **不要**再造一份 `paraIndex` 版本 —— 锚点字段名全项目统一用 `paragraphIndex`

### 裁决 3：冲突保留两份时，由服务端生成第二条记录的 id

`POST /api/sync/resolve` 选择 `keep_both` 时，**服务端**为第二条生成新的 `bookmark_id`（格式 `bm_` + uuid v4 去横线），并在响应体中回传完整的两条记录；**客户端以响应为准覆盖本地，不得自行生成**。

理由：方案文档要求主键由客户端生成，但 `keep_both` 必然产生同 id 的两条记录，只能由服务端分配。

### 裁决 4：以数据库表为准

实体类字段由表反推。**表的权威定义在 `server/sql/schema.sql`**（已建好，九张表齐全），`.context/04-设计-数据模型.md` 是它的出处。其中：

- **不建音频表**。音频只做内存缓存 + IndexedDB 缓存，不落服务端库。`AudioClip` 实体只在前端存在：`{ sentenceId, voice, rate, blobKey, durationMs }`
- **不建 Token 实体类**。`T_Token` 表只由认证服务直接读写，不经 `DataAccessLibrary`
- `T_Document` 的外键统一叫 `owner_id`，**不要用 `user_id`**
- `T_Paragraph` 有一列 `para_type`（`h1` / `h2` / `p` / `img`），这是**建库时补的**——04 §4.3.1 的字段清单里没有它，但没有这列就分不出标题段和正文段。**不要删它，也不要"改回文档那样"**。相应的，建议后面把 04 §4.3.1(4) 的字段清单也补上这一列。
- `T_ImageResource` 有一列 `alt`，同样是补的。依据是**接口契约 §4.1 的 imageRefs 示例里本来就有 `alt` 字段**，而 04 §4.3.1(6) 的字段清单漏了它，不补的话阅读器只能把包内路径当说明文字显示。建议 04 也补上。

---

## 五、术语表（全项目统一，不要用同义词）

| 用这个词 | 不要用 |
|---|---|
| 读者 | 用户、普通用户（`user` 只出现在表名/字段名里，如 `user_id`） |
| `deviceId` | 设备指纹、Device ID、设备标识 |
| `docId` | 文档标识、文档 ID |
| `anchor` | 位置锚点、进度锚点、阅读进度锚点 |
| `highlightCursor` | 高亮游标、当前高亮句子索引 |

数据库列名统一 `snake_case`，TS 字段统一 `camelCase`，接口 JSON 统一 `camelCase`。

---

## 六、不做的事（明确不做，不要自己加）

- **移动端 / 平板适配、响应式断点**——第一版只做桌面浏览器，窗口宽度 ≥ 1280px
- **AI 伴读问答**——接口留占位，不实现
- **第三方 OAuth 登录**——`oauthLogin(provider)` 留一个空实现即可
- **对象存储 / CDN**——图片存在服务端本地 `server/data/images/`，前端不直连
- **OT / CRDT 等合并算法**；**高亮位置跨端同步**
- **PDF 格式**
- 「自动识别小说角色、分配不同声音」这类文档里出现过但没有功能归属的想法
- 不要写单元测试框架（除非我明确要求某一轮）

---

## 七、工作方式约定

1. **每轮先跑起来再优化。** 写完一个可运行的小步就停下来让我验证，**不要一次写十几个文件**。
2. 改完必须保证 `npm run dev`（前端）与 `npm run server`（后端）能同时起来且不报错。
3. 不要引入"技术栈"里没写的依赖；需要新依赖先问我。
4. 所有接口错误必须被前端捕获并显示成中文提示，**不允许白屏**。
5. 界面文案一律中文。
6. 遇到歧义按第四节的四条裁决处理；**裁决覆盖不到时，按你认为最省事的方式做，不要停下来问我**，并在结束时列出你做了哪些临时决定。

---

## 八、`.context/` 索引（按需查阅，不要一次性全读）

| 文件 | 什么时候读 |
|---|---|
| `01-需求-用例与性能要求.md` | 需要知道某个功能到底要做什么、性能指标多少 |
| `02-设计-用例实现方案.md` | 实现某个用例时——六个用例的设计流程与消息参数；**句子切分规则 R1–R10 在这里** |
| `03-设计-类模型.md` | **建 TS 类型、写界面骨架时**——每个类的属性、操作、依赖关系的完整文字版 |
| `04-设计-数据模型.md` | **建库、写 DAO 时**——九张表逐字段 + `DataAccessLibrary` 全部方法签名 |
| `05-设计-界面与部署.md` | 做界面、写部署脚本时 |
| `06-设计-体系结构与约束.md` | 想确认分层与依赖方向时 |
| `07-接口契约.md` | **写任何接口时**——API 契约（路径、请求/响应体、错误码、冲突响应格式） |
| `08-书签补充.md` | 做书签功能时 |
| `08b-句子切分补充.md` | 做句子切分时 |
| `09-技术选型.md` | 确认版本、部署形态、语音合成方案 |
| `10-界面版面稿.md` | **做界面时必读**——四张界面外观图是位图已丢失，版面结构只在这里 |

**注意**：`.context/` 里的文档之间**存在已知冲突**（同一件事多种规定），这些冲突已由第四节的四条裁决解决了大部分，剩下的按第 7 条处理。
