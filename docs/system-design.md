# 知音漫卷 · 系统设计

> 版本：1.3.0　｜　最后更新：2026-11-03
>
> 本文回答「系统是什么、为什么这样设计」。
> 开发环境、代码地图、实现约定与测试流程见 [system-develop.md](./system-develop.md)；
> 全局事项（技术栈、启动、术语、工作流）见 [../AGENTS.md](../AGENTS.md)。

---

## 1. 系统定位与范围

知音漫卷是一个**桌面浏览器优先**的阅读 Web 应用：读者导入 EPUB / TXT / Markdown，
前端把文件解析成结构化数据，正文在浏览器中图文混排滚动阅读，并能逐句高亮跟读；
阅读进度与书签按设备记录并跨端同步。

演示当天必须真实跑通的三项：

1. **逐句高亮跟读**：高亮位置与真实播放事件严格对应。
2. **跨设备同步 + 冲突处理**：进度不倒退，书签冲突不静默丢数据。
3. **图文混排与图片懒加载**：插图长在原文位置，进入视口才加载。

1.3.0 起前端同时可以被 Capacitor 装进 Android 原生壳，但**网页版仍是主形态**，
移动端只做了更新提示与局部适配，不是完整的响应式改版。

明确不做：

- PDF、OCR；
- AI 伴读问答（只留接口占位）；
- 第三方 OAuth 登录（只留空实现）；
- 对象存储 / CDN；
- OT / CRDT 合并算法；
- 高亮位置跨端同步；
- 完整移动端 / 平板响应式适配；
- 服务端音频表（音频只做内存与 IndexedDB 缓存）。

---

## 2. 总体架构

```
浏览器（React 18 + Vite + TypeScript）
├─ pages/                 六个主界面 + 三个内嵌面板
├─ features/parse/         TXT / Markdown / EPUB 解析、SHA-256、句子切分
├─ features/render/        窗口化渲染、图片懒加载、目录
├─ features/readalong/     跟读编排、TTS 引擎、音频缓存
├─ features/sync/          锚点、进度、书签、离线队列、一键同步
├─ features/settings/      主题、字号、翻页、背景图
├─ features/profile/       头像
├─ features/cache/         IndexedDB 公共层
├─ features/app/           网页更新提示与原生更新闸门
└─ api/client.ts           统一请求封装（超时、401 刷新、错误信封）
              │  HTTPS + JSON（二进制接口除外）
              ▼
服务端（Fastify 4 + TypeScript，端口 3000）
├─ routes/                 health / auth / documents / resources / progress /
│                          bookmarks / sync / tts / readingTime / appVersion
├─ auth/                   JWT、scrypt 口令、刷新令牌、鉴权钩子
├─ sync/                   锚点工具、合并判定（纯函数）、落库与冲突
├─ tts/                    引擎抽象、缓存键、音色目录、Kokoro / Edge 适配
├─ dao/                    DataAccessLibrary（唯一数据访问入口）
├─ db.ts / errors.ts       建库与连接、统一错误信封
└─ SQLite                  server/data/zhiyin.db（13 张表）
              │
              ├─ server/data/files/     原始文件
              ├─ server/data/images/    图片副本
              ├─ server/data/avatars/   头像
              └─ server/data/tts/       合成音频缓存
              │
              ▼
TTS 上游（二选一，经服务端代理）
├─ 本地 Kokoro（OpenAI 兼容 /v1/audio/speech，默认 8880）
└─ 微软 Edge 在线语音（TTS_PROVIDER=edge，免 API Key）
```

**关键分层约束**

- **解析在前端**：服务端只存储与分发解析结果，不引入 EPUB / Markdown 解析依赖。
- **前端不直连第三方**：TTS 与图片回源都经服务端代理，前端代码里没有服务密钥。
- **正文渲染不走 React 差异渲染**：由 ref + 直接 DOM 操作完成，避免长文档重渲染。
- **句子切分、语音调度、同步合并是纯 TS 模块**：可脱离框架测试。
- **DataAccessLibrary 是唯一数据访问入口**；`T_Token` 由认证服务直接读写，是唯一例外。

