import { create } from 'zustand';
import type { ProcessedTable } from './types';
import { processedTableApi } from './storeApi';

interface ProcessedTableState {
  tables: ProcessedTable[];
  getByDashboard: (dashboardId: string) => ProcessedTable[];
  loadForDashboard: (dashboardId: string) => Promise<void>;
  addOrUpdate: (entry: Omit<ProcessedTable, 'id'>) => Promise<void>;
  remove: (id: string, dashboardId: string) => Promise<void>;
  clearByDashboard: (dashboardId: string) => Promise<void>;
}

export const useProcessedTableStore = create<ProcessedTableState>((set, get) => ({
  tables: [],

  getByDashboard: (dashboardId) =>
    get().tables.filter(t => t.dashboardId === dashboardId),

  loadForDashboard: async (dashboardId) => {
    try {
      const list = await processedTableApi.get(dashboardId);
      // Replace entries for this dashboard, keep others
      const others = get().tables.filter(t => t.dashboardId !== dashboardId);
      set({ tables: [...list, ...others] });
    } catch { /* ignore */ }
  },

  addOrUpdate: async (entry) => {
    const did = entry.dashboardId;
    await processedTableApi.addOrUpdate(did, entry);
    // Reload from backend to get merged result
    const list = await processedTableApi.get(did);
    const others = get().tables.filter(t => t.dashboardId !== did);
    set({ tables: [...list, ...others] });
  },

  remove: async (id, dashboardId) => {
    await processedTableApi.remove(dashboardId, id);
    set({ tables: get().tables.filter(t => !(t.id === id && t.dashboardId === dashboardId)) });
  },

  clearByDashboard: async (dashboardId) => {
    await processedTableApi.clear(dashboardId);
    set({ tables: get().tables.filter(t => t.dashboardId !== dashboardId) });
  },
}));
