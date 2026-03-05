import { create } from 'zustand';
import type { Metric, ChartType } from './types';
import { fetchMetricGenerate, fetchMetricQuery } from './api';
import { metricsApi } from './storeApi';

interface MetricState {
  metrics: Metric[];
  generating: boolean;
  error: string | null;

  loadForDashboard: (dashboardId: string) => Promise<void>;
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
  deleteMetric: (id: string) => Promise<void>;
  refreshMetric: (id: string, connectionString: string) => Promise<void>;
  clearByDashboard: (dashboardId: string) => Promise<void>;
  updateMetric: (id: string, updates: Partial<Pick<Metric, 'sql' | 'chartType' | 'data' | 'definition'>>) => Promise<void>;
  findByName: (dashboardId: string, name: string) => Metric | undefined;
  reorderMetrics: (dashboardId: string, fromId: string, toId: string) => void;
}

export const useMetricStore = create<MetricState>((set, get) => ({
  metrics: [],
  generating: false,
  error: null,

  loadForDashboard: async (dashboardId) => {
    try {
      const list = await metricsApi.get(dashboardId);
      const others = get().metrics.filter(m => m.dashboardId !== dashboardId);
      set({ metrics: [...list, ...others] });
    } catch { /* ignore */ }
  },

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
      await metricsApi.add(metric);
      set({ metrics: [metric, ...get().metrics], generating: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '查询失败';
      set({ generating: false, error: msg });
      throw e;
    }
  },

  deleteMetric: async (id) => {
    await metricsApi.remove(id);
    set({ metrics: get().metrics.filter(m => m.id !== id) });
  },

  refreshMetric: async (id, connectionString) => {
    const metric = get().metrics.find(m => m.id === id);
    if (!metric) return;
    try {
      const result = await fetchMetricQuery({ sql: metric.sql, connectionString });
      await metricsApi.update(id, { data: result.rows });
      set({ metrics: get().metrics.map(m => m.id === id ? { ...m, data: result.rows } : m) });
    } catch { /* silent */ }
  },

  clearByDashboard: async (dashboardId) => {
    await metricsApi.clear(dashboardId);
    set({ metrics: get().metrics.filter(m => m.dashboardId !== dashboardId) });
  },

  updateMetric: async (id, updates) => {
    await metricsApi.update(id, updates);
    set({ metrics: get().metrics.map(m => m.id === id ? { ...m, ...updates } : m) });
  },

  findByName: (dashboardId, name) =>
    get().metrics.find(m => m.dashboardId === dashboardId && m.name === name),

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
    set({ metrics: [...dashMetrics, ...others] });
  },
}));
