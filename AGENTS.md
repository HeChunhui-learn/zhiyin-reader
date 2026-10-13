# 知音漫卷（zhiyin-reader） · AGENTS.md

> 本文件是智能体（AI 编码助手）在本仓库工作的核心指引：项目理解 + 文档体系 + 交互协议 + 工作流。
> **核心项目约定在 `CLAUDE.md`**（每轮开工必读，与本文互补：CLAUDE.md 讲"这个项目是什么、已定下什么"，本文讲"怎么在这里干活"）。
> `.context/` 里的材料正文按需查阅，索引见 CLAUDE.md 第八节，**不要一次性全读**。

## ① 项目理解

### 项目简介

- **知音漫卷**，软件工程课程设计 · 第一组。跨平台阅读 Web 应用：读者导入 EPUB / TXT / Markdown，系统解析为结构化数据，在浏览器里图文混排滚动阅读，并能**逐句高亮跟读**；阅读进度与书签**跨设备同步**。
- **定位**：两周内做出可现场演示的桌面 Web 应用。**不是生产级产品，不要过度设计。**
- **演示当天必须真实跑通的三项**（其余功能都围绕它们服务）：① 逐句高亮跟读（TTS）② 跨设备同步 + 冲突处理 ③ 图文混排与图片懒加载。
- **六轮开发（R0–R6）已全部完成**，其后 `main` 又完成了 **R7（阅读体验与个人化，五步）**。当前处于**多角色并行迭代阶段**（分支 `V1.A` / `V1.B` / `V1.C` / `V1.D`）。
- **R7 五步**：R7-1 朗读音色可选（`server/src/tts/voiceCatalog.ts` + `GET /api/tts/voices`，契约 §9.4，没装的音色置灰）；R7-2 目录侧边抽屉 + 当前章节高亮（滚动回调里做变化检测闸门，只在跨章时 setState）；R7-3 阅读设置面板（白天/夜晚、字号、翻页方式、背景图，`client/src/features/settings/`）；R7-4 上传上限提到 100MB（后又提到 500MB，见契约 §4.8）+ 收藏（新表 `T_Favorite`）；R7-5 阅读时长统计（新表 `T_ReadingSession`，`client_id` 唯一索引 + `INSERT OR IGNORE`）与个人主页头像（新表 `T_UserProfile`，头像**不能**直接 `<img src>`，接口要 Bearer 必须经接口取二进制），新页面 `/stats` 与 `/profile`。

### 技术栈（版本已定，不要更换、不要新增）

| 层 | 选型 |
|---|---|
| 前端 | React 18 + Vite + TypeScript；路由 `react-router-dom` |
| 状态 | React 自带 state / context。**不引入 Redux、Zustand、MobX** |
| 样式 | 普通 CSS，单文件 `client/src/app.css`。**不引入 Tailwind、Ant Design、MUI** |
| 后端 | Node.js 20 + TypeScript + **Fastify 4**（不是 Express） |
| 数据库 | SQLite 单文件 `server/data/zhiyin.db`，驱动 `better-sqlite3` |
| 解析 | EPUB 用 `epub.js` **只取解析结果**；Markdown 用 `marked`；TXT 自己解析 |
| 语音合成 | 默认本地 `Kokoro-FastAPI`（OpenAI 兼容），**经服务端代理**；不可用时降级浏览器 `SpeechSynthesis` |
| 端口 | 前端 **5173**，服务端 **3000**，Kokoro **8880** |

**关键设计约束**：正文渲染层用 ref + 直接 DOM 操作实现，**不走 React 的差异渲染**；句子切分、语音调度、同步引擎实现为**无框架依赖的纯 TS 模块**。原因见 `.context/02-设计-用例实现方案.md`。

> ⚠️ **`better-sqlite3` 版本是当前最硬的环境坑**：`main` / `V1.A` / `V1.B` 上是 `^13.0.3`，但 **v13.0.0–13.0.3 的预编译包数量为 0**、install 脚本直接就是 `node-gyp rebuild`，Windows 上没有 Visual Studio Build Tools **必然装不上**。`V1.C` 已回退到 `^12.11.1`（提供 Node 24 / ABI 137 预编译包，下载即用）。**合并时以 `^12.11.1` 为准**；在没合之前，在 Windows 上跑 `main` 系分支需要临时 `npm i better-sqlite3@12.11.1 --no-save`。API 用法（`prepare`/`run`/`get`/`all`）两版一致，业务代码不受影响。

