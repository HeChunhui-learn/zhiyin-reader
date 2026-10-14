# 知音漫卷（zhiyin-reader） · AGENTS.md

> 本文件是本仓库**唯一的项目约定权威**：项目理解 + 项目约定 + 文档体系 + 交互协议 + 工作流。
> 2026-10-14 起，原 `CLAUDE.md` 的全部内容已并入本文件；`CLAUDE.md` 只留一张指路条，**不再承载正文**。
> `.context/` 里的材料正文按需查阅，索引见 **第六节**，**不要一次性全读**。

## ① 项目理解

### 项目简介

- **知音漫卷**，软件工程课程设计 · 第一组。跨平台阅读 Web 应用：读者导入 EPUB / TXT / Markdown，系统解析为结构化数据，在浏览器里图文混排滚动阅读，并能**逐句高亮跟读**；阅读进度与书签**跨设备同步**。
- **定位**：两周内做出可现场演示的桌面 Web 应用。**不是生产级产品，不要过度设计。**
- **演示当天必须真实跑通的三项**（其余功能都围绕它们服务）：① 逐句高亮跟读（TTS）② 跨设备同步 + 冲突处理 ③ 图文混排与图片懒加载。
- **开发轮次已全部完成**：R0–R6 六轮 + R7（阅读体验与个人化，五步）+ 四个角色迭代分支 `V1.A` / `V1.B` / `V1.C` / `V1.D`，**全部已并入集成分支 `dev`**（拓扑详见 ⑤）。
- **R7 五步**：R7-1 朗读音色可选（`server/src/tts/voiceCatalog.ts` + `GET /api/tts/voices`，契约 §9.4，没装的音色置灰）；R7-2 目录侧边抽屉 + 当前章节高亮（滚动回调里做变化检测闸门，只在跨章时 setState）；R7-3 阅读设置面板（白天/夜晚、字号、翻页方式、背景图）；R7-4 上传上限提到 100MB（后又提到 500MB，见契约 §4.8）+ 收藏（新表 `T_Favorite`）；R7-5 阅读时长统计（新表 `T_ReadingSession`，`client_id` 唯一索引 + `INSERT OR IGNORE` 让离线补报天然幂等）与个人主页头像（新表 `T_UserProfile`，头像**不能**直接 `<img src>`，接口要 Bearer 必须经接口取二进制），新页面 `/stats` 与 `/profile`。

### 技术栈（版本已定，不要更换、不要新增）

| 层 | 选型 |
|---|---|
| 前端 | React 18 + Vite + TypeScript；路由 `react-router-dom` |
| 状态 | React 自带 state / context。**不引入 Redux、Zustand、MobX** |
| 样式 | 普通 CSS，单文件 `client/src/app.css`。**不引入 Tailwind、Ant Design、MUI** |
| 后端 | Node.js 20 + TypeScript + **Fastify 4**（不是 Express） |
| 数据库 | SQLite 单文件 `server/data/zhiyin.db`，驱动 `better-sqlite3` **`^12.11.1`** |
| 解析 | EPUB 用 `epub.js` **只取解析结果**；Markdown 用 `marked`；TXT 自己解析 |
| 语音合成 | 默认本地 `Kokoro-FastAPI`（OpenAI 兼容），**经服务端代理**；不可用时降级浏览器 `SpeechSynthesis` |
| 端口 | 前端 **5173**，服务端 **3000**，Kokoro **8880** |

**关键设计约束**：正文渲染层用 ref + 直接 DOM 操作实现，**不走 React 的差异渲染**；句子切分、语音调度、同步引擎实现为**无框架依赖的纯 TS 模块**。原因见 `.context/02-设计-用例实现方案.md`。

> ⚠️ **`better-sqlite3` 必须钉在 `^12.11.1`（历史坑，别再踩）**：`V1.A` / `V1.B` 一度用过 `^13.0.3`，而 **v13.0.0–13.0.3 的预编译包数量为 0**、install 脚本直接就是 `node-gyp rebuild`，Windows 上没有 Visual Studio Build Tools **必然装不上**。`V1.C` 回退到 `^12.11.1`（提供 Node 24 / ABI 137 预编译包，下载即用）。**`dev` 上已经是 `^12.11.1`，合并时一律以此为准**。API 用法（`prepare`/`run`/`get`/`all`）两版一致，业务代码不受影响。

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

- **演示账号**：`demo@example.com` / `demo12345`（持有《人间词话》`doc_renjian`，17 段 / 44 句）。新增种子数据时用 `server/src/auth/password.ts` 的 `hashPassword` 生成**真实哈希**，不要写占位值 —— 曾因种子脚本写占位哈希导致演示账号登不进去（D-03）。
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
| `server/` | `npm test` | vitest，接口与集成测试（**串行跑**：SQLite 文件句柄与 WAL 在并发下会互相绊） |
| `server/` | `npm run db:reset` | 删掉 `server/data/` 整个目录 |
| `client/` | `npm run dev` | Vite 开发服务器（5173） |
| `client/` | `npm run build` | `tsc -b && vite build`（**提交前必须过**） |
| `client/` | `npm test` | vitest，纯函数单元测试（`environment: 'node'`，连 jsdom 都不用） |
| `client/` | `npm run preview` | 预览构建产物 |

