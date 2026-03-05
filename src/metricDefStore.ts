import { create } from 'zustand';
import type { MetricDef } from './types';
import { metricDefApi } from './storeApi';

interface MetricDefState {
  defs: MetricDef[];
  loadForDashboard: (dashboardId: string) => Promise<void>;
  add: (def: Omit<MetricDef, 'id' | 'createdAt'>) => Promise<MetricDef>;
  remove: (id: string) => Promise<void>;
  getAll: () => MetricDef[];
  getByDashboard: (dashboardId: string) => MetricDef[];
}

export const useMetricDefStore = create<MetricDefState>((set, get) => ({
  defs: [],

  loadForDashboard: async (dashboardId) => {
    try {
      const list = await metricDefApi.get(dashboardId);
      const others = get().defs.filter(d => d.dashboardId !== dashboardId);
      set({ defs: [...list, ...others] });
    } catch { /* ignore */ }
  },

  add: async (entry) => {
    const result = await metricDefApi.add(entry);
    set({ defs: [result, ...get().defs] });
    return result;
  },

  remove: async (id) => {
    await metricDefApi.remove(id);
    set({ defs: get().defs.filter(d => d.id !== id) });
  },

  getAll: () => get().defs,
  getByDashboard: (dashboardId) => get().defs.filter(d => d.dashboardId === dashboardId),
}));
