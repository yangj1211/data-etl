import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import DashboardContent from './components/DashboardContent';
import AgentPanel from './components/AgentPanel';
import MetricDefDetailModal from './components/MetricDefDetailModal';
import ErrorBoundary from './components/ErrorBoundary';
import { useDashboardStore } from './dashboardStore';
import { useConnectionStore } from './connectionStore';
import { PanelRightOpen } from 'lucide-react';
import type { MetricDef } from './types';

export default function App() {
  const activeDashboardId = useDashboardStore(s => s.activeDashboardId);
  const loaded = useDashboardStore(s => s.loaded);
  const loadDashboards = useDashboardStore(s => s.loadDashboards);
  const loadConnections = useConnectionStore(s => s.load);
  const [agentOpen, setAgentOpen] = useState(true);
  const [viewingMetric, setViewingMetric] = useState<MetricDef | null>(null);

  useEffect(() => {
    loadDashboards();
    loadConnections();
  }, []);

  return (
    <div className="h-screen flex bg-slate-50 overflow-hidden">
      <Sidebar onViewMetric={setViewingMetric} />

      <main className="flex-1 min-w-0 border-r border-slate-200 relative">
        <ErrorBoundary fallbackLabel="Dashboard">
          <DashboardContent />
        </ErrorBoundary>
        {/* 收起状态下的展开按钮 */}
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
          <ErrorBoundary fallbackLabel="Agent 面板">
            <AgentPanel onCollapse={() => setAgentOpen(false)} />
          </ErrorBoundary>
        </aside>
      )}

      {viewingMetric && (
        <ErrorBoundary fallbackLabel="指标详情">
          <MetricDefDetailModal def={viewingMetric} onClose={() => setViewingMetric(null)} />
        </ErrorBoundary>
      )}
    </div>
  );
}