> 🔌 **本机联网前提**：`npm install` 与 `git fetch/push` 需要外网。本机环境变量 `HTTPS_PROXY` / `HTTP_PROXY` 指向 `http://127.0.0.1:7900`，**而该端口并未监听**（直连会 `Failed to connect to github.com port 443 via 127.0.0.1`）；实际可用的是 **`7897`**（Clash Verge 混合端口）。临时走通：`git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 <git 命令>`。**改动全局配置前先问用户**；排错步骤另见 `../git代理报错修复步骤.md`。

### 目录结构

```
zhiyin-reader/
  AGENTS.md          # 本文件：唯一的项目约定权威
  CLAUDE.md          # 指路条（正文已并入本文件）
  README.md          # 面向人：六轮做了什么、怎么跑
  start.bat          # 一键启动（Windows）
  skills-lock.json   # 测试技能的来源与哈希锁
  .agents/skills/    # 测试技能（随仓库走，见 ④）
  .context/          # 材料正文（03/04/05/06/07/08 的抽取），按需查阅
  client/            # 前端，Vite 项目
    src/
      pages/         # 界面组件（类名固定，见 ②「界面清单」）
      api/           # 接口客户端（client.ts / authStore.ts / device.ts）
      models/        # TS 类型定义
      state/         # 会话状态
      features/
        parse/       # 前端解析器（txt / markdown / epub / sha256 / decode）
        readalong/   # 句子切分、跟读编排、TTS 引擎、音频缓存
          engines/   #   types / browserTts / serverTts / 工厂
        render/      # 图片缓存与懒加载（imageCache.ts / LazyImage.tsx / virtualWindow.ts / toc.ts）
        settings/    # 阅读设置（prefs 纯 TS + SettingsProvider + readerBackground）
        profile/     # 头像（UserAvatar.tsx，经接口取二进制，不能直接 <img src>）
        cache/       # IndexedDB 公共层（图片 / 音频 / 待同步队列 / 阅读背景图共用，v4）
        sync/        # 锚点、进度上报、书签读写、离线队列、bookmarkName
    e2e/             # Playwright 浏览器端到端（3 个 spec）
    test/            # Vitest 纯函数单元测试（8 个文件）
  server/            # 后端
    src/
      routes/        # health / auth / documents / resources / tts / progress / bookmarks / sync / readingTime
      tts/           # 语音合成代理（providers / cacheKey / 编排 / voiceCatalog 音色目录）
      sync/          # 同步与合并（anchor / merge 纯判定 / service 落库）
      dao/           # DataAccessLibrary —— 唯一的数据访问入口
      auth/          # jwt / password / tokens / require
      idempotency.ts # 幂等键工具（T_Idempotency，24h TTL）
      db.ts          # 连接与建库
      errors.ts      # 统一错误信封
    sql/schema.sql   # 建库脚本（表的权威定义，13 张表 / 222 行）
    sql/seed.ts      # 种子数据
    test/            # 接口与集成测试（6 个文件，全部走 app.inject()）
    data/            # SQLite、JWT 密钥、images/、files/、avatars/（已在 .gitignore）
  docs/              # 交付物（使用说明书 / 测试报告 / 演示脚本 / 标准化测试流程）
```

**13 张表**（`server/sql/schema.sql`，222 行 + 索引）：

```
R0 建库 9 张   T_User / T_Document / T_Paragraph / T_Sentence / T_ImageResource /
               T_ReadingProgress / T_SyncRecord / T_Bookmark / T_Token
R7 追加 3 张   T_Favorite（收藏）/ T_ReadingSession（阅读时长，client_id 唯一索引）/
               T_UserProfile（头像）
V1.A 追加 1 张 T_Idempotency（复合主键 (user_id, idem_key)，防跨用户重放，24h TTL）
```

`V1.B` 另给 `T_Bookmark` 追加了 `sort_order` / `chapter_title` 两列与索引 `ix_bookmark_order`。以上**全部已并入 `dev`**。

## ② 项目约定

### 当前进度

