-- ============================================================================
-- 知音漫卷 —— 建库脚本
-- 依据课程材料的字段设计；当前共 13 张表（含后续追加）。
-- 执行方式：服务端首次启动时自动执行（见 src/db.ts）；也可单独执行本文件。
--
-- 与课程材料的字段清单相比：凡在字段清单之外补充的列，均在下方以 ★ 标注。
--   本表（T_Bookmark）由角色 B 迭代追加 sort_order（同文档内排序位，稠密整数
--   0,1,2…）与 chapter_title（书签所在章节标题，B2 的"所属章节"与 B4 默认名
--   复用该列）两列，并追加 ix_bookmark_order 索引。
--
--   T_Paragraph 的 para_type 是另一处补充列：课程材料的字段清单里没有它，但没有它
--   就无法区分标题段与正文段，标题渲染与书签默认名都失去依据。
-- ============================================================================

PRAGMA foreign_keys = ON;

-- (1) 用户表 ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS T_User (
  user_id       TEXT PRIMARY KEY,
  account       TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- 加盐哈希，不保存明文
  salt          TEXT NOT NULL,
  nickname      TEXT,
  fail_count    INTEGER NOT NULL DEFAULT 0,   -- 连续失败登录次数
  locked_until  TEXT,                          -- 可空，锁定截止时间
  created_at    TEXT NOT NULL,
  last_login    TEXT
);

