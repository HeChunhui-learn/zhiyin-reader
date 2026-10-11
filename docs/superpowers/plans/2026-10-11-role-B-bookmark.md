# 角色 B（书签与书架）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给知音漫卷的书签补上拖动排序、分页与排序、跨文档总览、以及「章节标题 + 首句片段」的默认名，四项按 B1 → B3 → B2 → B4 顺序各自单独提交。

**Architecture:** 表结构在 `schema.sql` 末尾追加两列（`sort_order` 稠密整数、`chapter_title`）；排序与总览走**新增**的三个接口，契约 §7.4 的 `GET /api/bookmarks` 一个字不动，角色 A 的增量同步不受影响；拖动排序用手写 pointer 事件 + 乐观更新，整表重排在服务端一个事务里全成功或全失败。

**Tech Stack:** 前端 React 18 + Vite + TypeScript（无 UI 组件库，普通 CSS）；后端 Node 20 + TypeScript + Fastify 4 + better-sqlite3。

**Spec:** `docs/superpowers/specs/2026-10-11-role-B-bookmark-design.md`

## Global Constraints

以下取自规格文档与《迭代开发参考手册》，**每个任务都隐含包含本节**：

- **不引入任何新依赖**，不引入 UI 组件库、不引入 Redux 等状态库。
- **不写单元测试框架**（CLAUDE.md「不做的事」）。测试套件归角色 D 的 D2。本计划每个任务用**可复现的验证命令 + 预期输出**替代红绿循环：先跑一遍确认当前确实失败/缺列，再实现，再跑确认通过，最后提交。
- **文件白名单**（手册 §6、任务书 §3）。可改：`server/sql/schema.sql`（仅追加）、`server/src/routes/bookmarks.ts`、`client/src/features/sync/useBookmarks.ts`、`client/src/pages/LibraryView.tsx`、`client/src/pages/ReaderView.tsx`。需协商（本次均为纯追加、不重排已有定义）：`server/src/dao/index.ts`、`client/src/api/client.ts`。其他：`client/src/app.css`、`server/sql/seed.ts`。
- **绝对不碰**：`server/src/sync/`、`server/src/routes/sync.ts`、`client/src/features/readalong/`、`client/src/features/parse/`、`client/src/features/render/`、`server/src/db.ts`、`client/src/models/types.ts`、`client/src/features/sync/useProgress.ts`、`server/src/routes/documents.ts`。
- **错误信封**：一律 `{ code, message, details, requestId }`，`message` 必须是中文；响应头带 `X-Request-Id`。
- **分页约定**（契约 §1）：`page` 从 1 起，`pageSize` 默认 20、上限 100，响应含 `total`/`page`/`pageSize`。
- **术语**：`bookmarkId`、`docId`、`anchor`、`deviceId`、`chapterIndex`/`paragraphIndex`/`sentenceIndex`/`charOffset`/`scrollOffset`。不要造 `paraIndex` 版本。
- **代码风格**：不用分号，单引号，2 空格缩进，注释用中文，与现有文件一致。
- **每任务提交前必须**：`cd server && npm run typecheck` 无错误；`npm run server`（3000）与 `npm run dev`（5173）能同时起来。
- **提交信息**写清做了什么与验证结果。
- 演示账号：`demo@example.com` / `demo12345`；演示书 `doc_renjian`（《人间词话》17 段）。

## 文件结构

**修改**

| 文件 | 职责 | 改动 |
|---|---|---|
| `server/sql/schema.sql` | 建库脚本 | `T_Bookmark` 追加 2 列 + 1 索引 |
| `server/sql/seed.ts` | 种子数据 | 追加一本带 50 个书签的书 |
| `server/src/dao/index.ts` | 唯一数据访问入口 | `BookmarkRow` 加 2 可选字段；6 个新方法；写入路径带上新列 |
| `server/src/routes/bookmarks.ts` | 书签接口 | 新增 4 个接口；`POST /api/bookmarks` 追加可选字段；本地 DTO |
| `client/src/api/client.ts` | 前端请求封装 | 追加 4 个 API 函数与 DTO 字段 |
| `client/src/features/sync/useBookmarks.ts` | 书签读写 Hook | `reorder`、分页、排序、总览 |
| `client/src/pages/BookmarkPanel.tsx` | **新建**：书签面板 | 列表、拖动、分页、重命名、删除 |
| `client/src/pages/ReaderView.tsx` | 阅读界面 | 接入面板、`?para=` 定位、默认名 |
| `client/src/pages/LibraryView.tsx` | 书架界面 | 「我的书签」真实页面 |
| `client/src/app.css` | 样式 | 末尾追加拖动、分组、翻页样式 |
| `.context/07-接口契约.md` | 接口契约 | 追加 §7.5 / §7.6 / §7.7，§7.4 补说明 |
| `CLAUDE.md` | 项目约定 | 「当前进度」追加角色 B 一条 |
| `docs/迭代登记-B.md` | **新建**：登记表 | 附录 A / 附录 B 的登记行 |

**新建的文件只有两个**（`BookmarkPanel.tsx`、`docs/迭代登记-B.md`），其余都是追加式修改。把书签面板抽成独立文件，是因为 `ReaderView.tsx` 已经是全项目最大的页面文件（459 行），拖动逻辑再塞进去会让它无法一次读完。

**关于 `BookmarkRow` 新字段必须是可选的**——这是本计划最关键的一条实现约束：

`server/src/sync/service.ts`（**禁区**）里有三处构造 `BookmarkRow` 字面量（`insertBookmark` 的入参、`keep_both` 的 `copy`）。如果把 `sort_order`/`chapter_title` 定义为必填，该文件立刻编译不过，而我们不许改它。所以：

1. `BookmarkRow` 的新字段定义为**可选**（`sort_order?: number`、`chapter_title?: string | null`）。
2. `insertBookmark` 内部兜底：`sort_order` 缺省时取 `nextSortOrder(user_id, doc_id)`（追加到末尾），`chapter_title` 缺省时为 `null`。这样经 `/api/sync` 创建的书签也会拿到合理序号，不需要改禁区文件。
3. `POST /api/bookmarks` 要写 `chapter_title` 时，用新增的 `setBookmarkMeta`（**不递增版本号、不动 `updated_at`**），避免新书签的 `version` 从契约 §7.1 要求的 1 变成 2。

---

### Task 1: 表结构追加两列

**Files:**
- Modify: `server/sql/schema.sql`（`T_Bookmark` 建表段）
- Create: `docs/迭代登记-B.md`

**Interfaces:**
- Consumes: 无
- Produces: `T_Bookmark.sort_order INTEGER NOT NULL DEFAULT 0`、`T_Bookmark.chapter_title TEXT`、索引 `ix_bookmark_order`。后续所有任务依赖这两列存在。

- [ ] **Step 1: 先确认当前确实没有这两列**

```bash
cd server && npm run db:reset && npm run seed
node -e "const D=require('better-sqlite3');const db=new D('data/zhiyin.db');console.log(db.prepare('PRAGMA table_info(T_Bookmark)').all().map(c=>c.name).join(','))"
```

Expected: 输出里**没有** `sort_order`，也**没有** `chapter_title`。（若 `node -e` 因 esm/路径不便，改用 `npx tsx -e` 或直接在 `sqlite3` 里看 `PRAGMA table_info(T_Bookmark);`——关键是确认两列不存在。）

- [ ] **Step 2: 在 `schema.sql` 的 `T_Bookmark` 建表段末尾追加两列**

把 `T_Bookmark` 的 `CREATE TABLE` 改为（**只动这一个表，其余一律不碰**）：

```sql
CREATE TABLE IF NOT EXISTS T_Bookmark (
  bookmark_id TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES T_User(user_id) ON DELETE CASCADE,
  doc_id      TEXT NOT NULL REFERENCES T_Document(doc_id) ON DELETE CASCADE,
  anchor_json TEXT NOT NULL,            -- Anchor 结构的 JSON 串
  name        TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,                     -- 软删除墓碑，非空表示已删除
  -- ★ 追加列 B1：同文档内排序位，稠密整数 0,1,2…（角色 B 迭代，附录 A 已登记）
  sort_order    INTEGER NOT NULL DEFAULT 0,
  -- ★ 追加列 B4：书签所在章节标题；B2 的"所属章节"复用它
  chapter_title TEXT
);
CREATE INDEX IF NOT EXISTS ix_bookmark_sync
  ON T_Bookmark(user_id, doc_id, updated_at);
-- ★ 追加索引 B1：按拖动顺序取列表
CREATE INDEX IF NOT EXISTS ix_bookmark_order
  ON T_Bookmark(user_id, doc_id, sort_order);
```

同时把文件头部注释里"与 04 §4.3.1 的差异（仅一处…）"那句更新为"差异共三处"，并补一句说明本表新增的两列。

- [ ] **Step 3: 重建并确认两列已存在**

```bash
cd server && npm run db:reset && npm run seed
node -e "const D=require('better-sqlite3');const db=new D('data/zhiyin.db');console.log(db.prepare('PRAGMA table_info(T_Bookmark)').all().map(c=>c.name).join(','))"
```

Expected: 输出包含 `sort_order,chapter_title`；`npm run seed` 报"已灌入演示数据"。

- [ ] **Step 4: 建登记文件（附录 A 第一行）**

创建 `docs/迭代登记-B.md`：

```markdown
# 角色 B 迭代登记（可直接粘贴进《迭代开发参考手册》附录 A / 附录 B）

## 附录 A —— 表结构变更

| 日期 | 角色 | 变更 | 原因 |
|---|---|---|---|
| 2026-10-11 | B | `T_Bookmark` 追加 `sort_order INTEGER NOT NULL DEFAULT 0` | B1 书签拖动排序：同文档内排序位，稠密整数 0,1,2… |
| 2026-10-11 | B | `T_Bookmark` 追加 `chapter_title TEXT` | B4 书签默认名「章节标题 + 首句片段」；B2 的"所属章节"复用该列 |
| 2026-10-11 | B | 追加索引 `ix_bookmark_order (user_id, doc_id, sort_order)` | B1 按拖动顺序取列表 |

## 附录 B —— 接口变更

| 日期 | 角色 | 接口 | 变更 | 兼容性 |
|---|---|---|---|---|
| （后续任务逐行追加） | | | | |

## 与角色 A 的约定（sort_order 合并规则）

- **编号策略**：稠密整数 `0,1,2…`，拖动后整表重排，一次事务提交全部受影响行。
- **合并规则**：两端同时拖动同一批书签时走 **`superseded`**（取较新者），**不是 `keep_both`**。
  理由：`keep_both` 会为同一条书签造出重复副本，拖动场景下会产生成倍冗余。
- **本轮范围**：只在服务端落列与写路径；`/api/sync` 的 bookmarks 三集合暂不携带 `sortOrder`
  （属角色 A 第二轮"真增量同步游标"的范围）。跨端顺序一致性由 `GET /api/bookmarks/page` 保证：
  两台设备都按 `sort_order` 从服务端取，顺序必然一致。
- 新增列需 `cd server && npm run db:reset && npm run seed` 重建，已在提交信息中说明。
```

- [ ] **Step 5: 提交**

```bash
git add server/sql/schema.sql docs/迭代登记-B.md
git commit -m "feat(B1): T_Bookmark 追加 sort_order 与 chapter_title

B1 书签拖动排序的前置：同文档内排序位列 + 章节标题列（后者同时供 B4 默认名
与 B2 总览的"所属章节"使用），并追加 ix_bookmark_order 索引。

验证：npm run db:reset && npm run seed 重建成功；PRAGMA table_info(T_Bookmark)
确认新列存在。登记行已写入 docs/迭代登记-B.md 附录 A。"
```

