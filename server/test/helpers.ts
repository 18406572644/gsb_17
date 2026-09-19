/**
 * 多租户测试辅助：通过 HTTP API 登录、建文档、授权成员。
 * 每个测试文件使用独立 DATA_DIR，种子数据（demo-ws + 四个演示账号）始终可用。
 */

export interface LoginResult {
  token: string
  user: { id: string; username: string; displayName: string }
}

export async function http<T = any>(
  base: string,
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as T
  return { status: res.status, data }
}

export async function login(base: string, username: string, password: string): Promise<LoginResult> {
  const { status, data } = await http<LoginResult>(base, '/api/auth/login', 'POST', { username, password })
  if (status !== 200) throw new Error(`登录失败 ${status}: ${JSON.stringify(data)}`)
  return data
}

/** 用管理员账号创建一篇新文档（避免多个测试共用 demo 文档互相污染） */
export async function createDoc(
  base: string,
  adminToken: string,
  title: string,
  workspaceId = 'demo-ws',
): Promise<string> {
  const { status, data } = await http(base, `/api/workspaces/${workspaceId}/docs`, 'POST', { title }, adminToken)
  if (status !== 201) throw new Error(`创建文档失败 ${status}: ${JSON.stringify(data)}`)
  return (data as { doc: { id: string } }).doc.id
}

export async function grant(
  base: string,
  adminToken: string,
  docId: string,
  username: string,
  role: 'viewer' | 'commenter' | 'editor' | 'admin',
) {
  const { status, data } = await http(
    base,
    `/api/docs/${docId}/members`,
    'PUT',
    { username, role },
    adminToken,
  )
  if (status !== 200) throw new Error(`授权失败 ${status}: ${JSON.stringify(data)}`)
  return data
}

/** 便捷：admin 登录 + 建文档 + 给指定用户授权，返回各人 token 与 docId */
export async function setupDoc(
  base: string,
  grants: { username: string; role: 'viewer' | 'commenter' | 'editor' | 'admin' }[],
  title: string,
) {
  const admin = await login(base, 'admin', 'admin123')
  const docId = await createDoc(base, admin.token, title)
  const tokens: Record<string, string> = { admin: admin.token }
  for (const g of grants) {
    await grant(base, admin.token, docId, g.username, g.role)
    tokens[g.username] = (await login(base, g.username, `${g.username}123`)).token
  }
  return { adminToken: admin.token, docId, tokens }
}
