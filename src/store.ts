import { create } from 'zustand';
import type { ChatMessage, ContentBlock, EtlStep, FieldMapping } from './types';
import type { ConversationTurn } from './api';
import { fetchChatWithModel } from './api';
import { useProcessedTableStore } from './processedTableStore';
import { useSchemaStore } from './schemaStore';
import { useConnectionStore } from './connectionStore';
import { chatApi, etlStateApi } from './storeApi';

export interface ReuseContext {
  database: string;
  table: string;
  sourceTables: string[];
  fieldMappings: FieldMapping[];
  insertSql: string;
  chatHistory?: { role: string; content: string }[];
}

let msgId = 0;
const nextId = () => `msg-${++msgId}`;

function sysMsg(...contents: ContentBlock[]): ChatMessage {
  return { id: nextId(), role: 'system', contents, timestamp: Date.now() };
}
function userMsg(text: string, extraBlocks?: ContentBlock[]): ChatMessage {
  const contents: ContentBlock[] = [];
  if (extraBlocks) contents.push(...extraBlocks);
  contents.push({ type: 'text', text });
  return { id: nextId(), role: 'user', contents, timestamp: Date.now() };
}

interface AppState {
  dashboardId: string | null;
  step: EtlStep;
  connectionString: string | null;
  messages: ChatMessage[];
  isProcessing: boolean;

  loadForDashboard: (dashboardId: string) => void;
  sendMessage: (text: string, reuseContext?: ReuseContext) => void;
  reset: () => void;
}

/** 开场语 */
function getIntroMessage(): ChatMessage {
  const text = `欢迎使用智能 ETL 助手。

通过自然语言对话，你可以快速完成数据建模与加工流程：
• 连接数据库
• 选择基表
• 定义目标表结构
• 建立字段映射
• 自动校验与异常溯源

第一次使用？输入「**操作指南**」获取演示说明。
或直接提供 MySQL 连接串，立即开始构建你的数据任务。例如：\n\`mysql://username:password@host:3306/database_name\``;
  return {
    id: 'intro',
    role: 'system',
    contents: [{ type: 'text' as const, text }],
    timestamp: Date.now(),
  };
}

/** 操作指南演示消息 */
function getDemoConversationMessages(): ChatMessage[] {
  const t = Date.now();
  const msg = (id: string, role: 'system' | 'user', text: string): ChatMessage => ({
    id, role, contents: [{ type: 'text' as const, text }], timestamp: t,
  });
  return [
    msg('demo-0', 'system', '下面是一段**自问自答演示**（编造库表），带您走完从连接、选表、建表、映射到验证的全流程。\n\n请先在下方输入您的 **MySQL 连接串**；演示中将使用示例连接串继续。'),
    msg('demo-1', 'user', 'mysql://user:pass@host:3306/demo'),
    msg('demo-2', 'system', '连接成功。接下来请告诉我你想基于哪个库的哪张表做数据加工？'),
    msg('demo-3', 'user', '用 demo.orders 做加工'),
    msg('demo-4', 'system', '已查询表 `demo`.`orders` 的结构和前 10 条数据。\n\n**验证 SQL（表结构）**：\n```sql\nDESCRIBE `demo`.`orders`;\n```\n\n**实际返回（表结构）**：\n\n| Field | Type | Null | Key | Default | Extra |\n|-------|------|------|-----|---------|-------|\n| order_id | int | NO | PRI | NULL | auto_increment |\n| user_id | int | YES | | NULL | |\n| amount | decimal(10,2) | YES | | NULL | |\n| created_at | datetime | YES | | NULL | |\n\n**SQL 返回码**：DESCRIBE 执行成功，返回列数: 4。\n\n基表已确认，请描述目标表要有哪些字段。'),
    msg('demo-5', 'user', '目标表 demo.order_summary 要有 user_id、总金额 total_amount、笔数 order_count'),
    msg('demo-6', 'system', '生成建表 SQL 如下，请确认后说「确认建表」执行。\n\n```sql\nCREATE TABLE `demo`.`order_summary` (\n  `user_id` int DEFAULT NULL COMMENT \'用户ID\',\n  `total_amount` decimal(14,2) DEFAULT NULL COMMENT \'总金额\',\n  `order_count` int DEFAULT NULL COMMENT \'订单笔数\'\n) COMMENT=\'按用户汇总订单\';\n```'),
    msg('demo-7', 'user', '确认建表'),
    msg('demo-8', 'system', '建表成功。目标表已创建，请描述每个字段的数据来源与加工逻辑。'),
    msg('demo-9', 'user', 'user_id 取基表 user_id，总金额按 user_id 汇总 amount，笔数按 user_id 数订单'),
    msg('demo-10', 'system', '已生成数据映射 SQL，确认后说「执行」即可。\n\n```sql\nINSERT INTO `demo`.`order_summary` (`user_id`, `total_amount`, `order_count`)\nSELECT `user_id`, SUM(`amount`) AS total_amount, COUNT(*) AS order_count\nFROM `demo`.`orders`\nGROUP BY `user_id`;\n```'),
    msg('demo-11', 'user', '执行'),
    msg('demo-12', 'system', '执行完成。**SQL 返回码**：影响行数: 42。\n\n数据已写入目标表，可以发送「开始验证」检查数据质量。'),
    msg('demo-13', 'user', '开始验证'),
    msg('demo-14', 'system', '已对目标表 `demo`.`order_summary` 做空值分析。\n\n| column | nullCount | nullRate |\n|--------|-----------|----------|\n| user_id | 0 | 0.00% |\n| total_amount | 0 | 0.00% |\n| order_count | 0 | 0.00% |\n\n**SQL 返回码**：执行成功，总行数: 42。各列无空值，数据正常。'),
    msg('demo-15', 'system', '以上就是完整流程。\n\n现在，请在下方输入 MySQL 连接串，例如：\n`mysql://username:password@host:3306/database_name`\n开始构建数据任务。'),
  ];
}