---

## 3. 模块划分、界面与路由

### 3.1 前端模块

| 目录 / 文件 | 职责 |
|---|---|
| `src/pages/` | 界面组件，类名固定，见 3.2 |
| `src/api/client.ts` | fetch 封装：统一前缀、Bearer、15 秒超时、401 刷新一次并重放、错误转 `ApiError` |
| `src/api/authStore.ts` | accessToken 内存存储、refreshToken 读写 |
| `src/api/device.ts` | `deviceId` 生成与持久化 |
| `src/api/appVersion.ts` | 原生壳版本号、`X-App-Version-Code`、更新检查 |
| `src/api/platform.ts` | 判断是否运行在 Capacitor 原生壳 |
| `src/state/session.tsx` | 会话上下文，刷新页面后静默换新 |
| `src/features/parse/` | TXT / Markdown / EPUB 解析、解码、纯 JS SHA-256、句子切分 |
| `src/features/readalong/` | 跟读循环、句子切分、TTS 引擎（服务端 / 浏览器）、音频缓存、偏好 |
| `src/features/render/` | 窗口化几何、图片懒加载、IndexedDB 图片缓存、目录抽取 |
| `src/features/sync/` | 锚点、进度上报、书签读写、待同步队列、一键同步 |
| `src/features/settings/` | 主题、字号、翻页方式、阅读背景图 |
| `src/features/profile/` | 头像经接口取二进制并转 object URL |
| `src/features/cache/` | IndexedDB 公共层（图片 / 音频 / 待同步队列 / 背景图） |
| `src/features/app/` | 网页更新横幅、原生强制更新闸门、构建号解析 |
| `src/features/motion/`、`features/brand/` | 水墨动效与品牌图形 |

### 3.2 界面清单与路由

| 类名 | 中文 | 路由 | 说明 |
|---|---|---|---|
| `GuidingUI` | 引导界面 | `/guide` | 三页引导，根路径与未匹配路径都重定向到这里 |
| `LoginView` | 登录 / 注册 | `/login` | 账号为手机号或邮箱，密码至少 8 位 |
| `LibraryView` | 书架 | `/shelf` | 分类、检索、导入、收藏、批量删除、一键同步 |
| `ReaderView` | 阅读器 | `/read/:docId` | 正文、目录、设置、书签、跟读 |
| `StatsView` | 阅读时长 | `/stats` | 累计 / 今天 / 本周 / 按书统计 |
| `ProfileView` | 个人主页 | `/profile` | 头像、昵称、账号、服务器地址 |
| `ReaderSettingsPanel` | 阅读设置面板 | 内嵌 | 主题、字号、翻页方式、背景图 |
| `PlaybackBar` | 播放控制条 | 内嵌 | 上一句 / 跟读 / 下一句、语速、音色 |
| `ConflictDialog` | 冲突对话框 | 模态 | 展示双方差异并裁决 |
| `BookmarkPanel` | 书签面板 | 内嵌 | 新增、跳转、改名、删除、拖动排序 |

### 3.3 服务端模块

| 路径 | 职责 |
|---|---|
| `src/app.ts` | `buildApp()` 只组装 Fastify，不监听端口，便于测试 `app.inject()` |
| `src/index.ts` | 读取端口并 `listen` |
| `src/routes/auth.ts` | 注册、登录、刷新、退出、账号信息、改昵称 / 密码 |
| `src/routes/documents.ts` | 书架列表、导入、详情、正文分段、删除 |
| `src/routes/resources.ts` | 原始文件、图片、头像的二进制存取 |
| `src/routes/progress.ts` | 按文档拉取所有设备的进度、条件上报 |
| `src/routes/bookmarks.ts` | 书签增删改查、增量、分页、总览、拖动排序 |
| `src/routes/sync.ts` | 批量增量同步、未决冲突读取、用户裁决 |
| `src/routes/tts.ts` | 引擎与音色查询、单句合成 |
| `src/routes/readingTime.ts` | 阅读会话上报与统计 |
| `src/routes/appVersion.ts` | 原生 App 最新版本与强制更新信息 |
| `src/auth/` | HS256 JWT、scrypt 口令、刷新令牌轮换、鉴权钩子 |
| `src/sync/` | `anchor.ts` 锚点校验、`merge.ts` 合并判定、`service.ts` 落库与冲突 |
| `src/tts/` | `providers.ts` OpenAI 兼容上游、`edgeProvider.ts` Edge、`cacheKey.ts`、`voiceCatalog.ts` |
| `src/dao/index.ts` | 所有业务表的读写入口 |
| `src/db.ts` | SQLite 连接、建库、数据目录 |
| `src/errors.ts` | 统一错误码与中文消息 |
| `src/idempotency.ts` | 幂等键读写（`T_Idempotency`） |

