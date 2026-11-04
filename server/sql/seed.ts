/**
 * 种子数据：一个演示用户 + 一本演示书（《人间词话》，公有领域）。
 *
 * 用法：
 *   npm run seed            # 库里已有数据则跳过
 *   npm run seed -- --force # 先删掉演示用户及其文档再重新灌
 *
 * 段落由"前端解析"得到——本脚本扮演的就是前端解析器上传解析结果的角色
 * （docs/system-design.md §7 裁决 1：解析在前端，服务端只存）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeSalt, hashPassword } from '../src/auth/password'
import { dal, newId, now } from '../src/dao'
import { closeDb, getDb, initDb, isEmpty, SERVER_ROOT } from '../src/db'

/**
 * 演示账号的默认头像：128×128，品牌蓝的圆底上一重山一道水，与 features/brand/AppLogo 同源。
 * 2.1KB 的 PNG 直接嵌在源码里 —— 种子脚本要能在任何机器上跑出同样的结果，
 * 外挂一个图片文件就多一处"文件没跟着走"的可能。
 */
const DEMO_AVATAR_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAAflBMVEUfR570+P4xZs+Rqty3' +
  'ye8iSaBOcLpuj9IYPpQ1bNhUecU4c+MjS6I4c+MhSaAbPpAdP4+zx+2Xr+Hh6/0dP49Nb7eU' +
  'q9tzkM6BnNT///+yxe1Ze8EyaNA9ffMpVrM6ducAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAABH40WWAAAAIHRSTlP+/vz+/gf+/vkL/pmYS0sKlgQFCU0HugpEQo+1/gD+/nqyqBwA' +
  'AAVlSURBVHjaxVvZgqsqEGyJSFwzmZz1Xpf//8vToLiCNopaTzMuVNFd3ZoEoNqDOE9TxljT' +
  'Af9M0zzeNRQ434HcjQWo4mQBecqaDTBHEeDC3hDhooEqIN6e+zQOsVcB9Mk7hwFOoidLgNPo' +
  'iRJgM/fNIWx6YUNA3hxGfkBAzhoPYPleAWnjCekuATFrvIHF7gLyxityVwFp4xmpmwDv/FYF' +
  'ZgGsOQGMLuAUfosCuI7frAAu5DcqgCv5TQrgUn6DAji//tarES7mXyiAM/svpStPBMTNJYit' +
  'Atg1AphZQFzJT1uXIK3ipYAY338uQz4o0ALiOGYXAunmAqq0vBBDEkDzx+WliLUCuCUAoxCA' +
  'dmB5MbQP4Z4ADCGAmwLQhwBuCkAfArgrADoEcFcAdAjghh4w6QVwWwC6EIB6CtwjQD0R4C4L' +
  'ahvCfRlocwC3WbCzIdyYAZUDcM9AkjCPOQD3GggDbwqwDsDZAmEQBGKqgIlQsJ0mAEcLsEcQ' +
  'LBTIYw/GdpkA3CzQ8Y8VsLI7JnaZAJws0PPLGXeHklAfCt29wdCE+/i1AiaC8bHSVYKTgCmZ' +
  'UjCRJIPgasYY8r38yNaWxBSOQcgh3c2PCpb8yp8OElKyAAO/DS5mTIF553fKAyMKYEnghJCa' +
  'B6IAt/m3QaDlgQExAGImQeCREZJJOSbyJNEINAElsPkMExg+7cOsHYSlPEkdmYCyNlggqXV4' +
  '6mWCBJ6kfVVBEVCC0YICSjnNunyYLFCz0peAsrZYEBWgiSwnQ1TmR0AJ1hJ41Obpa5eUXgTA' +
  'Y6XWVstTUPIL9RYewW7ICG0ND3AeP4LAvy6gDA4igUMCIDgMARsCspWzSeABj1UB2YoA8MK/' +
  'kYYMCiu/CHxhJQ0F8PP519LAbQK88mNjBrsA4yl4BJ5hNgLSV9kl/BYjZPjZ0ODCKDgDpjQU' +
  'KMBgAvE4BcJggQq4wQRwDkwWQBNWWX0bskoKKO4TUCgB/D4BSI4mvC8HmAFZBffloGgFcA4n' +
  'kqyVBVLLr+u95mBRd5D0UO1F9P9GMgOtAC6v3RcGmHC2fIooNH97Mcan+rQ/2fyu/o+W0TIH' +
  'r142F2gpDYx4KBx3wkirU/hVvbvfjD7VX319f10SWd+T5EnLJIcBou2OKi3Y/Wz3Xf0iRMz8' +
  'hFGcSGmK4WYNagFYiTqcURR1QQrN0NFEGE3nVIP9T7dtIfh5wDg0obGAYudgVDEWB/Q/32MI' +
  'Ds/eKVI6AIMA7kxrPxMNsF3LZwJWQjDqOcszSJGgJVvHblRLiNdp9/YBGARwTpy9pGwZp8Or' +
  '8WWBPJJRBPSxmcLP5z1fxtOV4nLu0WiW8wklpmLc0o+q/mDrWSxkelf/zUp+2XJwPomiPPZy' +
  'OCRgIuD9nrUc0cfT85uqfAwb1pLNbfBUOOHteMw/WcxmsMEZKEYJmK2m29WOjhhgsaBxQ8GQ' +
  'k2XHmTUda/Zm/HMBi27QjtORqS/G1x6V4+elEF2RDsMsDLBcU8qrV3etLlkher5+ZJFMpjxv' +
  'wb3O0W3qnnrUgm2ran9Wv+c3d1PBTvwk1cazu+QpX+B04LoR30MHsq0r/q6+5SRbSsl5uBaf' +
  'g+afOMHNldUvlYVTOgAmmLK23OHR7MrPaavr8cIT+kFm5DfvL8ALM//9x8hv2WHBvXflouLc' +
  'aZOLZyOYw7+6zcenETI7/8pGJ7yl8BV+O//aVi9MGvcgoeC29G9vdsP7juYh42vT39zuJ6UX' +
  'ByRkRbU6fcKGxyMSCPSULZ97JZDoaZte+Q4vqNxzwuC0bb9KAj0MWUGlp298VsORNCh2Kr3L' +
  '1u/XSz3MXz++vp4WfH39eI0u9b/5/aVFLFVI7tf4Gir+AToazXxBgmJpAAAAAElFTkSuQmCC'

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

