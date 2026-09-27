import type {
  ApiError,
  AppState,
  Contact,
  Group,
  KeywordRule,
  KeywordRuleInput,
  Repeater,
  RepeaterInput,
  ScriptInfo,
  SendRequest,
  SignalMessage,
  TransportStatus,
} from '@automator/shared';

/** Error thrown for any non-2xx response; message comes from the ApiError body when present. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface RuleTestResult {
  matches: { ruleId: string; output: string | null }[];
}

export interface SimulateIncomingRequest {
  from: string;
  body: string;
  groupId?: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiRequestError(`Cannot reach the automator server (${err instanceof Error ? err.message : String(err)})`, 0);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`.trim();
    try {
      const data = (await res.json()) as Partial<ApiError> | null;
      if (data && typeof data.error === 'string' && data.error) message = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

export const api = {
  state: () => request<AppState>('GET', '/api/state'),
  status: () => request<TransportStatus>('GET', '/api/status'),
  refreshContacts: () => request<{ contacts: Contact[]; groups: Group[] }>('POST', '/api/contacts/refresh'),
  messages: (limit?: number) =>
    request<SignalMessage[]>('GET', limit === undefined ? '/api/messages' : `/api/messages?limit=${limit}`),
  send: (req: SendRequest) => request<SignalMessage>('POST', '/api/send', req),

  listRepeaters: () => request<Repeater[]>('GET', '/api/repeaters'),
  createRepeater: (input: RepeaterInput) => request<Repeater>('POST', '/api/repeaters', input),
  updateRepeater: (id: string, patch: Partial<RepeaterInput>) =>
    request<Repeater>('PUT', `/api/repeaters/${enc(id)}`, patch),
  deleteRepeater: (id: string) => request<void>('DELETE', `/api/repeaters/${enc(id)}`),
  runRepeater: (id: string) => request<Repeater>('POST', `/api/repeaters/${enc(id)}/run`),

  listRules: () => request<KeywordRule[]>('GET', '/api/rules'),
  createRule: (input: KeywordRuleInput) => request<KeywordRule>('POST', '/api/rules', input),
  updateRule: (id: string, patch: Partial<KeywordRuleInput>) =>
    request<KeywordRule>('PUT', `/api/rules/${enc(id)}`, patch),
  deleteRule: (id: string) => request<void>('DELETE', `/api/rules/${enc(id)}`),
  reorderRules: (ids: string[]) => request<KeywordRule[]>('POST', '/api/rules/reorder', { ids }),
  testRules: (body: string, sender?: string, group?: boolean) =>
    request<RuleTestResult>('POST', '/api/rules/test', { body, sender, group }),

  listScripts: () => request<ScriptInfo[]>('GET', '/api/scripts'),
  getScript: (name: string) => request<{ info: ScriptInfo; source: string }>('GET', `/api/scripts/${enc(name)}`),
  saveScript: (name: string, source: string) => request<ScriptInfo>('PUT', `/api/scripts/${enc(name)}`, { source }),
  deleteScript: (name: string) => request<void>('DELETE', `/api/scripts/${enc(name)}`),
  setScriptEnabled: (name: string, enabled: boolean) =>
    request<ScriptInfo>('POST', `/api/scripts/${enc(name)}/enable`, { enabled }),
  reloadScripts: () => request<ScriptInfo[]>('POST', '/api/scripts/reload'),

  simulateIncoming: (req: SimulateIncomingRequest) => request<void>('POST', '/api/simulate/incoming', req),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
