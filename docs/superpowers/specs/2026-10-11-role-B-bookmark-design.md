# 角色 B（书签与书架）迭代设计规格

- 日期：2026-10-11
- 分支：`V1.B`
- 依据：《迭代开发参考手册-第1组2026》§5–§7、§10、§12；《迭代任务书-B-书签与书架-第1组2026》
- 负责范围：书签的增删改查与排序、书架列表与分类、跨文档书签总览

---

## 1. 背景与目标

前六轮书签已能增删改查、软删除墓碑、参与冲突裁决，但还不好用：**不能排序、没有总览页、默认名是一串标识符**。本迭代把这三件事补上，共四项：

| 迭代项 | 轮次 | 目标 |
|---|---|---|
| B1 书签拖动排序 | 第一轮 | 加排序列 → 拖动排序 → 乐观更新 → 参与同步 |
| B3 书签列表分页与排序 | 第一轮 | 补分页，支持按创建时间 / 所属章节排序 |
| B2 跨文档书签总览 | 第二轮 | 新增跨文档查询接口，把「我的书签」做成真实页面 |
| B4 默认名「章节标题 + 首句片段」 | 第二轮 | 让默认名有实际含义 |

### 1.1 现状缺口（已核实）

- `T_Bookmark` 没有排序字段；`SELECT` 的默认顺序不可预期，跨端同步后顺序不一致。
- `GET /api/bookmarks`（契约 §7.4）**同时被界面列表与增量同步使用**，没有分页——与契约 §1「查询接口统一使用 page/pageSize」不一致。
- 书架「我的书签」分类（`LibraryView.tsx` 第 13 行 `category: 'bookmarked'`）筛选的是"有未删除书签的文档"，不是书签列表；服务端也没有跨文档书签接口。
- 书签默认名在 `ReaderView.tsx` 里写死为 `第 N 段`。
- 章节数据在数据库与接口里都不存在（`T_Paragraph` 无章节归属，无章节目录接口）。

---

## 2. 决策记录

以下四条为开工前与项目负责人确认的决策，后续实现不得偏离。

### 决策 1：`sort_order` 用稠密整数 `0,1,2…`

拖动后**整表重排**，在一次事务里提交全部受影响行。理由：序号跨端一定唯一、不重复，顺序确定；"两端同时拖动"的裁决最简单。验收只有 3 个书签，写放大可忽略。

**否决的方案**：留空隙 `10,20,30…`。虽然写入量小、并发冲突面小，但中点用尽需 rebalance，跨端合并更容易出现重复序号，裁决规则更复杂。

### 决策 2：`sort_order` 的合并规则为 `superseded`，不是 `keep_both`

两端同时拖动同一批书签时，**取较新者**，不保留两份。理由：`keep_both` 会为同一条书签造出重复副本，拖动场景下会产生成倍冗余。此条需与角色 A 确认并登记到手册附录 B。

### 决策 3：B3 的分页落在**新增的独立接口**上

保留 `GET /api/bookmarks`（契约 §7.4）的增量拉取语义不动，新增 `GET /api/bookmarks/page` 供界面分页排序。

**否决的方案**：直接给 §7.4 加 `page`/`pageSize`。契约 §1 规定 `pageSize` 默认 20，而不带分页参数的调用方（增量同步）会被默认值**静默截断到 20 条**——删除与变更拉不全且不报错，是隐性故障。该方案需角色 A 同步改代码，收益不抵风险。

### 决策 4：B4 用**做法一**（前端传章节标题）

给 `T_Bookmark` 追加一列 `chapter_title`；创建书签时由 `ReaderView` 从已加载的 `h1`/`h2` 段落算出章节标题一并上传。

**否决的方案**：做法二（给 `T_Paragraph` 加章节序号列 + 章节目录接口）。工作量大得多，且会牵动角色 C 的句子切分与角色 A 的锚点。此取舍需在提交信息中说明。

### 决策 5：本迭代不改 `server/src/sync/` 与 `routes/sync.ts`

`/api/sync` 的 bookmarks 三集合暂不携带 `sortOrder`（属角色 A 第二轮"真增量同步游标"的范围）。跨端顺序一致性由服务端列表接口保证。

---