### 怎么跑

要开**两个终端**：

```bash
# 终端 1 —— 服务端（3000）
cd server
npm install                # 首次
npm run seed               # 首次：建库 + 灌入演示数据
npm run server             # tsx watch，改代码自动重启

# 终端 2 —— 前端（5173）
cd client
npm install                # 首次
npm run dev                # → http://localhost:5173
```

也可双击项目根目录的 **`start.bat`**（自动检查 Node、装依赖、建库、开两个窗口、打开浏览器）。

- **演示账号**：`demo@example.com` / `demo12345`（持有《人间词话》`doc_renjian`，17 段 / 44 句）
- **数据库**：`server/data/zhiyin.db`；JWT 密钥在同目录 `.jwt-secret`（首次启动自动生成）
- **重建**：`cd server && npm run db:reset && npm run seed` —— **改了 `server/sql/schema.sql` 的列/表后必须重建**，`seed` 不会自动迁移已存在的库
- **Kokoro 没装也能演示**：`/api/tts/engines` 会如实报 `available=false`，前端自动降级为浏览器发声，跟读全链路照常可用

**可用脚本**（`server/package.json` / `client/package.json`）：

| 位置 | 命令 | 作用 |
|---|---|---|
| `server/` | `npm run server` | `tsx watch src/index.ts`（开发，自动重启） |
| `server/` | `npm run start` | `tsx src/index.ts`（不带 watch） |
| `server/` | `npm run seed` | 建库 + 灌演示数据 |
| `server/` | `npm run typecheck` | `tsc --noEmit` |
| `server/` | `npm run db:reset` | 删掉 `server/data/` 整个目录 |
| `client/` | `npm run dev` | Vite 开发服务器（5173） |
| `client/` | `npm run build` | `tsc -b && vite build`（**提交前必须过**） |
| `client/` | `npm run preview` | 预览构建产物 |

> 🔌 **本机联网前提**：`npm install` 与 `git fetch/push` 需要外网。本机环境变量 `HTTPS_PROXY` / `HTTP_PROXY` 指向 `http://127.0.0.1:7900`，**而该端口并未监听**（直连会 `Failed to connect to github.com port 443 via 127.0.0.1`）；实际可用的是 **`7897`**。临时走通：`git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 <git 命令>`。改动全局配置前先问用户。

### 目录结构

```
zhiyin-reader/
  AGENTS.md          # 本文件：怎么在这里干活
  CLAUDE.md          # 核心项目约定（技术栈 / 界面清单 / 四条裁决 / 术语表 / 不做的事）
  README.md          # 面向人：六轮做了什么、怎么跑
  start.bat          # 一键启动（Windows）
  .context/          # 材料正文（03/04/05/06/07/08 的抽取），按需查阅
  client/            # 前端，Vite 项目
    src/
      pages/         # 界面组件（类名固定，见 CLAUDE.md 第三节）
      api/           # 接口客户端（client.ts / authStore.ts / device.ts）
      models/        # TS 类型定义
      state/         # 会话状态
      features/
        parse/       # 前端解析器（txt / markdown / epub / sha256）
        readalong/   # 句子切分、跟读编排、TTS 引擎、音频缓存
          engines/   #   types / browserTts / serverTts / 工厂
        render/      # 图片缓存与懒加载（imageCache.ts / LazyImage.tsx / virtualWindow.ts / toc.ts）
        settings/    # 阅读设置（R7-3：prefs 纯 TS + SettingsProvider + readerBackground）
        profile/     # 头像（R7-5：UserAvatar.tsx，经接口取二进制，不能直接 <img src>）
        cache/       # IndexedDB 公共层（图片 / 音频 / 待同步队列 / 阅读背景图共用，v4）
        sync/        # 锚点、进度上报、书签读写、离线队列、（V1.B 未合并的 bookmarkName）
  server/            # 后端
    src/
      routes/        # health / auth / documents / resources / tts / progress / bookmarks / sync / readingTime
      tts/           # 语音合成代理（providers / cacheKey / 编排 / voiceCatalog 音色目录）
      sync/          # 同步与合并（anchor / merge 纯判定 / service 落库）
      dao/           # DataAccessLibrary —— 唯一的数据访问入口
      auth/          # jwt / password / tokens / require
      db.ts          # 连接与建库
      errors.ts      # 统一错误信封
    sql/schema.sql   # 建库脚本（表的权威定义，12 张表）
    sql/seed.ts      # 种子数据
    data/            # SQLite、JWT 密钥、images/、files/、tts/（已在 .gitignore）
  docs/              # 交付物（使用说明书 / 测试报告 / 演示脚本）
```