- **R0 已完成**：六个界面 + 路由 + 假数据，纯前端。
- **R1 已完成**：Fastify + SQLite 起服务，建库脚本 `server/sql/schema.sql`，种子数据，书架与阅读器读真实接口。
- **R2 已完成**：注册 / 登录 / 刷新令牌 / 退出、账号锁定；导入文档（前端解析 TXT 与 Markdown → 上传入库）；接口形状全面对齐《接口说明文档》契约。
- **R3 已完成**：EPUB 解析（epub.js 只取解析结果）；图片抽取、IndexedDB 缓存、按需加载与懒上传；正文内联渲染。
- **R4 已完成**：逐句跟读接真实 TTS —— 服务端代理本地 Kokoro（OpenAI 兼容）、服务端与客户端两级缓存、预加载、队列限流；不可用时自动降级为浏览器原生。游标由**真实的播放结束事件**驱动（不再有定时器）。
- **R5 已完成**：跨设备同步与冲突处理 —— 阅读进度按设备分行、版本号条件更新、书签增删改查与软删除墓碑、批量增量同步、冲突检测与「两份都保留」、用户裁决、离线待同步队列。
- **R6 已完成**：长文档窗口化渲染（500 段只渲染 25~38 个节点）；导入时上传原始文件；书架分类接真实数据；改昵称/改密码；一键启动脚本 `start.bat`；三份交付物文档在 `docs/`。
- **R7 已完成**（阅读体验与个人化，五步全部完成）：音色可选 / 目录抽屉 + 章节高亮 / 阅读设置面板 / 上传上限与收藏 / 阅读时长与头像。详见 ①「项目简介」。
- **迭代第一轮 · 角色 A 已完成**（分支 `V1.A`）：A2 幂等键落库（新增 `T_Idempotency`）、A4 冲突列表刷新后能读回（`persistConflict` 从 `routes/sync.ts` 下沉到 `sync/service.ts`）。第二轮的 A1（真增量游标）与 A3（幂等覆盖单项接口）**尚未开始**。
- **迭代 · 角色 B 已完成**（分支 `V1.B`）：书签拖动排序（`T_Bookmark.sort_order`，稠密整数 + 整表重排事务）、书签列表分页与排序（`GET /api/bookmarks/page`）、跨文档书签总览（`GET /api/bookmarks/overview`，「我的书签」已是真实页面）、书签默认名改为「章节标题 + 首句片段」（新增 `T_Bookmark.chapter_title`）。已知限制见 `docs/superpowers/specs/2026-10-11-role-B-bookmark-design.md`。
- **迭代 · 角色 C 已完成**（分支 `V1.C`）：`better-sqlite3` 回退 `12.11.1`、C1 补全句子切分规则 R5/R6/R8/R10、C3 改语速不再重念当前句。
- **迭代 · 角色 D 已完成**（分支 `V1.D`）：测试技能入库（`.agents/skills/` + `skills-lock.json`）+ **标准化测试套件落地（460 项断言 / 17 个测试文件 / 4447 行）**。

**八个轮次与四个迭代分支全部完成，460 项自动化断言全绿**（服务端集成 237 / 客户端单元 180 / 浏览器端到端 43，见 `docs/05-测试报告-V1.0.md`）。剩下的是**人力活，不是开发活**：在真机上核一遍（尤其窗口化滚动的观感）、把使用说明书打印出来、补 Kokoro 的实机验证。

启动方式与脚本见 ①「怎么跑」。数据库在 `server/data/zhiyin.db`，JWT 密钥在同目录 `.jwt-secret`（首次启动自动生成）。

### 已落地的实现约定（后续轮次沿用，不要另起一套）

- **认证**：自签 HS256 JWT（`server/src/auth/jwt.ts`，用 `node:crypto`，**没有引入 jsonwebtoken**）；口令用 `node:crypto` 的 scrypt 加盐哈希（`password.ts`）；刷新令牌是 256 位随机串、以 SHA-256 哈希存 `T_Token`，**每次刷新即轮换，旧的立即删除**；访问令牌 30 分钟、刷新令牌 14 天；连续失败 5 次锁 15 分钟。
- **令牌存放**：accessToken 只在内存，refreshToken 在 localStorage，刷新页面后由 `SessionProvider` 静默换新。**这是课程设计下的取舍，生产环境应把 refreshToken 放 httpOnly Cookie。**
- **接口错误**：一律 `{ code, message, details, requestId }`，**`message` 必须是中文**；响应头带 `X-Request-Id`（`server/src/app.ts` 的 `onRequest` 钩子）。前端 `ApiError` 会把 `code` 与 `details` 带出来。
- **服务端组装与监听分离**：`buildApp()` 在 `server/src/app.ts` **只组装不 listen**，`listen` 留在 `server/src/index.ts` —— 自动化测试要拿 `app.inject()` 直接打路由，一 import 就 listen 会占住 3000 端口。
- **前端请求**：`client/src/api/client.ts` 统一封装，15 秒超时，401 且携带刷新令牌时自动刷新一次并重放原请求（刷新做了**单飞**，避免并发互相顶掉）。
- **解析**：全部在 `client/src/features/parse/`，**服务端不做解析**（裁决 1）。句子也在前端切分并随段落上传。
- **内容哈希**：`client/src/features/parse/sha256.ts` 是纯 JS 实现，**不要换成 `crypto.subtle`** —— 平板通过局域网 http 访问时它不可用。
- **图片**：解析阶段抽出的 Blob 只写进 IndexedDB（`features/render/imageCache.ts`），**二进制不随导入上传**；阅读时图片首次进入视口才 `PUT` 上去（契约 §4.3 的懒上传）。服务端把图片落在 `server/data/images/`，前端一律经服务端取，不直连存储。
- **图片上限**：单文档 300 张或总量 200MB（先到者为准），按最后访问时间 LRU 淘汰（04 §4.1.3）。图片离开视口时撤销 object URL，IndexedDB 副本保留。
- **上传上限三处常量必须同值**：`server/src/app.ts` 的 `BODY_LIMIT`（500MB，**同时是内存上限**）、`server/src/routes/resources.ts` 的 `MAX_FILE_BYTES`、`client/src/features/parse/index.ts` 的预检常量（跨包无法共享，靠注释互相指认）。契约 §4.8。

