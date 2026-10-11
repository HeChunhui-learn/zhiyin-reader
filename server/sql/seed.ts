/**
 * 种子数据：一个演示用户 + 一本演示书（《人间词话》，公有领域）。
 *
 * 用法：
 *   npm run seed            # 库里已有数据则跳过
 *   npm run seed -- --force # 先删掉演示用户及其文档再重新灌
 *
 * 段落由"前端解析"得到——本脚本扮演的就是前端解析器上传解析结果的角色
 * （CLAUDE.md 裁决 1：解析在前端，服务端只存）。
 */
import { createHash } from 'node:crypto'
import { makeSalt, hashPassword } from '../src/auth/password'
import { dal, newId, now } from '../src/dao'
import { closeDb, getDb, initDb, isEmpty } from '../src/db'

const DEMO_USER_ID = 'u_demo'
/** 演示账号的密码。写在这里是为了让"跑完 seed 就能登录进去看演示书" */
export const DEMO_ACCOUNT = 'demo@example.com'
export const DEMO_PASSWORD = 'demo12345'

const PARAS: { type: 'h1' | 'h2' | 'p'; text: string }[] = [
  { type: 'h1', text: '人间词话 · 卷一' },
  { type: 'p', text: '词以境界为最上。有境界则自成高格，自有名句。五代北宋之词所以独绝者在此。' },
  { type: 'p', text: '有造境，有写境，此理想与写实二派之所由分。然二者颇难分别。因大诗人所造之境，必合乎自然；所写之境，亦必邻于理想故也。' },
  { type: 'p', text: '有有我之境，有无我之境。“泪眼问花花不语，乱红飞过秋千去。”有我之境也。“采菊东篱下，悠然见南山。”无我之境也。' },
  { type: 'p', text: '有我之境，以我观物，故物皆著我之色彩。无我之境，以物观物，故不知何者为我，何者为物。古人为词，写有我之境者为多，然未始不能写无我之境，此在豪杰之士能自树立耳。' },
  { type: 'h2', text: '卷二 · 境界说' },
  { type: 'p', text: '无我之境，人惟于静中得之。有我之境，于由动之静时得之。故一优美，一宏壮也。' },
  { type: 'p', text: '自然中之物，互相关系，互相限制。然其写之于文学及美术中也，必遗其关系、限制之处。故虽写实家，亦理想家也。' },
  { type: 'p', text: '虽如何虚构之境，其材料必求之于自然，而其构造，亦必从自然之法则。故虽理想家，亦写实家也。' },
  { type: 'p', text: '境非独谓景物也。喜怒哀乐，亦人心中之一境界。故能写真景物、真感情者，谓之有境界。否则谓之无境界。' },
  { type: 'h2', text: '卷三 · 气象' },
  { type: 'p', text: '“红杏枝头春意闹”，著一“闹”字，而境界全出。“云破月来花弄影”，著一“弄”字，而境界全出矣。' },
  { type: 'p', text: '境界有大小，不以是而分优劣。“细雨鱼儿出，微风燕子斜”，何遽不若“落日照大旗，马鸣风萧萧”？' },
  { type: 'p', text: '词至李后主而眼界始大，感慨遂深，遂变伶工之词而为士大夫之词。周介存置诸温、韦之下，可谓颠倒黑白矣。' },
  { type: 'p', text: '“自是人生长恨水长东”“流水落花春去也，天上人间”，《金荃》《浣花》能有此气象耶？' },
  { type: 'p', text: '客观之诗人，不可不多阅世。阅世愈深，则材料愈丰富，愈变化，《水浒传》《红楼梦》之作者是也。主观之诗人，不必多阅世。阅世愈浅，则性情愈真，李后主是也。' },
  { type: 'p', text: '古今之成大事业、大学问者，必经过三种之境界：“昨夜西风凋碧树。独上高楼，望尽天涯路。”此第一境也。“衣带渐宽终不悔，为伊消得人憔悴。”此第二境也。“众里寻他千百度，蓦然回首，那人却在，灯火阑珊处。”此第三境也。' },
]

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

/** 04 §4.3.1 的 content_hash：TXT/Markdown 按归一化后的正文文本算 SHA-256 */
function contentHash(paras: { text: string }[]): string {
  const normalized = paras
    .map((p) => p.text.replace(/[​-‍﻿]/g, '').trim())
    .join('\n')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

function wipeDemo(): void {
  const db = getDb()
  // 外键是 ON DELETE CASCADE，删用户即可连带删掉它的文档、段落……
  db.prepare('DELETE FROM T_User WHERE user_id = ?').run(DEMO_USER_ID)
}

function main(): void {
  initDb()
  const force = process.argv.includes('--force')

  if (force) {
    wipeDemo()
    console.log('已清除原有演示数据')
  } else if (!isEmpty()) {
    console.log('库中已有数据，跳过。要重新灌请加 --force')
    closeDb()
    return
  }

  // 用与登录接口完全相同的 scrypt 加盐哈希，保证这个账号真的能登进去
  const salt = makeSalt()
  dal.insertUser({
    user_id: DEMO_USER_ID,
    account: DEMO_ACCOUNT,
    password_hash: hashPassword(DEMO_PASSWORD, salt),
    salt,
    nickname: '示例读者',
    created_at: now(),
  })

  const text = PARAS.map((p) => p.text).join('\n')
  const doc = dal.insertDocument({
    doc_id: 'doc_renjian',
    owner_id: DEMO_USER_ID,
    file_name: '人间词话.txt',
    file_format: 'TXT',
    file_size: Buffer.byteLength(text, 'utf8'),
    title: '人间词话',
    author: '王国维',
    content_hash: contentHash(PARAS),
    resource_url: null,
    imported_at: now(),
  })

  dal.insertParagraphs(
    PARAS.map((p, i) => ({
      para_id: newId('para'),
      doc_id: doc.doc_id,
      para_index: i,
      para_type: p.type,
      text: p.text,
    })),
  )

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
  console.log(`文档 id：${doc.doc_id}`)
  console.log(`演示账号：${DEMO_ACCOUNT} ／ ${DEMO_PASSWORD}`)
  closeDb()
}

main()