---

### Task 2: DAO 层 —— 新字段与排序方法

**Files:**
- Modify: `server/src/dao/index.ts`（`BookmarkRow` 定义段、`insertBookmark`、`updateBookmarkIfVersion`、`forceUpdateBookmark`、新增 6 个方法）

**Interfaces:**
- Consumes: Task 1 的两列。
- Produces（后续任务按这些签名调用）：
  - `BookmarkRow` 新增可选字段 `sort_order?: number`、`chapter_title?: string | null`
  - `nextSortOrder(userId: string, docId: string): number`
  - `setBookmarkMeta(bookmarkId: string, fields: { sort_order?: number; chapter_title?: string | null }): void`
  - `listBookmarksPaged(userId, docId, sort: 'order'|'createdAt'|'chapter', order: 'asc'|'desc', page: number, pageSize: number): { total: number; rows: BookmarkRow[] }`
  - `reorderBookmarks(userId, docId, items: { bookmarkId: string; sortOrder: number; baseVersion: number }[], updatedAt: string): { ok: true; rows: BookmarkRow[] } | { ok: false; failedId: string; serverVersion: number }`
  - `listBookmarkedDocuments(userId: string, page: number, pageSize: number): { total: number; docs: { doc_id: string; doc_title: string | null; file_name: string }[] }`
  - `listBookmarksByDocIds(userId: string, docIds: string[]): BookmarkRow[]`

- [ ] **Step 1: 先确认这些方法都不存在**

Run: `cd server && npx tsc --noEmit` （当前应无错误）
Grep: `listBookmarksPaged|reorderBookmarks|nextSortOrder|setBookmarkMeta|listBookmarkedDocuments|listBookmarksByDocIds` in `server/src/dao/index.ts`
Expected: 0 命中。这是本任务的"红灯"——这些能力尚不存在。

- [ ] **Step 2: `BookmarkRow` 追加可选字段**

```ts
export interface BookmarkRow {
  bookmark_id: string
  user_id: string
  doc_id: string
  anchor_json: string
  name: string | null
  version: number
  created_at: string
  updated_at: string
  deleted_at: string | null
  /** ★ B1：同文档内排序位。**可选**——server/src/sync/service.ts（禁区）构造的行字面量
   *  不带它，缺省时由 insertBookmark 兜底分配 max+1，见下方注释 */
  sort_order?: number
  /** ★ B4：书签所在章节标题。同样可选，理由同上 */
  chapter_title?: string | null
}
```

- [ ] **Step 3: `insertBookmark` 带上新列并兜底分配序号**

```ts
  /**
   * 新列兜底：sort_order 缺省时追加到末尾（max+1），chapter_title 缺省为 null。
   *
   * 为什么是兜底而不是必填：server/src/sync/service.ts 在**禁区**里，它构造 BookmarkRow
   * 字面量时不带这两个字段。做成可选 + 此处兜底，既不改禁区文件，又让经 /api/sync
   * 创建的书签拿到合理序号（而不是全部挤在 0）。
   */
  insertBookmark(row: BookmarkRow): void {
    const sortOrder = row.sort_order ?? this.nextSortOrder(row.user_id, row.doc_id)
    getDb()
      .prepare(
        `INSERT INTO T_Bookmark
           (bookmark_id, user_id, doc_id, anchor_json, name, version, created_at, updated_at,
            deleted_at, sort_order, chapter_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.bookmark_id, row.user_id, row.doc_id, row.anchor_json, row.name,
        row.version, row.created_at, row.updated_at, row.deleted_at,
        sortOrder, row.chapter_title ?? null,
      )
  }
```

- [ ] **Step 4: 两个无条件/条件更新方法带上新列**

`updateBookmarkIfVersion` 与 `forceUpdateBookmark` 的 `fields` 参数各追加两个可选键，写法与既有的 `anchor_json`/`name` 一致：

```ts
      /** ★ B1 */
      sort_order?: number
      /** ★ B4 */
      chapter_title?: string | null
```

并在方法体内、`params.push(bookmarkId, baseVersion)` **之前**追加：

```ts
    if (fields.sort_order !== undefined) {
      sets.push('sort_order = ?')
      params.push(fields.sort_order)
    }
    if (fields.chapter_title !== undefined) {
      sets.push('chapter_title = ?')
      params.push(fields.chapter_title)
    }
```

- [ ] **Step 5: 在 `/* ---- 书签（契约 §7） ---- */` 分区内追加 6 个新方法**

按手册 §7.2「按模块分区追加方法，不要重排已有方法」，全部追加在 `countBookmarksByDocument` 之后、类的收尾 `}` 之前：

```ts
  /** B1：下一篇书签的排序位（同文档内 max+1，即追加到末尾） */
  nextSortOrder(userId: string, docId: string): number {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS m FROM T_Bookmark
          WHERE user_id = ? AND doc_id = ?`,
      )
      .get(userId, docId) as { m: number }
    return row.m + 1
  }

  /**
   * B4：创建书签时补写 chapter_title（以及可选的 sort_order）。
   * **不递增 version、不动 updated_at** —— 契约 §7.1 要求新建书签的 version 为 1，
   * 走 updateBookmarkIfVersion 会把它顶成 2。
   */
  setBookmarkMeta(
    bookmarkId: string,
    fields: { sort_order?: number; chapter_title?: string | null },
  ): void {
    const sets: string[] = []
    const params: unknown[] = []
    if (fields.sort_order !== undefined) {
      sets.push('sort_order = ?')
      params.push(fields.sort_order)
    }
    if (fields.chapter_title !== undefined) {
      sets.push('chapter_title = ?')
      params.push(fields.chapter_title)
    }
    if (sets.length === 0) return
    params.push(bookmarkId)
    getDb()
      .prepare(`UPDATE T_Bookmark SET ${sets.join(', ')} WHERE bookmark_id = ?`)
      .run(...params)
  }

  /**
   * B3：分页列表。sort 取白名单值，不做字符串拼接注入。
   * chapter 排序时 chapter_title 为空的（B4 之前的旧数据）固定排最后，不随 order 翻转。
   */
  listBookmarksPaged(
    userId: string,
    docId: string,
    sort: 'order' | 'createdAt' | 'chapter',
    order: 'asc' | 'desc',
    page: number,
    pageSize: number,
  ): { total: number; rows: BookmarkRow[] } {
    const total = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM T_Bookmark
            WHERE user_id = ? AND doc_id = ? AND deleted_at IS NULL`,
        )
        .get(userId, docId) as { n: number }
    ).n

    const col =
      sort === 'createdAt' ? 'created_at' : sort === 'chapter' ? 'chapter_title' : 'sort_order'
    const dir = order === 'desc' ? 'DESC' : 'ASC'
    const nullsLast = sort === 'chapter' ? ', (chapter_title IS NULL) ASC' : ''

    const rows = getDb()
      .prepare(
        `SELECT * FROM T_Bookmark
          WHERE user_id = ? AND doc_id = ? AND deleted_at IS NULL
          ORDER BY ${col} ${dir}${nullsLast}, bookmark_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(userId, docId, pageSize, (page - 1) * pageSize) as BookmarkRow[]

    return { total, rows }
  }

  /**
   * B1：整表重排。**一个事务，任一条版本不匹配即整体回滚**（任务书 §B1 坑 3：
   * 不接受版本冲突时的部分成功）。
   *
   * better-sqlite3 的 transaction() 在回调抛错时自动 ROLLBACK，所以判冲突直接抛。
   */
  reorderBookmarks(
    userId: string,
    docId: string,
    items: { bookmarkId: string; sortOrder: number; baseVersion: number }[],
    updatedAt: string,
  ):
    | { ok: true; rows: BookmarkRow[] }
    | { ok: false; failedId: string; serverVersion: number } {
    const db = getDb()

    const update = db.prepare(
      `UPDATE T_Bookmark
          SET sort_order = ?, version = version + 1, updated_at = ?
        WHERE bookmark_id = ? AND user_id = ? AND doc_id = ?
          AND version = ? AND deleted_at IS NULL`,
    )

    const run = db.transaction(() => {
      for (const it of items) {
        const r = update.run(it.sortOrder, updatedAt, it.bookmarkId, userId, docId, it.baseVersion)
        if (r.changes === 0) {
          const cur = db
            .prepare('SELECT version FROM T_Bookmark WHERE bookmark_id = ?')
            .get(it.bookmarkId) as { version: number } | undefined
          throw Object.assign(new Error('reorder conflict'), {
            failedId: it.bookmarkId,
            serverVersion: cur?.version ?? 0,
          })
        }
      }
    })

    try {
      run()
    } catch (e) {
      const err = e as { failedId?: string; serverVersion?: number }
      if (err.failedId) {
        return { ok: false, failedId: err.failedId, serverVersion: err.serverVersion ?? 0 }
      }
      throw e
    }

    return {
      ok: true,
      rows: items.map((it) => this.getBookmarkById(it.bookmarkId)!),
    }
  }

  /** B2：有未删除书签的文档，按组内最近更新时间降序，分页作用于**文档** */
  listBookmarkedDocuments(
    userId: string,
    page: number,
    pageSize: number,
  ): { total: number; docs: { doc_id: string; doc_title: string | null; file_name: string }[] } {
    const total = (
      getDb()
        .prepare(
          `SELECT COUNT(DISTINCT doc_id) AS n FROM T_Bookmark
            WHERE user_id = ? AND deleted_at IS NULL`,
        )
        .get(userId) as { n: number }
    ).n

    const docs = getDb()
      .prepare(
        `SELECT b.doc_id AS doc_id, d.title AS doc_title, d.file_name AS file_name
           FROM T_Bookmark b
           JOIN T_Document d ON d.doc_id = b.doc_id
          WHERE b.user_id = ? AND b.deleted_at IS NULL
          GROUP BY b.doc_id
          ORDER BY MAX(b.updated_at) DESC, b.doc_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(userId, pageSize, (page - 1) * pageSize) as {
      doc_id: string
      doc_title: string | null
      file_name: string
    }[]

    return { total, docs }
  }

  /** B2：取这批文档的全部未删除书签，按文档 + 拖动顺序排 */
  listBookmarksByDocIds(userId: string, docIds: string[]): BookmarkRow[] {
    if (docIds.length === 0) return []
    const placeholders = docIds.map(() => '?').join(', ')
    return getDb()
      .prepare(
        `SELECT * FROM T_Bookmark
          WHERE user_id = ? AND deleted_at IS NULL AND doc_id IN (${placeholders})
          ORDER BY doc_id ASC, sort_order ASC, bookmark_id ASC`,
      )
      .all(userId, ...docIds) as BookmarkRow[]
  }
```

- [ ] **Step 6: 类型检查通过**

Run: `cd server && npm run typecheck`
Expected: 无错误。**特别确认 `server/src/sync/service.ts` 没有报错**——这验证了 Step 2 把新字段做成可选的做法确实绕开了禁区文件。

- [ ] **Step 7: 服务端仍能起来**

Run: `cd server && npm run server`
Expected: 监听 3000，无异常退出。`Ctrl+C` 停掉。

- [ ] **Step 8: 提交**

```bash
git add server/src/dao/index.ts
git commit -m "feat(B1): DAO 支持书签排序位与章节标题

