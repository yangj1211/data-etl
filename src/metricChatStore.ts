import { create } from 'zustand';
import type { ChatMessage } from './types';
import { useMetricDefStore } from './metricDefStore';
import { useDashboardStore } from './dashboardStore';
import { useSchemaStore } from './schemaStore';
import { useProcessedTableStore } from './processedTableStore';

let msgId = 0;
const nextId = () => `mc-${++msgId}`;

function sysMsg(text: string): ChatMessage {
  return { id: nextId(), role: 'system', contents: [{ type: 'text', text }], timestamp: Date.now() };
}
function userMsg(text: string): ChatMessage {
  return { id: nextId(), role: 'user', contents: [{ type: 'text', text }], timestamp: Date.now() };
}

const STORAGE_PREFIX = 'etl-metric-chat-';

function persistMessages(dashboardId: string, messages: ChatMessage[]) {
  try {
    localStorage.setItem(STORAGE_PREFIX + dashboardId, JSON.stringify(messages));
  } catch { /* ignore */ }
}

function loadMessages(dashboardId: string): ChatMessage[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + dashboardId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

interface MetricChatState {
  dashboardId: string | null;
  messages: ChatMessage[];
  isProcessing: boolean;
  connectionString: string | null;

  loadForDashboard: (dashboardId: string) => void;
  setConnectionString: (cs: string) => void;
  sendMessage: (text: string) => void;
  reset: () => void;
}

const INTRO_TEXT = `你好，我是数据助手。

我同时具备**数据加工**和**指标定义**两种能力：

**数据加工**：查看库表结构、创建表、执行 SQL、字段映射、数据验证等
**指标定义**：根据表结构定义度量指标（如收入、订单量等）

你可以直接描述需求，比如：
- 「看看有哪些库和表」
- 「查看 xxx 表的结构」
- 「基于 xxx 表建一张目标表」
- 「我想定义一个收入指标」
- 「统计各产品线的订单量」`;

function getIntro(): ChatMessage {
  return { id: 'mc-intro', role: 'system', contents: [{ type: 'text', text: INTRO_TEXT }], timestamp: Date.now() };
}

export const useMetricChatStore = create<MetricChatState>((set, get) => ({
  dashboardId: null,
  messages: [getIntro()],
  isProcessing: false,
  connectionString: null,

  loadForDashboard: (dashboardId: string) => {
    msgId = 0;
    const saved = loadMessages(dashboardId);
    if (saved && saved.length > 0) {
      // restore msgId
      let maxId = 0;
      for (const m of saved) {
        const n = parseInt(m.id.replace(/\D/g, ''), 10);
        if (n > maxId) maxId = n;
      }
      msgId = maxId;
      set({ dashboardId, messages: saved, isProcessing: false });
    } else {
      set({ dashboardId, messages: [getIntro()], isProcessing: false });
    }
  },

  setConnectionString: (cs) => set({ connectionString: cs }),

  sendMessage: (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const { messages, connectionString, dashboardId } = get();
    const newMessages = [...messages, userMsg(trimmed)];
    set({ messages: newMessages, isProcessing: true });
    if (dashboardId) persistMessages(dashboardId, newMessages);

    const conversation = newMessages
      .filter(m => m.id !== 'mc-intro')
      .map(m => ({
        role: m.role === 'user' ? 'user' as const : 'assistant' as const,
        content: m.contents
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map(c => c.text).join('\n'),
      }))
      .filter(t => t.content.length > 0);

    (async () => {
      try {
        const res = await fetch('/api/metric-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation,
            connectionString,
            selectedTables: Array.from(useSchemaStore.getState().selectedTables),
            processedTables: (get().dashboardId
              ? useProcessedTableStore.getState().getByDashboard(get().dashboardId!).map(pt => ({
                  database: pt.database,
                  table: pt.table,
                  sourceTables: pt.sourceTables,
                  fieldMappings: pt.fieldMappings,
                  insertSql: pt.insertSql,
                }))
              : []),
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const updatedMessages = [...get().messages, sysMsg(data.reply)];
        set({ messages: updatedMessages, isProcessing: false });
        if (get().dashboardId) persistMessages(get().dashboardId!, updatedMessages);

        // 如果返回了确认的指标定义，自动保存
        if (data.metricDef) {
          const md = data.metricDef;
          const dbId = get().dashboardId || useDashboardStore.getState().activeDashboardId;
          if (dbId) {
            useMetricDefStore.getState().add({
              dashboardId: dbId,
              name: md.name,
              definition: md.definition,
              tables: md.tables || [],
              aggregation: md.aggregation || 'SUM',
              measureField: md.measureField || '',
            });
          }
        }
      } catch (err) {
        const errText = err instanceof Error ? err.message : '请求失败';
        const updatedMessages = [...get().messages, sysMsg(`请求失败：${errText}`)];
        set({ messages: updatedMessages, isProcessing: false });
        if (get().dashboardId) persistMessages(get().dashboardId!, updatedMessages);
      }
    })();
  },

  reset: () => {
    const { dashboardId } = get();
    msgId = 0;
    const fresh = [getIntro()];
    set({ messages: fresh, isProcessing: false });
    if (dashboardId) persistMessages(dashboardId, fresh);
  },
}));