**12 张表**（`server/sql/schema.sql`，共 192 行）：R0 建库时 9 张 —— `T_User` / `T_Document` / `T_Paragraph` / `T_Sentence` / `T_ImageResource` / `T_ReadingProgress` / `T_SyncRecord` / `T_Bookmark` / `T_Token`；**R7 追加 3 张** —— `T_Favorite`（收藏）、`T_ReadingSession`（阅读时长，`client_id` 唯一索引）、`T_UserProfile`（头像）。另有各分支未合并的追加：`V1.A` 的 `T_Idempotency`（复合主键 `(user_id, idem_key)`）、`V1.B` 给 `T_Bookmark` 追加 `sort_order` / `chapter_title` 两列与索引 `ix_bookmark_order`。

### 已落地的实现约定（后续沿用，不要另起一套）

- **认证**：自签 HS256 JWT（`server/src/auth/jwt.ts`，用 `node:crypto`，**没有引入 jsonwebtoken**）；口令用 `node:crypto` 的 scrypt 加盐哈希（`password.ts`）；刷新令牌是 256 位随机串、以 SHA-256 哈希存 `T_Token`，**每次刷新即轮换，旧的立即删除**；访问令牌 30 分钟、刷新令牌 14 天；连续失败 5 次锁 15 分钟。
- **令牌存放**：accessToken 只在内存，refreshToken 在 localStorage，刷新页面后由 `SessionProvider` 静默换新。**这是课程设计下的取舍，生产环境应把 refreshToken 放 httpOnly Cookie。**
- **接口错误**：一律 `{ code, message, details, requestId }`，**`message` 必须是中文**；响应头带 `X-Request-Id`（`server/src/index.ts:29-33`）。前端 `ApiError` 会把 `code` 与 `details` 带出来。
- **前端请求**：`client/src/api/client.ts` 统一封装，15 秒超时，401 且携带刷新令牌时自动刷新一次并重放原请求（刷新做了**单飞**，避免并发互相顶掉）。
- **解析**：全部在 `client/src/features/parse/`，**服务端不做解析**（裁决 1）。句子也在前端切分并随段落上传。
- **内容哈希**：`client/src/features/parse/sha256.ts` 是纯 JS 实现，**不要换成 `crypto.subtle`** —— 平板通过局域网 http 访问时它不可用。
- **图片**：解析阶段抽出的 Blob 只写进 IndexedDB（`features/render/imageCache.ts`），**二进制不随导入上传**；阅读时图片首次进入视口才 `PUT` 上去（契约 §4.3 的懒上传）。服务端把图片落在 `server/data/images/`，前端一律经服务端取，不直连存储。
- **图片上限**：单文档 300 张或总量 200MB（先到者为准），按最后访问时间 LRU 淘汰（04 §4.1.3）。图片离开视口时撤销 object URL，IndexedDB 副本保留。

### 同步与冲突的几条约定（R5 定下来的，改动时别拆掉）

1. **锚点字段名以接口契约 §6.1 为准**（`chapterIndex` / `paragraphIndex` / `sentenceIndex` / `charOffset` / `scrollOffset`），服务端 `server/src/sync/anchor.ts` 与客户端 `client/src/features/sync/anchor.ts` 各一份，**必须一致**。不要再造 `paraIndex` 版本（裁决 2 已校正）。
2. **契约 §8.1 的 `updated` / `deleted` 条目里没有 `docId`、也没有 `anchor`** —— 只有 `created` 有。服务端必须靠 `bookmarkId` 反查 docId；锚点缺省时要**沿用库里已有的**，否则一次"只改名"的同步会把书签位置冲成第 0 段。
3. **软删除必须刷新 `updated_at`**。增量拉取是按 `updated_at > since` 比的，墓碑不刷新就永远拉不到（材料审查 E15）。
4. **进度是每设备一行**，不是每用户一行。`GET .../progress` 必须返回**所有设备**的记录，否则新设备拉不到别端进度，跨设备续读根本不成立。
5. **「不回退保护」的落法**：客户端选恢复位置时，取最近更新的一条，但**若本机已记录的位置更靠前，就用本机的**（契约原文那句是循环表述，材料审查 E13）。
6. **`keep_both` 时第二条记录的 id 由服务端生成**（裁决 3）。原件保留服务端内容，本机那份另存为新记录、名字加「（本机）」后缀；`conflict.resolved` 指向**新的那条**。
7. **冲突提示要在 `reload()` 之后设置**。`reload()` 成功会清空 error，顺序反了的话冲突说明会一闪而过。
8. **进度冲突不落库**：`decideProgress` 只产出 `superseded`，服务端当场按「不回退保护」裁决完，落了只会攒出永远没人处理的幽灵冲突（`V1.A` 结论）。
9. **`V1.B` 的 `sort_order` 合并规则是 `superseded`（取较新者），不是 `keep_both`** —— `keep_both` 会为同一条书签造重复副本。与角色 A 的约定登记在 `docs/迭代登记-B.md`。

