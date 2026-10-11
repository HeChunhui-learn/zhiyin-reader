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
| 2026-10-11 | B | `POST /api/bookmarks/reorder` | **新增**：拖动排序整表重排，一个事务全成功或全失败 | 新增接口，不影响老调用方 |
| 2026-10-11 | B | `GET /api/bookmarks/page` | **新增**：分页列表，`sort` 支持 order/createdAt/chapter | 新增接口；§7.4 的 `GET /api/bookmarks` 未改动 |
| 2026-10-11 | B | `GET /api/bookmarks/overview` | **新增**：跨文档书签总览，按文档分组 | 新增接口 |
| 2026-10-11 | B | `POST /api/bookmarks` | 请求体新增可选 `chapterTitle`、`sortOrder`；响应新增 `sortOrder`、`chapterTitle` | **向后兼容**（新增字段，旧调用方不传仍可用） |
| 2026-10-11 | B | `GET /api/bookmarks`（§7.4） | 仅补文档说明"只服务增量同步" | **无结构变化** |

## 与角色 A 的约定（sort_order 合并规则）

- **编号策略**：稠密整数 `0,1,2…`，拖动后整表重排，一次事务提交全部受影响行。
- **合并规则**：两端同时拖动同一批书签时走 **`superseded`**（取较新者），**不是 `keep_both`**。
  理由：`keep_both` 会为同一条书签造出重复副本，拖动场景下会产生成倍冗余。
- **本轮范围**：只在服务端落列与写路径；`/api/sync` 的 bookmarks 三集合暂不携带 `sortOrder`
  （属角色 A 第二轮"真增量同步游标"的范围）。跨端顺序一致性由 `GET /api/bookmarks/page` 保证：
  两台设备都按 `sort_order` 从服务端取，顺序必然一致。
- 新增列需 `cd server && npm run db:reset && npm run seed` 重建，已在提交信息中说明。