### 同步与冲突的几条约定（R5 定下来的，改动时别拆掉）

1. **锚点字段名以接口契约 §6.1 为准**（`chapterIndex` / `paragraphIndex` / `sentenceIndex` / `charOffset` / `scrollOffset`），服务端 `server/src/sync/anchor.ts` 与客户端 `client/src/features/sync/anchor.ts` 各一份，**必须一致**。不要再造 `paraIndex` 版本（裁决 2 已校正）。
2. **契约 §8.1 的 `updated` / `deleted` 条目里没有 `docId`、也没有 `anchor`** —— 只有 `created` 有。服务端必须靠 `bookmarkId` 反查 docId；锚点缺省时要**沿用库里已有的**，否则一次"只改名"的同步会把书签位置冲成第 0 段。
3. **软删除必须刷新 `updated_at`**。增量拉取是按 `updated_at > since` 比的，墓碑不刷新就永远拉不到（材料审查 E15）。
4. **进度是每设备一行**，不是每用户一行。`GET .../progress` 必须返回**所有设备**的记录，否则新设备拉不到别端进度，跨设备续读根本不成立。
5. **「不回退保护」的落法**：客户端选恢复位置时，取最近更新的一条，但**若本机已记录的位置更靠前，就用本机的**（契约原文那句是循环表述，材料审查 E13）。
6. **`keep_both` 时第二条记录的 id 由服务端生成**（裁决 3）。原件保留服务端内容，本机那份另存为新记录、名字加「（本机）」后缀；`conflict.resolved` 指向**新的那条**。
7. **冲突落库在 `sync/service.ts` 的 `persistConflict`，不在路由层**（迭代 A4）。三条写入路径（批量同步、书签单项、进度单项）都要落，写在路由里必然漏 —— R5 就漏了，导致演示脚本那条"两个窗口改名"的路径产生的冲突从不入库，刷新页面后无冲突可读。
8. **进度冲突不落库**：`decideProgress` 只产出 `superseded`，服务端当场按「不回退保护」裁决完，落了只会攒出永远没人处理的幽灵冲突（迭代 A4 的结论）。
9. **裁决完要销账**（`markConflictResolved`）。不销账的话，读者裁决过的冲突下次进阅读页又会被 `GET /api/sync/conflicts` 读回来重弹。
10. **冲突提示要在 `reload()` 之后设置**。`reload()` 成功会清空 error，顺序反了的话冲突说明会一闪而过。
11. **幂等键存表，不存进程内存**（迭代 A2）。`T_Idempotency` 主键是 `(user_id, idem_key)` 复合 —— 单用 `idem_key` 的话，两个读者偶然用了同一个 UUID，A 的重放响应会被当成 B 的结果返回，那是跨用户泄漏。24 小时 TTL 由**读取时判一次**保证，不依赖清理任务是否跑过。工具在 `server/src/idempotency.ts`，A3 套到单项接口上只需换个 `scope`。
12. **`V1.B` 的 `sort_order` 合并规则是 `superseded`（取较新者），不是 `keep_both`** —— `keep_both` 会为同一条书签造重复副本。与角色 A 的约定登记在 `docs/迭代登记-B.md`。

### TTS 的几条约定（R4 定下来的，改动时别拆掉）

1. **缓存键客户端与服务端必须逐字节一致**。契约 §9.2 规定为 `sha256(engine + voice + rate + text)`，两边各一份实现：`client/src/features/readalong/ttsCacheKey.ts` 与 `server/src/tts/cacheKey.ts`。里面用 `\u0001` 作分隔符（直接拼接会有歧义，材料审查 O50）。**改一边必须改另一边**，否则客户端永远命中不了服务端缓存。
2. **播放器一律用 `document.createElement('audio')`，不要用 `new Audio()`**。后者依赖全局 `Audio` 构造函数，不是所有环境都有（jsdom 就没有）。同理见 `audioPlayer.ts` 的注释。
3. **引擎抽象成"朗读一句，念完 resolve"**（`engines/types.ts`）。服务端引擎靠 `<audio>` 的 ended 事件，浏览器引擎靠 `SpeechSynthesisUtterance` 的 onend —— 两条完全不同的路收敛成同一个接口，上层的游标推进只写一份。
4. **游标由真实播放事件驱动，不要再引入定时器**。R0–R3 的 `setInterval` 已经删掉了，那是为了让界面先跑起来。用定时器的话"高亮位置与音频严格对应"这条验收要求就不成立。
5. **改语速不进播放循环的依赖数组**（`V1.C` 的 C3）—— 走 `rateRef`，当前句念完、新语速从下一句生效。换引擎/音色仍会重启循环，这是有意的。
6. **降级链是自动的**：`GET /api/tts/engines` 里 `available=false` 的引擎不进前端列表（契约 §9.1）；只剩浏览器原生时界面上要显示"已降级为浏览器发声"，并说明它只支持句子级高亮。