### TTS 的几条约定（R4 定下来的，改动时别拆掉）

1. **缓存键客户端与服务端必须逐字节一致**。契约 §9.2 规定为 `sha256(engine + voice + rate + text)`，两边各一份实现：`client/src/features/readalong/ttsCacheKey.ts` 与 `server/src/tts/cacheKey.ts`。里面用 `\u0001` 作分隔符（直接拼接会有歧义，材料审查 O50）。**改一边必须改另一边**，否则客户端永远命中不了服务端缓存。
2. **播放器一律用 `document.createElement('audio')`，不要用 `new Audio()`**。后者依赖全局 `Audio` 构造函数，不是所有环境都有（jsdom 就没有）。
3. **引擎抽象成"朗读一句，念完 resolve"**（`engines/types.ts`）。服务端引擎靠 `<audio>` 的 ended 事件，浏览器引擎靠 `SpeechSynthesisUtterance` 的 onend —— 两条完全不同的路收敛成同一个接口，上层的游标推进只写一份。
4. **游标由真实播放事件驱动，不要再引入定时器**。R0–R3 的 `setInterval` 已经删掉了；用定时器的话"高亮位置与音频严格对应"这条验收要求就不成立。
5. **改语速不进播放循环的依赖数组**（`V1.C` 的 C3）—— 走 `rateRef`，当前句念完、新语速从下一句生效。换引擎/音色仍会重启循环，这是有意的。
6. **降级链是自动的**：`GET /api/tts/engines` 里 `available=false` 的引擎不进前端列表（契约 §9.1）；只剩浏览器原生时界面上要显示"已降级为浏览器发声"。

服务端 TTS 环境变量（`server/src/tts/providers.ts`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TTS_BASE_URL` | `http://127.0.0.1:8880/v1` | 任何 OpenAI 兼容的 `/v1/audio/speech` 都行 |
| `TTS_API_KEY` | 空 | 本地服务一般不需要 |
| `TTS_MODEL` | `kokoro` | |
| `TTS_TIMEOUT_MS` | `20000` | 超时返回 504 `UPSTREAM_TIMEOUT` |

上游失败返回 502 `UPSTREAM_TTS_FAILED`；合成请求同时最多 2 个、最多排 8 个，超了返回 429 `RATE_LIMITED`。

### epub.js 的三个坑（已在代码里处理，改动时别拆掉）

1. **必须传 `{ replacements: 'none' }`**。epub.js 在二进制（archived）模式下 `replacements` 默认取 `"blobUrl"`，会为书内每条资源创建一个由它自己持有的 object URL——我们不用它的渲染层，永远拿不到那些 URL 去 revoke，等于每张图漏一份（正是 04 §4.1.3 要防的）。
2. **`archive.getBlob` 要求路径带前导斜杠**。它的实现里写死了 `url.substr(1)`，所以只认 `/OEBPS/images/x.png` 这种形式；`joinPath` 里保留前导斜杠是**故意的**。
3. **default 导出有两种打包形态**。`package.json` 的 `module` 指向 ESM 源码（Vite 走这条，default 是函数），`main` 指向 Babel 编译的 CJS（Node 走这条，函数在 `.default` 上）。`epub.ts` 顶部的兼容判断两种都认，不要简化掉。

另外：`querySelectorAll('img')` **查不到元素自己**，所以 `<figure><img/></figure>` 这种图片作为直接子元素的结构要单独分支处理，否则会漏图。

### 界面清单（类名固定，不许改名）

