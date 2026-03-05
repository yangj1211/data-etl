import { useState, useEffect } from 'react';
import { Plus, LayoutDashboard, Trash2, BarChart3, ChevronRight, ChevronDown, Pencil } from 'lucide-react';
import { useDashboardStore } from '../dashboardStore';
import { useMetricDefStore } from '../metricDefStore';
import type { MetricDef } from '../types';

export default function Sidebar({ onViewMetric }: { onViewMetric?: (def: MetricDef) => void }) {
  const dashboards = useDashboardStore(s => s.dashboards);
  const activeDashboardId = useDashboardStore(s => s.activeDashboardId);
  const openDashboard = useDashboardStore(s => s.openDashboard);
  const createDashboard = useDashboardStore(s => s.createDashboard);
  const deleteDashboard = useDashboardStore(s => s.deleteDashboard);
  const renameDashboard = useDashboardStore(s => s.renameDashboard);

  const allMetricDefs = useMetricDefStore(s => s.defs);
  const removeMetricDef = useMetricDefStore(s => s.remove);

  // Ensure metric defs are loaded for all dashboards shown in sidebar
  useEffect(() => {
    dashboards.forEach(d => {
      useMetricDefStore.getState().loadForDashboard(d.id);
    });
  }, [dashboards]);

  const [showInput, setShowInput] = useState(false);
  const [newName, setNewName] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredMetric, setHoveredMetric] = useState<string | null>(null);
  const [expandedDashboards, setExpandedDashboards] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    createDashboard(name, '');
    setNewName('');
    setShowInput(false);
  };

  const toggleExpand = (id: string) => {
    setExpandedDashboards(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const getMetricsForDashboard = (dashboardId: string) =>
    allMetricDefs.filter(d => d.dashboardId === dashboardId);

  return (
    <div className="w-60 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col h-full">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-slate-100">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center">
            <LayoutDashboard className="w-4 h-4 text-white" />
          </div>
          <span className="text-sm font-semibold text-slate-900">指标平台</span>
        </div>
      </div>

      {/* 新建按钮 */}
      <div className="px-3 pt-3 pb-1">
        {showInput ? (
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') { setShowInput(false); setNewName(''); }
              }}
              onBlur={() => { if (!newName.trim()) setShowInput(false); }}
              placeholder="Dashboard 名称"
              className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="px-2 py-1.5 text-xs text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40 cursor-pointer transition-colors"
            >
              创建
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowInput(true)}
            className="w-full flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-indigo-600 rounded-lg hover:bg-indigo-50 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            新建 Dashboard
          </button>
        )}
      </div>

      {/* Dashboard 列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {dashboards.length === 0 && (
          <p className="text-xs text-slate-400 text-center mt-8 px-4">
            还没有 Dashboard，点击上方按钮创建
          </p>
        )}
        {dashboards.map(db => {
          const metrics = getMetricsForDashboard(db.id);
          const isActive = activeDashboardId === db.id;
          const isExpanded = expandedDashboards.has(db.id);

          return (
            <div key={db.id} className="mb-0.5">
              <div
                onMouseEnter={() => setHovered(db.id)}
                onMouseLeave={() => setHovered(null)}
                className={`
                  group flex items-center gap-1.5 px-2 py-2 rounded-lg cursor-pointer transition-all text-sm
                  ${isActive ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-50'}
                `}
              >
                {metrics.length > 0 ? (
                  <button
                    onClick={e => { e.stopPropagation(); toggleExpand(db.id); }}
                    className="p-0.5 rounded hover:bg-slate-200/50 transition-colors cursor-pointer flex-shrink-0"
                  >
                    {isExpanded
                      ? <ChevronDown className="w-3 h-3 text-slate-400" />
                      : <ChevronRight className="w-3 h-3 text-slate-400" />
                    }
                  </button>
                ) : (
                  <span className="w-4 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0 flex items-center gap-1.5" onClick={() => openDashboard(db.id)}>
                  <LayoutDashboard className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-indigo-500' : 'text-slate-400'}`} />
                  {editingId === db.id ? (
                    <input
                      autoFocus
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const name = editName.trim();
                          if (name) renameDashboard(db.id, name);
                          setEditingId(null);
                        }
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => {
                        const name = editName.trim();
                        if (name) renameDashboard(db.id, name);
                        setEditingId(null);
                      }}
                      onClick={e => e.stopPropagation()}
                      className="flex-1 min-w-0 px-1.5 py-0.5 text-xs rounded border border-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                    />
                  ) : (
                    <span
                      className="flex-1 truncate text-xs"
                      onDoubleClick={e => { e.stopPropagation(); setEditingId(db.id); setEditName(db.name); }}
                    >
                      {db.name}
                    </span>
                  )}
                  {metrics.length > 0 && editingId !== db.id && (
                    <span className="text-[10px] text-slate-400 bg-slate-100 rounded px-1">{metrics.length}</span>
                  )}
                </div>
                {hovered === db.id && editingId !== db.id && (
                  <button
                    onClick={e => { e.stopPropagation(); setEditingId(db.id); setEditName(db.name); }}
                    className="p-1 rounded text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 transition-colors cursor-pointer flex-shrink-0"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
                {hovered === db.id && editingId !== db.id && (
                  <button
                    onClick={e => { e.stopPropagation(); deleteDashboard(db.id); }}
                    className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors cursor-pointer flex-shrink-0"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>

              {/* 该 Dashboard 下的指标列表 */}
              {isExpanded && metrics.length > 0 && (
                <div className="ml-5 pl-2 border-l border-slate-100">
                  {metrics.map(md => (
                    <div
                      key={md.id}
                      onMouseEnter={() => setHoveredMetric(md.id)}
                      onMouseLeave={() => setHoveredMetric(null)}
                      onClick={() => onViewMetric?.(md)}
                      className="group flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm mb-0.5 text-slate-600 hover:bg-slate-50 transition-all cursor-pointer"
                    >
                      <BarChart3 className="w-3 h-3 flex-shrink-0 text-emerald-500" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] truncate">{md.name}</p>
                      </div>
                      {hoveredMetric === md.id && (
                        <button
                          onClick={e => { e.stopPropagation(); removeMetricDef(md.id); }}
                          className="p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors cursor-pointer flex-shrink-0"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