---

## 4. 数据模型

**表的权威定义是 [`server/sql/schema.sql`](../server/sql/schema.sql)**，共 13 张表。
以下只记设计意图与关键字段，字段细节以建库脚本为准。

| 表 | 用途 | 关键点 |
|---|---|---|
| `T_User` | 读者账号 | `password_hash` + `salt`；`fail_count` / `locked_until` 实现锁定 |
| `T_Document` | 文档元数据 | 外键统一叫 `owner_id`；`(owner_id, content_hash)` 唯一，用于重复导入去重 |
| `T_Paragraph` | 段落 | `para_index` 文档内段落序号；`para_type = h1 / h2 / p / img` |
| `T_Sentence` | 句子边界 | 段内 `sentence_index`、`start_offset`、`end_offset`；由前端切分后上传 |
| `T_ImageResource` | 图片引用 | `image_id` 客户端生成；`src` 原文路径、`alt` 替代文本、`remote_url` 服务端副本 |
| `T_ReadingProgress` | 阅读进度 | **每设备一行**；锚点四列展开；`last_sentence_index` 是本机瞬态，不参与跨端同步 |
| `T_SyncRecord` | 同步记录 | `conflict_json` 保存冲突信封；未决冲突从这里读回 |
| `T_Bookmark` | 书签 | 客户端生成 `bookmark_id`；软删除墓碑 `deleted_at`；`sort_order` 拖动顺序；`chapter_title` 所属章节 |
| `T_Token` | 刷新令牌 | 只存 SHA-256 哈希；刷新即轮换；只由认证服务直接读写 |
| `T_Idempotency` | 幂等键 | 复合主键 `(user_id, idem_key)`，防跨用户重放；24 小时 TTL |
| `T_Favorite` | 收藏 | 主键 `(user_id, doc_id)`，双向操作幂等 |
| `T_ReadingSession` | 阅读时长会话 | `client_id` 唯一索引 + `INSERT OR IGNORE`，离线补报天然幂等 |
| `T_UserProfile` | 用户档案 | 头像地址单独一张表，避免为加列而重建已有库 |

**锚点（Anchor）只有一种定义**：

```ts
type Anchor = {
  chapterIndex: number     // 章节序号，0 基
  paragraphIndex: number   // 章内段落序号，0 基
  sentenceIndex: number    // 段内句子序号，0 基
  charOffset: number       // 段内字符偏移，0 基（UTF-16 code unit）
  scrollOffset: number     // 滚动微调，像素
  docVersion?: string      // 文档内容哈希，可选
}
```

- `T_ReadingProgress` 用 `chapter_index` / `paragraph_index` / `char_offset` / `scroll_offset` 四列展开。
- `T_Bookmark.anchor_json` 存完整 JSON。
- **不要另造 `paraIndex` 版本的锚点**。导入请求里的 `paraIndex` 是段落本身的序号，不是锚点字段。

**几处有意为之的设计**

- 不建音频表：音频只存在于服务端文件缓存与浏览器 IndexedDB。
- `T_Paragraph.para_type`、`T_ImageResource.alt`、`T_ReadingProgress.server_received_at`
  是建库时补的列，缺少它们分别无法区分标题、无法显示图片说明、无法在客户端时钟偏移时裁决先后。
