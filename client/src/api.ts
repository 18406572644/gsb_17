/**
 * REST API 客户端：统一携带会话令牌、解析错误。
 * 令牌持久化在 localStorage，刷新页面后免重新登录。
 */
import type {
  Account,
  AddMemberRequest,
  AuditEntry,
  AuthResponse,
  CreateDocRequest,
  CreateWorkspaceRequest,
  DocBoot,
  DocMeta,
  DocPermissionList,
  HomeData,
  LoginRequest,
  RegisterRequest,
  SetDocPermissionRequest,
  UpdateMemberRoleRequest,
  Workspace,
  WorkspaceDetail,
  WorkspaceRole,
} from '../../shared/api'

const TOKEN_KEY = 'collab_token'

export class ApiException extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiException'
  }
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data: any = null
  try {
    data = await res.json()
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    if (res.status === 401) clearToken()
    throw new ApiException(res.status, data?.error || 'INTERNAL', data?.message || `请求失败（${res.status}）`)
  }
  return data as T
}

export const api = {
  login: (body: LoginRequest) => request<AuthResponse>('POST', '/api/auth/login', body),
  register: (body: RegisterRequest) => request<AuthResponse>('POST', '/api/auth/register', body),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request<{ account: Account }>('GET', '/api/auth/me'),

  home: () => request<HomeData>('GET', '/api/home'),
  workspaces: () => request<Workspace[]>('GET', '/api/workspaces'),
  createWorkspace: (body: CreateWorkspaceRequest) => request<Workspace>('POST', '/api/workspaces', body),
  workspace: (wid: string) => request<WorkspaceDetail>('GET', `/api/workspaces/${wid}`),
  addMember: (wid: string, body: AddMemberRequest) =>
    request('POST', `/api/workspaces/${wid}/members`, body),
  updateMemberRole: (wid: string, userId: string, body: UpdateMemberRoleRequest) =>
    request('PUT', `/api/workspaces/${wid}/members/${userId}`, body),
  removeMember: (wid: string, userId: string) =>
    request('DELETE', `/api/workspaces/${wid}/members/${userId}`),

  createDoc: (wid: string, body: CreateDocRequest) =>
    request<DocMeta>('POST', `/api/workspaces/${wid}/docs`, body),
  listDocs: (wid: string) => request<DocMeta[]>('GET', `/api/workspaces/${wid}/docs`),
  bootDoc: (wid: string, did: string) =>
    request<DocBoot>('GET', `/api/workspaces/${wid}/docs/${did}/boot`),
  permissions: (wid: string, did: string) =>
    request<DocPermissionList>('GET', `/api/workspaces/${wid}/docs/${did}/permissions`),
  setPermission: (wid: string, did: string, body: SetDocPermissionRequest) =>
    request('PUT', `/api/workspaces/${wid}/docs/${did}/permissions`, body),
  audit: (wid: string, did: string) =>
    request<AuditEntry[]>('GET', `/api/workspaces/${wid}/docs/${did}/audit`),
}

export type { WorkspaceRole }
