# 角色 A · 同步与冲突 —— 开发内容介绍

> 本文介绍角色 A 在「跨设备同步与冲突处理」这条线上的开发内容，供角色 B / C 与指导教师了解边界，
> 可直接粘贴进《迭代开发参考手册》角色 A 一节。
> 现状口径：**第一轮（A2、A4）已完成并合并；第二轮（A1、A3）尚未开始。**

---

## 一、A 负责什么

一句话：**读者在一台设备上读到哪儿、留了哪些书签，换一台设备打开能接着看，且两台设备各自的改动一件都不丢。**

对应需求里的「跨设备同步」用例，以及可靠性条款 **未决冲突不得丢失**（契约 §2.2.6 的落地）。

**属于 A 的范围**

| 内容 | 落点 |
|---|---|
| 批量增量同步（一次请求完成"上传本机增量 + 拉取服务端增量 + 冲突判定"） | `POST /api/sync`（契约 §8.1–8.2） |
| 合并语义：书签集合（多值）与阅读进度（单值） | `server/src/sync/merge.ts`（纯函数）+ `server/src/sync/service.ts`（落库） |
| 冲突的落库、读回、裁决、销账 全链路 | `T_SyncRecord` + `POST /api/sync/resolve` + `GET /api/sync/conflicts` |
| 幂等键 `Idempotency-Key` | `server/src/idempotency.ts` + `T_Idempotency` |
| 锚点的两种表示与比较 | `server/src/sync/anchor.ts` / `client/src/features/sync/anchor.ts` |
| 离线待同步队列、进度与书签的客户端读写 | `client/src/features/sync/`（`pendingQueue.ts` / `useProgress.ts` / `useBookmarks.ts`） |

**不属于 A 的范围**（改动前先对齐，别越界）

- 书签的**界面**（列表分页、拖动排序、跨文档总览）—— 角色 B，主要文件是 `LibraryView` 与 `useBookmarks` 的界面部分。
- 正文解析与句子切分 —— 前端解析层（裁决 1：服务端不解析）。
- 阅读进度的 `lastSentenceIndex`：它是跟读游标，**本机瞬态、不参与跨端同步**。

---

## 二、代码地图

| 层 | 文件 | 职责 |
|---|---|---|
| 表 | `server/sql/schema.sql` | `T_ReadingProgress`（每设备一行）、`T_SyncRecord`（冲突与同步记录）、`T_Bookmark`、`T_Idempotency`（第 10 张表，A2 追加） |
| 纯判定 | `server/src/sync/merge.ts` | `decideBookmark` / `decideProgress` / `isNewer`；只做判定，不碰数据库，方便逐条对着契约核 |
| 落库 | `server/src/sync/service.ts` | `applyProgress` / `applyBookmark` / `persistConflict` / `syncRecordToConflict` |
| 路由 | `server/src/routes/sync.ts` | `POST /api/sync`、`GET /api/sync/conflicts`、`POST /api/sync/resolve` |
| 幂等 | `server/src/idempotency.ts` | `withIdempotency` / `readIdempotent` / `rememberIdempotent` / 机会式过期清理 |
| 锚点 | `server/src/sync/anchor.ts`、`client/src/features/sync/anchor.ts` | 两份实现**必须一致**（字段名以契约 §6.1 为准） |
| 客户端 | `client/src/features/sync/` | `pendingQueue.ts`（IndexedDB 离线队列）、`useProgress.ts`（防抖上报与恢复）、`useBookmarks.ts` |
| 界面 | `ReaderView` / `ConflictDialog` | 冲突对话框由 `ReaderView` 唤起；`LibraryView` 尚未接入冲突读回（见第八节） |

---

## 三、第一轮已完成的内容

### A2 —— 幂等键落库（`T_Idempotency`）

**问题**：R5 把 `Idempotency-Key` 存在进程内存的一个 `Map` 里，服务端一重启键就没了，而契约 §1 要求 **24 小时内**有效。离线队列重放时正好会撞上这个窗口。

**做法**
- 新增第 10 张表 `T_Idempotency`，主键是 **`(user_id, idem_key)` 复合**，不是 `idem_key` 单列。
  理由：键由客户端生成，两个读者偶然生成同一个 UUID 时，A 的重放响应会被当成 B 的结果返回 —— 那是跨用户泄漏。
- 24 小时 TTL 由**读取时判一次**保证，不依赖清理任务跑没跑过；清理是写入路径上的机会式清理（每小时最多一次），因此不必为它去动 `server/src/index.ts`。
- 工具抽到 `server/src/idempotency.ts`，`scope` 列区分接口（`sync` / `bookmark` / `progress`），第二轮 A3 直接换 scope 复用。
- `withIdempotency` 要求「查键 → 干活 → 写结果」之间没有 `await`，否则两个并发重放会双双落库；`doSync` 因此写成同步函数（DAO 全是 better-sqlite3 的同步 API，满足前提）。重放时响应头带 `X-Idempotent-Replay: true`。

