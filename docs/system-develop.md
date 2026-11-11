# 知音漫卷 · 系统开发

> 版本：1.8.0　｜　最后更新：2026-11-10
>
> 本文回答「怎么开发、怎么避坑、现在做到哪」。
> 系统架构、数据模型、接口语义见 [system-design.md](./system-design.md)；
> 全局事项与技术栈见 [../AGENTS.md](../AGENTS.md)。

---

## 1. 当前版本与状态

| 项 | 现状 |
|---|---|
| 版本 | 客户端与服务端 `1.8.0`；Android 壳的 `versionCode / versionName` 由 CI 从 git tag 算出（本机默认 10 / 1.9.0） |
| 功能 | 导入解析、图文混排、逐句跟读、跨设备同步与冲突、收藏、阅读时长、头像、书签排序与总览、网页 / 原生更新提示、一键同步、GitHub Releases 分发与自更新 |
| 数据库 | 13 张表，权威定义 `server/sql/schema.sql` |
| 测试 | 服务端 277 项 + 客户端 228 项 + 端到端 47 项 = **552 项** |
| 技术栈 | React 18 + Vite + TypeScript；Fastify 4 + better-sqlite3；SQLite |
| 运行环境 | Node.js 20+；桌面浏览器窗口 ≥ 1280px |
| 演示服务器 | **已停用**（原 `123.56.172.230`）；本地或自建服务器运行，见 §2.1 |

1.9.0 新增内容：

- APK 改由 **GitHub Releases** 分发，推 `v*` tag 自动构建签名包（`.github/workflows/android.yml`）；
- 服务端 `GET /api/app/version` 改为代查 GitHub Releases API（5 分钟缓存，失败回落环境变量）；
- 登录页新增「服务器地址」入口，换服务器不必重新打包（`client/src/features/app/ServerSettings.tsx`）；
- 连不上服务器时，原生壳的提示改为引导用户去改地址，而不是提示起本地服务端。

1.3.0 内容（历史）：

- 服务端 `TTS_PROVIDER=edge` 时可切到微软 Edge 在线语音；
- 原生壳强制更新闸门（`UpdateGate` + `GET /api/app/version` + 426）；
- 手机 / 平板网页版构建号更新提示（`WebUpdateBanner`）；
- 书架「一键同步」补报离线队列并读回未决冲突；
- Android 壳（Capacitor）与相关构建产物。

---

## 2. 环境、启动与排错

### 2.1 启动

```bash
# 终端 1 —— 服务端（3000）
cd server
npm install          # 首次
npm run seed         # 首次：建库 + 演示数据
npm run server       # tsx watch

# 终端 2 —— 前端（5173）
cd client
npm install          # 首次
npm run dev
```

也可双击根目录 `start.bat`。演示账号：`demo@example.com / demo12345`。

服务端脚本：

| 命令 | 作用 |
|---|---|
| `npm run server` | `tsx watch src/index.ts` |
| `npm run start` | 不带 watch |
| `npm run seed` | 建库 + 灌演示数据 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest，接口与集成测试，串行跑 |
| `npm run db:reset` | 删除 `server/data/` |

前端脚本：

| 命令 | 作用 |
|---|---|
| `npm run dev` | Vite 开发服务器（5173） |
| `npm run build` | `tsc -b && vite build`，提交前必须过 |
| `npm test` | Vitest 纯函数单元测试（`environment: 'node'`） |
| `npm run preview` | 预览构建产物 |

### 2.2 数据库

- 文件：`server/data/zhiyin.db`；JWT 密钥：同目录 `.jwt-secret`（首次启动自动生成）。
- **改了 `server/sql/schema.sql` 的列或表，必须重建**：

```bash
cd server
npm run db:reset && npm run seed
```

`seed` 只负责灌数据，不会迁移已存在的库。重建会删除已导入文档、图片、原始文件与头像。

### 2.3 环境变量

TTS：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TTS_PROVIDER` | 空（本地 Kokoro） | 设为 `edge` 时切到 Edge 在线语音 |
| `TTS_BASE_URL` | `http://127.0.0.1:8880/v1` | 任意 OpenAI 兼容 `/v1/audio/speech` |
| `TTS_API_KEY` | 空 | 本地服务一般不需要 |
| `TTS_MODEL` | `kokoro` | |
| `TTS_TIMEOUT_MS` | `20000` | 超时返回 504 |

版本与更新：