- 新功能优先**追加新表**而不是给已有表加列：加列需要重建数据库，会清空读者已导入的书。

---

## 5. 接口设计

### 5.1 通用约定

| 项 | 约定 |
|---|---|
| 基础路径 | `/api`；除二进制接口外均为 JSON |
| 编码与时间 | UTF-8；ISO 8601 UTC 字符串 |
| 认证 | `Authorization: Bearer <accessToken>`；注册 / 登录 / 刷新 / 版本查询除外 |
| 访问令牌 | HS256 JWT，30 分钟；载荷含 `sub`、`jti`、`iat`、`exp`、`typ:"access"` |
| 刷新令牌 | 256 位随机串，服务端只存 SHA-256 哈希；14 天；每次刷新即轮换，旧的立即删除 |
| 设备标识 | 首次启动生成 UUID，存 localStorage；登录与同步上送 `deviceId` |
| 条件更新 | 写接口带 `baseVersion`；受影响行数为 0 返回 `409 SYNC_VERSION_CONFLICT` |
| 幂等 | `Idempotency-Key` 目前覆盖 `POST /api/sync`；服务端 24 小时内对相同键返回首次结果 |
| 分页 | `page` 从 1 起，`pageSize` 默认 20、上限 100；响应含 `total`、`page`、`pageSize` |
| 请求追踪 | 响应头 `X-Request-Id`，错误体回显同值 |

**统一错误信封**：

```json
{
  "code": "AUTH_INVALID_CREDENTIAL",
  "message": "账号或密码错误",
  "details": {},
  "requestId": "req_8f3c1a"
}
```

`message` 一律中文；`details` 承载该错误码特有的补充信息。

**错误码总表**

| HTTP | code | 含义 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 参数缺失或格式非法 |
| 401 | `AUTH_REQUIRED` | 未携带令牌 |
| 401 | `AUTH_TOKEN_EXPIRED` | 访问令牌过期，应刷新 |
| 401 | `AUTH_INVALID_CREDENTIAL` | 账号或密码错误（不区分账号是否存在） |
| 401 | `AUTH_REFRESH_INVALID` | 刷新令牌无效、过期或已被轮换 |
| 401 | `AUTH_OLD_PASSWORD_WRONG` | 修改密码时原密码不正确 |
| 403 | `FORBIDDEN_NOT_OWNER` | 资源不属于当前读者 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 409 | `CONFLICT_ACCOUNT_EXISTS` | 账号已被注册 |
| 409 | `CONFLICT_DOCUMENT_DUPLICATE` | 同一读者重复导入同一文档（`details.docId`） |
| 409 | `SYNC_VERSION_CONFLICT` | 版本号不匹配，`details.conflict` 见 5.3 |
| 413 | `PAYLOAD_TOO_LARGE` | 上传体量或段落数超过上限 |
| 415 | `UNSUPPORTED_FORMAT` / `UNSUPPORTED_MEDIA_TYPE` | 文档格式或二进制类型不支持 |
| 422 | `PARSE_FAILED` | 解析结果结构非法 |
| 423 | `ACCOUNT_LOCKED` | 连续失败 5 次，锁定 15 分钟（`details.lockedUntil`） |
| 426 | `APP_UPDATE_REQUIRED` | 原生壳版本低于服务端最低版本 |
| 429 | `RATE_LIMITED` | 请求过于频繁（`details.retryAfter`） |
| 500 | `INTERNAL_ERROR` | 服务端内部错误 |
| 502 | `UPSTREAM_TTS_FAILED` / `UPSTREAM_AI_FAILED` | 上游失败 |
| 504 | `UPSTREAM_TIMEOUT` | 上游超时 |

### 5.2 接口分组