**涉及**：`server/sql/schema.sql`、`server/src/idempotency.ts`、`server/src/dao/index.ts`、`server/src/routes/sync.ts`
**重建提示**：新表需 `cd server && npm run db:reset && npm run seed` 才会建出来。

### A4 —— 冲突读回（`GET /api/sync/conflicts`）

**问题**：冲突确实写进了 `T_SyncRecord`，但界面**从来没有读回来的路径** —— 冲突只活在当次会话的内存里，刷新页面就等于"未决冲突丢了"，正好违反 §2.2.6。演示脚本第三段「关掉页面再打开，冲突还在」那一幕也因此过不了。

更隐蔽的一处：`persistConflict` 当初只写在批量同步那条路径上，而**演示脚本走的是单项接口**（两个窗口分别改名，客户端发的是 `PATCH /api/bookmarks/:id`），所以那条路径产生的冲突**此前从不落库**。

**做法**
- `persistConflict` 从 `routes/sync.ts` **下沉到 `sync/service.ts`** —— 三条写入路径（批量同步、书签单项、进度单项）都要落库，写在路由里必然漏。
- 新增 `GET /api/sync/conflicts?docId={docId}`（契约 §8.6，只加新接口、不改老接口）：
  - 只返回**等待读者裁决**的冲突（`keep_both` / `require_user_choice`）；
  - `superseded`（进度冲突）**不返回** —— 服务端已按「不回退保护」当场裁决完毕，读者无事可做，返回只会让每次打开阅读页都重弹一条幽灵冲突；
  - 按 `scope:key:serverVersion` 去重，同一冲突反复检出只返回最新一条。
- 裁决完**销账**（`markConflictResolved`）：否则读者已裁决过的冲突下次进阅读页又被读回来重弹。`T_SyncRecord` 没有 `scope` / `key` 列，而 §7.2 规定已有表定义只许追加新表，所以把 `conflict_json` 解析出来在 JS 里按 `scope` + `key` 匹配 —— 一次裁决要扫的未决冲突本来就只有几条。
- 顺带补记契约：裁决接口的请求体扩展了 `relatedId`（`keep_both` 之后要"二选一"必须知道另一条是谁，材料审查 A25 的模糊点），取值来自冲突信封的 `resolved.bookmarkId`。**仅增字段，向后兼容。**

**涉及**：`server/src/sync/service.ts`、`server/src/routes/sync.ts`、`.context/07-接口契约.md` §8.4 / §8.6

---

## 四、第二轮待开发的内容

> 两条都还没动。A1 原先要等 B1 的 `sort_order` 落地，**该列已随 V1.B 合并进来，现在可以开工**。

### A1 —— 真正的增量游标

**现状问题**
- 游标就是上一次响应里的 `serverTime`，服务端靠 `updated_at > since` 的**字符串比较**筛增量；
- 书签增量走 SQL（`listBookmarksSince`），但**进度增量是把该文档全部设备记录取回来、在 JS 里筛 `since`**（`routes/sync.ts` 的 `changesProgress` 段）；
- 书签一多或同一文档设备一多，每次同步都是全量比一遍。

**要做的**
- 用一个单调、不受客户端时钟影响的游标（而不是"响应生成时刻"的字符串）表达"服务端到哪儿了"；
- 进度增量的筛选下推到 SQL，与书签走同一条路径；
- 顺带把 `sortOrder` 纳入 `/api/sync` 的书签三集合 —— 这是**与角色 B 谈定的本轮范围**（见第五节），跨端拖动顺序目前靠 `GET /api/bookmarks/page` 保证一致。

**注意**：改游标必须保持「软删除要刷新 `updated_at`」这条（材料审查 E15）—— 墓碑不刷新就永远拉不到。

### A3 —— 幂等覆盖单项接口

**现状问题**：`Idempotency-Key` 目前只覆盖 `POST /api/sync`。而离线队列真正会重放的是**单项接口**（`PATCH /api/bookmarks/:id`、`DELETE /api/bookmarks/:id`、`PUT /api/documents/:id/progress`），重放一次就可能多出一条书签副本。

**要做的**：把 `withIdempotency` 套到这几条路径上，`scope` 分别取 `bookmark` / `progress` —— 工具与 `scope` 列 A2 已经备好，这一轮只需接线。

---

## 五、与角色 B 的接口边界

