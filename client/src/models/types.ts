/**
 * 全项目共用的类型定义。
 * 字段名与《接口说明文档》契约、CLAUDE.md 术语表一致（camelCase）。
 * 服务端返回的 DTO 直接就是这个形状，前端不再二次转换。
 */

export type BookFormat = 'EPUB' | 'TXT' | 'MD'

/** 阅读进度摘要（契约 §4.4）。R5 接入 T_ReadingProgress 之前恒为 null */
export interface ProgressSummary {
  paraIndex: number
  /** 0–1 */
  percent: number
  updatedAt: string
}

/** 书架里的一本书 —— 对应 GET /api/documents 的 items 元素 */
export interface Book {
  docId: string
  title: string
  author: string
  fileFormat: BookFormat
  coverImageId: string | null
  paragraphCount: number
  /** 读者收藏了没有（R7-4）。服务端按 (user_id, doc_id) 记 */
  isFavorite: boolean
  progress: ProgressSummary | null
}

export type ParagraphType = 'h1' | 'h2' | 'p' | 'img'

/** 正文段落 —— 对应 T_Paragraph */
export interface Paragraph {
  paraIndex: number
  type: ParagraphType
  text: string
}

/** 冲突项 —— R5 之前用的是前端假数据 */
export interface ConflictItem {
  conflictId: string
  type: string
  localDevice: string
  localValue: string
  remoteDevice: string
  remoteValue: string
}
