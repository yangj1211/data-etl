import { create } from 'zustand';
import type { Dashboard } from './types';
import { dashboardApi } from './storeApi';

interface DashboardState {
  dashboards: Dashboard[];
  activeDashboardId: string | null;
  loaded: boolean;

  loadDashboards: () => Promise<void>;
  createDashboard: (name: string, description: string) => Promise<string>;
  deleteDashboard: (id: string) => Promise<void>;
  renameDashboard: (id: string, name: string) => Promise<void>;
  openDashboard: (id: string) => void;
  goHome: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  dashboards: [],
  activeDashboardId: null,
  loaded: false,

  loadDashboards: async () => {
    try {
      const list = await dashboardApi.list();
      set({ dashboards: list, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  createDashboard: async (name, description) => {
    const id = `db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const d = await dashboardApi.create(id, name, description);
    set({ dashboards: [d, ...get().dashboards], activeDashboardId: d.id });
    return d.id;
  },

  deleteDashboard: async (id) => {
    await dashboardApi.remove(id);
    set({ dashboards: get().dashboards.filter(d => d.id !== id) });
  },

  renameDashboard: async (id, name) => {
    await dashboardApi.rename(id, name);
    set({
      dashboards: get().dashboards.map(d =>
        d.id === id ? { ...d, name, updatedAt: Date.now() } : d
      ),
    });
  },

  openDashboard: (id) => set({ activeDashboardId: id }),
  goHome: () => set({ activeDashboardId: null }),
}));