| 域 | 方法与路径 | 用途 |
|---|---|---|
| 健康 | `GET /api/health` | 服务与数据库就绪检查 |
| 版本 | `GET /api/app/version` | 原生 App 最新版本、APK 地址、最低版本 |
| 认证 | `POST /api/auth/register` | 注册 |
| | `POST /api/auth/login` | 登录 |
| | `POST /api/auth/refresh` | 刷新并轮换令牌 |
| | `POST /api/auth/logout` | 退出，删除刷新令牌 |
| | `GET /api/users/me` | 当前读者信息 |
| | `PATCH /api/users/me` | 改昵称 / 改密码 |
| | `PUT /api/users/me/avatar` | 上传头像（二进制） |
| | `GET /api/users/me/avatar` | 读取头像（二进制，带 ETag） |
| | `DELETE /api/users/me/avatar` | 移除头像 |
| 文档 | `GET /api/documents` | 书架列表与检索；分类 `all / recent / favorite / bookmarked / offline` |
| | `POST /api/documents` | 提交解析结果入库 |
| | `GET /api/documents/:docId` | 文档详情 |
| | `GET /api/documents/:docId/content?from=&to=` | 正文分段，带 ETag / 304 |
| | `DELETE /api/documents/:docId` | 删除文档并级联清理 |
| | `PUT /api/documents/:docId/file` | 上传原始文件 |
| | `GET /api/documents/:docId/file` | 下载原始文件 |
| | `PUT /api/documents/:docId/favorite` | 收藏 |
| | `DELETE /api/documents/:docId/favorite` | 取消收藏 |
| 图片 | `PUT /api/documents/:docId/images/:imageId` | 懒上传单张图片 |
| | `GET /api/documents/:docId/images/:imageId` | 读取图片（服务端代理） |
| 进度 | `GET /api/documents/:docId/progress` | 拉取该文档**所有设备**的进度 |
| | `PUT /api/documents/:docId/progress` | 条件上报本机进度 |
| 时长 | `POST /api/documents/:docId/reading-time` | 上报一段阅读会话 |
| | `GET /api/documents/:docId/reading-time` | 单文档累计时长 |
| | `GET /api/reading-time/summary` | 累计 / 今天 / 本周 / 按书统计 |
| 书签 | `POST /api/bookmarks` | 新增 |
| | `PATCH /api/bookmarks/:bookmarkId` | 改名 / 移动 |
| | `DELETE /api/bookmarks/:bookmarkId` | 软删除 |
| | `GET /api/bookmarks?docId=&since=&includeDeleted=` | 增量拉取（同步用） |
| | `GET /api/bookmarks/page?docId=&sort=&order=&page=&pageSize=` | 界面分页列表 |
| | `GET /api/bookmarks/overview` | 跨文档书签总览 |
| | `POST /api/bookmarks/reorder` | 整表重排拖动顺序 |
| 同步 | `POST /api/sync` | 上传增量 + 拉取增量 + 冲突判定 |
| | `GET /api/sync/conflicts` | 读回未决冲突 |
| | `POST /api/sync/resolve` | 读者裁决 |
| TTS | `GET /api/tts/engines` | 可用引擎与音色 |
| | `GET /api/tts/voices` | 音色目录（含未安装的置灰项） |
| | `POST /api/tts/synthesize` | 合成单句音频，返回二进制 |
| AI | `POST /api/ai/chat` | 契约占位，**未注册路由、未实现** |

### 5.3 关键语义

**导入请求**（`POST /api/documents`）

```json
{
  "fileName": "三体.epub",
  "fileFormat": "EPUB",
  "fileSize": 5242880,
  "contentHash": "sha256:9f2c...",
  "title": "三体",
  "author": "刘慈欣",
  "paragraphs": [
    { "paraIndex": 0, "type": "h1", "text": "第一章 科学边界" },
    { "paraIndex": 1, "type": "p", "text": "汪淼站在楼顶……", "sentences": [
      { "sentenceIndex": 0, "startOffset": 0, "endOffset": 12 }
    ]}
  ],
  "imageRefs": [
    { "imageId": "img_3c81", "paraIndex": 4, "src": "images/cover.jpg", "alt": "封面" }
  ]
}
```

- 服务端按 `(owner_id, content_hash)` 去重；命中返回 409，`details.docId` 指向已有文档。
- 入库在单个事务内完成：文档、段落、句子、图片引用；图片二进制此时**不上传**。
- `imageId` 由客户端生成，是后续上传与缓存的稳定标识。