## 3. 数据模型变更

### 3.1 `server/sql/schema.sql`（仅追加）

在 `T_Bookmark` 的 `CREATE TABLE` 中追加两列，并追加一条索引：

```sql
CREATE TABLE IF NOT EXISTS T_Bookmark (
  bookmark_id TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES T_User(user_id) ON DELETE CASCADE,
  doc_id      TEXT NOT NULL REFERENCES T_Document(doc_id) ON DELETE CASCADE,
  anchor_json TEXT NOT NULL,
  name        TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  -- ★ B1 追加：同文档内排序位，稠密整数 0,1,2…（决策 1）
  sort_order    INTEGER NOT NULL DEFAULT 0,
  -- ★ B4 追加：书签所在章节标题（决策 4）；B2 的"所属章节"复用它
  chapter_title TEXT
);
CREATE INDEX IF NOT EXISTS ix_bookmark_order
  ON T_Bookmark(user_id, doc_id, sort_order);
```

**不改动任何已有列定义**，不新增表，不改 `src/db.ts`。

### 3.2 已有库的迁移方式

`initDb()` 只执行 `schema.sql`，而其中全是 `CREATE ... IF NOT EXISTS`——追加列**不会**作用于已存在的库。按手册 §12 完成定义第 5 条，迁移路径为：

```bash
cd server && npm run db:reset && npm run seed
```

### 3.3 `sql/seed.ts`（追加）

按任务书第 4 节要求，追加**一本带 50 个书签的书**，供角色 D 的测试复用。该书：40 段正文、含 3 个 `h2` 标题段、50 个书签分布于不同章节，`sort_order` 为 0–49。

---

## 4. 接口变更

三个新增接口 + 一个向后兼容的可选字段追加。**`GET /api/bookmarks` 不变。**

所有错误仍走统一信封 `{code, message, details, requestId}`，`message` 为中文。

### 4.1 `POST /api/bookmarks/reorder`（新增，B1）

整表重排：**一个事务，全成功或全失败**（任务书 §B1 坑 3：不接受版本冲突时的部分成功）。

请求：

```json
{
  "docId": "doc_5b7e",
  "items": [
    { "bookmarkId": "bm_9d2f...", "sortOrder": 0, "baseVersion": 3 },
    { "bookmarkId": "bm_51aa...", "sortOrder": 1, "baseVersion": 1 }
  ],
  "updatedAt": "2026-10-11T10:00:00.000Z"
}
```

`200`：

```json
{ "docId": "doc_5b7e", "applied": 2, "items": [ { "bookmarkId": "...", "sortOrder": 0, "version": 4 } ] }
```

`409 SYNC_VERSION_CONFLICT`：任一条 `baseVersion` 不匹配 → **整体回滚，一条都不落库**，`details.conflict.key` 指出是哪条书签。

`400 VALIDATION_FAILED`：`items` 为空、`items` 中存在重复 `bookmarkId`、或书签不属于该 `docId` / 该用户。

### 4.2 `GET /api/bookmarks/page`（新增，B3）

```
?docId=doc_5b7e&sort=order|createdAt|chapter&order=asc|desc&page=1&pageSize=20
```

- `sort` 默认 `order`（即 `sort_order`，拖动后的顺序）；`createdAt` 按创建时间；`chapter` 按 `chapter_title`（`chapter_title` 为空的排在最后）。
- `page` 从 1 起，`pageSize` 默认 20、上限 100（契约 §1）。
- 只返回未删除的书签。

`200`：

```json
{
  "total": 50, "page": 1, "pageSize": 20,
  "items": [
    { "bookmarkId": "bm_9d2f...", "docId": "doc_5b7e", "name": "卷一 · 词以境界为最上",
      "anchor": { "chapterIndex": 0, "paragraphIndex": 1, "sentenceIndex": 0, "charOffset": 0, "scrollOffset": 0 },
      "sortOrder": 0, "chapterTitle": "人间词话 · 卷一",
      "version": 3, "createdAt": "...", "updatedAt": "..." }
  ]
}
```

### 4.3 `GET /api/bookmarks/overview`（新增，B2）

跨文档书签总览，按文档分组。

```
?page=1&pageSize=20
```

`200`：

