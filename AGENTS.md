# 知音漫卷 · AGENTS.md

> 本文件是**全局事项的唯一入口**：项目定位、技术栈、启动方式、目录结构、术语、
> 交互协议与文档地图。
>
> 具体内容不在这里复述：
> - 系统怎么设计 → [`docs/system-design.md`](./docs/system-design.md)
> - 怎么开发、怎么避坑、怎么测 → [`docs/system-develop.md`](./docs/system-develop.md)
> - 面向使用者的说明 → [`README.md`](./README.md)

---

## 1. 项目是什么

**知音漫卷**，软件工程课程设计 · 第一组。一个桌面浏览器优先的阅读 Web 应用：
读者导入 EPUB / TXT / Markdown，前端解析为结构化数据，在浏览器里图文混排滚动阅读，
并能逐句高亮跟读；阅读进度与书签按设备记录并跨端同步。

演示当天必须真实跑通的三项：

1. **逐句高亮跟读（TTS）**
2. **跨设备同步 + 冲突处理**
3. **图文混排与图片懒加载**

项目已完整实现，当前版本 `1.3.0`。另有 Capacitor Android 壳，但网页版仍是主形态。

---

## 2. 技术栈（不要更换、不要新增）

| 层 | 选型 |
|---|---|
| 前端 | React 18 + Vite + TypeScript；路由 `react-router-dom` |
| 状态 | React 自带 state / context。**不引入 Redux、Zustand、MobX** |
| 样式 | 普通 CSS，单文件 `client/src/app.css`。**不引入 Tailwind、Ant Design、MUI** |
| 后端 | Node.js 20+、TypeScript、**Fastify 4**（不是 Express） |
| 数据库 | SQLite 单文件 `server/data/zhiyin.db`，驱动 `better-sqlite3` **`^12.11.1`** |
| 解析 | EPUB 用 `epub.js` 只取解析结果；Markdown 用 `marked`；TXT 自己解析 |
| 语音合成 | 本地 `Kokoro-FastAPI`（OpenAI 兼容，经服务端代理）或 Edge 在线语音；不可用时降级浏览器 `SpeechSynthesis` |
| 原生壳 | Capacitor Android（`client/android/`） |
| 端口 | 前端 **5173**、服务端 **3000**、Kokoro **8880** |

> ⚠️ **`better-sqlite3` 必须钉在 `^12.11.1`**。v13.0.0–13.0.3 的预编译包数量为 0，
> Windows 上没有 Visual Studio Build Tools 必然装不上。

---

## 3. 怎么跑

```bash
# 终端 1 —— 服务端（3000）
cd server
npm install            # 首次
npm run seed           # 首次：建库 + 演示数据
npm run server         # tsx watch

# 终端 2 —— 前端（5173）
cd client
npm install            # 首次
npm run dev
```

也可双击根目录 `start.bat`。浏览器打开 **http://localhost:5173**。

- 演示账号：`demo@example.com / demo12345`。
- 数据库：`server/data/zhiyin.db`；JWT 密钥：同目录 `.jwt-secret`（首次启动自动生成）。
- **改了 `server/sql/schema.sql` 必须重建**：`cd server && npm run db:reset && npm run seed`。
  重建会删除已导入的文档、图片、原始文件与头像。
- 没装 Kokoro 也能演示：`/api/tts/engines` 会如实返回 `available=false`，
  前端自动降级为浏览器发声。
- 环境变量、排错步骤、测试命令：见 [`docs/system-develop.md`](./docs/system-develop.md)。

---

## 4. 目录结构

```
zhiyin-reader/
├─ AGENTS.md            本文件：全局事项
├─ README.md            面向使用者
├─ start.bat            一键启动（Windows）
├─ docs/
│  ├─ system-design.md  系统设计
│  └─ system-develop.md 系统开发
├─ client/              前端（React + Vite + TypeScript）+ android/ Capacitor 壳
├─ server/              后端（Fastify + SQLite）
│  ├─ sql/schema.sql    13 张表的权威定义
│  ├─ sql/seed.ts       演示数据
│  └─ data/             运行时数据（已 gitignore）
```

---

## 5. 界面清单（类名固定，不许改名）

| 类名 | 中文 | 路由 |
|---|---|---|
| `GuidingUI` | 引导界面 | `/guide` |
| `LoginView` | 登录 / 注册界面 | `/login` |
| `LibraryView` | 书架界面 | `/shelf` |
| `ReaderView` | 阅读界面 | `/read/:docId` |
| `StatsView` | 阅读时长 | `/stats` |
| `ProfileView` | 个人主页 | `/profile` |
| `ReaderSettingsPanel` | 阅读设置面板 | 内嵌 |
| `PlaybackBar` | 播放控制条 | 内嵌 |
| `ConflictDialog` | 冲突对话框 | 模态 |
| `BookmarkPanel` | 书签面板 | 内嵌 |