服务端 TTS 环境变量（`server/src/tts/providers.ts`）：

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

### 遗留占位（后续轮次替换）

- ~~**幂等键存在进程内存里**，重启即失效~~ —— **迭代 A2 已修**：落 `T_Idempotency` 表，24 小时 TTL，过期机会式清理
- **`Idempotency-Key` 仍只覆盖 `/api/sync`**，单项接口没做（迭代 A3，未开始）
- **`POST /api/sync` 每次请求都整体比较所有书签**，书签很多时会慢（没做真正的增量游标，迭代 A1，未开始）
- ~~冲突列表只在本次会话内存里，刷新页面后界面读不回来~~ —— **迭代 A4 已修**（`GET /api/sync/conflicts` + 裁决销账）。但冲突**只在 `ReaderView` 读回，`LibraryView` 还没接入**
- **冲突裁决的请求体扩展了 `relatedId` 字段** —— 契约 §8.4 的请求体里没有它，但 `keep_both` 之后要"二选一"必须知道另一条是谁（材料审查 A25 的模糊点）。客户端从 `conflict.resolved.bookmarkId` 取，契约文档已补记
- 暂停是"停掉当前句"，不是"从句子中间继续" —— 恢复时该句从头念。真暂停要在引擎里保留位置，收益不大，先不做
- ~~语速改变会让当前句从头重念~~ —— **`V1.C` 的 C3 已修**（走 `rateRef`，下一句生效）
- ~~`PATCH /api/users/me`（改昵称/改密码）未实现~~ —— **R6 已实现**（`server/src/routes/auth.ts`，契约 §3.5）
- ~~导入时**没有上传原始文件**，`T_Document.resource_url` 恒为 null~~ —— **R6 已实现**（`LibraryView.tsx` 导入成功后调 `api.putOriginalFile`）
- ~~虚拟滚动还没做——正文一次性渲染全部段落，长文档会卡~~ —— **R6 已做窗口化渲染**（`features/render/virtualWindow.ts` 的 `buildGeometry`，500 段只渲染 25~38 个节点）
- 图片懒上传只在**阅读时**触发；导入后从没打开过的书，它的图在服务端一张都没有（契约 §4.3 的预期行为）
- `epubjs` 300KB+ 打进了主包，没做代码分割

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
| `BookmarkPanel` | 书签面板（`V1.B` 新建，嵌入 `ReaderView`） | 非独立路由 |

路由表见 `client/src/App.tsx`（`/` 与未匹配路径都重定向到 `/guide`）。**作废的名字**：「首页 HomeUI」「导入 ImportUI」「阅读 ReaderUI」「播放 PlaybackUI」一律不用。**导入文档不单独做界面**，在书架界面弹出文件选择框即可。

### 四条已拍板的裁决

> 这几条与 `.context/` 里的文档**不一致**，**以本节为准**。文档里那几处是已知的自相矛盾，不要再纠结。

#### 裁决 1：解析放在前端

服务端**只负责存储与分发解析结果，不做文档解析**。

导入流程：前端读文件 → 前端解析成结构化数据 → 一次性 `POST` 给服务端入库。

理由：两周工期下最省事；服务端不必引入 EPUB / Markdown 解析依赖。

#### 裁决 2：锚点只有一种定义

全项目只有一种锚点表示。**字段名以接口契约 §6.1 为准**（R5 时校正过一次：R0 写的版本用的是 `paraIndex` 且漏了 `sentenceIndex`，与契约不一致；接口形状按契约走，避免多一层翻译）：

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

- 数据库 `T_ReadingProgress` 用 `chapter_index` / `paragraph_index` / `char_offset` / `scroll_offset` **四列展开存储**，`sentenceIndex` 对应 `last_sentence_index` 列（本机瞬态，不参与跨端同步）
- 数据库 `T_Bookmark.anchor_json` 存 `Anchor` 的完整 JSON 串
- 04 §4.2 里出现的 `updateAnchor(chapter, paragraph, offset)` 按此结构理解
- **不要**再造一份 `paraIndex` 版本 —— 锚点字段名全项目统一用 `paragraphIndex`

#### 裁决 3：冲突保留两份时，由服务端生成第二条记录的 id

`POST /api/sync/resolve` 选择 `keep_both` 时，**服务端**为第二条生成新的 `bookmark_id`（格式 `bm_` + uuid v4 去横线），并在响应体中回传完整的两条记录；**客户端以响应为准覆盖本地，不得自行生成**。