| 事项 | 约定 |
|---|---|
| `T_Bookmark.sort_order` | B1 追加列，稠密整数 `0,1,2…`，拖动后整表重排、一个事务全成功或全失败 |
| 两端同时拖动同一批书签 | 合并规则为 **`superseded`（取较新者）**，**不用 `keep_both`** —— 后者会为同一条书签造出重复副本，拖动场景下冗余成倍 |
| `sortOrder` 是否进 `/api/sync` | 本轮**不进**；跨端顺序一致性由 `GET /api/bookmarks/page` 保证（两端都按 `sort_order` 从服务端取）。纳入是 A1 的范围 |
| 书签默认名 | B4 的「章节标题 + 首句片段」，新增 `chapter_title` 列；A 侧同步只把它当普通字段搬运 |
| 冲突对话框 | `ReaderView` 已接入冲突读回；`LibraryView` **尚未接入**，要加需双方确认（那是 B 的主要文件） |

---

## 六、演示当天与 A 有关的那一幕

三项必须真实跑通的验收里，「**跨设备同步 + 冲突处理**」整幕由 A 负责：

1. 两个窗口（两个 `deviceId`）打开同一本书，各自读到不同位置、各留一个书签；
2. 一端改名、另一端也改名 → 服务端判 `keep_both`，**第二条记录的 id 由服务端生成**（裁决 3），名字带「（本机）」后缀；
3. 冲突弹窗三选一（本机 / 云端 / 两份都留）→ 走 `POST /api/sync/resolve`；
4. **关掉页面再打开，冲突仍在**（这是 A4 兑现的那一幕，此前过不了）；
5. 换设备继续读，进度不倒退（不回退保护）。

---

## 七、A 侧必须守住的约定（改动时别拆掉）

1. **锚点字段名以契约 §6.1 为准**：`chapterIndex` / `paragraphIndex` / `sentenceIndex` / `charOffset` / `scrollOffset`。服务端与客户端各一份实现，**必须一致**；不要再造 `paraIndex` 版本。
2. **契约 §8.1 的 `updated` / `deleted` 条目没有 `docId`、也没有 `anchor`**（只有 `created` 有）。服务端要按 `bookmarkId` 反查 docId；锚点缺省时**沿用库里已有的**，否则一次"只改名"的同步会把书签位置冲成第 0 段。
3. **软删除必须刷新 `updated_at`** —— 增量拉取按 `updated_at > since` 比，墓碑不刷新就永远拉不到。
4. **进度是每设备一行**：`GET /api/documents/:id/progress` 必须返回**所有设备**的记录，否则新设备拉不到别端进度，跨设备续读根本不成立。
5. **「不回退保护」的落法**：取最近更新的一条，但**若本机已记录的位置更靠前，就用本机的**。契约原文那句是循环表述（材料审查 E13），这是它落成代码后的意思 —— 即 `compareAnchor(local, remote) < 0` 时位置规则推翻时间规则。
6. **时间戳并列**：双方 `updatedAt` 相差小于 **5 秒**（`CLOCK_SKEW_MS`）时改用 `serverReceivedAt` 判先后，规避客户端时钟偏移。
7. **`keep_both` 时第二条记录的 id 由服务端生成**（裁决 3，`bm_` + uuid v4 去横线）；客户端以响应为准覆盖本地，不得自行生成。`conflict.resolved` 指向**新的那条**。
8. **冲突落库在 `sync/service.ts` 的 `persistConflict`，不在路由层** —— 三条写入路径都要落，写在路由里必然漏（R5 就是这么漏掉演示脚本那条路径的）。**进度冲突不落库**：它是 `superseded`，服务端当场裁决完了。
9. **裁决完要销账**（`markConflictResolved`），否则读者裁决过的冲突会重弹。
10. **幂等键存表不存内存**，主键 `(user_id, idem_key)` 复合。
11. **冲突提示要在 `reload()` 之后设置** —— `reload()` 成功会清空 error，顺序反了提示会一闪而过。

---

## 八、已知限制（写进迭代说明，不要当没看见）

- `Idempotency-Key` 仍只覆盖 `POST /api/sync`，单项接口没做（A3）。
- `POST /api/sync` 的进度增量仍在 JS 里筛（A1）；书签增量已是 SQL 筛选。
- 冲突只在 `ReaderView` 读回，`LibraryView` 还没接入。
- 裁决请求体扩展了 `relatedId`，契约已补记，属"仅增字段"。
- 多进程部署时 `withIdempotency` 的"查+写"需放进一个事务 —— 课程设计是单进程，未上这个复杂度。
- 「暂停」是停掉当前句、恢复时该句从头念；语速改变会让当前句从头重念（TTS 侧约定，与同步无关，一并记着）。