/** T_Document.content_hash：TXT/Markdown 按归一化后的正文文本算 SHA-256 */
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

  /*
   * 演示头像单独补一次，不受下面"库里有数据就跳过"的约束。
   *
   * 否则老库（R7-5 之前建的）永远不会有机会拿到这张头像 ——
   * 想拿到就得 --force，而那会把读者自己导入的书一起删掉，
   * 为了一个默认头像付这个代价不合适。头像本身是 upsert，重复跑无害。
   */
  if (dal.getUserById(DEMO_USER_ID)) seedDemoAvatar(DEMO_USER_ID)

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

  seedDemoAvatar(DEMO_USER_ID)

  console.log(`已灌入演示数据：1 个用户、2 篇文档（${PARAS.length} 段 + ${BIG_PARAS.length} 段 50 书签）`)
  console.log(`文档 id：${doc.doc_id}`)
  console.log(`演示账号：${DEMO_ACCOUNT} ／ ${DEMO_PASSWORD}`)
  closeDb()
}

/**
 * 给演示账号放一张默认头像（R7-5）。
 *
 * 图片直接嵌在源码里而不是外挂一个二进制文件：种子脚本要能在任何一台机器上
 * 原样跑出同样的结果，多带一个资源文件就多一处"文件没跟着走"的可能。
 * 才 433 字节，不值得为它建个 assets 目录。
 */
function seedDemoAvatar(userId: string): void {
  const dir = join(SERVER_ROOT, 'data', 'avatars')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${userId}.png`), Buffer.from(DEMO_AVATAR_PNG_B64, 'base64'))
  dal.setUserAvatar(userId, '/api/users/me/avatar', now())
}

main()
