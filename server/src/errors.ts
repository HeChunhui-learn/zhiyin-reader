/**
 * 统一错误信封，对齐《接口说明文档》§1 与错误码总表 §2：
 *   { code, message, details, requestId }
 * 响应头另带 X-Request-Id。
 */

export class ApiError extends Error {
  status: number
  code: string
  details: Record<string, unknown>

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/* ---- 契约 §2 里本项目 R2 用得到的几个，集中定义避免拼错 ---- */

export const E = {
  validation: (fields: string[]) =>
    new ApiError(400, 'VALIDATION_FAILED', '参数缺失或格式非法。', { fields }),

  authRequired: () =>
    new ApiError(401, 'AUTH_REQUIRED', '请先登录。'),

  tokenExpired: () =>
    new ApiError(401, 'AUTH_TOKEN_EXPIRED', '登录已过期，请刷新令牌。'),

  invalidCredential: () =>
    new ApiError(401, 'AUTH_INVALID_CREDENTIAL', '账号或密码错误。'),

  refreshInvalid: () =>
    new ApiError(401, 'AUTH_REFRESH_INVALID', '刷新令牌无效、过期或已被轮换。'),

  accountLocked: (lockedUntil: string) =>
    new ApiError(423, 'ACCOUNT_LOCKED', '账号已被临时锁定，请稍后再试。', {
      lockedUntil,
    }),

  accountExists: () =>
    new ApiError(409, 'CONFLICT_ACCOUNT_EXISTS', '该账号已被注册。'),

  forbiddenNotOwner: () =>
    new ApiError(403, 'FORBIDDEN_NOT_OWNER', '该资源不属于当前用户。'),

  notFound: () => new ApiError(404, 'NOT_FOUND', '资源不存在。'),

  duplicateDocument: (docId: string) =>
    new ApiError(409, 'CONFLICT_DOCUMENT_DUPLICATE', '该文档已在书架中。', {
      docId,
    }),

  unsupportedFormat: () =>
    new ApiError(415, 'UNSUPPORTED_FORMAT', '不支持的文件格式。'),

  parseFailed: (reason: string) =>
    new ApiError(422, 'PARSE_FAILED', '文档解析失败。', { reason }),

  payloadTooLarge: () =>
    new ApiError(413, 'PAYLOAD_TOO_LARGE', '上传内容超过大小限制。'),

  /* ---- 契约 §9 上游服务相关 ---- */

  rateLimited: () =>
    new ApiError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试。'),

  upstreamTtsFailed: (engine: string) =>
    new ApiError(502, 'UPSTREAM_TTS_FAILED', '语音合成服务不可用。', { engine }),

  upstreamTimeout: (engine: string) =>
    new ApiError(504, 'UPSTREAM_TIMEOUT', '语音合成超时。', { engine }),
}