```json
{
  "total": 4, "page": 1, "pageSize": 20,
  "groups": [
    { "docId": "doc_5b7e", "docTitle": "人间词话", "bookmarkCount": 2,
      "items": [ { "bookmarkId": "...", "name": "...", "anchor": {...},
                   "sortOrder": 0, "chapterTitle": "人间词话 · 卷一",
                   "createdAt": "...", "updatedAt": "..." } ] }
  ]
}
```

- `total` 是**书签总数**，分页作用于书签；分组在分页结果内进行。
- 文档组按组内最近 `updated_at` 降序。
- 若 `chapterTitle` 为空（B4 之前的旧数据），前端降级显示"文档名 + 段落序号"。

### 4.4 `POST /api/bookmarks`（追加可选字段）

请求体新增两个**可选**字段，不改变原有字段语义：

- `sortOrder?: number` —— 不传时服务端分配 `max(sort_order) + 1`（追加到末尾）。
- `chapterTitle?: string | null` —— B4 的章节标题。

响应体追加 `sortOrder`，其余不变（仍为 `{bookmarkId, version, name}` + `sortOrder`）。

### 4.5 契约文档同步

`.context/07-接口契约.md` 追加 §7.5（分页列表）、§7.6（跨文档总览）、§7.7（拖动排序）；并给 §7.4 补一句说明：**该接口只用于增量同步，界面列表请用 §7.5**。

---

## 5. B1 拖动排序的实现设计

### 5.1 服务端

**`server/src/dao/index.ts`**（需协商文件，按手册 §7.2 模块分区追加、不重排已有方法）：

- `BookmarkRow` 追加 `sort_order: number`、`chapter_title: string | null`。
- `insertBookmark` 的列清单追加两列。
- `updateBookmarkIfVersion` / `forceUpdateBookmark` 的 `fields` 追加可选的 `sort_order`、`chapter_title`。
- 新增方法：
  - `listBookmarksPaged(userId, docId, sort, order, page, pageSize): { total, rows }`
  - `listBookmarksOverview(userId, page, pageSize): { total, rows }`（跨文档，带文档标题）
  - `nextSortOrder(userId, docId): number`

> 书签数量统计**复用已有的 `countBookmarksByDocument`**（`dao/index.ts:725`），不新增。

> 手册 §7.2 把 `dao/index.ts` 列为需协商文件。本次改动为**纯追加**，不触碰已有方法签名。

**`server/src/routes/bookmarks.ts`**（可改文件）：

- 新增 `POST /api/bookmarks/reorder`：用 `db.transaction(...)` 包裹全部 `updateBookmarkIfVersion` 调用，任一条返回 false 即抛错回滚。
- 新增 `GET /api/bookmarks/page`、`GET /api/bookmarks/overview`。
- 新增本地 DTO 映射函数（`bookmarkListDto(row)`），**不修改 `server/src/sync/service.ts` 的 `bookmarkToDto`**——该文件在禁区。
- `POST /api/bookmarks` 接受 `sortOrder`、`chapterTitle`。

### 5.2 客户端

**`client/src/api/client.ts`**（需协商文件，纯追加）：

- `BookmarkDto` 追加 `sortOrder: number`、`chapterTitle: string | null`。
- 新增 `listBookmarksPaged`、`listBookmarksOverview`、`reorderBookmarks`。
- `BookmarkPayload` 追加可选的 `sortOrder`、`chapterTitle`。

**`client/src/features/sync/useBookmarks.ts`**（可改文件）：

- `reload()` 改调 `api.listBookmarksPaged`（默认 `sort=order`），得到带 `sortOrder` 的列表。
- 新增 `reorder(orderedIds: string[])`：
  1. **乐观更新**：先把 `items` 按新顺序重排并渲染；
  2. 发 `POST /api/bookmarks/reorder`，`baseVersion` 取本地各项当前版本；
  3. 成功 → 用响应里的新版本号回写本地；
  4. 失败或 409 → **回滚到服务端顺序**并 `reload()`，把原因写进 `error`。

**`client/src/pages/ReaderView.tsx`**（可改文件）：

