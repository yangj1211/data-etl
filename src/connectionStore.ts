import { create } from 'zustand';
import { connectionApi } from './storeApi';

interface ConnectionState {
  history: string[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (cs: string) => Promise<void>;
  remove: (cs: string) => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  history: [],
  loaded: false,

  load: async () => {
    try {
      const list = await connectionApi.list();
      set({ history: list, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  save: async (cs) => {
    await connectionApi.save(cs);
    const filtered = get().history.filter(h => h !== cs);
    set({ history: [cs, ...filtered] });
  },

  remove: async (cs) => {
    await connectionApi.remove(cs);
    set({ history: get().history.filter(h => h !== cs) });
  },
}));