BookmarkRow 追加 sort_order / chapter_title（**可选**：server/src/sync/service.ts
在禁区里，必填会让它编译不过）；insertBookmark 兜底分配 max+1，使经 /api/sync
创建的书签也有合理序号；新增 nextSortOrder / setBookmarkMeta / listBookmarksPaged /
reorderBookmarks / listBookmarkedDocuments / listBookmarksByDocIds 六个方法。

验证：npm run typecheck 无错误（含禁区文件），npm run server 正常监听 3000。"
```

---

### Task 3: 服务端接口 —— reorder 与分页列表

**Files:**
- Modify: `server/src/routes/bookmarks.ts`

**Interfaces:**
- Consumes: Task 2 的 `dal.nextSortOrder`、`dal.setBookmarkMeta`、`dal.listBookmarksPaged`、`dal.reorderBookmarks`。
- Produces（前端按这些形状调用）：
  - `POST /api/bookmarks/reorder` → `200 {docId, applied, items: {bookmarkId, sortOrder, version}[]}`；`409 SYNC_VERSION_CONFLICT`（`details.conflict.key` 指出冲突条目，**整批已回滚**）；`400 VALIDATION_FAILED`
  - `GET /api/bookmarks/page?docId=&sort=&order=&page=&pageSize=` → `200 {total, page, pageSize, items: BookmarkListItem[]}`
  - `POST /api/bookmarks` 新增可选请求字段 `chapterTitle?`、`sortOrder?`；响应新增 `sortOrder` 与 `chapterTitle`

- [ ] **Step 1: 先确认这两个接口还不存在**

```powershell
cd server; npm run server   # 另开一个终端
$login = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/login -ContentType 'application/json' -Body '{"account":"demo@example.com","password":"demo12345","deviceId":"dev_verify"}'
$h = @{ Authorization = "Bearer $($login.accessToken)" }
Invoke-RestMethod -Uri 'http://localhost:3000/api/bookmarks/page?docId=doc_renjian' -Headers $h
```

Expected: 404（Fastify 默认找不到路由）。这是本任务的"红灯"。

- [ ] **Step 2: 在 `routes/bookmarks.ts` 顶部补 import 与本地 DTO**

`Anchor` 类型从 `../sync/anchor` **读取**——该模块不在禁区（禁区是 `server/src/sync/` 与 `routes/sync.ts`），而且本文件已经在 import 它的 `normalizeAnchor`，所以**合并到既有那一行**，不要新增第二行 import：

```ts
import { normalizeAnchor, type Anchor } from '../sync/anchor'
```

在 `conflict409` 旁边追加本地列表 DTO。**不要改 `../sync/service` 的 `bookmarkToDto`**（该文件在禁区），所以列表用自己的映射：

```ts
/**
 * 列表 DTO（B1/B3）。
 *
 * 为什么不复用 sync/service.ts 的 bookmarkToDto：那个文件在任务书的禁区里，
 * 而它没有 sortOrder / chapterTitle。列表相关的新字段在本文件内自成一份，
 * 增量同步的那份保持原样，互不影响。
 */
function bookmarkListDto(row: BookmarkRow) {
  return {
    bookmarkId: row.bookmark_id,
    docId: row.doc_id,
    name: row.name,
    anchor: JSON.parse(row.anchor_json) as Anchor,
    sortOrder: row.sort_order ?? 0,
    chapterTitle: row.chapter_title ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}
```

同时把 `import { dal, now } from '../dao'` 改为 `import { dal, now, type BookmarkRow } from '../dao'`。

- [ ] **Step 3: 新增 `POST /api/bookmarks/reorder`**

追加在 `/* §7.1 新增书签 */` 之前（顺序不影响功能，只为可读性）：

```ts
  /**
   * §7.7 拖动排序：整表重排。
   *
   * **一个事务，全成功或全失败** —— 任一条 baseVersion 不匹配即整体回滚，
   * 不接受部分成功（任务书 §B1 坑 3）。
   */
  app.post<{
    Body: {
      docId?: string
      items?: { bookmarkId?: string; sortOrder?: number; baseVersion?: number }[]
      updatedAt?: string
    }
  }>('/api/bookmarks/reorder', async (req) => {
    const userId = requireUserId(req)
    const b = req.body ?? {}
    const items = b.items ?? []

    if (!b.docId) throw E.validation(['docId'])
    if (!Array.isArray(items) || items.length === 0) throw E.validation(['items'])

    const ids = items.map((i) => i.bookmarkId)
    if (ids.some((id) => !id)) throw E.validation(['items.bookmarkId'])
    if (new Set(ids).size !== ids.length) throw E.validation(['items.bookmarkId'])
    for (const it of items) {
      if (typeof it.sortOrder !== 'number' || !Number.isInteger(it.sortOrder)) {
        throw E.validation(['items.sortOrder'])
      }
      if (typeof it.baseVersion !== 'number') throw E.validation(['items.baseVersion'])
    }

    // 先整体校验归属，再落库：不属于本用户/本文档的一律 404，避免越权改别人的书签
    for (const it of items) {
      const row = dal.getBookmarkById(it.bookmarkId!)
      if (!row || row.user_id !== userId || row.doc_id !== b.docId) throw E.notFound()
    }

    const updatedAt = b.updatedAt ?? now()
    const r = dal.reorderBookmarks(
      userId,
      b.docId,
      items.map((it) => ({
        bookmarkId: it.bookmarkId!,
        sortOrder: it.sortOrder!,
        baseVersion: it.baseVersion!,
      })),
      updatedAt,
    )

    if (!r.ok) {
      // 冲突条目：给出双方版本，resolution 用 superseded（附录 B 的约定：
      // 拖动排序取较新者，不用 keep_both，否则会多出一堆重复书签）
      const submitted = items.find((it) => it.bookmarkId === r.failedId)
      throw new ApiError(
        409,
        'SYNC_VERSION_CONFLICT',
        '书签顺序已被其他设备修改，本批调整已整体撤销。',
        {
          conflict: {
            scope: 'bookmark',
            key: r.failedId,
            baseVersion: submitted?.baseVersion ?? 0,
            serverVersion: r.serverVersion,
            local: { bookmarkId: r.failedId, sortOrder: submitted?.sortOrder ?? 0 },
            remote: { bookmarkId: r.failedId, version: r.serverVersion },
            resolution: 'superseded',
            resolved: null,
            note: '顺序取服务端较新的一份。',
          },
        },
      )
    }

    return {
      docId: b.docId,
      applied: r.rows.length,
      items: r.rows.map((row) => ({
        bookmarkId: row.bookmark_id,
        sortOrder: row.sort_order ?? 0,
        version: row.version,
      })),
    }
  })
```

- [ ] **Step 4: 新增 `GET /api/bookmarks/page`**

追加在 `/* §7.4 增量拉取 */` 之后。**`GET /api/bookmarks`（§7.4）一个字不动**：

```ts
  /**
   * §7.5 分页列表（B3）。界面列表走这里；§7.4 的 GET /api/bookmarks 只服务增量同步。
   *
   * 分成两个接口是有意的：契约 §1 规定 pageSize 默认 20，如果直接给 §7.4 加分页，
   * 那些不带分页参数的调用方（增量同步）会被静默截断到 20 条 —— 变更拉不全且不报错。
   */
  app.get<{
    Querystring: {
      docId?: string
      sort?: string
      order?: string
      page?: string
      pageSize?: string
    }
  }>('/api/bookmarks/page', async (req) => {
    const userId = requireUserId(req)
    const q = req.query
    if (!q.docId) throw E.validation(['docId'])

    const doc = dal.getDocumentById(q.docId)
    if (!doc || doc.owner_id !== userId) throw E.notFound()

    const sort = q.sort === 'createdAt' || q.sort === 'chapter' ? q.sort : 'order'
    const order = q.order === 'desc' ? 'desc' : 'asc'
    const page = Math.max(1, Number(q.page ?? 1) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20) || 20))

    const { total, rows } = dal.listBookmarksPaged(userId, q.docId, sort, order, page, pageSize)
    return { total, page, pageSize, items: rows.map(bookmarkListDto) }
  })
```

- [ ] **Step 5: `POST /api/bookmarks` 接受 `chapterTitle` / `sortOrder`**

`BookmarkBody` 接口追加两个可选字段：

```ts
  /** ★ B4：创建时带上的章节标题 */
  chapterTitle?: string | null
  /** ★ B1：显式指定排序位；不传则服务端追加到末尾 */
  sortOrder?: number
```

在 `if (r.conflict) throw conflict409(r.conflict)` **之后**、计算 `code` **之前**插入：

```ts
    // 新列走 setBookmarkMeta，不用 updateBookmarkIfVersion：
    // 后者会递增 version，把契约 §7.1 要求的新建 version=1 顶成 2。
    // sort_order 缺省时由 insertBookmark 兜底分配 max+1，这里只在显式传入时覆盖。
    if (b.chapterTitle !== undefined || b.sortOrder !== undefined) {
      dal.setBookmarkMeta(b.bookmarkId!, {
        ...(b.chapterTitle !== undefined ? { chapter_title: b.chapterTitle } : {}),
        ...(b.sortOrder !== undefined ? { sort_order: b.sortOrder } : {}),
      })
    }
```

并把原有的响应体改为（**追加**两个字段，不改动 `bookmarkId`/`version`/`name` 的语义）：

```ts
    const fresh = dal.getBookmarkById(b.bookmarkId!)
    const code = r.applied ? 201 : 200
    return reply.code(code).send({
      bookmarkId: b.bookmarkId!,
      version: fresh?.version ?? r.version,
      name: fresh?.name ?? b.name ?? null,
      sortOrder: fresh?.sort_order ?? 0,
      chapterTitle: fresh?.chapter_title ?? null,
    })
```

- [ ] **Step 6: `npm run typecheck` 通过**

Run: `cd server && npm run typecheck`
Expected: 无错误。

- [ ] **Step 7: 端到端验证分页接口**

重启服务端后：

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/login -ContentType 'application/json' -Body '{"account":"demo@example.com","password":"demo12345","deviceId":"dev_verify"}'
$h = @{ Authorization = "Bearer $($login.accessToken)" }

# 造 3 个书签
1..3 | ForEach-Object {
  $body = @{ bookmarkId = "bm_verify$_"; docId = 'doc_renjian'; name = "验证$_"
             anchor = @{ chapterIndex = 0; paragraphIndex = $_; sentenceIndex = 0; charOffset = 0; scrollOffset = 0 }
             updatedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/bookmarks -ContentType 'application/json' -Headers $h -Body $body
}

# 分页列表：应看到 3 条，sortOrder 为 0,1,2
Invoke-RestMethod -Uri 'http://localhost:3000/api/bookmarks/page?docId=doc_renjian' -Headers $h | ConvertTo-Json -Depth 6
```

Expected: `total=3`；`items` 的 `sortOrder` 依次为 `0,1,2`；`chapterTitle` 为 `null`（本章还没传）。

- [ ] **Step 8: 端到端验证 reorder（含整批回滚）**

```powershell
# 正常重排：把 3 条倒过来
$items = @(
  @{ bookmarkId = 'bm_verify1'; sortOrder = 2; baseVersion = 1 },
  @{ bookmarkId = 'bm_verify2'; sortOrder = 1; baseVersion = 1 },
  @{ bookmarkId = 'bm_verify3'; sortOrder = 0; baseVersion = 1 }
)
$body = @{ docId = 'doc_renjian'; items = $items; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/bookmarks/reorder -ContentType 'application/json' -Headers $h -Body $body | ConvertTo-Json -Depth 6

# 确认顺序真的变了
Invoke-RestMethod -Uri 'http://localhost:3000/api/bookmarks/page?docId=doc_renjian' -Headers $h |
  Select-Object -ExpandProperty items | Select-Object bookmarkId, sortOrder
```