根路径 `/` 与未匹配路径都重定向到 `/guide`。**导入文档不单独做界面**，在书架弹出文件选择框。

---

## 6. 术语表（全项目统一）

| 用这个词 | 不要用 |
|---|---|
| 读者 | 用户、普通用户（`user` 只出现在表名 / 字段名里） |
| `deviceId` | 设备指纹、Device ID、设备标识 |
| `docId` | 文档标识、文档 ID |
| `anchor` | 位置锚点、进度锚点、阅读进度锚点 |
| `highlightCursor` | 高亮游标、当前高亮句子索引 |

数据库列名 `snake_case`，TS 字段与接口 JSON `camelCase`。

---

## 7. 全局约束

### 7.1 四条已拍板的裁决

遇到与历史材料或其他文档冲突时，以这四条为准（全文见 `docs/system-design.md` §7）：

1. **解析放在前端**：服务端只存储与分发解析结果。
2. **锚点只有一种定义**：`chapterIndex / paragraphIndex / sentenceIndex / charOffset / scrollOffset`。
   不要另造 `paraIndex` 版本。
3. **`keep_both` 时第二条记录 id 由服务端生成**，客户端以响应为准。
4. **以数据库表为准**：`server/sql/schema.sql` 是字段权威。

### 7.2 开工前必须知道的跨包约定

这些约定的完整说明与「为什么」在 [`docs/system-develop.md`](./docs/system-develop.md) §4：

- TTS 缓存键客户端与服务端**必须逐字节一致**（两份实现，改一边必须改另一边）。
- 句子的 `startOffset` / `endOffset` 与锚点字段一旦改，既有书签与进度会漂移。
- 上传上限三处常量必须同值（服务端 `BODY_LIMIT`、`MAX_FILE_BYTES`、前端预检）。
- 图片二进制不进导入请求；阅读时才懒上传。
- `client/src/features/parse/sha256.ts` 是纯 JS 实现，**不要换成 `crypto.subtle`**。
- 播放器用 `document.createElement('audio')`，不要用 `new Audio()`。
- 游标由真实播放事件驱动，**不要引入定时器**。
- 软删除必须刷新 `updated_at`。
- 离线待同步队列**按读者隔离**；批量同步的 `created` 书签必须校验 `docId` 的属主与存在性。

### 7.3 不做的事

- PDF、OCR；
- AI 伴读问答（只留接口占位）；
- 第三方 OAuth 登录（只留空实现）；
- 对象存储 / CDN；
- OT / CRDT 合并算法；高亮位置跨端同步；
- 服务端音频表；
- 完整移动端 / 平板响应式改版（当前只有 Android 壳与局部适配）；
- 另一套测试框架（现有三层测试体系见 system-develop §5）。

---

## 8. 交互协议

- **用户以中文交流，回复用中文；界面文案一律中文。**
- **方案需确认后执行**：重要变更先说明方案，用户确认后再动手；文档更新无需确认。
- **减少工具调用轮次**：批量读文件、按需读档，不整读大文档。
- **代码风格**：不用分号、单引号、2 空格缩进、注释用中文。
- **注释**：重要代码写清「为什么」，尤其是那些「别拆掉」的约定。
- **错误必须被前端捕获并显示中文提示，不允许白屏。**
- **不引入技术栈之外的依赖；需要新依赖先问。**
- **改完必须保证前端与后端能同时起来且不报错。**
- **提交信息**：中文，带范围前缀（如 `feat(B1):` / `fix(A2):`），正文写清现象、根因、改法、
  实际跑过的验证。禁止「文件更改」这类无信息量标题。
- **遇到歧义**：按四条裁决；裁决覆盖不到时按最省事的方式做，并在结束时列出临时决定。

---

## 9. 文档地图

| 文档 | 读它的时候 |
|---|---|
| **AGENTS.md**（本文件） | 任何任务开工前 |
| [`README.md`](./README.md) | 要面向人介绍怎么用、怎么启动 |
| [`docs/system-design.md`](./docs/system-design.md) | 要改架构、数据模型、接口、关键流程 |
| [`docs/system-develop.md`](./docs/system-develop.md) | 要写代码、跑测试、排查环境、看已知限制 |
| `server/sql/schema.sql` | 确认表的字段与约束 |

**维护规则**：一个事实只写在一处；其他文档放链接。改约定先改对应文档再改代码。

---

## 10. 开工前检查清单

1. 读本文件；涉及设计读 `system-design.md`，涉及实现读 `system-develop.md`。
2. 确认分支与工作区状态，先 `git fetch` 对齐。
3. 改 schema → 先计划 `db:reset && seed`。
4. 动手前先跑一遍现状（类型检查或相关测试），拿到「改之前」的证据。
5. 完成后跑 `system-develop.md` §5.4 的六步门禁，并附实际输出。
