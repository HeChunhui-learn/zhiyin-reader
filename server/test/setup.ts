import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 每个用例文件一个独立的临时 SQLite 库。
 *
 * **必须在任何业务模块被 import 之前设好 `ZHIYIN_DB`** —— `server/src/db.ts` 在
 * 模块顶层就把 `DB_PATH` 算出来了（`process.env.ZHIYIN_DB ?? ...`），
 * 之后再改环境变量不会生效。setupFiles 保证在任何测试文件的 import 之前执行，
 * 这个本文件里只碰 node: 内置模块、不 import 业务代码，就是为了守住这个顺序。
 *
 * 不共用 `server/data/zhiyin.db` 的理由：用例会写书签、删文档、改密码，
 * 跑一遍测试就把演示库搞脏了，演示前还得记得重建。
 */
const dir = mkdtempSync(join(tmpdir(), 'zhiyin-test-'))
process.env.ZHIYIN_DB = join(dir, 'test.db')
// 测试里默认不打访问日志，免得把断言输出冲掉（要看就 ZHIYIN_LOG_REQUESTS=1）
process.env.ZHIYIN_LOG_REQUESTS ??= '0'

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 临时目录清不掉不影响用例结论，Windows 上偶发文件占用
  }
})
