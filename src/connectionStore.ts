import { create } from 'zustand';

const STORAGE_KEY = 'etl-saved-connections';

export interface SavedConnection {
  /** 连接串 */
  connectionString: string;
  /** 显示名称（从连接串中提取 host/db） */
  label: string;
  /** 上次使用时间 */
  lastUsed: number;
}

function parseLabel(cs: string): string {
  try {
    const m = cs.match(/:\/\/([^:]+):.*@([^:\/]+):?(\d+)?\/?([^?]*)/);
    if (m) {
      const user = m[1];
      const host = m[2];
      const db = m[4] || '';
      const short = host.length > 20 ? host.slice(0, 17) + '...' : host;
      return db ? `${user}@${short}/${db}` : `${user}@${short}`;
    }
  } catch { /* ignore */ }
  return cs.length > 40 ? cs.slice(0, 37) + '...' : cs;
}

function loadAll(): SavedConnection[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAll(list: SavedConnection[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

interface ConnectionState {
  connections: SavedConnection[];
  /** 连接成功后调用，保存/更新连接串 */
  save: (connectionString: string) => void;
  remove: (connectionString: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: loadAll(),

  save: (connectionString: string) => {
    const existing = get().connections;
    const idx = existing.findIndex(c => c.connectionString === connectionString);
    let updated: SavedConnection[];
    if (idx >= 0) {
      updated = [...existing];
      updated[idx] = { ...updated[idx], lastUsed: Date.now() };
    } else {
      updated = [
        { connectionString, label: parseLabel(connectionString), lastUsed: Date.now() },
        ...existing,
      ];
    }
    // 最多保留 10 条，按最近使用排序
    updated.sort((a, b) => b.lastUsed - a.lastUsed);
    updated = updated.slice(0, 10);
    saveAll(updated);
    set({ connections: updated });
  },

  remove: (connectionString: string) => {
    const updated = get().connections.filter(c => c.connectionString !== connectionString);
    saveAll(updated);
    set({ connections: updated });
  },
}));
