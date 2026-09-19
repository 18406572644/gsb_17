/** 服务端统一错误：携带 HTTP 状态码与稳定错误码，REST 与 WS 共用 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'BAD_MESSAGE'
      | 'INTERNAL',
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static unauthorized(m = '未登录或登录已失效') {
    return new ApiError(401, 'UNAUTHORIZED', m)
  }

  static forbidden(m = '没有执行该操作的权限') {
    return new ApiError(403, 'FORBIDDEN', m)
  }

  static notFound(m = '资源不存在') {
    return new ApiError(404, 'NOT_FOUND', m)
  }

  static conflict(m = '资源冲突') {
    return new ApiError(409, 'CONFLICT', m)
  }

  static bad(m = '请求参数不合法') {
    return new ApiError(400, 'BAD_MESSAGE', m)
  }
}