理由：方案文档要求主键由客户端生成，但 `keep_both` 必然产生同 id 的两条记录，只能由服务端分配。

#### 裁决 4：以数据库表为准

实体类字段由表反推。**表的权威定义在 `server/sql/schema.sql`**（13 张表齐全），`.context/04-设计-数据模型.md` 是它的出处。其中：

- **不建音频表**。音频只做内存缓存 + IndexedDB 缓存，不落服务端库。`AudioClip` 实体只在前端存在：`{ sentenceId, voice, rate, blobKey, durationMs }`
- **不建 Token 实体类**。`T_Token` 表只由认证服务直接读写，不经 `DataAccessLibrary`
- `T_Document` 的外键统一叫 `owner_id`，**不要用 `user_id`**
- `T_SyncRecord` 无 `scope` / `key` 列且已有表定义不许改，需要时在 JS 里解析 `conflict_json`
- `T_Paragraph` 有一列 `para_type`（`h1` / `h2` / `p` / `img`），这是**建库时补的**——04 §4.3.1 的字段清单里没有它，但没有这列就分不出标题段和正文段。**不要删它，也不要"改回文档那样"**。相应的，建议后面把 04 §4.3.1(4) 的字段清单也补上这一列。
- `T_ImageResource` 有一列 `alt`，同样是补的。依据是**接口契约 §4.1 的 imageRefs 示例里本来就有 `alt` 字段**，而 04 §4.3.1(6) 的字段清单漏了它，不补的话阅读器只能把包内路径当说明文字显示。建议 04 也补上。

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
- **不要写单元测试框架**（除非明确要求某一轮）—— 注：`V1.D` 已落地标准化测试套件，此后这条只约束"不要另起一套测试框架"

## ③ 文档体系

| 文档 | 用途 |
|---|---|
| `AGENTS.md` | **本文件：唯一的项目约定权威**。项目理解 / 项目约定 / 文档体系 / 交互协议 / 工作流 |
| `CLAUDE.md` | 指路条（正文已并入本文件） |
| `README.md` | 面向人：六轮各做了什么、怎么跑、演示账号、占位清单、排期（300 行）。**R1 之前的记录带"当时状态"性质，形状已在 R2 按契约调整过** |
| `.context/` | **材料正文**（11 份）。`07-接口契约.md`（789 行）是**接口权威**，写任何接口前必读；`10-界面版面稿.md`（166 行）是**四张界面外观位图丢失后仅存的版面结构**，做界面时必读；何时读哪份见 **⑥** |
| `docs/01-使用说明书.md` | 面向使用者：启动、界面、完整操作流程、常见问题（284 行，R7 已补新功能） |
| `docs/02-测试用例与测试报告.md` | 121 条用例 / **252 项断言**的台账，**含开发中发现的 15 个缺陷及修复**（308 行）——**缺陷表是全篇最有价值的部分**，排查类似问题先来这里翻。⚠️ 这是 **R6 那一轮的台账**，R7 新增功能与 `V1.D` 的测试套件都不在其中 |
| `docs/03-演示脚本.md` | 8 分钟现场演示的逐段话术与应急处理（144 行） |
| `docs/04-标准化测试流程.md` | **测试分层与六步门禁**（双端 typecheck / 前端构建 / 三层测试）。改测试相关的东西先读它 |
| `docs/05-测试报告-V1.0.md` | **V1.0 集成测试报告**：460 项断言全绿（服务端 237 / 客户端单元 180 / 端到端 43，17 个测试文件），含集成过程中发现的 5 处缺陷 |
| `server/sql/schema.sql` | **表的权威定义**（裁决 4），**13 张表**（222 行）+ 索引 |
| `.context/04-设计-数据模型.md` | `schema.sql` 的出处，但**字段清单有已知遗漏**（`para_type` / `alt` / `serverReceivedAt`），以 `schema.sql` 为准 |
| `docs/A-同步与冲突-开发内容介绍.md` | 角色 A 的开发内容介绍与代码地图 |
| `docs/迭代登记-B.md` | 角色 B 的表结构/接口变更登记，供粘贴进《迭代开发参考手册》附录 A/B |
| `docs/superpowers/` | `V1.B` 的设计规格（含已知限制）与 **2293 行实现计划**（10 个任务各自单独提交） |
| 手册与任务书（`.docx`，仓库根） | `迭代开发参考手册-第1组2026.docx`（协作规范：第 7 章分支与提交、第 6.4 节两轮迭代硬依赖图、第 11 章已知坑、第 12 章验收定义）、`迭代任务书-C-跟读与语音-第1组2026.docx` —— **开工前必读** |

**文档口径原则**：本文件 ②「当前进度」在每个轮次结束时更新；`docs/` 是**交付物**。README 声称三份"已生成 Word"，但**仓库里只跟踪了 `.md`**（`.docx` 未入库）。

## ④ 交互协议