**进度**

- 拉取必须返回该文档**所有设备**的记录，否则新设备拿不到别端进度。
- 上报带 `updatedAt` 与 `baseVersion`；`baseVersion` 不匹配可能产生冲突。
- 「不回退保护」：取最近更新的一条，但若本机已记录的位置更靠前，就用本机的。
- 上报时机：滚动停止 1500ms 防抖、跟读跨段落、页面隐藏或卸载时补一次；失败进离线队列。

**书签**

- 软删除写墓碑并**刷新 `updated_at`**，否则增量拉取按 `updated_at > since` 永远拉不到删除事件。
- `updated` / `deleted` 条目里没有 `docId` 和 `anchor`；服务端靠 `bookmarkId` 反查，
  锚点缺省时**沿用库里已有的** —— 否则一次「只改名」的同步会把位置冲成第 0 段。
- 拖动排序使用稠密整数 `0,1,2…`；两端同时拖动取较新者（`superseded`），不产生重复副本。

**批量同步与冲突信封**

`POST /api/sync` 的请求体包含 `deviceId`、`since`、`progress`、`bookmarks.created / updated / deleted`；
响应包含 `serverTime`、`applied`、`conflicts`、`changes`。

冲突信封三种 `resolution`：

| resolution | 场景 | 服务端行为 |
|---|---|---|
| `keep_both` | 书签并发改名 / 移动；删除与修改冲突 | 保留双方；改名冲突新增一条副本，删改冲突保留修改 |
| `require_user_choice` | 无法安全自动裁决 | 不改数据，等待 `POST /api/sync/resolve` |
| `superseded` | 进度记录被判定为旧版本 | 保留较新记录，被覆盖的一份写入冲突记录 |

- `keep_both` 时第二条记录的 id 由**服务端**生成（`bm_` + uuid v4 去横线）。
- 裁决请求体额外带 `relatedId`：`keep_both` 之后要「二选一」必须知道另一条是谁；
  客户端从冲突信封的 `resolved.bookmarkId` 取。
- 裁决成功后必须销账（`T_SyncRecord` 置为已解决），否则下次进阅读页会重弹。

**TTS**

- `POST /api/tts/synthesize` 请求体：`{ text, voice, rate, format, engine }`；
  返回音频二进制，响应头 `X-Cache: hit|miss`。
- 缓存键：`sha256(engine + voice + rate + text)`，分隔符为 `\u0001`；
  客户端与服务端各一份实现，必须逐字节一致。
- 引擎 id：`kokoro-local`、`edge-tts`、`browser-native`。
  `available=false` 的引擎不进前端列表；浏览器原生永远可用，是兜底路径。
- 语速是倍率（0.5～2.0）；Edge 上游的 rate 是百分比，由适配层换算。

**阅读时长**

- 纯追加型遥测，不参与版本合并；`clientId` 是幂等键。
- 只统计页面可见且窗口聚焦的时长；单段上限 6 小时。

**版本与更新**

- 原生壳每个请求带 `X-App-Version-Code`，低于 `minVersionCode` 返回 426。
- `GET /api/app/version` 公开，返回 `versionCode / versionName / apkUrl / minVersionCode / force / notes`。
- 网页版通过 `index.html` 的 `<meta name="zhiyin-build">` 比较构建号，手机 / 平板显示轻提示。

---

## 6. 关键流程

### 6.1 导入与解析

1. 读者在书架选择文件；前端先按同一上限预检大小，超限直接给中文提示。
2. 按扩展名分派解析器：
   - TXT：按空行分段，识别「第 X 章 / 卷 / 节」为标题；
   - Markdown：`marked` 解析标题、段落、图片；
   - EPUB：`epub.js` 只取解析结果，按 spine 顺序拼章节，`h1~h6` 转标题段。
