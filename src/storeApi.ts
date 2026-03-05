/** API helpers for backend persistent storage. */

const BASE = '/api/store';

async function _get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function _post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}

async function _put(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
}

async function _patch(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
}

async function _del(path: string, body?: unknown): Promise<void> {
  const opts: RequestInit = { method: 'DELETE' };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

import type { Dashboard, ChatMessage, ProcessedTable, MetricDef } from './types';

// ─── Dashboards ───
export const dashboardApi = {
  list: () => _get<Dashboard[]>('/dashboards'),
  create: (id: string, name: string, description: string) =>
    _post<Dashboard>('/dashboards', { id, name, description }),
  remove: (id: string) => _del(`/dashboards/${id}`),
  rename: (id: string, name: string) => _patch(`/dashboards/${id}`, { name }),
};

// ─── ETL State ───
export const etlStateApi = {
  get: (did: string) => _get<{ step: number; connectionString: string | null }>(`/etl-state/${did}`),
  set: (did: string, data: { step?: number; connectionString?: string }) =>
    _put(`/etl-state/${did}`, data),
};

// ─── Chat Messages ───
export const chatApi = {
  get: (did: string) => _get<ChatMessage[]>(`/chat-messages/${did}`),
  save: (did: string, messages: ChatMessage[]) =>
    _put(`/chat-messages/${did}`, { messages }),
  clear: (did: string) => _del(`/chat-messages/${did}`),
};

// ─── Metric Chat Messages ───
export const metricChatApi = {
  get: (did: string) => _get<ChatMessage[]>(`/metric-chat-messages/${did}`),
  save: (did: string, messages: ChatMessage[]) =>
    _put(`/metric-chat-messages/${did}`, { messages }),
  clear: (did: string) => _del(`/metric-chat-messages/${did}`),
};

// ─── Processed Tables ───
export const processedTableApi = {
  get: (did: string) => _get<ProcessedTable[]>(`/processed-tables/${did}`),
  addOrUpdate: (did: string, entry: Omit<ProcessedTable, 'id'>) =>
    _post(`/processed-tables/${did}`, entry),
  remove: (did: string, ptId: string) => _del(`/processed-tables/${did}/${ptId}`),
  clear: (did: string) => _del(`/processed-tables-all/${did}`),
};

// ─── Metric Defs ───
export const metricDefApi = {
  get: (did: string) => _get<MetricDef[]>(`/metric-defs/${did}`),
  add: (entry: Omit<MetricDef, 'id' | 'createdAt'> & { dashboardId: string }) =>
    _post<MetricDef>('/metric-defs', entry),
  remove: (id: string) => _del(`/metric-defs/${id}`),
};

// ─── Connections ───
export const connectionApi = {
  list: () => _get<string[]>('/connections'),
  save: (cs: string) => _post('/connections', { connectionString: cs }),
  remove: (cs: string) => _del('/connections', { connectionString: cs }),
};

// ─── Schema Selections ───
export const schemaSelectionApi = {
  get: (did: string) => _get<string[]>(`/schema-selection/${did}`),
  save: (did: string, tables: string[]) => _put(`/schema-selection/${did}`, { selectedTables: tables }),
};


// ─── Metrics (monitoring data) ───
import type { Metric, ChartType } from './types';

export const metricsApi = {
  get: (did: string) => _get<Metric[]>(`/metrics/${did}`),
  add: (entry: Metric) => _post<Metric>('/metrics', entry),
  update: (id: string, updates: Partial<Pick<Metric, 'sql' | 'chartType' | 'data' | 'definition'>>) =>
    _patch(`/metrics/${id}`, updates),
  remove: (id: string) => _del(`/metrics/${id}`),
  clear: (did: string) => _del(`/metrics-all/${did}`),
};