- **用户以中文交流，回复用中文。** 界面文案一律中文。
- **方案需用户确认后执行**：重要变更前阐明实现方案、用户确认后执行；文档更新无需确认。
- **会话卫生**：**减少工具调用轮次** —— 批量读文件、一次读多个、用脚本聚合验证，不一条条试；**按需读档不整读** —— 本文件 / `.context/` 大文档用 Grep 定位小节再 Read 行段，**不要一次性全读 `.context/`**。
- **代码风格**（与现有文件保持一致）：**不用分号、单引号、2 空格缩进、注释用中文**。
- **注释**：写入的重要代码片段需写注释说明。**特别地，本文件 ② 里那些"别拆掉"的约定，落到代码处要留注释说明为什么**（现有代码已有此风格，如 `audioPlayer.ts` 为何不用 `new Audio()`）。
- **错误必须被前端捕获并显示成中文提示，不允许白屏。** 所有接口错误一律走 `{ code, message, details, requestId }` 信封。
- **不引入"技术栈"里没写的依赖；需要新依赖先问。**
- **改完必须保证 `npm run dev`（前端 5173）与 `npm run server`（后端 3000）能同时起来且不报错。**
- **遇到歧义**：按四条裁决处理；**裁决覆盖不到时，按你认为最省事的方式做，不要停下来问**，并在结束时列出做了哪些临时决定。
- **用户报「服务起不来 / 装不上依赖 / 登录不上」时，先确认环境再看代码** —— 这类错误极易被误判成业务 Bug。按顺序看：① `better-sqlite3` 版本（见 ① 的警告）；② `server/data/` 有没有建库（没有就 `npm run db:reset && npm run seed`）；③ 代理端口（见 ① 的联网前提）。
- **提交信息写清做了什么与验证结果**；`V1.B` 起采用 `feat(B1):` / `fix(B1):` / `docs(B):` 这类带范围前缀的中文标题 + 详细正文（现象、根因、改法、**实际跑过的验证**）。**禁止「文件更改」这类无信息量标题。**

### 测试现状

- **测试套件已经落地**（`V1.D` 的 D2）：**17 个测试文件 / 460 项断言 / 4447 行**，三层分工如下。

| 层 | 位置 | 规模 | 环境 |
|---|---|---|---|
| 服务端接口与集成 | `server/test/` | 6 个文件，237 项 | Node + `app.inject()`；**串行跑**（`fileParallelism: false`，SQLite 的 WAL 在并发下会互相绊） |
| 客户端单元 | `client/test/` | 8 个文件，180 项 | **`environment: 'node'`，连 jsdom 都不用** —— 只测纯函数 |
| 浏览器端到端 | `client/e2e/` | 3 个 spec，43 项 | Playwright 驱动**真实 Chrome** |

- **三层边界是有意划的**：需要浏览器 API 的（IndexedDB、IntersectionObserver、真实排版与滚动流畅度）一律推给 Playwright，**不在 Node 里打替身** —— 替身跑通了也不代表真机跑得通，反而会给出虚假的绿。理由写在 `client/vitest.config.ts`。
- **端到端用本机 Chrome（`channel: 'chrome'`），不下 Playwright 自带的 chromium** —— npm 走 `127.0.0.1:7897` 代理，`npx playwright install chromium` 会在 90% 处报 `ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC`。换台机器若没装 Chrome，改成 `channel: 'msedge'`。
- **端到端用独立测试库**：`server/e2e-server.mjs` 每次启动前重建 `server/data-e2e/` 并灌种子，**绝不碰演示库** `server/data/zhiyin.db`。注意图片／原始文件／头像仍落在 `server/data/` 下（路径由 `db.ts` 的 `SERVER_ROOT` 决定，不走 `ZHIYIN_DB`）—— 这是个已知的隔离缺口，端到端用例实际不碰它们。
- **提交前的三项验证**（`V1.B` 计划明确要求）：① `cd server && npm run typecheck` 无错误；② `cd client && npx tsc --noEmit` 无错误；③ `cd client && npm run build` 通过。**改了行为/接口还要附上实际跑过的证据**。
- **已知未覆盖**（`docs/02` 第 6 节如实列出）：真实 Kokoro 音色与延迟、真实多设备局域网同步、30 分钟长时间压测、3000 段以上超大文档、无障碍。**不要把这些说成已验证。**

### 本仓库已装好的测试技能（按需加载，不要重复装）

`npx skills` 装到**项目内** `.agents/skills/`（本机智能体就从这里解析），来源与哈希锁定在根目录 `skills-lock.json`，**随仓库走，团队成员 `npx skills experimental_install` 即可还原**：

| 技能 | 来源 | 对应哪块 |
|---|---|---|
| `vitest` | `antfu/skills` | 纯函数对拍（解析 / 切句 / 缓存键 / 窗口几何）、界面挂载（jsdom） |
| `webapp-testing` | `anthropics/skills` | **浏览器真机测试** —— Playwright 驱动真实浏览器，含截图与控制台日志 |
| `playwright-best-practices` | `currents-dev/playwright-best-practices-skill` | 同上，多上下文/多用户（正好对应"两端同步"用例）、认证流程、时钟 mock |
| `javascript-testing-patterns` | `wshobson/agents` | 单测的组织方式：mock、fixture、断言结构 |
| `e2e-testing-patterns` | `wshobson/agents` | 端到端用例的组织方式 |