Expected: reorder 返回 `applied=3`，各条 `version` 变成 2；列表里 `bm_verify3` 的 `sortOrder=0`、`bm_verify1` 的 `sortOrder=2`。

**再验证整批回滚**（关键：一条版本错，全批不落库）：

```powershell
# 故意让第 2 条用过期版本号 1
$items = @(
  @{ bookmarkId = 'bm_verify1'; sortOrder = 0; baseVersion = 2 },
  @{ bookmarkId = 'bm_verify2'; sortOrder = 1; baseVersion = 1 },
  @{ bookmarkId = 'bm_verify3'; sortOrder = 2; baseVersion = 2 }
)
$body = @{ docId = 'doc_renjian'; items = $items; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 6
try {
  Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/bookmarks/reorder -ContentType 'application/json' -Headers $h -Body $body
} catch {
  $_.ErrorDetails.Message
  (Get-Content $_.Exception.Response.GetResponseStream() | Out-String)
}

# 第 1 条用过期版本号 1，且第 1 条本应改成 sortOrder=0 —— 回滚后它必须还是 2
Invoke-RestMethod -Uri 'http://localhost:3000/api/bookmarks/page?docId=doc_renjian' -Headers $h |
  Select-Object -ExpandProperty items | Select-Object bookmarkId, sortOrder
```

Expected: 返回 `409` + `SYNC_VERSION_CONFLICT`，`details.conflict.key = "bm_verify2"`，`resolution = "superseded"`；**列表里 `bm_verify1` 的 `sortOrder` 仍是 `2`**（说明整批确实回滚了，没留下半吊子状态）。

- [ ] **Step 9: 清理验证数据**

```bash
cd server && npm run db:reset && npm run seed
```

（重建后演示库回到只有 1 本书、0 个书签的干净状态。）

- [ ] **Step 10: 提交**

```bash
git add server/src/routes/bookmarks.ts
git commit -m "feat(B1,B3): 书签拖动排序与分页列表接口

- POST /api/bookmarks/reorder：整表重排，一个事务，任一条版本不匹配即整体回滚，
  409 的 details.conflict.key 指出冲突条目，resolution 取 superseded
- GET /api/bookmarks/page：分页列表，sort 支持 order/createdAt/chapter
- POST /api/bookmarks 接受可选 chapterTitle / sortOrder，响应回带两字段
- 列表 DTO 在本文件内自成一份，不改禁区文件 sync/service.ts 的 bookmarkToDto
- 契约 §7.4 的 GET /api/bookmarks 一字未动，角色 A 的增量同步不受影响

验证：npm run typecheck 无错误；实跑 3 书签的分页（sortOrder 0,1,2）；
实跑 reorder 倒序成功；故意给第 2 条传过期 baseVersion → 409 且整批回滚
（第 1 条的 sortOrder 仍为 2，未落库）。"
```

---

### Task 4: 客户端 API 与 Hook —— 乐观更新

**Files:**
- Modify: `client/src/api/client.ts`
- Modify: `client/src/features/sync/useBookmarks.ts`

**Interfaces:**
- Consumes: Task 3 的三个接口。
- Produces:
  - `BookmarkDto` 新增可选 `sortOrder?: number`、`chapterTitle?: string | null`
  - `api.listBookmarksPaged(opts): Promise<{total, page, pageSize, items: BookmarkDto[]}>`
  - `api.reorderBookmarks(body): Promise<{docId, applied, items: {bookmarkId, sortOrder, version}[]}>`
  - `BookmarksApi` 新增 `reorder(orderedIds: string[]): Promise<void>`、`page`/`pageSize`/`total`/`setPage`、`sort`/`setSort`

- [ ] **Step 1: 先确认 `reorder` 还不存在**

Grep: `reorderBookmarks|listBookmarksPaged` in `client/src/` 
Expected: 0 命中。这是"红灯"。

- [ ] **Step 2: `api/client.ts` 给 `BookmarkDto` 补两个可选字段**

`sortOrder` / `chapterTitle` 必须是**可选**：契约 §7.4 的增量同步响应不带它们。

```ts
export interface BookmarkDto {
  bookmarkId: string
  docId: string
  name: string | null
  anchor: Anchor
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  /** ★ B1：同文档内排序位。§7.4 的增量同步响应不带它，故可选 */
  sortOrder?: number
  /** ★ B4：书签所在章节标题。§7.4 的增量同步响应不带它，故可选 */
  chapterTitle?: string | null
}
```

- [ ] **Step 3: `api/client.ts` 追加两个请求函数**

追加在既有 `listBookmarks` **之后**（纯追加，不动已有实现）：

```ts
  /**
   * §7.5 分页列表（B1/B3）。界面列表走这里。
   * §7.4 的 listBookmarks 保持原样，只服务增量同步。
   */
  listBookmarksPaged: (opts: {
    docId: string
    sort?: 'order' | 'createdAt' | 'chapter'
    order?: 'asc' | 'desc'
    page?: number
    pageSize?: number
  }) => {
    const q = new URLSearchParams({ docId: opts.docId })
    if (opts.sort) q.set('sort', opts.sort)
    if (opts.order) q.set('order', opts.order)
    if (opts.page) q.set('page', String(opts.page))
    if (opts.pageSize) q.set('pageSize', String(opts.pageSize))
    return request<{ total: number; page: number; pageSize: number; items: BookmarkDto[] }>(
      `/bookmarks/page?${q.toString()}`,
    )
  },

  /** §7.7 拖动排序：一次提交整批新顺序 */
  reorderBookmarks: (body: {
    docId: string
    items: { bookmarkId: string; sortOrder: number; baseVersion: number }[]
    updatedAt: string
  }) =>
    request<{
      docId: string
      applied: number
      items: { bookmarkId: string; sortOrder: number; version: number }[]
    }>('/bookmarks/reorder', { method: 'POST', body: JSON.stringify(body) }),
```

同时给 `BookmarkPayload` 追加两个可选字段（创建书签时用）：

```ts
  /** ★ B4：章节标题 */
  chapterTitle?: string | null
```

- [ ] **Step 4: `useBookmarks.ts` —— `reload` 改用分页接口**

把 `reload` 里的 `const res = await api.listBookmarks({ docId })` 换成：

```ts
      const res = await api.listBookmarksPaged({ docId, page, pageSize, sort, order })
      setItems(res.items.filter((i) => !i.deletedAt))
      setTotal(res.total)
```

并在 hook 顶部补状态：

```ts
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [sort, setSort] = useState<'order' | 'createdAt' | 'chapter'>('order')
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
```

`reload` 的依赖数组补上 `page, pageSize, sort, order`。

- [ ] **Step 5: `useBookmarks.ts` —— 新增 `reorder`（乐观更新）**

```ts
  /**
   * B1 拖动排序：**乐观更新**。
   *
   * 先本地重排立即渲染（拖完不许等网络），再发请求。
   * 失败（含 409 整批回滚）就把顺序**回滚到服务端真值** —— reload() 会重新按
   * sort_order 拉一遍，不留半吊子状态。错误提示放在 reload 之后设置，
   * 否则 reload 成功会清空 error（R5 踩过的坑，见 CLAUDE.md 同步约定第 7 条）。
   */
  const reorder = useCallback(
    async (orderedIds: string[]) => {
      const byId = new Map(items.map((i) => [i.bookmarkId, i]))
      const next = orderedIds.map((id) => byId.get(id)).filter((i): i is BookmarkDto => !!i)
      if (next.length !== items.length) return

      setItems(next.map((it, i) => ({ ...it, sortOrder: i })))
      try {
        await api.reorderBookmarks({
          docId,
          items: next.map((it, i) => ({
            bookmarkId: it.bookmarkId,
            sortOrder: i,
            baseVersion: it.version,
          })),
          updatedAt: new Date().toISOString(),
        })
        await reload()
        setError('')
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : '调整顺序失败'
        await reload()
        setError(msg)
      }
    },
    [items, docId, reload],
  )
```

`BookmarksApi` 接口声明追加：

```ts
  reorder: (orderedIds: string[]) => Promise<void>
  total: number
  page: number
  setPage: (p: number) => void
  sort: 'order' | 'createdAt' | 'chapter'
  setSort: (s: 'order' | 'createdAt' | 'chapter') => void
```

并在返回对象里补上 `reorder`、`total`、`page`、`setPage`、`sort`、`setSort`。

- [ ] **Step 6: `add` 支持章节标题**

`add` 的签名改为 `add(anchor: Anchor, name: string, chapterTitle?: string | null)`，请求体带上它，离线入队的 payload 也带上：

```ts
      const payload = {
        bookmarkId: uuid(),
        docId,
        anchor,
        name,
        chapterTitle: chapterTitle ?? null,
        updatedAt: new Date().toISOString(),
      }
```

- [ ] **Step 7: 前端类型检查与启动**

Run: `cd client && npx tsc -b --noEmit`（若该命令不适用，用 `npm run build` 的 tsc 阶段）
Expected: 无错误。

Run: `cd client && npm run dev`
Expected: 5173 正常启动，书架能打开（此时界面尚未接入拖动，属正常）。

- [ ] **Step 8: 提交**

```bash
git add client/src/api/client.ts client/src/features/sync/useBookmarks.ts
git commit -m "feat(B1): 前端书签 API 与乐观更新

- api/client.ts 追加 listBookmarksPaged / reorderBookmarks；BookmarkDto 与
  BookmarkPayload 追加可选的 sortOrder / chapterTitle（§7.4 响应不带这两字段，故可选）
- useBookmarks.reload 改走分页接口；新增 reorder（乐观更新：先本地重排渲染，
  再发请求，失败即 reload 回滚到服务端真值）；add 支持章节标题
- 列表分页与排序状态（page/pageSize/sort/order）进了 hook

验证：前端类型检查无错误；npm run dev 正常启动，书架可打开。"
```

---

### Task 5: 书签面板 —— 手写 pointer 拖动排序

**Files:**
- Create: `client/src/pages/BookmarkPanel.tsx`
- Modify: `client/src/pages/ReaderView.tsx`
- Modify: `client/src/app.css`（末尾追加）

**Interfaces:**
- Consumes: Task 4 的 `BookmarksApi.reorder`、`items`（含 `sortOrder`）。
- Produces:
  - `BookmarkPanel` 组件，props：`{ items, defaultAddName, onAdd, onRename, onRemove, onReorder, onJump }`
  - `ReaderView` 内部不再持有 `renamingId` / `renamingText`

- [ ] **Step 1: 先确认拖动尚不存在**

Grep: `onPointerDown|setPointerCapture` in `client/src/`
Expected: 0 命中。这是"红灯"。

- [ ] **Step 2: 新建 `client/src/pages/BookmarkPanel.tsx`**

完整文件：