| 类名 | 中文 | 路由 |
|---|---|---|
| `GuidingUI` | 引导界面 | `/guide` |
| `LoginView` | 登录／注册界面 | `/login` |
| `LibraryView` | 书架界面（含"我的收藏"分类） | `/shelf` |
| `ReaderView` | 阅读界面 | `/read/:docId` |
| `StatsView` | 阅读时长（R7-5 新建） | `/stats` |
| `ProfileView` | 个人主页（R7-5 新建） | `/profile` |
| `ReaderSettingsPanel` | 阅读设置面板（R7-3 新建，嵌入阅读界面） | 非独立路由 |
| `PlaybackBar` | 播放控制条（嵌入阅读界面底部） | 非独立路由 |
| `ConflictDialog` | 冲突对话框（模态） | 非独立路由，由 `ReaderView` / `LibraryView` 唤起 |
| `BookmarkPanel` | 书签面板（`V1.B` 新建，**本分支尚未合并**） | 非独立路由，嵌在 `ReaderView` |

路由表见 `client/src/App.tsx`（`/` 与未匹配路径都重定向到 `/guide`）。**作废的名字**：「首页 HomeUI」「导入 ImportUI」「阅读 ReaderUI」「播放 PlaybackUI」一律不用。**导入文档不单独做界面**，在书架界面弹出文件选择框即可。

### 四条已拍板的裁决

> 这几条与 `.context/` 里的文档**不一致**，**以本节为准**。文档里那几处是已知的自相矛盾，不要再纠结。完整表述见 CLAUDE.md 第四节。

1. **解析放在前端** —— 服务端只负责存储与分发解析结果，不做文档解析。
2. **锚点只有一种定义** —— 字段名以接口契约 §6.1 为准，全项目统一用 `paragraphIndex`（**不要**再造 `paraIndex` 版本）。
3. **冲突保留两份时，由服务端生成第二条记录的 id**（格式 `bm_` + uuid v4 去横线），客户端以响应为准覆盖本地，**不得自行生成**。
4. **以数据库表为准** —— 表的权威定义在 `server/sql/schema.sql`。其中：**不建音频表**；**不建 Token 实体类**（`T_Token` 不经 `DataAccessLibrary`）；`T_Document` 的外键统一叫 `owner_id`，**不要用 `user_id`**；`T_Paragraph.para_type`（`h1`/`h2`/`p`/`img`）与 `T_ImageResource.alt` 是**建库时补的**，**不要删、不要"改回文档那样"**。

### 术语表（全项目统一，不要用同义词）

| 用这个词 | 不要用 |
|---|---|
| 读者 | 用户、普通用户（`user` 只出现在表名/字段名里，如 `user_id`） |
| `deviceId` | 设备指纹、Device ID、设备标识 |
| `docId` | 文档标识、文档 ID |
| `anchor` | 位置锚点、进度锚点、阅读进度锚点 |
| `highlightCursor` | 高亮游标、当前高亮句子索引 |

数据库列名统一 `snake_case`，TS 字段统一 `camelCase`，接口 JSON 统一 `camelCase`。

### 不做的事（明确不做，不要自己加）

- **移动端 / 平板适配、响应式断点** —— 第一版只做桌面浏览器，窗口宽度 ≥ 1280px
- **AI 伴读问答** —— 接口留占位（契约 §9.3），不实现
- **第三方 OAuth 登录** —— `oauthLogin(provider)` 留空实现即可
- **对象存储 / CDN** —— 图片存 `server/data/images/`，前端不直连
- **OT / CRDT 等合并算法**；**高亮位置跨端同步**
- **PDF 格式**
- 「自动识别小说角色、分配不同声音」这类文档里出现过但没有功能归属的想法
- **不要写单元测试框架**（除非明确要求某一轮）

## ② 文档体系