3. 前端切分句子，生成 `contentHash`，把结构化结果一次性 `POST /api/documents`。
4. 上传原始文件（失败不影响入库，标记为仅本地可见）。
5. 图片 Blob 只写 IndexedDB，**不随导入上传**；阅读时首次进入视口再懒上传。

### 6.2 图文混排与懒加载

- 段落按原文顺序渲染，图片内联在引用位置，不集中堆到文末。
- 超过 150 段启用窗口化渲染：只保留视口附近段落节点，上下用撑高块维持滚动条；
  500 段实测只生成 25～38 个节点。150 段以下走全量渲染。
- 图片进入视口才加载：先查 IndexedDB，再向服务端取，两边都没有显示「图片不可用」。
- 服务端也没有而本地有时，顺手补传，其他设备才看得到。
- 离开视口撤销 object URL；IndexedDB 副本保留。
- 上限：单文档 300 张或总量 200MB（先到者为准），按最后访问时间 LRU 淘汰。

### 6.3 逐句跟读

句子切分规则：

| 规则 | 说明 |
|---|---|
| R1 | `。！？…` 及其组合视为句末边界，标点归属前一句 |
| R2 | `；`、`：` 只作句内停顿，不切分 |
| R3 | 引号 / 括号内的句末标点同样切分，收尾符号归前一句 |
| R4 | 连续省略号只算一次边界，不产生空句 |
| R5 | 数字间句点（如 3.14）与缩写白名单（Mr.、No.）不切分 |
| R6 | 段内换行、制表符、连续空格归一为单个空格 |
| R7 | 切分前去掉首尾空白与零宽字符，偏移以归一化后的文本为准 |
| R8 | 单句超过 200 字时在最近的 `、` 或 `，` 处强制切分，仍无标点则硬切 |
| R9 | 纯标点、纯空白、零长度片段一律丢弃 |
| R10 | 文档不变时索引稳定；改切分规则视为内容升级，需重建句子与音频缓存 |

跟读流程：

1. `useReadAlong` 从当前 `highlightCursor` 开始，逐句调用引擎。
2. 服务端引擎合成音频后用 `<audio>` 播放，**以 `ended` 事件推进游标**；
   浏览器引擎用 `SpeechSynthesisUtterance`，**以 `onend` 事件推进**。
3. 每次朗读预取后面 2 句；客户端命中 IndexedDB 时连请求都不发。
4. 引擎 / 音色不可用时自动降级：服务端引擎 → 浏览器原生；界面显示「已降级为浏览器发声」。
5. 读者点正文任意句子会接管游标；跟读中改语速只影响下一句（`rateRef`），不重念当前句。

### 6.4 同步与冲突

1. **进度按设备一行**。打开文档时拉取所有设备记录，按「不回退保护」选恢复位置。
2. 滚动停止 1500ms 后防抖上报；页面隐藏 / 卸载时用 `sendBeacon` 补报。
3. 书签使用客户端生成的 id，支持增量拉取、分页、跨文档总览与拖动排序。
4. 写接口带 `baseVersion`；服务端检测到版本不一致时进入合并判定：
   - 两端新增不同 id → 并集；
   - 同一书签并发修改 → `keep_both`；
   - 一端删、一端改 → 保留修改；
   - 进度 → `superseded`，自动按不回退保护裁决。
5. 冲突写入 `T_SyncRecord`；`GET /api/sync/conflicts` 读回未决项，读者裁决后销账。
6. 网络失败的变更进 IndexedDB 待同步队列；书架「一键同步」按文档分组补报，
   一次点击用一个幂等键前缀，重试不会重复落库。

### 6.5 阅读时长

- 前端只累计「页面可见 + 窗口聚焦」的时间，按会话上报。
- 每段带 `clientId`，服务端唯一索引 + `INSERT OR IGNORE`，离线重发无副作用。
- `/stats` 展示累计、今天、本周与按书排行；跨零点的一段归到开始那天。

### 6.6 版本检查与更新

- **原生壳**：启动时查 `/api/app/version`，版本低于要求时弹不可关闭的更新闸门；
  任一接口返回 426 也会触发。检查失败不阻断离线阅读。
