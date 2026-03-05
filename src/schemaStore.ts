import { create } from 'zustand';
import { fetchTableList } from './api';
import type { DatabaseTree } from './api';
import { schemaSelectionApi } from './storeApi';

interface SchemaState {
  dashboardId: string | null;
  tree: DatabaseTree[];
  loading: boolean;
  error: string | null;
  selectedTables: Set<string>;
  expandedDbs: Set<string>;

  loadForDashboard: (dashboardId: string) => Promise<void>;
  fetchTree: (connectionString: string) => Promise<void>;
  toggleDb: (db: string) => void;
  toggleTable: (db: string, table: string) => void;
  toggleAllDbTables: (db: string) => void;
  expandDb: (db: string) => void;
  collapseDb: (db: string) => void;
  clearSelection: () => void;
  reset: () => void;
}

function _persist(state: { dashboardId: string | null; selectedTables: Set<string> }) {
  if (state.dashboardId) {
    schemaSelectionApi.save(state.dashboardId, [...state.selectedTables]).catch(() => {});
  }
}

export const useSchemaStore = create<SchemaState>((set, get) => ({
  dashboardId: null,
  tree: [],
  loading: false,
  error: null,
  selectedTables: new Set(),
  expandedDbs: new Set(),

  loadForDashboard: async (dashboardId: string) => {
    try {
      const saved = await schemaSelectionApi.get(dashboardId);
      set({ dashboardId, selectedTables: new Set(saved) });
    } catch {
      set({ dashboardId, selectedTables: new Set() });
    }
  },

  fetchTree: async (connectionString: string) => {
    set({ loading: true, error: null });
    try {
      const data = await fetchTableList(connectionString);
      set({ tree: data.databases || [], loading: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '加载失败', loading: false });
    }
  },

  toggleTable: (db, table) => {
    const key = `${db}.${table}`;
    const next = new Set(get().selectedTables);
    if (next.has(key)) next.delete(key); else next.add(key);
    set({ selectedTables: next });
    _persist(get());
  },

  toggleAllDbTables: (db) => {
    const { tree, selectedTables } = get();
    const dbNode = tree.find(d => d.database === db);
    if (!dbNode) return;
    const allKeys = dbNode.tables.map(t => `${db}.${t}`);
    const allSelected = allKeys.every(k => selectedTables.has(k));
    const next = new Set(selectedTables);
    if (allSelected) allKeys.forEach(k => next.delete(k));
    else allKeys.forEach(k => next.add(k));
    set({ selectedTables: next });
    _persist(get());
  },

  toggleDb: (db) => get().toggleAllDbTables(db),

  expandDb: (db) => {
    const next = new Set(get().expandedDbs);
    next.add(db);
    set({ expandedDbs: next });
  },

  collapseDb: (db) => {
    const next = new Set(get().expandedDbs);
    next.delete(db);
    set({ expandedDbs: next });
  },

  clearSelection: () => {
    set({ selectedTables: new Set() });
    _persist(get());
  },

  reset: () => {
    set({ tree: [], loading: false, error: null, selectedTables: new Set(), expandedDbs: new Set() });
    _persist(get());
  },
}));
