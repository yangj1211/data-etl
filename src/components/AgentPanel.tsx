import { useEffect, useRef } from 'react';
import { Database, RotateCcw, PanelRightClose } from 'lucide-react';
import { useStore } from '../store';
import { useMetricChatStore } from '../metricChatStore';
import { useDashboardStore } from '../dashboardStore';
import { useChatModeStore } from '../chatModeStore';
import { useSchemaStore } from '../schemaStore';
import { useProcessedTableStore } from '../processedTableStore';
import { useMetricDefStore } from '../metricDefStore';
import { useMetricStore } from '../metricStore';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';
import SchemaTree from './SchemaTree';

function TypingIndicator() {
  return (
    <div className="flex gap-2.5 msg-enter px-3">
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Database className="w-3.5 h-3.5 text-white" />
      </div>
      <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
        <div className="flex gap-1.5 items-center h-4">
          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 typing-dot" />
          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 typing-dot" />
          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 typing-dot" />
        </div>
      </div>
    </div>
  );
}

export default function AgentPanel({ onCollapse }: { onCollapse: () => void }) {
  const mode = useChatModeStore(s => s.mode);

  // ETL store
  const etlMessages = useStore(s => s.messages);
  const etlProcessing = useStore(s => s.isProcessing);
  const etlReset = useStore(s => s.reset);
  const loadForDashboard = useStore(s => s.loadForDashboard);

  // Metric chat store
  const metricMessages = useMetricChatStore(s => s.messages);
  const metricProcessing = useMetricChatStore(s => s.isProcessing);
  const metricReset = useMetricChatStore(s => s.reset);
  const setMetricConn = useMetricChatStore(s => s.setConnectionString);
  const loadMetricForDashboard = useMetricChatStore(s => s.loadForDashboard);
  const loadSchemaForDashboard = useSchemaStore(s => s.loadForDashboard);

  // Sync connection string from ETL store to metric chat store
  const etlConn = useStore(s => s.connectionString);
  useEffect(() => {
    if (etlConn) setMetricConn(etlConn);
  }, [etlConn, setMetricConn]);

  const activeDashboardId = useDashboardStore(s => s.activeDashboardId);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const messages = mode === 'etl' ? etlMessages : metricMessages;
  const isProcessing = mode === 'etl' ? etlProcessing : metricProcessing;
  const handleReset = mode === 'etl' ? etlReset : metricReset;

  useEffect(() => {
    if (activeDashboardId) {
      loadForDashboard(activeDashboardId);
      loadMetricForDashboard(activeDashboardId);
      loadSchemaForDashboard(activeDashboardId);
      useProcessedTableStore.getState().loadForDashboard(activeDashboardId);
      useMetricDefStore.getState().loadForDashboard(activeDashboardId);
      useMetricStore.getState().loadForDashboard(activeDashboardId);
    }
  }, [activeDashboardId, loadForDashboard, loadMetricForDashboard, loadSchemaForDashboard]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isProcessing]);

  return (
    <div className="h-full flex flex-col border-l border-slate-200">
      {/* Agent Header */}
      <div className="flex-shrink-0 border-b border-slate-200 bg-white px-3 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={onCollapse}
              className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              title="收起面板"
            >
              <PanelRightClose className="w-3.5 h-3.5" />
            </button>
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center">
              <Database className="w-3 h-3 text-white" />
            </div>
            <span className="text-xs font-semibold text-slate-900">Agent</span>
          </div>
          <button
            onClick={handleReset}
            className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
            title="重置会话"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Schema Tree */}
      <SchemaTree />

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-1 py-3 space-y-3">
          {messages.map(msg => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
          {isProcessing && <TypingIndicator />}
          <div ref={chatEndRef} />
        </div>
      </div>

      <ChatInput />
    </div>
  );
}