- **网页版**：只在手机 / 平板显示轻提示，比较页面内与服务器 `index.html` 的构建号；
  点「立即刷新」才重载，忽略只对当前构建号生效。

### 6.7 TTS 引擎选择

| 引擎 | 何时使用 | 特点 |
|---|---|---|
| `kokoro-local` | 默认；本地 8880 有服务 | 经服务端代理，OpenAI 兼容 |
| `edge-tts` | 服务端设 `TTS_PROVIDER=edge` | 免 API Key，无 GPU 环境可用 |
| `browser-native` | 上游不可用 | 浏览器 Web Speech API，只支持句子级高亮 |

三者对上层是同一种「朗读一句，念完 resolve」接口，游标推进只写一份。

---

## 7. 四条裁决与关键取舍

### 裁决 1：解析放在前端

服务端只负责存储与分发解析结果，不做文档解析。
导入流程是「前端读文件 → 前端解析 → 一次性 POST 入库」。
理由：两周工期下最省事，服务端不必引入 EPUB / Markdown 解析依赖。

### 裁决 2：锚点只有一种定义

全项目统一使用第 4 节给出的 `Anchor`，字段名以第 4 节为准。
数据库四列展开，书签存完整 JSON。**不要另造 `paraIndex` 版本**。

### 裁决 3：`keep_both` 时第二条记录 id 由服务端生成

格式 `bm_` + uuid v4 去横线；响应返回完整两条记录，客户端以响应为准覆盖本地，
不得自行生成。

### 裁决 4：以数据库表为准

实体字段由 `server/sql/schema.sql` 反推。`T_Document` 外键叫 `owner_id`；
不建音频表；`T_Token` 不经 `DataAccessLibrary`；
`para_type`、`alt`、`server_received_at` 是建库时补的有效列，不要删。

### 其他关键取舍

- refreshToken 放 localStorage 是课程设计取舍；生产环境应放 httpOnly Cookie。
- 图片二进制不进导入请求，换取导入请求小、图片按需传输。
- 不引入 Redux / Zustand / Tailwind / UI 库；状态用 React 自带能力。
- 不做 OT / CRDT；冲突用「版本号 + 合并规则 + 用户裁决」处理。
- 增量同步目前每次整体比较所有书签，未做真正增量游标（见 system-develop 的已知限制）。

---

## 8. 非功能要求

### 性能与容量

| 项 | 指标 / 上限 |
|---|---|
| 长文档渲染 | 超过 150 段窗口化；500 段只渲染 25～38 个节点 |
| 图片缓存 | 单文档 300 张或总量 200MB，LRU |
| 音频缓存 | 单文档 60MB，LRU |
| 单次上传 | 500MB（`BODY_LIMIT` 与 `MAX_FILE_BYTES` 必须同值） |
| 正文规模 | `MAX_PARAGRAPHS = 20000` |
| 头像 | 2MB；png / jpg / webp |
| 单张图片 | 10MB |
| 阅读背景图 | 8MB，仅本机 |
| 请求超时 | 普通请求 15 秒；导入相关 300 秒；TTS 上游 20 秒 |
| TTS 并发 | 同时合成 2 个，排队 8 个，超限 429 |

### 安全

- 口令 scrypt 加盐哈希，不存明文；登录失败 5 次锁 15 分钟。
- 访问令牌 30 分钟；刷新令牌只存哈希、每次轮换。
- 所有资源接口校验属主；非属主返回 403，不存在返回 404。
- 图片回源只允许 http / https，拒绝私有网段与环回地址（防 SSRF）。
- 二进制上传校验类型白名单与大小。
- 前端不持有任何第三方服务密钥。
- 错误消息必须是中文，且不泄漏账号是否存在等可枚举信息。

### 兼容性

- 桌面浏览器，窗口宽度 ≥ 1280px；Chrome / Edge / Firefox / Safari 近年版本。
- Node.js 20 及以上；`better-sqlite3` 固定 `^12.11.1`（见 system-develop）。
- 端口：前端 5173、服务端 3000、Kokoro 8880。