| 文档 | 用途 |
|---|---|
| `CLAUDE.md` | **核心项目约定**（321 行）：项目定位、当前进度、已落地的实现约定、同步/冲突约定、TTS 约定、epub.js 三个坑、技术栈、目录结构、界面清单、四条裁决、术语表、不做的事、`.context/` 索引 |
| `README.md` | 面向人：六轮各做了什么、怎么跑、演示账号、占位清单、排期（300 行）。**R1 之前的记录带"当时状态"性质，形状已在 R2 按契约调整过** |
| `.context/` | **材料正文**（11 份）。`07-接口契约.md`（674 行）是**接口权威**，写任何接口前必读；`10-界面版面稿.md`（166 行）是**四张界面外观位图丢失后仅存的版面结构**，做界面时必读；索引与"什么时候读"见 CLAUDE.md 第八节 |
| `docs/01-使用说明书.md` | 面向使用者：启动、界面、完整操作流程、常见问题（280 行，R7 已补新功能） |
| `docs/02-测试用例与测试报告.md` | 121 条用例 / **252 项断言的台账**，**含开发中发现的 15 个缺陷及修复**（308 行）——**缺陷表是全篇最有价值的部分**，排查类似问题先来这里翻。⚠️ **R7 新增的功能（音色/设置/收藏/时长/头像）都不在这份报告覆盖范围内** |
| `docs/03-演示脚本.md` | 8 分钟现场演示的逐段话术与应急处理（144 行） |
| `server/sql/schema.sql` | **表的权威定义**（裁决 4），**12 张表**（192 行）+ 索引 |
| `.context/04-设计-数据模型.md` | `schema.sql` 的出处，但**字段清单有已知遗漏**（`para_type` / `alt` / `serverReceivedAt`），以 `schema.sql` 为准 |
| 各分支迭代文档 | `V1.B`：`docs/superpowers/specs/2026-10-11-role-B-bookmark-design.md`（设计规格，含已知限制）、`docs/superpowers/plans/2026-10-11-role-B-bookmark.md`（**2293 行实现计划**，10 个任务各自单独提交）、`docs/迭代登记-B.md`（表结构/接口变更登记，供粘贴进《迭代开发参考手册》附录 A/B） |
| 手册与任务书（`V1.C`） | `迭代开发参考手册-第1组2026.docx`（协作规范：第 7 章分支与提交、第 6.4 节两轮迭代硬依赖图、第 11 章已知坑、第 12 章验收定义）、`迭代任务书-C-跟读与语音-第1组2026.docx` —— **开工前必读** |

**文档口径原则**：`CLAUDE.md` 的"当前进度"每轮结束时更新；`docs/` 三份是**交付物**。README 声称三份"已生成 Word"，但**仓库里只跟踪了 `.md`**（`.docx` 未入库）。

## ③ 交互协议

- **用户以中文交流，回复用中文。** 界面文案一律中文。
- **方案需用户确认后执行**：重要变更前阐明实现方案、用户确认后执行；文档更新无需确认。
- **会话卫生**：**减少工具调用轮次** —— 批量读文件、一次读多个、用脚本聚合验证，不一条条试；**按需读档不整读** —— `CLAUDE.md` / `.context/` 大文档用 Grep 定位小节再 Read 行段，**不要一次性全读 `.context/`**。
- **代码风格**（与现有文件保持一致）：**不用分号、单引号、2 空格缩进、注释用中文**。
- **注释**：写入的重要代码片段需写注释说明。**特别地，`CLAUDE.md` 里那些"别拆掉"的约定，落到代码处要留注释说明为什么**（现有代码已有此风格，如 `audioPlayer.ts` 为何不用 `new Audio()`）。
- **错误必须被前端捕获并显示成中文提示，不允许白屏。** 所有接口错误一律走 `{ code, message, details, requestId }` 信封。
- **不引入"技术栈"里没写的依赖；需要新依赖先问。**
- **改完必须保证 `npm run dev`（前端 5173）与 `npm run server`（后端 3000）能同时起来且不报错。**
- **遇到歧义**：按四条裁决处理；**裁决覆盖不到时，按你认为最省事的方式做，不要停下来问**，并在结束时列出做了哪些临时决定。
- **用户报「服务起不来 / 装不上依赖 / 登录不上」时，先确认环境再看代码** —— 这类错误极易被误判成业务 Bug。按顺序看：① `better-sqlite3` 版本（见 ① 的警告）；② `server/data/` 有没有建库（没有就 `npm run db:reset && npm run seed`）；③ 代理端口（见 ① 的联网前提）。**演示账号登不进去**曾因种子脚本写了**占位密码哈希**（D-03）——新增种子数据时用 `server/src/auth/password.ts` 的 `hashPassword` 生成真实哈希，**不要写占位值**。
- **提交信息写清做了什么与验证结果**；`V1.B` 起采用 `feat(B1):` / `fix(B1):` / `docs(B):` 这类带范围前缀的中文标题 + 详细正文（现象、根因、改法、**实际跑过的验证**）。**禁止「文件更改」这类无信息量标题。**

### ⚠️ 测试现状（务必据实理解，不要被"252 项断言全绿"误导）