- 书签面板每条加拖动手柄。
- **手写 pointer 事件**，不用 HTML5 drag & drop（触控设备与 jsdom 都不友好）：
  - `onPointerDown` → 记录起点 + `setPointerCapture`；
  - `onPointerMove` → 超过 4px 阈值后进入拖动态，按各条 `offsetHeight` 与指针 y 坐标算出目标下标，实时重排本地预览；
  - `onPointerUp` → 计算最终顺序，调 `bms.reorder(...)`；`Escape` 取消并还原。
- 拖动期间给被拖项加 `.mark-dragging` 类，其余项加过渡动画。

**可访问性**：每条同时提供「上移／下移」按钮，无鼠标也能排序，并便于自动化验收。

**`client/src/app.css`**（末尾追加）：拖动相关样式。不引入 UI 库，不重排已有规则。

---

## 6. B3 分页与排序

- 服务端：§4.2 的新接口。
- `ReaderView` 书签面板底部加翻页控件（「上一页 / 第 x/y 页 / 下一页」）。
- `sql/seed.ts` 加 50 书签的书（§3.3）。

验收：一本有 50 个书签的文档，列表接口按页返回，翻页正确。

---

## 7. B2 跨文档书签总览

- 服务端：§4.3 的新接口。
- `LibraryView.tsx`：`nav === 'bookmarks'` 时**不再走文档列表**，改渲染书签总览：
  - 按文档分组（组头显示书名与书签数）；
  - 每条显示：名称 / 所属章节 `chapterTitle`（缺失时降级为"文档名 + 段落序号"）/ 创建时间 / 段落序号；
  - 点击一条 → `navigate('/read/{docId}?para={paragraphIndex}')`。
- `ReaderView.tsx`：读取 `?para=` 查询参数，加载完成后 `gotoParagraph(paraIndex)` 一次（用 ref 标记，只跳一次，不覆盖后续滚动）。

验收：给两本书各加 2 个书签 → 进「我的书签」看到两组共 4 条 → 点其中一条能跳到正确文档的正确位置。

---

## 8. B4 默认名「章节标题 + 首句片段」

**不需要动解析层**：`ReaderView` 已通过 `api.getContent` 拿到带 `type: 'h1' | 'h2'` 的 `paragraphs`。

- **章节标题** = 锚点段落（`paragraphIndex`）**之前最近的一个 `h1`/`h2` 段落的文本**；若之前没有标题段，则取文档里第一个标题段；仍无则用书名。
- **首句片段** = 锚点段落经 `splitSentences` 切分后的第一句，截断到 20 字（超出加 `…`）。
- **默认名** = `` `${chapterTitle} · ${firstSentenceFragment}` ``，形如 `人间词话 · 卷一 · 词以境界为最上`。
- 创建书签时把 `chapterTitle` 一并上传，落进新列。
- 保留**可选名称输入框**（`.context/08-书签补充.md` §2.3 要求"可填写书签名称，未填写时以此默认"）：面板的「加当前位置」改为展开一个小输入框，留空即用默认名。

验收：新建书签时，名称自动是「章节标题 + 首句片段」的形式，而不是标识符。

**取舍说明（需写进提交信息）**：未做做法二（`T_Paragraph` 加章节序号列 + 章节目录接口），因为工作量大得多且会牵动角色 C 的句子切分与角色 A 的锚点；本章节标题由前端从已有的标题段推导，足以满足本迭代的默认名与总览展示需求。

---

## 9. 同步边界与登记

### 9.1 与角色 A 的交叉点

- `sort_order` 自动进入增量同步范围——本轮**只落列与写路径**，`/api/sync` 的合并逻辑不改（决策 5）。
- **合并规则约定为 `superseded`**（决策 2），登记进手册附录 B。
- 跨端顺序一致性由 `GET /api/bookmarks/page` 保证：两台设备都从服务端按 `sort_order` 取，顺序必然一致。

### 9.2 登记产物

- 新建 `docs/迭代登记-B.md`：记录附录 A（表结构变更）与附录 B（接口变更）的登记行，格式与手册一致，**可直接粘贴进 docx**。
- 更新 `.context/07-接口契约.md`（§4.5）。
- 更新 `CLAUDE.md` 的"当前进度"，**追加自己那一条，不删别人的**。

---