版本号的**正常来源是 GitHub Releases**，日常发版不用碰环境变量：
推一个 `v1.9.0` tag → CI 构建签名 APK 并发布 Release →
服务端读 Releases API 拿到版本号与下载地址（缓存 5 分钟）。
下面这些变量只在 GitHub 查不到时兜底，或用来手动干预。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `APP_UPDATE_SOURCE` | 空（走 GitHub） | 设为 `env` 时完全不联网，只用下面的变量 |
| `APP_RELEASE_REPO` | `HeChunhui-learn/zhiyin-reader` | fork 后填自己的仓库 |
| `GITHUB_TOKEN` | 空 | 仅私有仓库或想提配额时需要；公开仓库不必配 |
| `APP_VERSION_CODE` | `9` | 兜底最新 versionCode |
| `APP_VERSION_NAME` | `1.8.0` | 兜底展示用版本名 |
| `APP_APK_URL` | `/download/zhiyin-1.8.0.apk` | 兜底下载地址，可用绝对地址 |
| `MIN_APP_VERSION_CODE` | 跟随最新版 | 低于此值返回 426；**显式设 0 可关掉门槛** |
| `APP_FORCE_UPDATE` | `true` | 设为 `false` 关闭强制更新 |
| `APP_UPDATE_NOTES` | 内置文案 | 更新说明 |

> 发版流程见 [06-手机端安装与连接指南.md](./06-手机端安装与连接指南.md) 的「发布新版本」一节。
> `VITE_APP_VERSION_CODE` / `VITE_APP_VERSION_NAME` 由 CI 从 tag 算出并注入，
> **不要手工赋值** —— 它必须和 APK 里编译进去的 versionCode 完全一致，
> 差了就会全站 426（见 `client/src/api/appVersion.ts` 的注释）。

### 2.4 排错

按顺序排查，不要先怀疑业务代码：

1. **`better-sqlite3` 版本**：必须 `^12.11.1`。v13.0.0–13.0.3 没有预编译包，
   Windows 上没有 VS Build Tools 必然装不上。
2. **数据库是否建好**：`server/data/` 不存在时先 `npm run db:reset && npm run seed`。
3. **代理端口**：环境变量里的 `7900` 没有监听；本机实际可用 `7897`。
   git 用临时参数，不要改全局配置：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'; $env:HTTP_PROXY='http://127.0.0.1:7897'
