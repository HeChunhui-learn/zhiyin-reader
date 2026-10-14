# 知音漫卷（zhiyin-reader） —— 指路条

> ⚠️ **本仓库的全部项目约定已合并至 [`AGENTS.md`](./AGENTS.md)（2026-10-14）。**
> 本文件**不再承载任何正文**，请以 `AGENTS.md` 为唯一权威；改约定只改那一份。

| 文档 | 内容 |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | **唯一权威**：项目理解 / 项目约定（进度、实现约定、同步与冲突、TTS、epub.js、界面清单、四条裁决、术语表、不做的事）/ 文档体系 / 交互协议 / 开发工作流 / `.context/` 索引 |
| [`README.md`](./README.md) | 面向人：六轮各做了什么、怎么跑、演示账号、排期 |
| `.context/` | 材料正文（11 份），索引见 `AGENTS.md` 第六节，**按需查阅，不要一次性全读** |

**三件最容易被忘的事**（细节见 `AGENTS.md`）：

1. 跑起来要开两个终端 —— 服务端 `cd server && npm run server`（3000）、前端 `cd client && npm run dev`（5173）；或双击 `start.bat`。
2. 改了 `server/sql/schema.sql` 的列/表 —— **必须** `cd server && npm run db:reset && npm run seed` 重建，`seed` 不会迁移已存在的库。
3. 遇到歧义按 `AGENTS.md` 的四条裁决处理；裁决覆盖不到时按最省事的方式做，并在结束时列出临时决定。
