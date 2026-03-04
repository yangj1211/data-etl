export interface MappingFromModel {
  targetField: string;
  source: string;
  logic: string;
  sql: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  connectionString?: string | null;
  /** 当前 ETL 步骤 1～6，后端仅执行本步操作 */
  currentStep?: number;
  /** 用户选中的库表列表（格式 db.table） */
  selectedTables?: string[];
  /** 复用加工逻辑上下文 */
  reuseContext?: {
    database: string;
    table: string;
    sourceTables: string[];
    fieldMappings: { targetField: string; sourceTable: string; sourceExpr: string; transform: string }[];
    insertSql: string;
    chatHistory?: { role: string; content: string }[];
  };
}

import type { ChartType } from './types';

/** 指标操作联合类型，由后端 /api/chat 在检测到指标意图时返回 */
export type MetricAction =
  | { type: 'preview'; name: string; definition: string; tables: string[]; sql: string; chartType: ChartType; explanation: string }
  | { type: 'create'; name: string; definition: string; tables: string[]; sql: string; chartType: ChartType; data: Record<string, unknown>[] }
  | { type: 'update'; targetMetricName: string; sql?: string; chartType?: ChartType; data?: Record<string, unknown>[] }
  | { type: 'refresh'; targetMetricName: string; data: Record<string, unknown>[] };

export interface ChatApiResponse {
  reply: string;
  connectionReceived?: boolean;
  /** 本轮是否有一次连接测试且为成功 */
  connectionTestOk?: boolean;
  /** 模型判断的当前步骤 1～6 */
  currentStep?: number;
  /** 指标操作指令，当后端检测到指标意图时返回 */
  metricAction?: MetricAction;
  /** 后端在 INSERT 成功时返回的结构化加工表信息 */
  processedTable?: {
    database: string;
    table: string;
    insertSql: string;
    sourceTables: string[];
    fieldMappings: { targetField: string; sourceTable: string; sourceExpr: string; transform: string }[];
  };
}

export async function fetchChatWithModel(
  conversation: ConversationTurn[],
  context: ChatContext,
): Promise<ChatApiResponse> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation, context }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface MappingApiRequest {
  /** 当前轮用户输入（保留兼容） */
  message: string;
  /** 完整对话历史，供 DeepSeek 结合上下文理解与转换 */
  conversation?: ConversationTurn[];
  targetTableName: string;
  targetFields: { name: string; type: string; comment: string }[];
  existingMappings: { targetField: string; source: string; logic: string; sql: string; status: string }[];
}

export interface MappingApiResponse {
  mappings: MappingFromModel[];
}