## 10. 验收标准（完成定义）

按手册 §12 六条：

1. 代码实现完成，`npm run server` 与 `npm run dev` 都能起来。
2. 服务端 `npm run typecheck` 无错误。
3. 按任务书里的验收步骤**实际走一遍**，结果写进提交信息。
4. 接口变更已同步 `.context/07-接口契约.md`。
5. `schema.sql` 与 `sql/seed.ts` 已同步，`npm run db:reset && npm run seed` 能重建成功。
6. `CLAUDE.md` 的"当前进度"已更新。

### 10.1 逐项验收清单

**B1**：同一文档内把 3 个书签拖成新顺序 → 刷新页面顺序保持 → 另一台设备（隐身窗口，另一 `deviceId`）同步后顺序一致。

**B3**：一本有 50 个书签的文档，列表接口按页返回，翻页正确。

**B2**：给两本书各加 2 个书签 → 进「我的书签」看到两组共 4 条 → 点其中一条能跳到正确文档的正确位置。

**B4**：新建书签时名称自动是「章节标题 + 首句片段」形式。

### 10.2 提交节奏

按 `B1 → B3 → B2 → B4` 顺序，**每项单独提交**，做完即报告，提交信息写清做了什么与验证结果。

---

## 11. 文件清单

### 可改（白名单）

| 文件 | 改动 |
|---|---|
| `server/sql/schema.sql` | 追加 2 列 + 1 索引 |
| `server/src/routes/bookmarks.ts` | 3 个新接口 + POST 追加字段 + 本地 DTO |
| `client/src/features/sync/useBookmarks.ts` | `reorder` + 切换分页接口 |
| `client/src/pages/LibraryView.tsx` | 「我的书签」真实页面 |
| `client/src/pages/ReaderView.tsx` | 拖动、分页控件、默认名、`?para=` 定位 |
| `server/sql/seed.ts` | 50 书签的演示书 |

### 需协商（本次为纯追加，不重排已有定义）

| 文件 | 改动 |
|---|---|
| `server/src/dao/index.ts` | `BookmarkRow` 加 2 字段；3 个新查询方法；insert/update 带新列 |
| `client/src/api/client.ts` | 追加 3 个 API 与 DTO 字段 |

**`client/src/models/types.ts` 本轮不改。** 新增的书签类型（总览分组、分页响应）全部放在 `api/client.ts` —— 书签的既有类型 `BookmarkDto` / `BookmarkPayload` / `ConflictEnvelope` 本来就在那里，跟着放不必动共享文件，少一次协商。

### 其他

| 文件 | 改动 |
|---|---|
| `client/src/app.css` | 末尾追加拖动与分组样式 |
| `.context/07-接口契约.md` | §7.5 / §7.6 / §7.7，§7.4 补说明 |
| `CLAUDE.md` | 「当前进度」追加角色 B 一条 |
| `docs/迭代登记-B.md` | 新建，附录 A/B 登记行 |

### 不碰

`server/src/sync/`、`server/src/routes/sync.ts`、`client/src/features/readalong/`、`client/src/features/parse/`、`client/src/features/render/`、`server/src/db.ts`、`client/src/models/types.ts`、`client/src/features/sync/useProgress.ts`、`server/src/routes/documents.ts`。

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 拖动排序在 `ReaderView.tsx`（412 行，全项目最大页面）里改动面大 | 拖动逻辑单独抽成 `client/src/pages/` 内的一个 hook/组件；`ReaderView` 只接线 |
| 乐观更新失败后顺序错乱 | 失败即 `reload()` 回滚到服务端真值，并提示原因；不留半吊子状态 |
| `chapter_title` 为空的旧数据 | 前端所有展示点降级到"文档名 + 段落序号" |
| 加列后旧库读不到新列 | 明确迁移路径 `npm run db:reset && npm run seed`；写入提交信息与登记 |
| 触碰 `sync/service.ts` 的 `bookmarkToDto` | 本轮**不改**该文件；列表 DTO 在 `routes/bookmarks.ts` 内本地实现 |
| `?para=` 定位与"恢复到上次阅读位置"打架 | `?para=` 优先级更高，用 ref 保证只跳一次，之后不再干预滚动 |