- **仓库里没有任何测试文件**（`grep` 全仓 `*.test.*` / `*.spec.*` / vitest / jest / node --test / assert 零命中），`package.json` 里也**没有 test 脚本**。**252 项断言是用临时脚本跑出来的，脚本已删除**（见 `V1.C` 的 C1 提交："单元验证 22 项断言全部通过（临时脚本已删除）"）。
- **测试套件的正式归属是"角色 D 的 D2"**（见 `V1.B` 计划文档的 Global Constraints），**该分支尚未落地**。因此 `V1.C` 的 C1 只做到"测试文本与期望结果已备好，可移交角色 D 写成正式单测"。
- **当前每个任务用"可复现的验证命令 + 预期输出"替代红绿循环**：先跑一遍确认当前确实失败/缺列 → 再实现 → 再跑确认通过 → 提交。
- **提交前的三项验证**（`V1.B` 计划明确要求）：① `cd server && npm run typecheck` 无错误；② `cd client && npx tsc --noEmit` 无错误；③ `cd client && npm run build` 通过。**改了行为/接口还要附上实际跑过的证据**（接口回读、浏览器实测、断言计数）。
- **已知未覆盖**（`docs/02` 第 6 节如实列出）：浏览器真机排版/CSS/滚动流畅度、真实 Kokoro 音色与延迟、真实多设备局域网同步、30 分钟长时间压测、3000 段以上超大文档、无障碍。**不要把这些说成已验证。**

### 本仓库已装好的测试技能（`V1.D`，按需加载，不要重复装）

`npx skills` 装到**项目内** `.agents/skills/`（本机智能体就从这里解析），来源与哈希锁定在根目录 `skills-lock.json`，**随仓库走，团队成员 `npx skills experimental_install` 即可还原**：

| 技能 | 来源 | 对应 `docs/02` 的哪块 |
|---|---|---|
| `vitest` | `antfu/skills` | 纯函数对拍（解析 / 切句 / 缓存键 / 窗口几何）、界面挂载（jsdom） |
| `webapp-testing` | `anthropics/skills` | **补 §6.1 最大缺口「浏览器真机测试」** —— Playwright 驱动真实浏览器，含截图与控制台日志 |
| `playwright-best-practices` | `currents-dev/playwright-best-practices-skill` | 同上，多上下文/多用户（正好对应"两端同步"用例）、认证流程、时钟mock |
| `javascript-testing-patterns` | `wshobson/agents` | 单测的组织方式：mock、fixture、断言结构 |
| `e2e-testing-patterns` | `wshobson/agents` | 端到端用例的组织方式 |

> 安装命令是 `npx -y skills add <owner/repo@skill> --copy -y`。**`--copy` 不能省** —— 默认是软链接到全局 store，那样提交进仓库的是断链的空目录。装完 `npx skills` 会额外生成 `.claude/` `.codebuddy/` `.junie/` `.qoder/` `.zcode/` 五份**逐字节相同的副本**，本仓库只保留 `.agents/skills/`（本机唯一被解析的那份），其余已删；**再装技能后记得照样删掉**，否则仓库白胖 4.7MB。

> ⚠️ **装了技能 ≠ 有测试套件。** 上面这些是**写法与工具知识**，不是可运行的测试。`docs/02` 的 252 项断言**仍然没有对应代码**（测试套件归属"角色 D 的 D2"，尚未落地）。**不要因为 `.agents/skills/` 里有 `vitest` 就以为 `npm test` 能跑 —— 各 `package.json` 里至今没有 test 脚本。**

## ④ 开发工作流

> **`main` 已不是"只有一个初始提交"了。** `CLAUDE.md` / `README.md` 里的"六轮已完成"指 R0–R6 的成果在初始提交 `f1a765e` 里；之后 `main` 又前进了 4 个提交（R7 阅读体验与个人化 + 3 个修复），当前 `origin/main` = `97030f3`。**迭代工作仍按分支走**：

