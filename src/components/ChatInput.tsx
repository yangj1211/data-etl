import { useState, useRef, useEffect } from 'react';
import { SendHorizonal, Wrench, BarChart3, Repeat2, Eye, Database, X } from 'lucide-react';
import { useStore } from '../store';
import { useMetricChatStore } from '../metricChatStore';
import { useChatModeStore } from '../chatModeStore';
import { useProcessedTableStore } from '../processedTableStore';
import { useDashboardStore } from '../dashboardStore';
import { useConnectionStore } from '../connectionStore';
import type { ProcessedTable } from '../types';
import LineageModal from './LineageModal';

export default function ChatInput() {
  const [text, setText] = useState('');
  const [showReuse, setShowReuse] = useState(false);
  const [previewTable, setPreviewTable] = useState<ProcessedTable | null>(null);
  const mode = useChatModeStore(s => s.mode);
  const setMode = useChatModeStore(s => s.setMode);

  const etlProcessing = useStore(s => s.isProcessing);
  const etlSend = useStore(s => s.sendMessage);
  const etlConnectionString = useStore(s => s.connectionString);
  const metricProcessing = useMetricChatStore(s => s.isProcessing);
  const metricSend = useMetricChatStore(s => s.sendMessage);

  const savedConnections = useConnectionStore(s => s.connections);
  const removeConnection = useConnectionStore(s => s.remove);

  const allProcessedTables = useProcessedTableStore(s => s.tables);
  const dashboards = useDashboardStore(s => s.dashboards);
  const activeDashboardId = useDashboardStore(s => s.activeDashboardId);

  const isProcessing = mode === 'etl' ? etlProcessing : metricProcessing;
  const sendMessage = mode === 'etl' ? etlSend : metricSend;

  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isProcessing) inputRef.current?.focus();
  }, [isProcessing]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isProcessing) return;
    sendMessage(trimmed);
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const placeholder = mode === 'etl'
    ? '输入连接串或描述数据加工需求...'
    : '描述你想创建的指标...';

  // 获取可复用的加工逻辑（排除当前 dashboard 的）
  const reusableTables = allProcessedTables.filter(
    t => t.insertSql && t.dashboardId !== activeDashboardId
  );
  const getDashboardName = (id: string) =>
    dashboards.find(d => d.id === id)?.name || '未知';

  const handleReuse = (table: typeof reusableTables[0]) => {
    if (isProcessing) return;
    // Directly send with reuse context — no intermediate state needed
    etlSend('', {
      database: table.database,
      table: table.table,
      sourceTables: table.sourceTables,
      fieldMappings: table.fieldMappings,
      insertSql: table.insertSql,
      chatHistory: table.chatHistory,
    });
    setShowReuse(false);
  };

  const handleSelectConnection = (cs: string) => {
    if (isProcessing) return;
    sendMessage(cs);
  };

  // 未连接时显示历史连接串标签
  const showConnectionTags = mode === 'etl' && !etlConnectionString && savedConnections.length > 0;

  return (
    <div className="flex-shrink-0 border-t border-slate-200 bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3">
        {/* Mode selector */}
        <div className="flex gap-1.5 mb-2">
          <button
            onClick={() => setMode('etl')}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
              mode === 'etl'
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50 border border-transparent'
            }`}
          >
            <Wrench className="w-3 h-3" />
            业务表加工
          </button>
          <button
            onClick={() => setMode('metric')}
            className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
              mode === 'metric'
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50 border border-transparent'
            }`}
          >
            <BarChart3 className="w-3 h-3" />
            添加指标
          </button>
          {mode === 'etl' && reusableTables.length > 0 && (
            <button
              onClick={() => setShowReuse(!showReuse)}
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ml-auto ${
                showReuse
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'text-slate-400 hover:text-amber-600 hover:bg-amber-50 border border-transparent'
              }`}
            >
              <Repeat2 className="w-3 h-3" />
              复用加工逻辑
            </button>
          )}
        </div>

        {/* Reuse panel */}
        {showReuse && (
          <div className="mb-2 bg-amber-50/50 border border-amber-200 rounded-lg p-2 max-h-48 overflow-y-auto">
            <p className="text-[10px] text-amber-700 font-medium mb-1.5">点击「查看血缘」预览加工逻辑，确认后点「复用」：</p>
            <div className="space-y-1">
              {reusableTables.map(t => (
                <div
                  key={t.id + t.dashboardId}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-white border border-amber-100 hover:border-amber-300 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-800">{t.database}.{t.table}</span>
                      <span className="text-[10px] text-slate-400">{getDashboardName(t.dashboardId)}</span>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-0.5 truncate">
                      来源：{t.sourceTables.join(', ') || '未知'}
                    </p>
                  </div>
                  <button
                    onClick={() => setPreviewTable(t)}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-indigo-600 bg-indigo-50 rounded hover:bg-indigo-100 transition-colors cursor-pointer flex-shrink-0"
                  >
                    <Eye className="w-3 h-3" />
                    查看血缘
                  </button>
                  <button
                    onClick={() => handleReuse(t)}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-amber-700 bg-amber-100 rounded hover:bg-amber-200 transition-colors cursor-pointer flex-shrink-0"
                  >
                    <Repeat2 className="w-3 h-3" />
                    复用
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lineage preview modal */}
        {previewTable && (
          <LineageModal
            table={previewTable}
            onClose={() => setPreviewTable(null)}
            onAddMetric={() => {}}
          />
        )}

        {/* Saved connections — inline tags, shown when not yet connected */}
        {showConnectionTags && (
          <div className="mb-2 flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-slate-400 flex items-center gap-1 mr-0.5">
              <Database className="w-3 h-3" />
              快速连接：
            </span>
            {savedConnections.map(c => (
              <span
                key={c.connectionString}
                className="inline-flex items-center gap-1 max-w-[280px] group"
              >
                <button
                  onClick={() => handleSelectConnection(c.connectionString)}
                  disabled={isProcessing}
                  className="px-2 py-0.5 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 hover:border-emerald-300 transition-colors cursor-pointer truncate disabled:opacity-50"
                  title={c.connectionString}
                >
                  {c.label}
                </button>
                <button
                  onClick={() => removeConnection(c.connectionString)}
                  className="p-0.5 text-slate-300 hover:text-red-400 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                  title="删除"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Input area */}
        <div className="flex items-end gap-3 bg-slate-50 rounded-xl border border-slate-200 p-2 focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
          <textarea
            ref={inputRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={isProcessing}
            rows={1}
            className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none disabled:opacity-50"
            style={{ maxHeight: 120, minHeight: 36 }}
            onInput={e => {
              const t = e.currentTarget;
              t.style.height = 'auto';
              t.style.height = Math.min(t.scrollHeight, 120) + 'px';
            }}
          />
          <button
            onClick={handleSend}
            disabled={isProcessing || !text.trim()}
            className={`
              p-2 rounded-lg transition-colors flex-shrink-0
              ${text.trim() && !isProcessing
                ? 'bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }
            `}
          >
            <SendHorizonal className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-1.5 text-center">
          Shift+Enter 换行 · Enter 发送
        </p>
      </div>
    </div>
  );
}
