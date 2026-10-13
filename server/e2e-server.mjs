/**
 * 端到端测试专用的服务端启动器。
 *
 * 与 `npm run server` 的区别只有两点：
 *   1. 数据库指到**独立的 e2e 库**（server/data-e2e/zhiyin.db），
 *      端到端用例会反复导入文档、改书签、删文档，绝不能拿演示库来跑 ——
 *      跑完一遍演示库就脏了，还得记得重建。
 *   2. 每次启动前重建并灌种子数据，保证每个测试批次的起点一致。
 *
 * 注意：图片／原始文件／头像仍落在 server/data/ 下 —— 那几个目录的路径由
 * server/src/db.ts 的 SERVER_ROOT 决定，不走 ZHIYIN_DB。端到端用例不碰它们，
 * 所以实际上不会写什么；这里如实记一笔，免得以后有人以为它们也隔离了。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const E2E_DATA = join(here, 'data-e2e')
const E2E_DB = join(E2E_DATA, 'zhiyin.db')

// 每次重建，避免上一轮留下的书签/文档让断言飘
if (existsSync(E2E_DATA)) rmSync(E2E_DATA, { recursive: true, force: true })

const env = { ...process.env, ZHIYIN_DB: E2E_DB }

function run(command, args) {
  return new Promise((resolve, reject) => {
    // stdio: 'inherit' —— 种子与服务的输出直接透传给 Playwright 的 webServer 日志
    const child = spawn(command, args, { cwd: here, env, stdio: 'inherit', shell: true })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))))
    child.on('error', reject)
  })
}

await run('npx', ['tsx', 'sql/seed.ts'])
console.log(`[e2e] 测试库已就绪：${E2E_DB}`)
await run('npx', ['tsx', 'src/index.ts'])
