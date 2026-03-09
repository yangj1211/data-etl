import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import DashboardContent from './components/DashboardContent';
import AgentPanel from './components/AgentPanel';
import MetricDefDetailModal from './components/MetricDefDetailModal';
import { useDashboardStore } from './dashboardStore';
import { useMetricStore } from './metricStore';
import { useMetricDefStore } from './metricDefStore';
import { useProcessedTableStore } from './processedTableStore';
import { PanelRightOpen } from 'lucide-react';
import type { MetricDef } from './types';

export default function App() {
  const activeDashboardId = useDashboardStore(s => s.activeDashboardId);
  const loaded = useDashboardStore(s => s.loaded);
  const dbError = useDashboardStore(s => s.error);
  const [agentOpen, setAgentOpen] = useState(true);
  const [viewingMetric, setViewingMetric] = useState<MetricDef | null>(null);

  const loadMetrics = useMetricStore(s => s.loadFromServer);
  const loadMetricDefs = useMetricDefStore(s => s.loadFromServer);
  const loadProcessedTables = useProcessedTableStore(s => s.loadFromServer);

  useEffect(() => {
    useDashboardStore.getState().loadFromServer();
    loadMetrics();
    loadMetricDefs();
    loadProcessedTables();
  }, [loadMetrics, loadMetricDefs, loadProcessedTables]);

  // 加载中
  if (!loaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-3 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-4" />
          <p className="text-slate-500 text-sm">正在连接服务器...</p>
        </div>
      </div>
    );
  }

  // 连接失败
  if (dbError) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center max-w-md px-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-50 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-slate-800 mb-2">无法连接到服务器</h2>
          <p className="text-sm text-slate-500 mb-4">{dbError}</p>
          <p className="text-xs text-slate-400 mb-6">请检查后端服务是否启动，以及数据库连接是否正常。</p>
          <button
            onClick={() => {
              useDashboardStore.setState({ loaded: false, error: null });
              useDashboardStore.getState().loadFromServer();
              loadMetrics();
              loadMetricDefs();
              loadProcessedTables();
            }}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-slate-50 overflow-hidden">
      <Sidebar onViewMetric={setViewingMetric} />

      <main className="flex-1 min-w-0 border-r border-slate-200 relative">
        <DashboardContent />
        {activeDashboardId && !agentOpen && (
          <button
            onClick={() => setAgentOpen(true)}
            className="absolute right-3 top-3 flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-indigo-600 bg-white border border-slate-200 rounded-lg shadow-sm hover:bg-indigo-50 transition-colors cursor-pointer z-10"
          >
            <PanelRightOpen className="w-3.5 h-3.5" />
            ETL Agent
          </button>
        )}
      </main>

      {activeDashboardId && agentOpen && (
        <aside className="w-[560px] flex-shrink-0 bg-white">
          <AgentPanel onCollapse={() => setAgentOpen(false)} />
        </aside>
      )}

      {viewingMetric && (
        <MetricDefDetailModal def={viewingMetric} onClose={() => setViewingMetric(null)} />
      )}
    </div>
  );
}