git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 fetch
```

4. **端口占用**：前端 5173、服务端 3000、Kokoro 8880。
5. **端到端探活超时**：Vite 必须显式 `--host 127.0.0.1`，见 5.4。
6. **服务端测试偶发挂住**：多为 stale vitest worker，结束残留 node 进程后重跑；
   不要把 vitest 输出接到 `Select-Object` 之类的管道里。
7. **413**：先核对 500MB 三处常量是否同值（见 4.8）。
8. **图片不可用**：图片是懒上传的；从未在导入设备上打开过的图，服务端没有副本，
   回到导入设备滚到该图位置即可补传。

---

## 3. 代码地图

### 3.1 前端

```
client/
├─ src/
│  ├─ pages/                 GuidingUI / LoginView / LibraryView / ReaderView /
│  │                         StatsView / ProfileView / ReaderSettingsPanel /
│  │                         PlaybackBar / ConflictDialog / BookmarkPanel
│  ├─ api/
│  │  ├─ client.ts           fetch 封装、类型、api 方法
│  │  ├─ authStore.ts        accessToken 内存、refreshToken 持久化
│  │  ├─ device.ts           deviceId
│  │  ├─ appVersion.ts       原生壳版本号与更新检查
│  │  └─ platform.ts         是否 Capacitor 原生壳
│  ├─ state/session.tsx      会话上下文
│  ├─ features/
│  │  ├─ parse/              index / txt / markdown / epub / decode / sha256 / types
│  │  ├─ readalong/          useReadAlong / splitSentences / audioPlayer /
│  │  │                      audioCache / ttsCacheKey / readAlongPrefs / engines/
│  │  ├─ render/             virtualWindow / LazyImage / imageCache / toc
│  │  ├─ sync/               anchor / useProgress / useBookmarks / pendingQueue /
│  │  │                      useReadingTime / bookmarkName / oneClickSync
│  │  ├─ settings/           prefs / SettingsProvider / readerBackground / ThemeToggle
│  │  ├─ profile/            UserAvatar
│  │  ├─ cache/              IndexedDB 公共层
│  │  ├─ app/                UpdateGate / WebUpdateBanner / webBuild
│  │  ├─ motion/             水墨动效
│  │  └─ brand/              Logo 与图形
│  ├─ models/types.ts        文档与段落类型
│  ├─ app.css                全站样式（单文件）
│  └─ App.tsx                路由表
├─ test/                    Vitest 纯函数测试（12 个文件）
├─ e2e/                     Playwright（3 个 spec + 2 个 fixture）
├─ android/                 Capacitor Android 壳
├─ capacitor.config.ts
├─ vite.config.ts           构建号注入 + /api 代理
├─ vitest.config.ts         environment: node
└─ playwright.config.ts     真实 Chrome，自动拉起两个服务
```

### 3.2 服务端

```
server/
├─ src/
│  ├─ index.ts              listen
│  ├─ app.ts                buildApp()：插件、钩子、路由注册
│  ├─ db.ts                 SQLite 连接、建库、数据目录
│  ├─ errors.ts             错误码与中文消息
│  ├─ idempotency.ts        幂等键读写
│  ├─ auth/                 jwt / password / tokens / require
│  ├─ routes/               auth / documents / resources / progress /
│  │                        bookmarks / sync / tts / readingTime / appVersion / health
│  ├─ sync/                 anchor / merge / service
│  ├─ tts/                  providers / edgeProvider / cacheKey / voiceCatalog / index
│  └─ dao/index.ts          DataAccessLibrary
├─ sql/schema.sql           13 张表的权威定义
├─ sql/seed.ts              演示数据（口令必须用 hashPassword 生成真实哈希）
├─ test/                    7 个测试文件 + helpers + setup
├─ e2e-server.mjs           端到端专用启动器（独立 data-e2e）
└─ data/                    SQLite、密钥、files / images / avatars / tts
```

### 3.3 运行时数据

| 内容 | 位置 |
|---|---|
| 账号、文档、段落、句子、书签、进度、收藏、时长 | `server/data/zhiyin.db` |
| 原始文件 | `server/data/files/` |
| 图片副本 | `server/data/images/` |
| 头像 | `server/data/avatars/` |
| 合成音频 | `server/data/tts/` |
| 浏览器缓存 | IndexedDB / localStorage |

备份就是复制整个 `server/data/` 目录。

---

## 4. 实现约定（改动时不要拆掉）

### 4.1 认证与令牌

- 自签 HS256 JWT，用 `node:crypto`，**没有引入 jsonwebtoken**。
- 口令用 `node:crypto` 的 scrypt 加盐哈希。
- 刷新令牌是 256 位随机串，以 SHA-256 哈希存 `T_Token`；**每次刷新即轮换，旧的立即删除**。
- accessToken 只在内存，refreshToken 在 localStorage；刷新页面由 `SessionProvider` 静默换新。
  这是课程设计取舍，生产环境应放 httpOnly Cookie。
- 连续失败 5 次锁 15 分钟；登录失败不区分「账号不存在」和「密码错误」。
- 种子数据的口令必须用 `server/src/auth/password.ts` 的 `hashPassword` 生成真实哈希。

### 4.2 错误与请求

- 所有非 2xx 一律 `{ code, message, details, requestId }`，`message` 必须是中文。
- 响应头带 `X-Request-Id`。
- 前端 `client/src/api/client.ts` 统一封装：15 秒超时、401 且带刷新令牌时自动刷新一次并重放；
  刷新做了**单飞**，避免并发互相顶掉。
- 导入相关请求（`POST /api/documents`、`PUT .../file`）超时放宽到 300 秒。
- 所有接口错误必须被捕获并显示中文提示，不允许白屏。

### 4.3 解析与内容哈希

- 解析全部在 `client/src/features/parse/`，服务端不做解析（裁决 1）。
- 句子在前端切分，随段落上传；切分规则见 system-design 6.3。
- `client/src/features/parse/sha256.ts` 是纯 JS SHA-256，**不要换成 `crypto.subtle`**：
  平板通过局域网 http 访问时它不可用。
- 导入请求里的段落字段是 `paraIndex`；**锚点**字段是 `paragraphIndex`，两者不要混。

### 4.4 图片

- 导入时图片 Blob 只写 IndexedDB（`features/render/imageCache.ts`），二进制不随导入上传。
- 阅读时首次进入视口才 `PUT` 上去；服务端落 `server/data/images/`，前端一律经服务端取。
- 离开视口撤销由 `LazyImage` 持有的 object URL；IndexedDB 副本保留。
- 上限：单文档 300 张或总量 200MB（先到者为准），按最后访问时间 LRU 淘汰。
- 服务端回源只允许 http / https，拒绝私有网段与环回地址（防 SSRF）；单张上限 10MB。
- 头像同理不能直接 `<img src>`：接口要 Bearer，必须经接口取二进制再转 object URL。

### 4.5 TTS

1. **缓存键客户端与服务端必须逐字节一致**：
   `sha256(engine + voice + rate + text)`，分隔符 `\u0001`。
   两份实现分别在 `client/src/features/readalong/ttsCacheKey.ts` 与
   `server/src/tts/cacheKey.ts`。**改一边必须改另一边**，否则客户端永远命中不了服务端缓存。
2. 播放器一律用 `document.createElement('audio')`，不要用 `new Audio()`：
   后者依赖全局 `Audio` 构造函数，不是所有环境都有。
3. 引擎抽象成「朗读一句，念完 resolve」：服务端引擎靠 `<audio>` 的 `ended`，
   浏览器引擎靠 `SpeechSynthesisUtterance.onend`，上层游标推进只写一份。
4. **游标由真实播放事件驱动，不要引入定时器**。用定时器会导致高亮与音频不对应。
5. 改语速不进播放循环的依赖数组，走 `rateRef`，下一句生效；换引擎 / 音色仍会重启循环。
6. 降级链自动：`GET /api/tts/engines` 里 `available=false` 的引擎不进前端列表；
   只剩浏览器原生时显示「已降级为设备发声」。
7. 服务端合成同时最多 2 个、最多排 8 个；超了 429。上游失败 502、超时 504。
8. `TTS_PROVIDER=edge` 时服务端用 Edge 适配器；客户端只认 `/api/tts/*`，不需要换包。

### 4.6 同步与冲突

1. 锚点字段以 system-design 4 节为准；服务端 `sync/anchor.ts` 与客户端 `features/sync/anchor.ts`
   各一份，**必须一致**。不要再造 `paraIndex` 版本。
2. 契约中 `updated` / `deleted` 条目没有 `docId`、也没有 `anchor`；服务端靠 `bookmarkId`
   反查 docId，锚点缺省时**沿用库里已有的**。
3. **软删除必须刷新 `updated_at`**，否则增量拉取永远拉不到墓碑。
4. 进度是**每设备一行**，`GET .../progress` 必须返回所有设备的记录。
5. 「不回退保护」：取最近更新的一条，但若本机已记录的位置更靠前，就用本机的。
6. `keep_both` 时第二条记录的 id 由服务端生成；原件保留服务端内容，本机那份另存为新记录，
   名字加「（本机）」后缀；`conflict.resolved` 指向新的那条。
7. 冲突落库在 `sync/service.ts` 的 `persistConflict`，不在路由层。批量同步、书签单项、
   进度单项三条写入路径都要落。
8. 进度冲突不落库：`decideProgress` 只产出 `superseded`，服务端当场裁决完。
9. 裁决完要销账（`markConflictResolved`），否则下次进阅读页会重弹。
10. 冲突提示要在 `reload()` 之后设置，`reload()` 成功会清空 error。
11. 幂等键存 `T_Idempotency`，主键 `(user_id, idem_key)`；24 小时 TTL 在读取时判定。
12. `sort_order` 的合并规则是 `superseded`，不是 `keep_both`（后者会造重复副本）。
13. 一键同步：进度按文档分组、同一本只补最后一条；书签合并成一次请求。
    某组 5xx / 网络失败只保留该组队列并计入 `failed`，不能中断其余组；
    404（文档已删除）清掉该组队列。
14. **批量同步的 `created` 书签必须校验 `docId` 的属主与存在性**。不校验会写进别人的文档；
    文档已删除时插入撞外键、返回 500，而客户端只在 404 时清队列 —— 一条坏记录会永久卡住同步。
    现在的做法是**跳过并回传 `applied.bookmarks.skipped`**，不让整批请求失败。
15. 离线队列**按读者隔离**：`PendingChange.userId` 记录归属，`listPending` 只返回当前读者的行；
    旧版本没有 `userId` 的行一律忽略。切换账号后绝不能把上一位读者的队列补报到新账号。
16. 一键同步不消费 `changes`，请求带 `includeChanges: false`，服务端跳过全量增量扫描。
17. 进度 / 书签在线补报成功后，要清掉对应的旧队列行（`pickSyncedProgress` /
    `pickSyncedBookmark`），否则「待同步 N 条」会一直挂着。

### 4.7 epub.js 的三个坑

1. **必须传 `{ replacements: 'none' }`**：默认会为每条资源创建 epub.js 自己持有的
   object URL，我们拿不到去 revoke，等于每张图漏一份。
2. **`archive.getBlob` 要求路径带前导斜杠**：实现里写死了 `url.substr(1)`，
   只认 `/OEBPS/images/x.png`；`joinPath` 保留前导斜杠是故意的。
3. **default 导出有两种打包形态**：Vite 走 ESM（default 是函数），Node 走 CJS（函数在 `.default`）。
   顶部的兼容判断两种都认，不要简化。

另外：`querySelectorAll('img')` **查不到元素自己**，`<figure><img/></figure>`
这种图片作为直接子元素的结构要单独分支处理。

### 4.8 数据库与 schema

- `server/sql/schema.sql` 是唯一权威。新功能优先**追加新表**；给已有表加列必须重建数据库。
- 上传上限三处常量必须同值：`server/src/app.ts` 的 `BODY_LIMIT`（500MB，同时是内存上限）、
  `server/src/routes/resources.ts` 的 `MAX_FILE_BYTES`、`client/src/features/parse/index.ts`
  的前端预检常量。跨包无法共享，靠注释互相指认。
- `MAX_PARAGRAPHS = 20000` 是正文规模的兜底。
- 不建音频表；`T_Token` 不经 `DataAccessLibrary`。
- `T_Paragraph.para_type`、`T_ImageResource.alt`、`T_ReadingProgress.server_received_at`
  不是冗余列，删了会丢功能。

### 4.9 更新提示与一键同步（1.3.0）

- `vite.config.ts` 每次构建注入 `<meta name="zhiyin-build">`；网页更新提示比较它。
- `UpdateGate` 只在 Capacitor 原生壳生效；检查失败放行，不阻断离线阅读。
- 原生请求带 `X-App-Version-Code`，服务端低于 `MIN_APP_VERSION_CODE` 返回 426。
- `oneClickSync.ts` 只补报 progress / bookmark；readingTime 由 `useReadingTime` 自己补报。
- 一次点击一个幂等键前缀（`all_<runId>_p_<docId>` / `_b_<docId>`），重试不会重复落库。

### 4.9.1 版本源改成 GitHub Releases（1.9.0）

`server/src/routes/appVersion.ts` 现在是两层结构，读的时候别把两件事混起来：

| 函数 | 在哪用 | 联不联网 |
|---|---|---|
| `resolveAppVersion()` | `GET /api/app/version` | 会，查 `api.github.com/repos/<repo>/releases/latest`，5 分钟缓存 |
| `peekAppVersion()` | `app.ts` 的 426 闸门（`onRequest`，每个请求都走） | **绝不**，只读上面那次查询留下的缓存 |

闸门必须不联网：GitHub 一旦不通，挂在 `onRequest` 上的网络请求会让**所有**接口
都多等一次超时（`FETCH_TIMEOUT_MS = 4000`），整站变慢。更新检查真正发生在
`/api/app/version`，闸门只是蹭结果。

几个必须守住的约定：

- `versionCode` 由 CI 写进 Release 正文的 `<!-- zhiyin:versionCode=10900 -->`。
  tag 只表达 `1.9.0`，Android 的 `versionCode` 是另一个整数，两者换算规则
  （`主*10000 + 次*100 + 修订`）一旦和 APK 里编译进去的值对不上，
  手机端会永远认为自己是旧版。
- `resolveMinVersionCode()` 是全模块**唯一**算门槛的地方。接口与闸门都调它，
  否则会出现「接口说不用更新、请求却被拦成 426」的自相矛盾。
- `MIN_APP_VERSION_CODE` **显式设 0 就是关掉闸门**（维护时用）；没配时按默认意图
  —— 知道最新版号就要求升到最新，不知道（GitHub 不通且没配 `APP_VERSION_CODE`）就放行，
  宁可少拦，也别把正常用户锁在门外。
- 注入 `fetchImpl` 时**不读写**模块缓存（`useCache = opts.fetchImpl === undefined`），
  否则第一个用例塞进缓存的结果会让后面用例莫名其妙地红。
- `parseRelease()` 拿不到 tag / 版本标记 / APK 附件就返回 `null`，让调用方回落到
  环境变量 —— 宁可显示旧版本号，也不要显示一个错的。

发版流程见 §6.2 of [07-开发环境与技术原理.md](./07-开发环境与技术原理.md)，
日常操作（推 tag、配 Secrets、重发某一版）见
[06-手机端安装与连接指南.md](./06-手机端安装与连接指南.md) §5。

### 4.9.2 服务器地址运行时可改（1.9.0）

APK 里的 API 地址是**编译时**由 `VITE_API_BASE` 打进去的默认值。服务端换机器、
换端口，或者原演示服务器下线，安装包里的默认值就失效了。所以：

- `client/src/features/app/ServerSettings.tsx` 是登录页与个人主页共用的入口，
  存 `localStorage` 的 `zhiyin.apiBase`，下次启动生效。
- **登录页必须有这个入口**：只在个人主页的话，用户会卡死 ——
  连不上 → 登不了 → 进不去个人主页改地址。
- CI 构建时**不注入** `VITE_API_BASE`（没有"人人可用"的默认地址），于是
  `DEFAULT_API_BASE` 是 `/api`；组件用 `needsConfig = isNativeApp() && DEFAULT_API_BASE === '/api'`
  判断这种情况，直接把面板展开并拦住空输入，不让用户对着「连不上」发呆。
  想给安装包一个默认地址，就配仓库变量 `ZHIYIN_API_BASE`。
- 连不上时的文案按环境分流（`client/src/api/client.ts` 的 `offlineHint()`）：
  浏览器里说 `npm run server`，原生壳里引导去改地址。

---

## 4.10 正文与语音缓存（2026-11-10）

- 阅读器通过 `features/cache/readerDocument.ts` 统一加载。先在线请求详情校验归属与存在性，再复用正文和预切句结果；不将旧缓存作为离线授权依据。
- 缓存键按 API 地址、读者、docId 隔离；版本含解析版本、导入时间、文件大小、段落数和图片数。加载中切换账号或服务器会中止该次加载。
- 正文内存 LRU 上限 32MB、有效期 5 分钟；IndexedDB `documents` 上限 64MB、有效期 24 小时（按 JSON 字符数的两倍估算容量），写入时淘汰过期与最久未访问的条目。IndexedDB 禁用、写满或缓存损坏时回退网络。
- 同文档在途加载合并，开发环境 StrictMode 重挂载不重复下载正文。打开时仍会读取详情、进度和书签。
- 当前句先启动加载，后续句子同时预取。若当前句加入的预取遇到 429/5xx/网络错误，转入前台有界重试；播放推进仍使用真实结束事件。
- 服务端音色探测单飞，沿用 10 秒探测结果缓存；相同文本、音色、语速、引擎和实际格式的在途合成合并。
- 音频文件命中先于上游探测；缓存文件在数据库同目录的 `tts/`，原子异步写入。生产默认路径仍是 `server/data/tts/`，测试跟随独立数据库隔离。
- 缓存键算法保持不变；服务端磁盘音频仍沿用原有保留策略，本轮未添加自动总容量清理。浏览器音频的单文档 60MB 限制保持不变。

---

## 5. 测试体系与门禁

### 5.1 三层分工

| 层 | 工具 | 位置 | 规模 | 覆盖什么 |
|---|---|---|---|---|
| 单元 | Vitest | `client/test/` | 19 文件 / **228 项** | 纯函数：解析、切句、缓存键、窗口几何、构建号、API 基址整理、待同步队列与一键同步编排 |
| 接口与集成 | Vitest + `app.inject()` | `server/test/` | 11 文件 / **277 项** | 真实路由、状态码、错误码、数据库副作用、同步越权、Edge TTS 适配与版本接口 |
| 端到端 | Playwright + 真实 Chrome | `client/e2e/` | 5 spec / **47 项** | 真实浏览器：排版、滚动、点击、多上下文同步、EPUB |

合计 **552 项**。

### 5.2 分层边界（别越界）

- **单元层刻意不用 jsdom**：`client/vitest.config.ts` 是 `environment: 'node'`。
  需要 IndexedDB / IntersectionObserver / SpeechSynthesis 的，交给 Playwright，
  不用替身硬凑。
- **接口层不监听端口**：全部走 `app.inject()`，测试时开发用的 3000 端口可以照常占着。
- **EPUB 解析放端到端**：`section.load()` 需要真实 DOM，在 Node 里会静默挂住。
- **端到端用独立测试库** `server/data-e2e/`，每次启动前重建，绝不碰演示库。

### 5.3 隔离规范

- `server/test/setup.ts` 用 `mkdtempSync` 建临时目录，把 `ZHIYIN_DB` 指过去。
  **必须在业务模块 import 之前设置**：`db.ts` 在模块顶层计算 `DB_PATH`，
  之后再改环境变量不生效。
- 服务端测试串行跑（`fileParallelism: false`）：`better-sqlite3` 的文件句柄与 WAL
  在并发下会互相绊。
- 端到端启动器 `server/e2e-server.mjs` 每次重建 `server/data-e2e/` 并灌种子。
  注意图片 / 原始文件 / 头像仍落在 `server/data/`，端到端用例实际不碰它们。

### 5.4 怎么跑（六步门禁）

```bash
# [1] 服务端类型检查
cd server && npm run typecheck

# [2] 前端类型检查
cd client && npx tsc --noEmit

# [3] 前端生产构建
cd client && npm run build

# [4] 服务端接口与集成测试
cd server && npm test

# [5] 客户端单元测试
cd client && npm test

# [6] 端到端测试
cd client && npx playwright test
```

端到端环境：

- 本机用 Chrome（`channel: 'chrome'`）。没装 Chrome 时改成 `msedge`，
  或先跑通 `npx playwright install chromium`。
- 前端必须显式 `--host 127.0.0.1`；Playwright 的 `webServer` 探活打的是 `127.0.0.1`，
  而 `npm run dev` 默认绑 `localhost`，实测会等到 120 秒超时。
- 视口 1440×900。

CI（GitHub Actions）三个 job 并行：`static`（两端类型检查 + 前端构建）、
`unit`（两端 Vitest）、`e2e`（Playwright 自带 chromium）。Node 固定 22：
`better-sqlite3@12.11.1` 的预编译包覆盖 Node 22 / 24 / 25 / 26，不含 20 的 ABI。

另外 `android.yml` 是**发版专用**，不在每次 push 时跑：只有推 `v*` tag
（或手动触发并指定版本号）才会构建签名 APK 并发布 GitHub Release，见 §7。

### 5.5 改了什么要跟着改什么

| 改动 | 会红的用例 | 原因 |
|---|---|---|
| TTS 缓存键任一边 | `tts-cachekey-parity.test.ts` | 两边必须逐字节一致，否则静默变慢 |
| 句子切分规则 | `readalong-split.test.ts` | 锚点 `charOffset` 与高亮范围会偏 |
| 锚点字段名 | `sync-merge.test.ts` 相关组 | 裁决 2 |
| 合并判定 | `sync-merge.test.ts`、`sync-bookmark.test.ts` | 冲突行为不报错，只能靠断言守 |
| 软删除逻辑 | 墓碑 `updatedAt` 用例 | 不刷新就永远拉不到墓碑 |
| 窗口化几何 / 字号 | `render-virtualwindow.test.ts` | 短文档必须仍全量渲染 |
| 图片 `imageId` 或主键 | `cross-document-imageid.test.ts`、`e2e/epub-parse.spec.ts` 的 D-T01 | 主键是 `(doc_id, image_id)`，两本同名图各存各的 |
| 零宽字符表 | `readalong-zerowidth.test.ts` | 两处口径必须一致 |
| 界面类名 | `e2e/ui-flows.spec.ts` | 类名是全局契约 |
| 进度上报触发方式 | `e2e/sync-two-devices.spec.ts` | 只在 `.reader-scroll` 的 scroll 事件里上报 |
| 构建号注入 / 更新提示 | `web-build.test.ts` | 解析与设备判断是纯函数 |
| API 基址整理规则 | `api-base.test.ts` | 整理错了表现是"连不上"，不报错 |
| 版本接口 / 426 闸门 | `app-version.test.ts` | 两边算门槛必须一致，否则自相矛盾 |

### 5.6 没覆盖的

- 真实 Kokoro 音色质量与实际延迟（本机未安装）；
- 真实平板 + 笔记本的局域网同步（只用两个独立 browser context 模拟）；
- 30 分钟长时间压测；
- 3000 段以上文档的真实渲染（只测到 2000 段的几何计算）；
- 无障碍（键盘导航、屏幕阅读器）；
- 图片懒加载的真机字节流与 LRU 淘汰（接口层覆盖了上传 / 回读 / ETag）。

---

## 6. 已知限制与遗留项

| 项 | 现状 |
|---|---|
| 暂停语义 | 暂停是「停掉当前句」，恢复时该句从头念，不是句中断点续播 |
| 双窗口同一设备 | 两个窗口共享 localStorage，`deviceId` 相同；真跨设备要用两台机器 |
| 冲突界面 | 未决冲突只在 `ReaderView` 读回，`LibraryView` 还没接入 |
| 同步增量 | 一键同步已用 `includeChanges: false` 跳过扫描；普通批量同步仍整体比较所有书签，未做真正增量游标 |
| 幂等覆盖 | `Idempotency-Key` 只覆盖 `/api/sync`，单项接口没接 |
| 图片懒上传 | 只在阅读时触发；导入后从未打开过的书，服务端一张图都没有（设计如此） |
| 主包体积 | `epubjs` 300KB+ 打进主包，没做代码分割 |
| 移动端 | 有 Android 壳与更新提示，但完整响应式改版未并入当前主线 |
| 上传内存 | 500MB 是每请求内存上限；前端全量读文件，数百 MB 的 EPUB 可能打爆内存 |
| 版本常量 | `package.json` 1.8.0、Android 壳由 CI 从 tag 算（本机默认 10 / 1.9.0）、服务端默认 9 / 1.8.0；只有发版 tag 是权威值 |

---

## 7. 变更登记

### 表结构

| 表 / 列 | 变更 | 说明 |
|---|---|---|
| `T_Paragraph.para_type` | 建库时补 | `h1 / h2 / p / img`，缺了分不出标题 |
| `T_ImageResource.alt` | 建库时补 | 契约 imageRefs 里有，缺了只能显示包内路径 |
| `T_ReadingProgress.server_received_at` | 建库时补 | 双方 `updatedAt` 相差 < 5 秒时裁决先后 |
| `T_Bookmark.sort_order` | 追加 | 书签拖动排序，稠密整数 |
| `T_Bookmark.chapter_title` | 追加 | 书签所属章节，总览与默认名复用 |
| `T_Favorite` | 新增 | 收藏 |
| `T_ReadingSession` | 新增 | 阅读时长会话，`client_id` 唯一 |
| `T_UserProfile` | 新增 | 头像 |
| `T_Idempotency` | 新增 | 幂等键，复合主键，24h TTL |

### 与最初接口设计的偏差

| 项 | 实现 | 原因 |
|---|---|---|
| 裁决请求体 `relatedId` | 额外必填字段 | `keep_both` 后要二选一，必须知道另一条记录 |
| 书签 `sortOrder` / `chapterTitle` | 可选字段 | 老调用方不传时服务端补默认值 |

### 1.9.0（GitHub 分发与自更新）

| 变更 | 位置 |
|---|---|
| 发版工作流：推 `v*` tag 构建签名 APK 并发 Release | `.github/workflows/android.yml` |
| 版本源改查 GitHub Releases（5 分钟缓存，失败回落环境变量） | `server/src/routes/appVersion.ts` |
| 426 闸门改用 `peekAppVersion()`（不联网） | `server/src/app.ts` |
| 签名支持环境变量注入，版本号可由 CI 传入 | `client/android/app/build.gradle` |
| 服务器地址入口抽成共用组件，登录页也能改 | `client/src/features/app/ServerSettings.tsx`、`LoginView.tsx`、`ProfileView.tsx` |
| 连不上时按环境给不同提示 | `client/src/api/client.ts` 的 `offlineHint()` |
| 原演示服务器停用，文档全面改写 | `docs/06`、`docs/07`、`docs/system-design.md`、`README.md` |
| `POST /api/sync` 的 `includeChanges` | 可选开关，缺省 true | 一键同步不需要服务端增量，关掉可省全量扫描 |
| `applied.bookmarks.skipped` | 响应里新增数组 | 文档已删 / 越权 / 缺 docId 的条目被跳过，客户端据此清队列 |
| 导入段落 `type` | 契约示例里没有 `type` | 标题 / 图片段需要类型 |
| 音频表 | 不建 | 只做文件与 IndexedDB 缓存 |
| AI 伴读 | 只留接口占位 | 明确不做 |

### 质量审查修复（1.3.0 之后）

| 问题 | 修复 |
|---|---|
| 批量同步的 created 书签不校验 `docId` 属主 / 存在性 | 服务端跳过并回传 `skipped`；文档已删除不再 500 |
| 离线队列不区分读者 | `PendingChange.userId` + `listPending` 按读者过滤；`authStore.userId` 由 Session 维护 |
| 一键同步只清 404、坏记录会永久卡住 | 无效条目走 `skipped` 正常清队列；5xx 保留该组并继续其余组 |
| 批量同步丢失 `chapterTitle` | `BookmarkIn` / `BookmarkPayload` / 落库全链路透传 |
| Edge 音色探测无超时 | `withTimeout` 包住 `getVoices` 与 `generate` |
| Edge 忽略请求格式、Content-Type 不一致 | `resolveFormat` 声明实际格式；只支持 mp3 / opus，其余 400 |
| 进度成功后旧队列行不清 | `pickSyncedProgress` / `pickSyncedBookmark` 在在线成功后清行 |
| 书签补报按文档串行、每次全量扫描 | 书签合并为一次请求；`includeChanges: false` 跳过增量扫描 |
| 触摸屏桌面被误判为手机 | `isPhoneOrTablet` 改为「粗指针 + 无 hover」 |

### 1.3.0

| 变更 | 位置 |
|---|---|
| Edge TTS 适配器 | `server/src/tts/edgeProvider.ts`、`providers.ts`、`tts/index.ts` |
| 原生更新闸门 | `client/src/features/app/UpdateGate.tsx`、`api/appVersion.ts`、`routes/appVersion.ts` |
| 网页更新提示 | `client/src/features/app/WebUpdateBanner.tsx`、`webBuild.ts`、`vite.config.ts` |
| 一键同步 | `client/src/features/sync/oneClickSync.ts`、`LibraryView.tsx` |
| Android 壳 | `client/android/`、`capacitor.config.ts` |

---

## 8. 文档维护规则

1. **单一事实来源**：一个事实只写在一处，其他文档放链接，不复制全文。
2. **AGENTS.md** 只放全局事项；系统怎么设计写 `system-design.md`；
   怎么开发、怎么测、有哪些坑写本文。
3. **README.md** 面向使用者，不写架构与实现细节。
4. 改了接口 / 表结构 / 关键流程，同步更新对应章节与「变更登记」。
5. 改了实现约定，先在本文对应小节留注释说明「为什么」，再改代码。
6. 文档里的测试数字以实际跑出来的结果为准，不要沿用历史快照。
