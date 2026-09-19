/**
 * HTTP API 客户端：统一注入登录令牌、解析 JSON、抛出带错误码的 ApiError。
 */
import type {
  AuditResponse,
  AuthResponse,
  CreateDocRequest,
  CreateWorkspaceRequest,
  DocDetailResponse,
  DocListItem,
  GrantDocMemberRequest,
  RecentResponse,
  RegisterRequest,
  UpdateDocRequest,
  WorkspaceDetail,
  WorkspaceListItem,
  DocMemberView,
  AddWorkspaceMemberRequest,
} from '../../../shared/tenant'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const TOKEN_KEY = 'collab-token'

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
    // 非 JSON 响应
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || 'INTERNAL', data?.message || `请求失败（${res.status}）`)
  }
  return data as T
}

export const api = {
  register: (body: RegisterRequest) => request<AuthResponse>('POST', '/api/auth/register', body),
  login: (body: { username: string; password: string }) => request<AuthResponse>('POST', '/api/auth/login', body),
  logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout'),
  me: () => request<{ user: import('../../../shared/tenant').User }>('GET', '/api/me'),

  recent: () => request<RecentResponse>('GET', '/api/recent'),
  listWorkspaces: () => request<{ workspaces: WorkspaceListItem[] }>('GET', '/api/workspaces'),
  createWorkspace: (body: CreateWorkspaceRequest) =>
    request<{ workspace: import('../../../shared/tenant').Workspace }>('POST', '/api/workspaces', body),
  workspaceDetail: (wsId: string) => request<WorkspaceDetail>('GET', `/api/workspaces/${wsId}`),
  addWorkspaceMember: (wsId: string, body: AddWorkspaceMemberRequest) =>
    request<{ member: unknown }>('POST', `/api/workspaces/${wsId}/members`, body),
  updateWorkspaceMember: (wsId: string, userId: string, role: 'admin' | 'member') =>
    request<{ ok: boolean }>('PATCH', `/api/workspaces/${wsId}/members/${userId}`, { role }),
  removeWorkspaceMember: (wsId: string, userId: string) =>
    request<{ ok: boolean }>('DELETE', `/api/workspaces/${wsId}/members/${userId}`),

  listDocs: (wsId: string) => request<{ docs: DocListItem[] }>('GET', `/api/workspaces/${wsId}/docs`),
  createDoc: (wsId: string, body: CreateDocRequest) =>
    request<{ doc: import('../../../shared/tenant').WorkspaceDoc }>('POST', `/api/workspaces/${wsId}/docs`, body),
  workspaceAudit: (wsId: string) => request<AuditResponse>('GET', `/api/workspaces/${wsId}/audit`),

  docDetail: (docId: string) => request<DocDetailResponse>('GET', `/api/docs/${docId}`),
  renameDoc: (docId: string, body: UpdateDocRequest) =>
    request<{ doc: import('../../../shared/tenant').WorkspaceDoc }>('PATCH', `/api/docs/${docId}`, body),
  deleteDoc: (docId: string) => request<{ ok: boolean }>('DELETE', `/api/docs/${docId}`),
  markOpened: (docId: string) => request<{ ok: boolean }>('POST', `/api/docs/${docId}/opened`),

  listDocMembers: (docId: string) => request<{ members: DocMemberView[] }>('GET', `/api/docs/${docId}/members`),
  grantDocMember: (docId: string, body: GrantDocMemberRequest) =>
    request<{ member: DocMemberView }>('PUT', `/api/docs/${docId}/members`, body),
  revokeDocMember: (docId: string, userId: string) =>
    request<{ ok: boolean }>('DELETE', `/api/docs/${docId}/members/${userId}`),
  docAudit: (docId: string) => request<AuditResponse>('GET', `/api/docs/${docId}/audit`),
}