```tsx
import { useRef, useState } from 'react'
import type { BookmarkDto } from '../api/client'

/**
 * 书签面板（B1）。从 ReaderView 抽出来独立成文件 —— ReaderView 已是全项目最大的
 * 页面（459 行），拖动逻辑再塞进去会让它无法一次读完。
 *
 * 拖动用手写 pointer 事件，不用 HTML5 drag & drop：后者在触控设备上行为不一致，
 * 而且 jsdom 里根本没有 DataTransfer，验收时无法自动化。
 */

interface Props {
  items: BookmarkDto[]
  /** 当前位置的默认名（B4：「章节标题 · 首句片段」），留空时用它 */
  defaultAddName: string
  onAdd: (name: string) => void
  onRename: (bookmarkId: string, name: string) => void
  onRemove: (bookmarkId: string) => void
  onReorder: (orderedIds: string[]) => void
  onJump: (paragraphIndex: number) => void
}

/** 超过这个像素数才算拖动，避免把手柄上的单击误判成拖拽 */
const DRAG_THRESHOLD = 4

export default function BookmarkPanel({
  items,
  defaultAddName,
  onAdd,
  onRename,
  onRemove,
  onReorder,
  onJump,
}: Props) {
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [renamingId, setRenamingId] = useState('')
  const [renamingText, setRenamingText] = useState('')

  /** 拖动中的预览顺序；null 表示没在拖，直接显示 items */
  const [previewIds, setPreviewIds] = useState<string[] | null>(null)
  const [draggingId, setDraggingId] = useState('')
  const dragRef = useRef<{
    pointerId: number
    bookmarkId: string
    startY: number
    moved: boolean
  } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const byId = new Map(items.map((i) => [i.bookmarkId, i]))
  const shown = previewIds
    ? previewIds.map((id) => byId.get(id)).filter((i): i is BookmarkDto => !!i)
    : items

  /** 按指针纵向位置算出目标下标，实时重排预览 */
  function applyDragMove(clientY: number) {
    const d = dragRef.current
    const list = listRef.current
    if (!d || !list) return

    const nodes = Array.from(list.querySelectorAll<HTMLElement>('[data-bm-id]'))
    const order = nodes.map((n) => n.dataset.bmId ?? '')
    const from = order.indexOf(d.bookmarkId)
    if (from < 0) return

    // 指针落在哪一条上，就插到那一条的位置
    let target = -1
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect()
      if (clientY >= r.top && clientY <= r.bottom) {
        target = i
        break
      }
    }
    // 拖到列表末尾之下时归到最后一位
    if (target < 0 && nodes.length > 0) {
      const last = nodes[nodes.length - 1].getBoundingClientRect()
      if (clientY > last.bottom) target = nodes.length - 1
    }
    if (target < 0 || target === from) return

    const next = order.slice()
    next.splice(from, 1)
    next.splice(target, 0, d.bookmarkId)
    setPreviewIds(next)
  }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>, bookmarkId: string) {
    // 只在书签多于 1 条时允许拖动
    if (items.length < 2) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, bookmarkId, startY: e.clientY, moved: false }
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return
      d.moved = true
      setDraggingId(d.bookmarkId)
      setPreviewIds(items.map((i) => i.bookmarkId))
    }
    applyDragMove(e.clientY)
  }

  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current
    dragRef.current = null
    if (!d || d.pointerId !== e.pointerId) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDraggingId('')

    if (!d.moved) {
      setPreviewIds(null)
      return
    }
    const ids = previewIds ?? items.map((i) => i.bookmarkId)
    setPreviewIds(null)
    onReorder(ids)
  }

  /** 取消拖动（Escape 或指针被系统抢走） */
  function cancelDrag() {
    dragRef.current = null
    setDraggingId('')
    setPreviewIds(null)
  }

  /** 无鼠标也能排序：上移 / 下移 */
  function moveBy(bookmarkId: string, delta: number) {
    const ids = items.map((i) => i.bookmarkId)
    const from = ids.indexOf(bookmarkId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    onReorder(ids)
  }

  return (
    <aside className="toc-panel" onKeyDown={(e) => e.key === 'Escape' && cancelDrag()}>
      <div className="toc-head toc-head-row">
        <span>书签</span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setAddOpen((v) => !v)
            setAddName('')
          }}
        >
          加当前位置
        </button>
      </div>

      {addOpen && (
        <div className="marks-add">
          <input
            className="input mark-rename"
            autoFocus
            placeholder={defaultAddName || '书签名称（留空用默认名）'}
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onAdd(addName.trim())
                setAddOpen(false)
                setAddName('')
              }
              if (e.key === 'Escape') setAddOpen(false)
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              onAdd(addName.trim())
              setAddOpen(false)
              setAddName('')
            }}
          >
            添加
          </button>
        </div>
      )}

      {items.length === 0 && (
        <p className="muted marks-empty">还没有书签。读到某处点「加当前位置」。</p>
      )}

      <div className="marks-list" ref={listRef}>
        {shown.map((b, index) => (
          <div
            className={'mark-item' + (draggingId === b.bookmarkId ? ' dragging' : '')}
            key={b.bookmarkId}
            data-bm-id={b.bookmarkId}
          >
            <button
              className="mark-grip"
              title="按住拖动排序"
              aria-label="拖动排序"
              onPointerDown={(e) => onPointerDown(e, b.bookmarkId)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={cancelDrag}
            >
              ⠿
            </button>

            {renamingId === b.bookmarkId ? (
              <input
                className="input mark-rename"
                autoFocus
                value={renamingText}
                onChange={(e) => setRenamingText(e.target.value)}
                onBlur={() => setRenamingId('')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onRename(b.bookmarkId, renamingText)
                    setRenamingId('')
                  }
                  if (e.key === 'Escape') setRenamingId('')
                }}
              />
            ) : (
              <button
                className="mark-name"
                title="跳到这个书签"
                onClick={() => onJump(b.anchor.paragraphIndex)}
              >
                {b.name || '（无名）'}
                <span className="mark-pos">
                  {b.chapterTitle ? `${b.chapterTitle} · ` : ''}第 {b.anchor.paragraphIndex + 1} 段
                </span>
              </button>
            )}

            <button
              className="mark-act"
              title="上移"
              disabled={index === 0}
              onClick={() => moveBy(b.bookmarkId, -1)}
            >
              ↑
            </button>
            <button
              className="mark-act"
              title="下移"
              disabled={index === shown.length - 1}
              onClick={() => moveBy(b.bookmarkId, 1)}
            >
              ↓
            </button>
            <button
              className="mark-act"
              title="重命名"
              onClick={() => {
                setRenamingId(b.bookmarkId)
                setRenamingText(b.name ?? '')
              }}
            >
              ✎
            </button>
            <button className="mark-act" title="删除" onClick={() => onRemove(b.bookmarkId)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}
```

- [ ] **Step 3: `ReaderView.tsx` 接入面板**

补 import：

```tsx
import BookmarkPanel from './BookmarkPanel'
```

删除 `renamingId` / `renamingText` 两个 state（已移进面板），并删除整个 `{marksOpen && (<aside className="toc-panel">…</aside>)}` 块，替换为：

```tsx
        {marksOpen && (
          <BookmarkPanel
            items={bms.items}
            defaultAddName={defaultNameFor(currentParaRef.current)}
            onAdd={(name) => void bms.add(anchorAt(currentParaRef.current, ra.cursor), name)}
            onRename={(id, name) => void bms.rename(id, name)}
            onRemove={(id) => void bms.remove(id)}
            onReorder={(ids) => void bms.reorder(ids)}
            onJump={(paraIndex) => {
              gotoParagraph(paraIndex)
              ra.stopAutoScroll()
            }}
          />
        )}
```

同时删除顶栏「书签」按钮里那行 `加当前位置` 的旧实现（现在在面板里）。

> `defaultNameFor` 在 Task 9 才实现；本步骤先放一个占位实现并**立即在 Task 9 替换**：
> ```tsx
>   const defaultNameFor = (_paraIndex: number) => ''
> ```
> 这样 Task 5 可独立编译与验收，Task 9 再给出真正的命名规则。

- [ ] **Step 4: `app.css` 末尾追加样式**

```css
/* ---- B1：书签面板的拖动排序 ---- */
.marks-add { display: flex; gap: 6px; padding: 6px 10px; }
.marks-list { display: flex; flex-direction: column; }
.mark-item.dragging { opacity: 0.85; background: rgba(59, 110, 165, 0.12); }
.mark-grip {
  cursor: grab;
  touch-action: none;          /* 关键：不设的话触控会被浏览器当成滚动抢走指针 */
  user-select: none;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.5;
  padding: 0 4px;
}
.mark-grip:active { cursor: grabbing; opacity: 1; }
.mark-act:disabled { opacity: 0.3; cursor: default; }
```

- [ ] **Step 5: 前端类型检查与启动**

Run: `cd client && npx tsc -b --noEmit`
Expected: 无错误。

Run: `cd server && npm run server` 与 `cd client && npm run dev`
Expected: 两边都起来，无报错。

- [ ] **Step 6: 浏览器实走一遍拖动**

1. 打开 `http://localhost:5173`，用 `demo@example.com / demo12345` 登录。
2. 进《人间词话》，右上「书签」。
3. 点「加当前位置」三次（分别在正文不同位置滚动后再加），得到 3 条。
4. 按住某条的 `⠿` 手柄上下拖动 → 松手。
5. **刷新页面 → 顺序保持**。
6. 再点「↑ / ↓」按钮 → 顺序改变且刷新后保持。
7. 开一个**隐身窗口**，登录同一账号，进同一本书 → 书签顺序与刚才一致。

Expected: 全部通过。任何一步不通就停下来查，不要继续。

- [ ] **Step 7: 提交**

```bash
git add client/src/pages/BookmarkPanel.tsx client/src/pages/ReaderView.tsx client/src/app.css
git commit -m "feat(B1): 书签面板支持拖动排序

- 新建 BookmarkPanel.tsx，从 ReaderView（459 行，全项目最大页面）中抽离书签面板
- 拖动用手写 pointer 事件 + setPointerCapture，不用 HTML5 drag&drop
  （触控行为不一致，且 jsdom 没有 DataTransfer）；touch-action: none 防止触控被滚动抢走
- 同时提供 ↑/↓ 按钮，无鼠标也能排序，也便于自动化验收
- ReaderView 只负责接线：把 bms.reorder / add / rename / remove 传进面板

验证：前端类型检查无错误；实走 3 书签拖动 → 刷新顺序保持 → 隐身窗口
（另一 deviceId）顺序一致；↑/↓ 按钮同样生效。"
```

---

### Task 6: B3 分页、排序与 50 书签的种子数据

**Files:**
- Modify: `server/sql/seed.ts`
- Modify: `client/src/pages/BookmarkPanel.tsx`（加分页与排序控件）
- Modify: `client/src/pages/ReaderView.tsx`（把分页/排序状态传下去）

**Interfaces:**
- Consumes: Task 2 的 `listBookmarksPaged`、Task 3 的 `GET /api/bookmarks/page`、Task 4 的 hook 状态。
- Produces: 演示库里多一本 `doc_bookmark50`（50 个书签），供角色 D 的测试复用。

- [ ] **Step 1: 先确认种子里没有 50 书签的书**

Run: `cd server && npm run seed -- --force` 后
`Invoke-RestMethod 'http://localhost:3000/api/documents' -Headers $h | Select -Expand items | Select title`
Expected: 只有《人间词话》一本。这是"红灯"。

- [ ] **Step 2: `seed.ts` 追加一本 50 书签的书**

在 `PARAS` 之后追加常量：