export async function fetchMappingsFromModel(
  payload: MappingApiRequest,
): Promise<MappingApiResponse> {
  const res = await fetch('/api/mapping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface DmlApiRequest {
  targetTableFullName: string;
  mappings: { targetField: string; source: string; logic: string; sql: string }[];
}

export interface DmlApiResponse {
  dml: string;
}

export async function fetchDmlFromModel(payload: DmlApiRequest): Promise<DmlApiResponse> {
  const res = await fetch('/api/dml', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** 根据当前 SQL 让模型优化（如子查询改 JOIN） */
export async function fetchOptimizeDml(currentDml: string): Promise<DmlApiResponse> {
  const res = await fetch('/api/dml/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dml: currentDml }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}


// ────────── 指标相关 API ──────────

export interface DatabaseTree {
  database: string;
  tables: string[];
}

export async function fetchTableList(connectionString: string): Promise<{ databases: DatabaseTree[] }> {
  const res = await fetch('/api/tables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionString }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface MetricMatchRequest {
  description: string;
  metricDefs: {
    name: string;
    definition: string;
    tables: string[];
    aggregation: string;
    measureField: string;
  }[];
}

export interface MetricMatchResponse {
  matches: { name: string; reason: string }[];
  suggestion: string;
}

export async function fetchMetricMatch(payload: MetricMatchRequest): Promise<MetricMatchResponse> {
  const res = await fetch('/api/metric/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface MetricGenerateRequest {
  metricName: string;
  description: string;
  metricDefs: {
    name: string;
    definition: string;
    tables: string[];
    aggregation: string;
    measureField: string;
  }[];
  connectionString: string;
}

export interface MetricGenerateResponse {
  sql: string;
  chartType: 'number' | 'bar' | 'line' | 'pie' | 'table';
  explanation: string;
  derivedMetricDef?: {
    name: string;
    definition: string;
    tables: string[];
    aggregation: string;
    measureField: string;
  } | null;
}

export async function fetchMetricGenerate(payload: MetricGenerateRequest): Promise<MetricGenerateResponse> {
  const res = await fetch('/api/metric/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface MetricQueryRequest {
  sql: string;
  connectionString: string;
}

export interface MetricQueryResponse {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export async function fetchMetricQuery(payload: MetricQueryRequest): Promise<MetricQueryResponse> {
  const res = await fetch('/api/metric/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ────────── 血缘分析 API（含前端缓存） ──────────

// 前端内存缓存，避免重复请求血缘分析
const _lineageCache = new Map<string, unknown>();

function _cacheKey(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

export interface MetricLineageTable {
  name: string;
  role: string;
  fields: string[];
}

export interface MetricLineageLayer {
  level: 'source' | 'processed' | 'metric';
  label: string;
  tables: MetricLineageTable[];
}

export interface MetricLineageEdge {
  from: { table: string; field: string };
  to: { table: string; field: string };
  transform: string;
}

export interface MetricLineageResponse {
  layers: MetricLineageLayer[];
  edges: MetricLineageEdge[];
  summary: string;
}

export async function fetchMetricLineage(payload: {
  metricDef: { name: string; definition: string; tables: string[]; aggregation: string; measureField: string };
  processedTables: { database: string; table: string; sourceTables: string[]; fieldMappings: { targetField: string; sourceTable: string; sourceExpr: string; transform: string }[]; insertSql: string }[];
  connectionString: string;
}): Promise<MetricLineageResponse> {
  const key = _cacheKey({ type: 'metric-lineage', metric: payload.metricDef.name, tables: payload.metricDef.tables });
  const cached = _lineageCache.get(key);
  if (cached) return cached as MetricLineageResponse;

  const res = await fetch('/api/metric-lineage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  const data: MetricLineageResponse = await res.json();
  _lineageCache.set(key, data);
  return data;
}

export interface LineageSourceTable {
  name: string;
  alias: string;
  role: '基表' | '维表' | '关联表';
  joinType: string;
  joinCondition: string;
}

export interface LineageFieldMapping {
  targetField: string;
  sourceTable: string;
  sourceField: string;
  transform: string;
  expression: string;
}

export interface LineageJoinRelation {
  leftTable: string;
  rightTable: string;
  joinType: string;
  condition: string;
}

export interface LineageResponse {
  targetTable: string;
  sourceTables: LineageSourceTable[];
  fieldMappings: LineageFieldMapping[];
  joinRelations: LineageJoinRelation[];
  groupBy: string;
  filters: string;
}

export async function fetchLineage(payload: {
  sql: string;
  connectionString: string;
  targetTable: string;
  fieldMappings?: { targetField: string; sourceTable: string; sourceExpr: string; transform: string }[];
  sourceTables?: string[];
}): Promise<LineageResponse> {
  const key = _cacheKey({ type: 'lineage', sql: payload.sql, target: payload.targetTable });
  const cached = _lineageCache.get(key);
  if (cached) return cached as LineageResponse;

  const res = await fetch('/api/lineage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  const data: LineageResponse = await res.json();
  _lineageCache.set(key, data);
  return data;
}

// ────────── 加工逻辑摘要 API ──────────

export interface LineageSummary {
  title: string;
  purpose?: string;
  steps: string[];
  keyLogic: string[];
  reuseTips?: string;
}

export async function fetchLineageSummary(payload: {
  chatHistory: { role: string; content: string }[];
  insertSql: string;
  targetTable: string;
  sourceTables: string[];
}): Promise<LineageSummary> {
  const key = _cacheKey({ type: 'lineage-summary', sql: payload.insertSql, target: payload.targetTable });
  const cached = _lineageCache.get(key);
  if (cached) return cached as LineageSummary;

  const res = await fetch('/api/lineage/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  const data: LineageSummary = await res.json();
  _lineageCache.set(key, data);
  return data;
}