-- (2) 文档表 ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS T_Document (
  doc_id       TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES T_User(user_id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  file_format  TEXT NOT NULL,           -- EPUB / TXT / MD
  file_size    INTEGER,
  title        TEXT,
  author       TEXT,
  content_hash TEXT,                    -- 重复导入去重
  resource_url TEXT,
  imported_at  TEXT NOT NULL
);
-- 同一用户的 (owner_id, content_hash) 联合唯一（docs/system-design.md §5.3）
CREATE UNIQUE INDEX IF NOT EXISTS ux_document_owner_hash
  ON T_Document(owner_id, content_hash);

-- (3) 段落表 ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS T_Paragraph (
  para_id    TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES T_Document(doc_id) ON DELETE CASCADE,
  para_index INTEGER NOT NULL,
  para_type  TEXT NOT NULL DEFAULT 'p', -- ★ 补充列：h1 / h2 / p
  text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_paragraph_doc
  ON T_Paragraph(doc_id, para_index);

-- (4) 句子表 ----------------------------------------------------------------
-- 句子由前端在解析阶段切分并随段落一并上传（docs/system-design.md §7 裁决 1）。
CREATE TABLE IF NOT EXISTS T_Sentence (
  sentence_id    TEXT PRIMARY KEY,
  para_id        TEXT NOT NULL REFERENCES T_Paragraph(para_id) ON DELETE CASCADE,
  sentence_index INTEGER NOT NULL,      -- 段内序号，0 基
  start_offset   INTEGER NOT NULL,
  end_offset     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sentence_para
  ON T_Sentence(para_id, sentence_index);

-- (5) 图片资源表 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS T_ImageResource (
  image_id   TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES T_Document(doc_id) ON DELETE CASCADE,
  para_index INTEGER NOT NULL,          -- 图片所在的段落位置
  src        TEXT,                      -- 原文里的引用标记
  alt        TEXT,                      -- ★ 补充列：替代文本，契约 §4.1 的 imageRefs 里有这个字段
  cache_key  TEXT,
  local_url  TEXT,
  remote_url TEXT
);
CREATE INDEX IF NOT EXISTS ix_image_doc
  ON T_ImageResource(doc_id, para_index);

-- (6) 阅读进度表 ------------------------------------------------------------
-- 锚点按 docs/system-design.md §7 裁决 2 的 Anchor 结构四列展开存储。
-- last_sentence_index 是"切换前后台/息屏后恢复"用的本机瞬态指针，
-- 它属于朗读位置，**不参与跨端同步**（docs/system-design.md §4、AGENTS.md 不做的事）。
CREATE TABLE IF NOT EXISTS T_ReadingProgress (
  progress_id         TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES T_User(user_id) ON DELETE CASCADE,
  doc_id              TEXT NOT NULL REFERENCES T_Document(doc_id) ON DELETE CASCADE,
  device_id           TEXT NOT NULL,
  chapter_index       INTEGER NOT NULL DEFAULT 0,
  paragraph_index     INTEGER NOT NULL DEFAULT 0,
  char_offset         INTEGER NOT NULL DEFAULT 0,
  scroll_offset       REAL    NOT NULL DEFAULT 0,
  last_sentence_index INTEGER,
  updated_at          TEXT NOT NULL,               -- 客户端提供的修改时间（离线场景必需）
  server_received_at  TEXT NOT NULL,               -- ★ 补充列：服务端接收时间，契约 §8.5 要求
                                                   --   双方 updatedAt 相差小于 5 秒时以它判定先后
  version             INTEGER NOT NULL DEFAULT 0   -- 条件更新与增量同步
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_progress_user_doc_device
  ON T_ReadingProgress(user_id, doc_id, device_id);

-- (7) 同步记录表 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS T_SyncRecord (
  record_id      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES T_User(user_id) ON DELETE CASCADE,
  doc_id         TEXT NOT NULL REFERENCES T_Document(doc_id) ON DELETE CASCADE,
  device_id      TEXT,
  state          TEXT NOT NULL,         -- 待同步 / 已同步 / 冲突
  local_delta    TEXT,                  -- JSON
  remote_changes TEXT,                  -- JSON
  conflict_json  TEXT,                  -- JSON
  version        INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_syncrecord_user
  ON T_SyncRecord(user_id, state);

-- (8) 书签表 ----------------------------------------------------------------
-- bookmark_id 由客户端生成（两端各自新增的书签天然不同主键，可直接并集合并）；
-- 但冲突选择"两份都保留"时，第二条记录的 id 由服务端分配（docs/system-design.md §7 裁决 3）。
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
  sort_order    INTEGER NOT NULL DEFAULT 0,  -- ★ 追加列 B1：同文档内排序位，稠密整数 0,1,2…
  chapter_title TEXT                         -- ★ 追加列 B4：章节标题；B2 的"所属章节"复用它
);
CREATE INDEX IF NOT EXISTS ix_bookmark_sync
  ON T_Bookmark(user_id, doc_id, updated_at);
-- ★ 追加索引 B1：按拖动顺序取列表
CREATE INDEX IF NOT EXISTS ix_bookmark_order
  ON T_Bookmark(user_id, doc_id, sort_order);

-- (9) 令牌表 ----------------------------------------------------------------
-- 只由认证服务直接读写，不经 DataAccessLibrary（docs/system-design.md §7 裁决 4）。
CREATE TABLE IF NOT EXISTS T_Token (
  token_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES T_User(user_id) ON DELETE CASCADE,
  device_id    TEXT,
  refresh_hash TEXT NOT NULL,           -- 刷新令牌的哈希，不保存明文
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_token_user
  ON T_Token(user_id);

-- (10) 幂等键表 --------------------------------------------------------------
-- 契约 §1：批量同步与二进制上传支持 `Idempotency-Key` 请求头，服务端在 24 小时内
-- 对相同键返回首次结果。R5 把这张表省了，改用进程内存的 Map 存，重启即失效（A2 补）。
--
-- 主键取 (user_id, idem_key) 复合而不是 idem_key 单列：键由客户端生成，
-- 两个读者各生成一个相同 UUID 的概率虽小，但一旦撞上，A 的重放响应会被
-- 当成 B 的结果返回 —— 那是跨用户的数据泄漏，不可接受。
--
-- scope 列区分接口（sync / bookmark / progress）。A3 要把幂等套到单项接口上，
-- 有了它一张表就够用；本期只写 'sync'。
CREATE TABLE IF NOT EXISTS T_Idempotency (
  user_id       TEXT NOT NULL REFERENCES T_User(user_id) ON DELETE CASCADE,
  idem_key      TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'sync',
  response_json TEXT NOT NULL,          -- 首次请求的响应体，重放时原样返回
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, idem_key)
);
-- 清理过期记录时按时间扫，没有这个索引就得全表扫
CREATE INDEX IF NOT EXISTS ix_idempotency_created
  ON T_Idempotency(created_at);
-- (11) 收藏表（R7-4 追加）----------------------------------------------------
-- 只追加新表，不改上面任何一张表的定义 —— 改已有表的列要 db:reset，
-- 那会把读者已经导入的书全删掉。initDb() 每次启动重跑本文件，
-- 全是 CREATE ... IF NOT EXISTS，所以现有的库下次启动就自动多出这张表。
CREATE TABLE IF NOT EXISTS T_Favorite (
  user_id    TEXT NOT NULL REFERENCES T_User(user_id) ON DELETE CASCADE,
  doc_id     TEXT NOT NULL REFERENCES T_Document(doc_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, doc_id)
);
CREATE INDEX IF NOT EXISTS ix_favorite_user
  ON T_Favorite(user_id, created_at);

-- (12) 阅读时长（R7-5 追加）---------------------------------------------------
-- 存**会话流水**而不是"每用户一行累计值"：离线队列会重发（useProgress 那套），
-- client_id 上的唯一索引 + INSERT OR IGNORE 让重发变成无操作；
-- 累计计数器方案一重发就多记一次，而且很难事后分辨。
-- 只记"可见且聚焦"的时长，由前端算好再报上来。
CREATE TABLE IF NOT EXISTS T_ReadingSession (
  session_id  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES T_User(user_id) ON DELETE CASCADE,
  doc_id      TEXT NOT NULL REFERENCES T_Document(doc_id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  client_id   TEXT NOT NULL,            -- 客户端生成的幂等键，补报必需
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_readingsession_client
  ON T_ReadingSession(client_id);
CREATE INDEX IF NOT EXISTS ix_readingsession_user_doc
  ON T_ReadingSession(user_id, doc_id, started_at);
CREATE INDEX IF NOT EXISTS ix_readingsession_user
  ON T_ReadingSession(user_id, started_at);

-- (13) 用户档案 / 头像（R7-5 追加）-------------------------------------------
-- 头像单独一张表而不是给 T_User 加列：加列要 db:reset，
-- 那会把读者已经导入的书全删掉（本轮三条持久化都遵循这一点）。
CREATE TABLE IF NOT EXISTS T_UserProfile (
  user_id    TEXT PRIMARY KEY REFERENCES T_User(user_id) ON DELETE CASCADE,
  avatar_url TEXT,
  updated_at TEXT NOT NULL
);