> 安装命令是 `npx -y skills add <owner/repo@skill> --copy -y`。**`--copy` 不能省** —— 默认是软链接到全局 store，那样提交进仓库的是断链的空目录。装完 `npx skills` 会额外生成 `.claude/` `.codebuddy/` `.junie/` `.qoder/` `.zcode/` 五份**逐字节相同的副本**，本仓库只保留 `.agents/skills/`（本机唯一被解析的那份），其余已删；**再装技能后记得照样删掉**，否则仓库白胖 4.7MB。

## ⑤ 开发工作流

> **集成分支是 `dev`。** R0–R6 + R7 + 四个迭代分支 `V1.A` / `V1.B` / `V1.C` / `V1.D` **已全部并入 `dev`**（领先 `main` 49 个提交）。`main` 上只有初始提交 `f1a765e`（R0–R6）与 R7 相关提交。

| 分支 | 相对 `main` | 内容 |
|---|---|---|
| `dev` | **领先 49** | 集成分支：R7 + `V1.A` + `V1.B` + `V1.C` + `V1.D`（含 460 项测试套件）全部并入 |
| `main` | — | 初始提交 `f1a765e`（R0–R6）+ R7 |
| `V1.A` | 已并入 `dev` | 同步与幂等：A2 幂等键落库、A4 冲突列表可读回 |
| `V1.B` | 已并入 `dev` | 书签与书架：拖动排序 / 分页排序 / 跨文档总览 / 默认名 |
| `V1.C` | 已并入 `dev` | 跟读与语音：`better-sqlite3` 回退 12.11.1、切分规则补全、改语速不重念 |
| `V1.D` | 已并入 `dev` | 测试技能（`.agents/skills/` + `skills-lock.json`）与 460 项测试套件 |
| `dev-mobile` | 独立 | 多端适配（响应式地基 + 《多端适配方案》/《核心技术说明》两份 HTML），**尚未并入 `dev`** |
| `V1.0-merge` | 独立 | R7 时期的集成分支快照 |

**分支模型**：按角色/范围开分支（`V1.A` / `V1.B` / `V1.C` / `V1.D`），**不直接往 `main` 推**。合并前先读《迭代开发参考手册》第 7 章分支与提交规范、第 6.4 节两轮迭代的硬依赖图。开新分支前先 `git fetch` 对齐。

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
- **改上传上限 → 三处常量同改**（见 ②「已落地的实现约定」）。
- **`T_Document` 外键是 `owner_id`**；**`T_SyncRecord` 无 `scope`/`key` 列且已有表定义不许改**，需要时在 JS 里解析 `conflict_json`。

**`.gitignore` 已忽略**：`node_modules/`、`dist/`、`*.local`、`*.tsbuildinfo`、`.env`、**`server/data/`**（含 SQLite、`.jwt-secret`、`images/`、`files/`、`avatars/`）、`coverage/`、`test-results/`、`e2e-report/`、`playwright-report/`、`server/data-e2e/`。**不要提交 `server/data/` 下的任何东西，尤其不要提交 `.jwt-secret`。** `.gitattributes` 固定 `* text=auto eol=lf`，`*.bat` 用 CRLF。

## ⑥ `.context/` 索引（按需查阅，不要一次性全读）

| 文件 | 什么时候读 |
|---|---|
| `01-需求-用例与性能要求.md` | 需要知道某个功能到底要做什么、性能指标多少 |
| `02-设计-用例实现方案.md` | 实现某个用例时——六个用例的设计流程与消息参数；**句子切分规则 R1–R10 在这里** |
| `03-设计-类模型.md` | **建 TS 类型、写界面骨架时**——每个类的属性、操作、依赖关系的完整文字版 |
| `04-设计-数据模型.md` | **建库、写 DAO 时**——逐字段 + `DataAccessLibrary` 全部方法签名（⚠️ 字段清单有已知遗漏，以 `schema.sql` 为准） |
| `05-设计-界面与部署.md` | 做界面、写部署脚本时 |
| `06-设计-体系结构与约束.md` | 想确认分层与依赖方向时 |
| `07-接口契约.md` | **写任何接口时**——API 契约（路径、请求/响应体、错误码、冲突响应格式）。**接口权威** |
| `08-书签补充.md` | 做书签功能时 |
| `08b-句子切分补充.md` | 做句子切分时 |
| `09-技术选型.md` | 确认版本、部署形态、语音合成方案 |
| `10-界面版面稿.md` | **做界面时必读**——四张界面外观图是位图已丢失，版面结构只在这里 |

**注意**：`.context/` 里的文档之间**存在已知冲突**（同一件事多种规定），这些冲突已由 ②「四条已拍板的裁决」解决了大部分，剩下的按 ④ 最后一条处理。