| 分支 | 领先 `main` | 落后 `main` | 内容 |
|---|---|---|---|
| `main` (`97030f3`) | — | — | 初始提交 `f1a765e`（R0–R6 全部成果）+ R7 五步与 3 个修复 |
| `V1.A` | 1 | 4 | 同步与幂等：A2 幂等键落库（`T_Idempotency`，复合主键 `(user_id, idem_key)` 防跨用户重放，24h TTL 读取时判定）、A4 冲突列表刷新后能读回（`persistConflict` 下沉到 `sync/service.ts` 的三条写入路径、新增 `GET /api/sync/conflicts?docId=`、裁决后销账） |
| `V1.B` | 24 | 4 | 书签与书架（B1 拖动排序 → B3 分页排序 → B2 跨文档总览 → B4 默认名「章节标题 + 首句片段」），含 `docs/superpowers/` 的设计规格与 2293 行实现计划 |
| `V1.C` | 4 | 4 | 跟读与语音：`better-sqlite3` 回退 12.11.1、C1 补全句子切分规则 R5/R6/R8/R10、C3 改语速不再重念当前句；并加入《迭代开发参考手册》与《迭代任务书-C》 |
| `V1.D` | 0 | 0 | 从 `origin/main` 切出，承载**测试技能与测试套件**工作（`.agents/skills/` + `skills-lock.json` + 本文件）。基点即 `97030f3`，**不含 R7 之前的任何迭代分支成果**。 |

> ⚠️ **`main` 前进后，三个迭代分支都落在后面 4 个提交**（`V1.A`/`V1.B`/`V1.C` 各 `behind=4`）。它们改过的文件（`server/sql/schema.sql`、`server/src/routes/bookmarks.ts`、`client/src/pages/ReaderView.tsx` 等）R7 也动过，**合并时会真冲突，不要以为能快进合并**。开新分支前先 `git fetch` 对齐 `origin/main`。

**分支模型**：按角色/范围开分支（`V1.A` / `V1.B` / `V1.C` / `V1.D`），**不直接往 `main` 推**。合并前先读《迭代开发参考手册》第 7 章分支与提交规范、第 6.4 节两轮迭代的硬依赖图。

**每个任务的闭环**（`V1.B` 已按此执行，10 个任务各自单独提交）：

1. **先跑一遍确认当前确实失败/缺列**（拿到"改之前"的证据）
2. **实现**，只改白名单内的文件
3. **验证**：`server` typecheck + `client` tsc + `client` build 三项无错误；行为类改动附实际跑过的证据
4. **提交**：中文提交信息（`feat(B1):` 这类前缀 + 现象/根因/改法/验证正文），**一个任务一个提交**
5. **汇报验证结果并等待用户确认**，未获确认不进入下一个任务

**文件白名单与禁区**（来自角色 B 的计划，属协作约束，改前先确认自己没越界）：

- **可改**：`server/sql/schema.sql`（**仅追加**）、`server/src/routes/bookmarks.ts`、`client/src/features/sync/useBookmarks.ts`、`client/src/pages/LibraryView.tsx`、`client/src/pages/ReaderView.tsx`、`client/src/app.css`、`server/sql/seed.ts`
- **绝对不碰**（其他角色的范围）：`server/src/sync/`、`server/src/routes/sync.ts`、`client/src/features/readalong/`、`client/src/features/parse/`、`client/src/features/render/`、`server/src/db.ts`、`client/src/models/types.ts`、`client/src/features/sync/useProgress.ts`、`server/src/routes/documents.ts`
- **改共享文件（`server/src/dao/index.ts`、`client/src/api/client.ts`）需协商**，且**优先纯追加、不重排已有定义**

**几处必须记住的连带影响**：

- **改 `schema.sql` 的列/表 → 必须 `cd server && npm run db:reset && npm run seed` 重建**，并在提交信息里说明。`seed` 不会迁移已存在的库。
- **改锚点字段名或切分规则 → 既有书签与阅读进度锚点会漂移**。`V1.C` 的 C1 做法是**逐段回归比对**（旧 44 句 / 新 44 句、0 处变化）证明锚点不漂移，**改动前请照做**。
- **改 TTS 缓存键的一边 → 必须同步改另一边**（`client/src/features/readalong/ttsCacheKey.ts` 与 `server/src/tts/cacheKey.ts`）。
- **`T_Document` 外键是 `owner_id`**；**`T_SyncRecord` 无 `scope`/`key` 列且已有表定义不许改**，需要时在 JS 里解析 `conflict_json`。

**`.gitignore` 已忽略**：`node_modules/`、`dist/`、`*.local`、`*.tsbuildinfo`、`.env`、**`server/data/`**（含 SQLite、`.jwt-secret`、`images/`、`files/`、`tts/`）。**不要提交 `server/data/` 下的任何东西，尤其不要提交 `.jwt-secret`。** `.gitattributes` 固定 `* text=auto eol=lf`，`*.bat` 用 CRLF。