function getDefaultState() {
  return {
    dashboardId: null as string | null,
    step: 1 as EtlStep,
    connectionString: null as string | null,
    messages: [getIntroMessage()],
    isProcessing: false,
  };
}

function looksLikeConnectionString(s: string): boolean {
  if (/^mysql:\/\//i.test(s) || (/^[a-z]+:\/\//i.test(s) && s.includes('@') && /:\d+/.test(s))) return true;
  return /mysql\s+.+-h\s+/i.test(s) && (/-u\s/i.test(s) || /-u'/.test(s));
}

function wantsDemoGuide(text: string): boolean {
  const t = text.trim();
  return /操作指南|看演示|看指南|^演示$|^指南$/.test(t) || /^[1一]\.?\s*看/.test(t);
}

function getDemoMessageDelay(msg: ChatMessage): number {
  const base = 1200;
  if (msg.role === 'user') return base;
  const text = msg.contents[0]?.type === 'text' ? msg.contents[0].text : '';
  return base + Math.min(3500, Math.floor(text.length / 50) * 250);
}

/** Persist to backend (fire-and-forget) */
function persistState(state: { dashboardId: string | null; step: EtlStep; connectionString: string | null; messages: ChatMessage[] }) {
  if (!state.dashboardId) return;
  const did = state.dashboardId;
  chatApi.save(did, state.messages).catch(() => {});
  etlStateApi.set(did, { step: state.step, connectionString: state.connectionString || undefined }).catch(() => {});
}

export const useStore = create<AppState>((set, get) => ({
  ...getDefaultState(),

  loadForDashboard: (dashboardId: string) => {
    msgId = 0;
    // Set default state immediately, then load from backend
    set({ ...getDefaultState(), dashboardId });

    (async () => {
      try {
        const [savedMessages, savedState] = await Promise.all([
          chatApi.get(dashboardId),
          etlStateApi.get(dashboardId),
        ]);
        if (savedMessages && savedMessages.length > 0) {
          const maxId = savedMessages.reduce((max, m) => {
            const match = m.id.match(/^msg-(\d+)$/);
            return match ? Math.max(max, parseInt(match[1])) : max;
          }, 0);
          msgId = maxId;
          set({
            messages: savedMessages,
            step: (savedState.step || 1) as EtlStep,
            connectionString: savedState.connectionString || null,
          });
          if (savedState.connectionString) {
            useSchemaStore.getState().fetchTree(savedState.connectionString);
            useConnectionStore.getState().save(savedState.connectionString);
          }
        }
      } catch { /* first load, no data yet */ }
    })();
  },

  sendMessage: (text: string, reuseContext?: ReuseContext) => {
    const trimmed = text.trim();
    if (!trimmed && !reuseContext) return;

    const { messages, step, dashboardId } = get();

    let userText = trimmed;
    const extraBlocks: ContentBlock[] = [];
    if (reuseContext) {
      extraBlocks.push({
        type: 'reuse_card',
        database: reuseContext.database,
        table: reuseContext.table,
        sourceTables: reuseContext.sourceTables,
      });
      if (!userText) {
        userText = `一键复用 ${reuseContext.database}.${reuseContext.table} 的加工逻辑，请直接生成加工方案`;
      }
      set({ step: 4 as EtlStep });
    }

    const newMessages = [...messages, userMsg(userText, extraBlocks.length > 0 ? extraBlocks : undefined)];
    set({ messages: newMessages, isProcessing: true });
    persistState({ ...get(), messages: newMessages });

    if (step === 1 && wantsDemoGuide(userText)) {
      const demoList = getDemoConversationMessages();
      let idx = 0;
      const run = () => {
        if (idx >= demoList.length) {
          set({ isProcessing: false });
          persistState(get());
          return;
        }
        const next = { ...demoList[idx], id: `demo-${idx}-${Date.now()}` };
        set((s) => ({ messages: [...s.messages, next] }));
        const delay = getDemoMessageDelay(demoList[idx]);
        idx += 1;
        setTimeout(run, delay);
      };
      setTimeout(run, getDemoMessageDelay(demoList[0]));
      return;
    }

    const buildConversation = (): ConversationTurn[] =>
      get()
        .messages.filter((msg) => !msg.id.startsWith('demo-') && msg.id !== 'intro')
        .map((msg) => {
          const t = msg.contents
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
            .trim();
          if (!t) return null;
          return { role: msg.role === 'user' ? ('user' as const) : ('assistant' as const), content: t };
        })
        .filter((t): t is ConversationTurn => t !== null);

    (async () => {
      try {
        const conversation = buildConversation();
        const selected = Array.from(useSchemaStore.getState().selectedTables);
        const res = await fetchChatWithModel(conversation, {
          connectionString: get().connectionString || undefined,
          currentStep: get().step,
          selectedTables: selected.length > 0 ? selected : undefined,
          reuseContext: reuseContext || undefined,
        });

        const updatedMessages = [...get().messages];
        updatedMessages.push(sysMsg({ type: 'text', text: res.reply }));

        const updates: Partial<AppState> = { messages: updatedMessages, isProcessing: false };

        if (res.connectionReceived && looksLikeConnectionString(userText)) {
          updates.connectionString = userText;
          useConnectionStore.getState().save(userText);
          useSchemaStore.getState().fetchTree(trimmed);
        }
        if (res.currentStep && res.currentStep >= 1 && res.currentStep <= 6) {
          updates.step = res.currentStep as EtlStep;
        }

        set(updates);
        persistState({ ...get(), ...updates } as any);

        // 检测是否有新的已加工表
        const dashId = get().dashboardId;
        if (dashId && res.processedTable) {
          const pt = res.processedTable;
          const chatHistory = get().messages
            .filter(m => !m.id.startsWith('demo-') && m.id !== 'intro')
            .map(m => ({
              role: m.role === 'user' ? 'user' : 'assistant',
              content: m.contents
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map(c => c.text).join('\n').trim(),
            }))
            .filter(m => m.content);

          useProcessedTableStore.getState().addOrUpdate({
            dashboardId: dashId,
            database: pt.database,
            table: pt.table,
            sourceTables: pt.sourceTables,
            fieldMappings: pt.fieldMappings || [],
            insertSql: pt.insertSql,
            chatHistory,
            processedAt: Date.now(),
          });

          const connStr = get().connectionString;
          if (connStr) {
            const schema = useSchemaStore.getState();
            await schema.fetchTree(connStr);
            const tableKey = `${pt.database}.${pt.table}`;
            if (!schema.selectedTables.has(tableKey)) {
              schema.toggleTable(pt.database, pt.table);
            }
            schema.expandDb(pt.database);
            if (pt.sourceTables && Array.isArray(pt.sourceTables)) {
              for (const src of pt.sourceTables) {
                const parts = src.split('.');
                if (parts.length === 2) {
                  const [srcDb, srcTbl] = parts;
                  if (!schema.selectedTables.has(src)) {
                    schema.toggleTable(srcDb, srcTbl);
                  }
                  schema.expandDb(srcDb);
                }
              }
            }
          }
        }
      } catch (err) {
        const updatedMessages = [...get().messages];
        const errText = err instanceof Error ? err.message : '请求失败';
        updatedMessages.push(
          sysMsg({ type: 'text', text: `对话服务暂不可用：${errText}\n\n请检查后端与 DeepSeek 配置。` }),
        );
        set({ messages: updatedMessages, isProcessing: false });
        persistState(get());
      }
    })();
  },

  reset: () => {
    const { dashboardId } = get();
    msgId = 0;
    const fresh = { ...getDefaultState(), dashboardId };
    set(fresh);
    if (dashboardId) {
      chatApi.clear(dashboardId).catch(() => {});
      etlStateApi.set(dashboardId, { step: 1 }).catch(() => {});
    }
  },
}));
