import { useState, useRef } from 'react';
import { LayoutDashboard, Plus, Table2, Clock } from 'lucide-react';
import { useDashboardStore } from '../dashboardStore';
import { useMetricStore } from '../metricStore';
import { useProcessedTableStore } from '../processedTableStore';
import { useStore } from '../store';
import MetricCard, { isCompactMetric } from './MetricCard';
import AddMetricModal from './AddMetricModal';
import LineageModal from './LineageModal';
import ErrorBoundary from './ErrorBoundary';
import type { ProcessedTable } from '../types';

export default function DashboardContent() {
  const activeDashboardId = useDashboardStore(s => s.activeDashboardId);
  const dashboards = useDashboardStore(s => s.dashboards);
  const dashboard = dashboards.find(d => d.id === activeDashboardId);

  const allMetrics = useMetricStore(s => s.metrics);
  const deleteMetric = useMetricStore(s => s.deleteMetric);
  const refreshMetric = useMetricStore(s => s.refreshMetric);
  const reorderMetrics = useMetricStore(s => s.reorderMetrics);
  const connectionString = useStore(s => s.connectionString);

  const allProcessedTables = useProcessedTableStore(s => s.tables);
  const processedTables = allProcessedTables.filter(t => t.dashboardId === activeDashboardId);

  const metrics = allMetrics.filter(m => m.dashboardId === activeDashboardId);

  const [showAdd, setShowAdd] = useState(false);
  const [lineageTable, setLineageTable] = useState<ProcessedTable | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);

  const handleTableClick = (pt: ProcessedTable) => {
    setLineageTable(pt);
  };

  const handleOpenAdd = () => {
    setShowAdd(true);
  };

  if (!dashboard) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-3">
            <LayoutDashboard className="w-7 h-7 text-slate-300" />
          </div>
          <p className="text-sm text-slate-400">选择或创建一个 Dashboard</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Dashboard 标题栏 */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-900">{dashboard.name}</h1>
          {dashboard.description && (
            <p className="text-xs text-slate-500 mt-0.5">{dashboard.description}</p>
          )}
        </div>
        <button
          onClick={handleOpenAdd}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          添加监控数据
        </button>
      </div>

      {/* 已加工表区域 */}
      {processedTables.length > 0 && (
        <div className="flex-shrink-0 px-6 pt-4 pb-2">
          <p className="text-xs font-medium text-slate-500 mb-2">已加工的业务表</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {processedTables.map(pt => (
              <button
                key={pt.id}
                onClick={() => handleTableClick(pt)}
                className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-lg hover:border-indigo-300 hover:shadow-sm transition-all cursor-pointer group"
              >
                <Table2 className="w-3.5 h-3.5 text-indigo-500" />
                <div className="text-left">
                  <p className="text-xs font-medium text-slate-800 group-hover:text-indigo-700">{pt.database}.{pt.table}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Clock className="w-2.5 h-2.5 text-slate-300" />
                    <span className="text-[10px] text-slate-400">{new Date(pt.processedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 指标网格 */}
      <div className="flex-1 overflow-y-auto p-6">
        {metrics.length === 0 ? (
          <div className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center">
            <div className="w-12 h-12 rounded-xl bg-indigo-50 flex items-center justify-center mx-auto mb-3">
              <LayoutDashboard className="w-6 h-6 text-indigo-400" />
            </div>
            <p className="text-sm font-medium text-slate-600 mb-1">还没有监控数据</p>
            <p className="text-xs text-slate-400 mb-4">
              点击「添加监控数据」，选择已加工的表并描述监控定义，Agent 会自动生成查询 SQL
            </p>
            <button
              onClick={handleOpenAdd}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              添加监控数据
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {metrics.map(m => (
              <div
                key={m.id}
                draggable
                onDragStart={(e) => {
                  dragRef.current = m.id;
                  setDragId(m.id);
                  e.dataTransfer.effectAllowed = 'move';
                  // transparent drag image
                  const el = e.currentTarget as HTMLElement;
                  const ghost = el.cloneNode(true) as HTMLElement;
                  ghost.style.opacity = '0.6';
                  ghost.style.position = 'absolute';
                  ghost.style.top = '-9999px';
                  document.body.appendChild(ghost);
                  e.dataTransfer.setDragImage(ghost, 0, 0);
                  setTimeout(() => document.body.removeChild(ghost), 0);
                }}
                onDragEnd={() => { setDragId(null); setDropId(null); dragRef.current = null; }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragRef.current && dragRef.current !== m.id) {
                    setDropId(m.id);
                  }
                }}
                onDragLeave={() => { if (dropId === m.id) setDropId(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragRef.current && dragRef.current !== m.id && activeDashboardId) {
                    reorderMetrics(activeDashboardId, dragRef.current, m.id);
                  }
                  setDragId(null);
                  setDropId(null);
                  dragRef.current = null;
                }}
                className={`${isCompactMetric(m.chartType) ? 'col-span-1' : 'col-span-2'} transition-all duration-150 ${
                  dragId === m.id ? 'opacity-40 scale-95' : ''
                } ${dropId === m.id ? 'ring-2 ring-indigo-400 ring-offset-2 rounded-xl' : ''}`}
                style={{ cursor: 'grab' }}
              >
                <MetricCard
                  metric={m}
                  onDelete={deleteMetric}
                  onRefresh={(id) => connectionString && refreshMetric(id, connectionString)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {showAdd && activeDashboardId && (
        <ErrorBoundary fallbackLabel="添加监控数据">
          <AddMetricModal
            dashboardId={activeDashboardId}
            onClose={() => setShowAdd(false)}
          />
        </ErrorBoundary>
      )}

      {lineageTable && (
        <ErrorBoundary fallbackLabel="数据血缘">
          <LineageModal
            table={lineageTable}
            onClose={() => setLineageTable(null)}
            onAddMetric={(_tableId: string) => { setLineageTable(null); setShowAdd(true); }}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}