```ts
/** 角色 D 的测试要一份"书签很多"的稳定数据，这里造一本 50 书签的书（任务书 §4） */
const BIG_TITLE = '书签压力册'
const BIG_PARAS: { type: 'h1' | 'h2' | 'p'; text: string }[] = Array.from(
  { length: 40 },
  (_, i) => {
    if (i === 0) return { type: 'h1' as const, text: '第一章　起点' }
    if (i === 13) return { type: 'h2' as const, text: '第二章　中段' }
    if (i === 27) return { type: 'h2' as const, text: '第三章　收束' }
    return { type: 'p' as const, text: `第 ${i + 1} 段正文。这一段的用途是给书签提供落点。` }
  },
)
/** 50 个书签：段落号 0..39 循环取，章节标题与上面三个标题段对应 */
const BIG_BOOKMARKS = Array.from({ length: 50 }, (_, i) => {
  const para = i % 40
  const chapter = para < 13 ? '第一章　起点' : para < 27 ? '第二章　中段' : '第三章　收束'
  return { paraIndex: para, chapterTitle: chapter }
})
```

在 `main()` 里、写完《人间词话》之后追加：

```ts
  // 第二本书：50 个书签，供分页与跨文档总览的验收使用
  const bigText = BIG_PARAS.map((p) => p.text).join('\n')
  const bigDoc = dal.insertDocument({
    doc_id: 'doc_bookmark50',
    owner_id: DEMO_USER_ID,
    file_name: '书签压力册.txt',
    file_format: 'TXT',
    file_size: Buffer.byteLength(bigText, 'utf8'),
    title: BIG_TITLE,
    author: null,
    content_hash: contentHash(BIG_PARAS),
    resource_url: null,
    imported_at: now(),
  })

  dal.insertParagraphs(
    BIG_PARAS.map((p, i) => ({
      para_id: newId('para'),
      doc_id: bigDoc.doc_id,
      para_index: i,
      para_type: p.type,
      text: p.text,
    })),
  )

  const stamp = now()
  BIG_BOOKMARKS.forEach((bm, i) => {
    dal.insertBookmark({
      bookmark_id: `bm_seed${String(i).padStart(2, '0')}`,
      user_id: DEMO_USER_ID,
      doc_id: bigDoc.doc_id,
      anchor_json: JSON.stringify({
        chapterIndex: 0,
        paragraphIndex: bm.paraIndex,
        sentenceIndex: 0,
        charOffset: 0,
        scrollOffset: 0,
      }),
      name: `${bm.chapterTitle} · 第 ${bm.paraIndex + 1} 段`,
      version: 1,
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
      sort_order: i,
      chapter_title: bm.chapterTitle,
    })
  })

  console.log(`已灌入演示数据：1 个用户、2 篇文档（${PARAS.length} 段 + ${BIG_PARAS.length} 段 50 书签）`)
```

**注意**：这里显式传 `sort_order` 与 `chapter_title`，绕开 `insertBookmark` 的 max+1 兜底——否则 50 条会各自算一次 `max+1`，在没有索引的重复扫描下慢，而且顺序会依赖插入次序。显式传值顺序确定。

同时把 `wipeDemo()` 保持不变（按 user_id 级联删除即可带走第二本书）。

- [ ] **Step 3: 重建并确认 50 书签**

```bash
cd server && npm run db:reset && npm run seed
```

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/api/bookmarks/page?docId=doc_bookmark50&pageSize=20' -Headers $h | ConvertTo-Json -Depth 4
```

Expected: `total = 50`，`items` 长度 20，第一条 `sortOrder = 0`。

- [ ] **Step 4: 验证翻页**

```powershell
foreach ($p in 1,2,3) {
  $r = Invoke-RestMethod -Uri "http://localhost:3000/api/bookmarks/page?docId=doc_bookmark50&pageSize=20&page=$p" -Headers $h
  "page=$p 拿到的条数=$($r.items.Count)  首条 sortOrder=$($r.items[0].sortOrder)  末条 sortOrder=$($r.items[-1].sortOrder)"
}
```

Expected: `page=1` → 20 条，0…19；`page=2` → 20 条，20…39；`page=3` → 10 条，40…49。**三页无重叠、无遗漏。**

- [ ] **Step 5: 验证两种排序**

```powershell
# 按章节排序：第一章(0..12) 应在最前，第二章(13..26) 居中，第三章(27..39) 在后
Invoke-RestMethod -Uri 'http://localhost:3000/api/bookmarks/page?docId=doc_bookmark50&sort=chapter&pageSize=5' -Headers $h |
  Select-Object -ExpandProperty items | Select-Object chapterTitle, sortOrder
```

Expected: 前 5 条 `chapterTitle` 全是「第一章　起点」。（`chapter_title` 为空的旧书签若存在，会被排在最后。）

- [ ] **Step 6: 面板加分页与排序控件**

`BookmarkPanel` 的 `Props` 追加：

```ts
  total: number
  page: number
  pageSize: number
  sort: 'order' | 'createdAt' | 'chapter'
  onSortChange: (s: 'order' | 'createdAt' | 'chapter') => void
  onPageChange: (p: number) => void
