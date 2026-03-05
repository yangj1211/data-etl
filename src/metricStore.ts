import { create } from 'zustand';
import type { Metric, ChartType } from './types';
import { fetchMetricGenerate, fetchMetricQuery } from './api';

const STORAGE_KEY = 'etl-metrics';

function loadAll(): Metric[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAll(metrics: Metric[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(metrics));
}

interface MetricState {
  metrics: Metric[];
  generating: boolean;
  error: string | null;

  getByDashboard: (dashboardId: string) => Metric[];
  generateMetric: (opts: {
    dashboardId: string;
    name: string;
    description: string;
    metricDefs: {
      name: string;
      definition: string;
      tables: string[];
      aggregation: string;
      measureField: string;
    }[];
    connectionString: string;
    processedTables?: {
      database: string;
      table: string;
      sourceTables: string[];
      fieldMappings: { targetField: string; sourceTable: string; sourceExpr: string; transform: string }[];
      insertSql: string;
    }[];
  }) => Promise<{ sql: string; chartType: ChartType; explanation: string; derivedMetricDef?: { name: string; definition: string; tables: string[]; aggregation: string; measureField: string } | null }>;
  confirmMetric: (opts: {
    dashboardId: string;
    name: string;
    description: string;
    tables: string[];
    sql: string;
    chartType: ChartType;
    connectionString: string;
  }) => Promise<void>;
  deleteMetric: (id: string) => void;
  refreshMetric: (id: string, connectionString: string) => Promise<void>;
  clearByDashboard: (dashboardId: string) => void;
  updateMetric: (id: string, updates: Partial<Pick<Metric, 'sql' | 'chartType' | 'data' | 'definition'>>) => void;
  findByName: (dashboardId: string, name: string) => Metric | undefined;
  reorderMetrics: (dashboardId: string, fromId: string, toId: string) => void;
}

export const useMetricStore = create<MetricState>((set, get) => ({
  metrics: loadAll(),
  generating: false,
  error: null,

  getByDashboard: (dashboardId) => get().metrics.filter(m => m.dashboardId === dashboardId),

  generateMetric: async ({ dashboardId, name, description, metricDefs, connectionString, processedTables }) => {
    set({ generating: true, error: null });
    try {
      const result = await fetchMetricGenerate({ metricName: name, description, metricDefs, connectionString, processedTables });
      set({ generating: false });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : '生成失败';
      set({ generating: false, error: msg });
      throw e;
    }
  },

  confirmMetric: async ({ dashboardId, name, description, tables, sql, chartType, connectionString }) => {
    set({ generating: true, error: null });
    try {
      const queryResult = await fetchMetricQuery({ sql, connectionString });
      const metric: Metric = {
        id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        dashboardId,
        name,
        definition: description,
        tables,
        sql,
        chartType,
        data: queryResult.rows,
        createdAt: Date.now(),
      };
      const updated = [metric, ...get().metrics];
      saveAll(updated);
      set({ metrics: updated, generating: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '查询失败';
      set({ generating: false, error: msg });
      throw e;
    }
  },

  deleteMetric: (id) => {
    const updated = get().metrics.filter(m => m.id !== id);
    saveAll(updated);
    set({ metrics: updated });
  },

  refreshMetric: async (id, connectionString) => {
    const metric = get().metrics.find(m => m.id === id);
    if (!metric) return;
    try {
      const result = await fetchMetricQuery({ sql: metric.sql, connectionString });
      const updated = get().metrics.map(m =>
        m.id === id ? { ...m, data: result.rows } : m
      );
      saveAll(updated);
      set({ metrics: updated });
    } catch (e) {
      // silent fail for refresh
    }
  },

  clearByDashboard: (dashboardId) => {
    const updated = get().metrics.filter(m => m.dashboardId !== dashboardId);
    saveAll(updated);
    set({ metrics: updated });
  },

  updateMetric: (id, updates) => {
    const updated = get().metrics.map(m =>
      m.id === id ? { ...m, ...updates } : m
    );
    saveAll(updated);
    set({ metrics: updated });
  },

  findByName: (dashboardId, name) => {
    return get().metrics.find(m => m.dashboardId === dashboardId && m.name === name);
  },

  reorderMetrics: (dashboardId, fromId, toId) => {
    if (fromId === toId) return;
    const all = get().metrics;
    const dashMetrics = all.filter(m => m.dashboardId === dashboardId);
    const others = all.filter(m => m.dashboardId !== dashboardId);
    const fromIdx = dashMetrics.findIndex(m => m.id === fromId);
    const toIdx = dashMetrics.findIndex(m => m.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = dashMetrics.splice(fromIdx, 1);
    dashMetrics.splice(toIdx, 0, moved);
    const updated = [...dashMetrics, ...others];
    saveAll(updated);
    set({ metrics: updated });
  },
}));