```

在 `</div>`（`marks-list` 的收尾）之后追加：

```tsx
      {total > 0 && (
        <div className="marks-pager">
          <select
            className="input marks-sort"
            value={sort}
            onChange={(e) => onSortChange(e.target.value as 'order' | 'createdAt' | 'chapter')}
          >
            <option value="order">拖动顺序</option>
            <option value="createdAt">创建时间</option>
            <option value="chapter">所属章节</option>
          </select>
          <span className="muted">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页 · 共 {total} 条
          </span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            上一页
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={page >= Math.ceil(total / pageSize)}
            onClick={() => onPageChange(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
```

同时：`sort !== 'order'` 时禁用拖动与 ↑/↓（顺序由排序决定，拖了也会被下一次 reload 覆盖）：

```tsx
  const canDrag = items.length > 1 && sort === 'order'
```

并用 `canDrag` 替换 `onPointerDown` 里的 `if (items.length < 2) return`，以及给 ↑/↓ 按钮的 `disabled` 加上 `|| !canDrag`。

`app.css` 末尾追加：

```css
/* ---- B3：书签面板的分页与排序 ---- */
.marks-pager {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border-top: 1px solid rgba(0, 0, 0, 0.08);
}
.marks-sort { width: auto; padding: 2px 6px; }
```

- [ ] **Step 7: `ReaderView` 把状态传下去**

```tsx
          <BookmarkPanel
            items={bms.items}
            total={bms.total}
            page={bms.page}
            pageSize={bms.pageSize}
            sort={bms.sort}
            onSortChange={bms.setSort}
            onPageChange={bms.setPage}
            defaultAddName={defaultNameFor(currentParaRef.current)}
            /* …其余 props 同 Task 5… */
          />
```

`BookmarksApi` 需要暴露 `pageSize`，在 Task 4 的基础上补上。

- [ ] **Step 8: 浏览器验收**

打开《书签压力册》→ 书签面板应显示「第 1 / 3 页 · 共 50 条」，翻页正确；切「所属章节」后前几条都是第一章；切回「拖动顺序」后拖动能生效。

- [ ] **Step 9: 提交**

```bash
git add server/sql/seed.ts client/src/pages/BookmarkPanel.tsx client/src/pages/ReaderView.tsx client/src/app.css client/src/features/sync/useBookmarks.ts
git commit -m "feat(B3): 书签列表分页与排序

- seed 追加《书签压力册》：40 段、3 个章节标题段、50 个书签（sort_order 0..49），
  供分页/排序/总览的验收与角色 D 的测试复用
- 书签面板加分页控件与排序下拉（拖动顺序 / 创建时间 / 所属章节）
- 非"拖动顺序"时禁用拖动与上移下移（顺序由排序决定，拖了也会被 reload 覆盖）

验证：total=50；pageSize=20 时三页分别 20/20/10 条、无重叠无遗漏；
sort=chapter 时第一章的 5 条排在最前；界面翻页与排序切换正确。"
```

---

### Task 7: B2 服务端 —— 跨文档书签总览接口

**Files:**
- Modify: `server/src/routes/bookmarks.ts`（新增 `GET /api/bookmarks/overview`）
- Modify: `client/src/api/client.ts`（新增调用函数）

**Interfaces:**
- Consumes: Task 2 的 `dal.listBookmarkedDocuments`、`dal.listBookmarksByDocIds`。
- Produces:
  - `GET /api/bookmarks/overview?page=&pageSize=` → `200 {total, page, pageSize, groups: [{docId, docTitle, bookmarkCount, items}]}`
  - `api.listBookmarksOverview(opts)`

**分页语义（重要）**：`page`/`pageSize` 作用于**文档组**，不是书签。这样 `bookmarkCount` 才是该文档的真实书签总数（按书签分页的话，组头显示的条数只会是"本页里该文档的条数"，对读者是错的）。`total` 是**有书签的文档数**。

- [ ] **Step 1: 先确认接口不存在**

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/api/bookmarks/overview' -Headers $h
```

Expected: 404。这是"红灯"。

- [ ] **Step 2: `routes/bookmarks.ts` 追加接口**

追加在 `GET /api/bookmarks/page` 之后：

```ts
  /**
   * §7.6 跨文档书签总览（B2）。
   *
   * 分页作用于**文档组**而不是书签：组头的 bookmarkCount 要是该文档的真实书签总数，
   * 按书签分页的话它只会是"本页里该文档的条数"，对读者是错的。
   * total 因此是"有书签的文档数"。
   */
  app.get<{ Querystring: { page?: string; pageSize?: string } }>(
    '/api/bookmarks/overview',
    async (req) => {
      const userId = requireUserId(req)
      const q = req.query
      const page = Math.max(1, Number(q.page ?? 1) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20) || 20))

      const { total, docs } = dal.listBookmarkedDocuments(userId, page, pageSize)
      const rows = dal.listBookmarksByDocIds(
        userId,
        docs.map((d) => d.doc_id),
      )

      // 按 docs 的顺序建组（DAO 已按组内最近更新时间降序），再往组里塞书签
      const groups = docs.map((d) => ({
        docId: d.doc_id,
        docTitle: d.doc_title ?? d.file_name,
        bookmarkCount: 0,
        items: [] as ReturnType<typeof bookmarkListDto>[],
      }))
      const byDoc = new Map(groups.map((g) => [g.docId, g]))

      for (const row of rows) {
        const g = byDoc.get(row.doc_id)
        if (!g) continue
        g.items.push(bookmarkListDto(row))
        g.bookmarkCount++
      }

      return { total, page, pageSize, groups }
    },
  )
```

- [ ] **Step 3: `client/src/api/client.ts` 追加调用函数**

```ts
  /** §7.6 跨文档书签总览（B2）：按文档分组 */
  listBookmarksOverview: (opts: { page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.page) q.set('page', String(opts.page))
    if (opts.pageSize) q.set('pageSize', String(opts.pageSize))
    const qs = q.toString()
    return request<{
      total: number
      page: number
      pageSize: number
      groups: {
        docId: string
        docTitle: string
        bookmarkCount: number
        items: BookmarkDto[]
      }[]
    }>(`/bookmarks/overview${qs ? '?' + qs : ''}`)
  },
```

- [ ] **Step 4: 类型检查与接口验证**

Run: `cd server && npm run typecheck` 与 `cd client && npx tsc -b --noEmit`
Expected: 均无错误。

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/api/bookmarks/overview' -Headers $h | ConvertTo-Json -Depth 5
```

Expected: `total = 1`（当前只有《书签压力册》有书签），`groups[0].docTitle = "书签压力册"`，`bookmarkCount = 50`，`items` 长度 50、按 `sortOrder` 升序。

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/bookmarks.ts client/src/api/client.ts
git commit -m "feat(B2): 跨文档书签总览接口

GET /api/bookmarks/overview?page=&pageSize= 按文档分组返回书签。
分页作用于文档组而非书签 —— 组头的 bookmarkCount 要是该文档的真实书签总数，
按书签分页的话它只会是"本页里该文档的条数"，对读者是错的；total 因此是有书签的文档数。

验证：npm run typecheck（前后端）无错误；实调 overview 得到
total=1、docTitle=书签压力册、bookmarkCount=50、items 按 sortOrder 升序。"
```

---

### Task 8: B2 界面 —— 「我的书签」真实页面与锚点跳转

**Files:**
- Modify: `client/src/pages/LibraryView.tsx`
- Modify: `client/src/pages/ReaderView.tsx`

**Interfaces:**
- Consumes: Task 7 的 `api.listBookmarksOverview`。
- Produces: 路由 `/read/{docId}?para={paragraphIndex}` 被 `ReaderView` 识别。

- [ ] **Step 1: 先确认「我的书签」还不是书签列表**

浏览器登录后进书架 → 点左侧「我的书签」。
Expected: 现在显示的是"带书签的文档"卡片网格（空态文案"还没有任何文档带书签"），**不是书签列表**。这是"红灯"。

- [ ] **Step 2: `ReaderView` 支持 `?para=` 定位**

补 import：`import { useParams, useSearchParams } from 'react-router-dom'`

```tsx
  const [searchParams] = useSearchParams()
  const jumpPara = searchParams.get('para')
```

新增一个只跳一次的 effect，并让"恢复上次位置"在带 `?para=` 时让路：

```tsx
  /** B2：从书架「我的书签」点进来时，定位到锚点段落（只跳一次，不干扰后续滚动） */
  const jumpedRef = useRef(false)
  useEffect(() => {
    if (jumpedRef.current) return
    if (jumpPara === null || paragraphs.length === 0) return
    jumpedRef.current = true
    gotoParagraph(Number(jumpPara), false)
  }, [jumpPara, paragraphs, gotoParagraph])
```

并把既有的恢复位置 effect 开头改为：

```tsx
  useEffect(() => {
    if (resumedRef.current) return
    if (!prog.ready || paragraphs.length === 0) return
    resumedRef.current = true
    // 带 ?para= 时由上面的 effect 负责定位，不再恢复上次位置（否则两个跳转打架）
    if (jumpPara !== null) return
    if (prog.resumeParagraph <= 0) return
    const idx = clampToParagraphs({ ...anchorAt(prog.resumeParagraph) }, paragraphs)
    gotoParagraph(idx, false)
  }, [prog.ready, prog.resumeParagraph, paragraphs, gotoParagraph, jumpPara])
```

- [ ] **Step 3: `LibraryView` —— 「我的书签」改渲染总览**

追加 import 与状态：

```tsx
import { ApiError, api, type BookmarkDto } from '../api/client'
```

```tsx
  const [overview, setOverview] = useState<
    Awaited<ReturnType<typeof api.listBookmarksOverview>>['groups']
  >([])
  const [bmLoading, setBmLoading] = useState(false)
  const [bmPage, setBmPage] = useState(1)
  const [bmTotal, setBmTotal] = useState(0)
  const [bmError, setBmError] = useState('')
```

在既有 `load()` **之外**再加一个只服务书签分类的加载函数：

```tsx
  /* B2：书签分类走跨文档总览接口，不再走文档列表 */
  const loadOverview = useCallback(async () => {
    if (!user || nav !== 'bookmarks') return
    setBmLoading(true)
    setBmError('')
    try {
      const r = await api.listBookmarksOverview({ page: bmPage, pageSize: 20 })
      setOverview(r.groups)
      setBmTotal(r.total)
    } catch (e) {
      setBmError(e instanceof ApiError ? e.message : '加载书签失败，请稍后重试。')
    } finally {
      setBmLoading(false)
    }
  }, [user, nav, bmPage])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])
```

并把既有的文档 `load()` 加一道闸，书签分类下不请求文档列表：

```tsx
  const load = useCallback(async () => {
    if (!user || nav === 'bookmarks') return
    /* …其余不变… */
  }, [user, keyword, category, nav])
```

在 `<main className="shelf-main">` 内、文档网格**之前**插入书签总览分支：

```tsx
          {nav === 'bookmarks' && (
            <div className="marks-overview">
              {bmLoading && <div className="shelf-empty">正在加载书签…</div>}

              {!bmLoading && bmError && (
                <div className="shelf-empty">
                  <p className="error-text">{bmError}</p>
                  <button className="btn btn-primary" onClick={() => void loadOverview()}>
                    重试
                  </button>
                </div>
              )}

              {!bmLoading && !bmError && overview.length === 0 && (
                <div className="shelf-empty">
                  <p>还没有任何书签</p>
                  <p className="muted">在阅读界面点右上角「书签 → 加当前位置」</p>
                </div>
              )}

              {!bmLoading && !bmError && overview.length > 0 && (
                <>
                  {overview.map((g) => (
                    <section className="marks-group" key={g.docId}>
                      <header className="marks-group-head">
                        <span className="marks-group-title">{g.docTitle}</span>
                        <span className="muted">{g.bookmarkCount} 条</span>
                      </header>
                      {g.items.map((b: BookmarkDto) => (
                        <button
                          className="marks-row"
                          key={b.bookmarkId}
                          onClick={() => navigate(`/read/${b.docId}?para=${b.anchor.paragraphIndex}`)}
                        >
                          <span className="marks-row-name">{b.name || '（无名）'}</span>
                          {/* B4 之前的旧数据没有 chapterTitle，降级成"文档名 + 段落序号" */}
                          <span className="marks-row-chapter">
                            {b.chapterTitle
                              ? `${b.chapterTitle} · 第 ${b.anchor.paragraphIndex + 1} 段`
                              : `${g.docTitle} · 第 ${b.anchor.paragraphIndex + 1} 段`}
                          </span>
                          <span className="marks-row-time">
                            {new Date(b.createdAt).toLocaleString('zh-CN')}
                          </span>
                        </button>
                      ))}
                    </section>
                  ))}

                  {bmTotal > 20 && (
                    <div className="marks-pager">
                      <span className="muted">
                        第 {bmPage} / {Math.ceil(bmTotal / 20)} 页 · 共 {bmTotal} 本
                      </span>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={bmPage <= 1}
                        onClick={() => setBmPage((p) => p - 1)}
                      >
                        上一页
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={bmPage >= Math.ceil(bmTotal / 20)}
                        onClick={() => setBmPage((p) => p + 1)}
                      >
                        下一页
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
```

并把既有文档网格的条件从 `{!loading && !error && books.length > 0 && (` 改为
`{nav !== 'bookmarks' && !loading && !error && books.length > 0 && (`，
空态那块同理加上 `nav !== 'bookmarks' &&`。

- [ ] **Step 4: `app.css` 末尾追加样式**

```css
/* ---- B2：跨文档书签总览 ---- */
.marks-overview { padding: 4px 2px 24px; }
.marks-group { margin-bottom: 18px; }
.marks-group-head {
  display: flex; align-items: baseline; gap: 10px;
  padding: 6px 2px; border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}
.marks-group-title { font-weight: 600; }
.marks-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 12px; align-items: center; width: 100%;
  padding: 8px 6px; text-align: left;
  border: none; background: transparent; cursor: pointer;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}
.marks-row:hover { background: rgba(59, 110, 165, 0.07); }
.marks-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.marks-row-chapter,
.marks-row-time { color: #6b7280; font-size: 13px; }
```

- [ ] **Step 5: 类型检查与启动**

Run: `cd client && npx tsc -b --noEmit`
Expected: 无错误。

- [ ] **Step 6: 浏览器验收（任务书的验收步骤）**

1. 打开《人间词话》，加 2 个书签。
2. 打开《书签压力册》，加 2 个书签（用面板的「加当前位置」）。
3. 回书架 → 点「我的书签」→ **看到两组共 4 条**。
4. 点《人间词话》那组里的一条 → **跳到正确文档的正确段落位置**。
5. 点《书签压力册》那组里的一条 → 同样跳对。

Expected: 四步全通过。

- [ ] **Step 7: 提交**

```bash
git add client/src/pages/LibraryView.tsx client/src/pages/ReaderView.tsx client/src/app.css
git commit -m "feat(B2): 「我的书签」做成跨文档总览页

- LibraryView 的书签分类改走跨文档总览接口，按文档分组展示名称/所属章节/
  创建时间/段落序号；点击跳 /read/{docId}?para={段落号}
- ReaderView 识别 ?para= 并定位到锚点段落；带 ?para= 时不再恢复上次阅读位置
  （两个跳转会打架），用 ref 保证只跳一次、不干扰后续滚动
- chapterTitle 为空的旧数据降级显示"文档名 + 段落序号"

验证：npm run typecheck 无错误；实走给两本书各加 2 个书签 → 「我的书签」
看到两组共 4 条 → 各点一条都跳到正确文档的正确位置。"
```

---

### Task 9: B4 —— 默认名「章节标题 + 首句片段」

**Files:**
- Modify: `client/src/pages/ReaderView.tsx`

**Interfaces:**
- Consumes: Task 4 的 `bms.add(anchor, name, chapterTitle)`、Task 5 的 `BookmarkPanel.defaultAddName`、Task 3 的 `POST /api/bookmarks` 的 `chapterTitle` 字段。
- Produces: 书签默认名与 `T_Bookmark.chapter_title`。

- [ ] **Step 1: 先确认当前默认名还是「第 N 段」**

浏览器里加一个书签。
Expected: 名称是 `第 3 段` 这样的标识符，而不是章节标题 + 首句。这是"红灯"。
（Task 5 已把 `defaultNameFor` 占位成返回 `''`，所以此刻会落到 `BookmarkPanel` 里"（无名）"的显示路径——无论哪种，都还不是要求的形状。）

- [ ] **Step 2: 在 `ReaderView` 实现命名规则**

替换 Task 5 留下的占位实现：

```tsx
  /**
   * B4：书签默认名 =「章节标题 + 首句片段」（.context/08-书签补充.md §2.3 的要求）。
   *
   * 章节标题不需要动解析层——ReaderView 已经拿到带 type: 'h1' | 'h2' 的 paragraphs，
   * 取锚点段落**之前最近的一个标题段**即可；之前没有就退回文档里第一个标题段，
   * 再没有就用书名。
   */
  const chapterTitleFor = useCallback(
    (paraIndex: number): string => {
      for (let i = Math.min(paraIndex, paragraphs.length - 1); i >= 0; i--) {
        const p = paragraphs[i]
        if (p && (p.type === 'h1' || p.type === 'h2')) return p.text
      }
      const first = paragraphs.find((p) => p.type === 'h1' || p.type === 'h2')
      return first?.text ?? book?.title ?? ''
    },
    [paragraphs, book],
  )

  /** 首句片段：取锚点段落切分后的第一句，超过 20 字截断 */
  const firstSentenceOf = useCallback(
    (paraIndex: number): string => {
      const s = (byPara.get(paraIndex) ?? [])[0]?.text ?? paragraphs[paraIndex]?.text ?? ''
      return s.length > 20 ? `${s.slice(0, 20)}…` : s
    },
    [byPara, paragraphs],
  )

  const defaultNameFor = useCallback(
    (paraIndex: number): string => {
      const parts = [chapterTitleFor(paraIndex), firstSentenceOf(paraIndex)].filter(Boolean)
      return parts.join(' · ')
    },
    [chapterTitleFor, firstSentenceOf],
  )
```

- [ ] **Step 3: `onAdd` 把名称与章节标题一起提交**

```tsx
            onAdd={(name) => {
              const idx = currentParaRef.current
              void bms.add(
                anchorAt(idx, ra.cursor),
                name || defaultNameFor(idx),
                chapterTitleFor(idx),
              )
            }}
```

- [ ] **Step 4: 类型检查与启动**

Run: `cd client && npx tsc -b --noEmit`
Expected: 无错误。

- [ ] **Step 5: 浏览器验收（任务书的验收步骤）**

1. 打开《人间词话》，滚到第二段（`h1`「人间词话 · 卷一」之后的第一段正文）。
2. 点「加当前位置」→ 输入框 placeholder 应显示 `人间词话 · 卷一 · 词以境界为最上`。
3. 直接点「添加」（不填名称）→ 书签名称应是该默认名。
4. 进书架「我的书签」→ 该条显示「名称 + 人间词话 · 卷一 · 第 2 段」。
5. 再测一次**手填名称**：填「我的标记」→ 名称应是「我的标记」，章节仍记录为「人间词话 · 卷一」。

Expected: 五步全通过。

- [ ] **Step 6: 确认 chapter_title 真的落库**

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/api/bookmarks/page?docId=doc_renjian' -Headers $h |
  Select-Object -ExpandProperty items | Select-Object name, chapterTitle, sortOrder
```

Expected: 看到 `chapterTitle = "人间词话 · 卷一"`，`sortOrder` 连续。

- [ ] **Step 7: 提交**

```bash
git add client/src/pages/ReaderView.tsx
git commit -m "feat(B4): 书签默认名改为「章节标题 + 首句片段」

默认名 = 章节标题 · 首句片段（08-书签补充.md §2.3 的要求），章节标题取锚点段落
之前最近的 h1/h2 标题段，回退顺序：之前的标题段 → 文档第一个标题段 → 书名。
首句超过 20 字截断。创建时把 chapterTitle 一并上传落进 T_Bookmark.chapter_title。
保留可填写名称的输入框，填了就用填的。

**未做做法二**（给 T_Paragraph 加章节序号列 + 章节目录接口）：工作量大得多，
且会牵动角色 C 的句子切分与角色 A 的锚点；章节标题由前端从已有的标题段推导，
已足以满足本迭代的默认名与总览展示需求。

验证：npm run typecheck 无错误；实走《人间词话》第二段 → placeholder 与
不填名称时的默认名均为「人间词话 · 卷一 · 词以境界为最上」；手填名称时不覆盖；
GET /api/bookmarks/page 确认 chapterTitle 已落库。"
```

---

### Task 10: 契约、进度与登记收尾

**Files:**
- Modify: `.context/07-接口契约.md`
- Modify: `CLAUDE.md`
- Modify: `docs/迭代登记-B.md`

**Interfaces:**
- Consumes: Task 3 / 7 的接口形状。
- Produces: 文档与实现对得上（手册 §12 完成定义第 4、6 条）。

- [ ] **Step 1: 契约文档追加三节，并给 §7.4 补说明**

在 `.context/07-接口契约.md` 的 §7.4 之后追加：

```markdown
### 7.5 分页列表（界面列表用）

`GET /api/bookmarks/page?docId=doc_5b7e&sort=order&order=asc&page=1&pageSize=20`

- `sort` 取值 `order`（同文档内拖动顺序，默认）/ `createdAt`（创建时间）/ `chapter`（所属章节）；
  `chapter` 排序时 `chapterTitle` 为空的记录固定排在最后。
- `page` 从 1 起，`pageSize` 默认 20、上限 100。

`200`：

```json
{
  "total": 50, "page": 1, "pageSize": 20,
  "items": [
    { "bookmarkId": "bm_9d2f...", "docId": "doc_5b7e", "name": "人间词话 · 卷一 · 词以境界为最上",
      "anchor": { "chapterIndex": 0, "paragraphIndex": 1, "sentenceIndex": 0, "charOffset": 0, "scrollOffset": 0 },
      "sortOrder": 0, "chapterTitle": "人间词话 · 卷一",
      "version": 1, "createdAt": "...", "updatedAt": "...", "deletedAt": null }
  ]
}
```

### 7.6 跨文档书签总览

`GET /api/bookmarks/overview?page=1&pageSize=20`

**分页作用于文档组**（`total` 为有书签的文档数），组内返回该文档的全部书签，
因此 `bookmarkCount` 是该文档的真实书签总数。

`200`：

```json
{
  "total": 2, "page": 1, "pageSize": 20,
  "groups": [
    { "docId": "doc_5b7e", "docTitle": "人间词话", "bookmarkCount": 2,
      "items": [ { "bookmarkId": "...", "name": "...", "anchor": {...},
                   "sortOrder": 0, "chapterTitle": "人间词话 · 卷一",
                   "createdAt": "...", "updatedAt": "...", "deletedAt": null } ] }
  ]
}
```

### 7.7 拖动排序（整表重排）

`POST /api/bookmarks/reorder`

```json
{ "docId": "doc_5b7e",
  "items": [ { "bookmarkId": "bm_9d2f...", "sortOrder": 0, "baseVersion": 3 },
             { "bookmarkId": "bm_51aa...", "sortOrder": 1, "baseVersion": 1 } ],
  "updatedAt": "2026-10-11T10:00:00.000Z" }
```

`200`：`{ "docId": "doc_5b7e", "applied": 2, "items": [ { "bookmarkId": "...", "sortOrder": 0, "version": 4 } ] }`

`409 SYNC_VERSION_CONFLICT`：任一条 `baseVersion` 不匹配即**整体回滚**（不接受部分成功），
`details.conflict.key` 指出冲突条目，`resolution` 为 `superseded`。

排序位编号策略为**稠密整数 `0,1,2…`**；两端同时拖动的合并规则为 `superseded`（取较新者），
不使用 `keep_both`——否则会为同一条书签造出重复副本。
```

并在 §7.4 标题下方补一句：

```markdown
> **本接口只服务增量同步。** 界面上的书签列表请用 §7.5；§7.5 是后加的独立接口，
> 本接口的响应形状保持不变，以免不带分页参数的调用方被 `pageSize` 默认值静默截断。
```

- [ ] **Step 2: `CLAUDE.md`「当前进度」追加角色 B 一条**

在「当前进度」列表末尾（`- **R6 已完成**…` 之后）追加，**不要删改别人的条目**：

```markdown
- **迭代 I1/I2 · 角色 B 已完成**：书签拖动排序（`T_Bookmark.sort_order`，稠密整数 + 整表重排事务）、
  书签列表分页与排序（新增 `GET /api/bookmarks/page`，§7.4 保持原样）、跨文档书签总览
  （新增 `GET /api/bookmarks/overview`，「我的书签」已是真实页面）、书签默认名改为
  「章节标题 + 首句片段」（新增 `T_Bookmark.chapter_title`，做法一）。
  **新列需 `npm run db:reset && npm run seed` 重建**。`sort_order` 的合并规则与角色 A 约定为
  `superseded`，登记在 `docs/迭代登记-B.md`。
```

- [ ] **Step 3: 登记文件补齐附录 B**

把 `docs/迭代登记-B.md` 的附录 B 占位行替换为：

```markdown
| 2026-10-11 | B | `POST /api/bookmarks/reorder` | **新增**：拖动排序整表重排，一个事务全成功或全失败 | 新增接口，不影响老调用方 |
| 2026-10-11 | B | `GET /api/bookmarks/page` | **新增**：分页列表，`sort` 支持 order/createdAt/chapter | 新增接口；§7.4 的 `GET /api/bookmarks` 未改动 |
| 2026-10-11 | B | `GET /api/bookmarks/overview` | **新增**：跨文档书签总览，按文档分组 | 新增接口 |
| 2026-10-11 | B | `POST /api/bookmarks` | 请求体新增可选 `chapterTitle`、`sortOrder`；响应新增 `sortOrder`、`chapterTitle` | **向后兼容**（新增字段，旧调用方不传仍可用） |
| 2026-10-11 | B | `GET /api/bookmarks`（§7.4） | 仅补文档说明"只服务增量同步" | **无结构变化** |
```

- [ ] **Step 4: 全量重建与最终验收**

```bash
cd server && npm run db:reset && npm run seed && npm run typecheck
cd ../client && npx tsc -b --noEmit
```

Expected: 全部成功，无类型错误。

两个终端分别 `npm run server` 与 `npm run dev`，然后按任务书把**四项验收各走一遍**：

| 项 | 验收步骤 | 通过标准 |
|---|---|---|
| B1 | 同一文档拖 3 个书签成新顺序 → 刷新 → 隐身窗口打开同一本书 | 顺序保持；两台设备一致 |
| B3 | 打开《书签压力册》书签面板 | 第 1/3 页 · 共 50 条；翻页正确；按章节排序正确 |
| B2 | 两本书各 2 个书签 → 书架「我的书签」 | 两组共 4 条；点任意一条跳到正确文档的正确位置 |
| B4 | 《人间词话》第二段加书签，不填名称 | 名称是「人间词话 · 卷一 · 词以境界为最上」 |

- [ ] **Step 5: 提交**

```bash
git add .context/07-接口契约.md CLAUDE.md docs/迭代登记-B.md
git commit -m "docs(B): 同步契约、项目进度与迭代登记

- .context/07-接口契约.md 追加 §7.5 分页列表、§7.6 跨文档总览、§7.7 拖动排序；
  给 §7.4 补说明"本接口只服务增量同步，界面列表请用 §7.5"
- CLAUDE.md「当前进度」追加角色 B 一条（未删改他人条目）
- docs/迭代登记-B.md 补齐附录 B 的五行接口变更登记

验证：npm run db:reset && npm run seed 重建成功；前后端 typecheck 无错误；
四项验收按任务书步骤各走一遍，结果见前四个提交的提交信息。"
```

---

## 完成定义核对（手册 §12）

| 条目 | 落在哪个任务 |
|---|---|
| 1. 代码完成，前后端能同时起来 | Task 2/3/4/5/6/7/8/9 各自的启动验证 |
| 2. `npm run typecheck` 无错误 | 每个任务的类型检查步骤 + Task 10 Step 4 |
| 3. 按任务书验收步骤实走一遍，结果写进提交信息 | 每个任务的验收步骤与提交信息 |
| 4. 接口变更已同步契约文档 | Task 10 Step 1 |
| 5. `schema.sql` 与 `seed.ts` 已同步，能重建 | Task 1 Step 3、Task 6 Step 3、Task 10 Step 4 |
| 6. `CLAUDE.md` 进度已更新 | Task 10 Step 2 |

另按《迭代任务书-B》第 5 章的额外三条：

- B1 的 `sort_order` 合并规则已与角色 A 确认并登记 → Task 1 Step 4（约定）+ Task 10 Step 3（登记）
- B2 的接口变更已同步契约文档并登记到附录 B → Task 10 Step 1、Step 3
- 「我的书签」页面不再是空页 → Task 8 Step 6

## 需要提醒项目负责人的两件事

1. **`server/src/dao/index.ts` 与 `client/src/api/client.ts` 是手册 §7.2 的"需协商"文件。** 本计划只做**模块分区追加**（不重排已有方法/类型），但按手册要求仍需在群里知会角色 A/C/D。
2. **加列后旧库必须重建**（`npm run db:reset && npm run seed`），否则 `T_Bookmark` 读不到新列。这一步会清掉本地已有的书签与进度，演示前请确认重建时机。
