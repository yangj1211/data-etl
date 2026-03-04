import { useState, useEffect } from 'react';
import { X, Database, Loader2, AlertCircle, GitBranch, Code2, BookOpen } from 'lucide-react';
import type { ProcessedTable } from '../types';
import { useStore } from '../store';
import { fetchLineage, fetchLineageSummary } from '../api';
import type { LineageResponse, LineageSummary } from '../api';

interface Props {
  table: ProcessedTable;
  onClose: () => void;
  onAddMetric: (tableId: string) => void;
}

const ROLE_COLORS: Record<string, { bg: string; border: string; header: string; text: string; badge: string }> = {
  '基表': { bg: '#eff6ff', border: '#93c5fd', header: '#dbeafe', text: '#1e40af', badge: '#3b82f6' },
  '维表': { bg: '#fefce8', border: '#fde047', header: '#fef9c3', text: '#854d0e', badge: '#eab308' },
  '关联表': { bg: '#fdf2f8', border: '#f9a8d4', header: '#fce7f3', text: '#9d174d', badge: '#ec4899' },
};
const TARGET_COLOR = { bg: '#f0fdf4', border: '#86efac', header: '#dcfce7', text: '#166534', badge: '#22c55e' };

type TabKey = 'lineage' | 'sql' | 'summary';

const TABS: { key: TabKey; label: string; icon: typeof GitBranch }[] = [
  { key: 'lineage', label: '数据血缘', icon: GitBranch },
  { key: 'sql', label: '加工 SQL', icon: Code2 },
  { key: 'summary', label: '加工逻辑摘要', icon: BookOpen },
];

function LineageDiagram({ data }: { data: LineageResponse }) {
  const sources = data.sourceTables || [];
  const mappings = data.fieldMappings || [];

  const sourceFieldMap = new Map<string, Set<string>>();
  for (const m of mappings) {
    if (!sourceFieldMap.has(m.sourceTable)) sourceFieldMap.set(m.sourceTable, new Set());
    sourceFieldMap.get(m.sourceTable)!.add(m.sourceField);
  }

  const targetFields = mappings.map(m => m.targetField);

  const colW = 220, fieldH = 22, headerH = 36, padY = 8, gapX = 360, sourceX = 30;
  const targetX = sourceX + colW + gapX;
  const sourceGap = 20;
  let curY = 30;

  const sourceBoxes = sources.map(src => {
    const fields = [...(sourceFieldMap.get(src.name) || [])];
    const h = headerH + Math.max(fields.length, 1) * fieldH + padY;
    const box = { ...src, x: sourceX, y: curY, w: colW, h, fields };
    curY += h + sourceGap;
    return box;
  });

  const targetH = headerH + Math.max(targetFields.length, 1) * fieldH + padY;
  const totalSourceH = sourceBoxes.length > 0
    ? sourceBoxes[sourceBoxes.length - 1].y + sourceBoxes[sourceBoxes.length - 1].h - sourceBoxes[0].y
    : targetH;
  const targetY = sourceBoxes.length > 0
    ? sourceBoxes[0].y + Math.max(0, (totalSourceH - targetH) / 2)
    : 30;

  const svgH = Math.max(curY + 20, targetY + targetH + 40);
  const svgW = targetX + colW + 40;

  const lines: { x1: number; y1: number; x2: number; y2: number; transform: string }[] = [];
  mappings.forEach((m, mi) => {
    const srcBox = sourceBoxes.find(s => s.name === m.sourceTable);
    if (!srcBox) return;
    const srcFieldIdx = srcBox.fields.indexOf(m.sourceField);
    const y1 = srcBox.y + headerH + (srcFieldIdx >= 0 ? srcFieldIdx : 0) * fieldH + fieldH / 2;
    const y2 = targetY + headerH + mi * fieldH + fieldH / 2;
    lines.push({ x1: srcBox.x + srcBox.w, y1, x2: targetX, y2, transform: m.transform });
  });

  return (
    <svg width={svgW} height={svgH} className="block">
      <defs>
        <marker id="lm-arrow" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
          <polygon points="0 0, 7 2.5, 0 5" fill="#6366f1" />
        </marker>
      </defs>

      {(() => {
        const labelH = 22;
        const labelPositions: { x: number; y: number; text: string; lineIdx: number }[] = [];
        lines.forEach((l, i) => {
          const isDirect = l.transform === '直接映射' || l.transform === '直接取值';
          if (isDirect) return;
          const midX = (l.x1 + l.x2) / 2;
          let labelY = (l.y1 + l.y2) / 2;
          for (let attempt = 0; attempt < 20; attempt++) {
            const overlap = labelPositions.some(p => Math.abs(p.x - midX) < 120 && Math.abs(p.y - labelY) < labelH);
            if (!overlap) break;
            labelY += labelH;
          }
          labelPositions.push({ x: midX, y: labelY, text: l.transform, lineIdx: i });
        });

        return lines.map((l, i) => {
          const midX = (l.x1 + l.x2) / 2;
          const isDirect = l.transform === '直接映射' || l.transform === '直接取值';
          const labelInfo = labelPositions.find(p => p.lineIdx === i);
          const displayText = l.transform.length > 20 ? l.transform.slice(0, 20) + '…' : l.transform;
          const rectW = Math.min(displayText.length * 9 + 16, 200);
          return (
            <g key={`line-${i}`}>
              <path d={`M${l.x1},${l.y1} C${midX},${l.y1} ${midX},${l.y2} ${l.x2},${l.y2}`}
                fill="none" stroke={isDirect ? '#94a3b8' : '#6366f1'} strokeWidth="1.2"
                strokeDasharray={isDirect ? 'none' : '5 3'} markerEnd="url(#lm-arrow)" opacity={isDirect ? 0.3 : 0.5} />
              {labelInfo && (
                <g>
                  <rect x={labelInfo.x - rectW / 2} y={labelInfo.y - 10} width={rectW} height={20} rx="10"
                    fill="#eef2ff" stroke="#c7d2fe" strokeWidth="0.8" />
                  <text x={labelInfo.x} y={labelInfo.y + 4} textAnchor="middle" fontSize="9" fill="#4338ca" fontWeight="500">
                    {displayText}
                  </text>
                </g>
              )}
            </g>
          );
        });
      })()}

      {sourceBoxes.map((src, si) => {
        const colors = ROLE_COLORS[src.role] || ROLE_COLORS['关联表'];
        return (
          <g key={`src-${si}`}>
            <rect x={src.x} y={src.y} width={src.w} height={src.h} rx="8" fill={colors.bg} stroke={colors.border} strokeWidth="1.5" />
            <rect x={src.x} y={src.y} width={src.w} height={headerH} rx="8" fill={colors.header} />
            <rect x={src.x} y={src.y + headerH - 4} width={src.w} height="4" fill={colors.header} />
            <rect x={src.x + src.w - 38} y={src.y + 10} width={30} height={16} rx="8" fill={colors.badge} opacity="0.15" />
            <text x={src.x + src.w - 23} y={src.y + 22} textAnchor="middle" fontSize="9" fill={colors.badge} fontWeight="600">{src.role}</text>
            <text x={src.x + 10} y={src.y + 23} fontSize="11" fontWeight="600" fill={colors.text}>
              {src.name.length > 20 ? src.name.slice(0, 20) + '…' : src.name}
            </text>
            {src.fields.map((f, fi) => (
              <text key={fi} x={src.x + 14} y={src.y + headerH + fi * fieldH + 15} fontSize="10" fill="#475569">{f}</text>
            ))}
            {src.fields.length === 0 && (
              <text x={src.x + 14} y={src.y + headerH + 15} fontSize="10" fill="#94a3b8" fontStyle="italic">(无直接字段引用)</text>
            )}
            {src.joinType && src.joinType !== '无（主表）' && (
              <text x={src.x + src.w + 4} y={src.y + headerH / 2 + 4} fontSize="8" fill="#94a3b8">{src.joinType}</text>
            )}
          </g>
        );
      })}

      <g>
        <rect x={targetX} y={targetY} width={colW} height={targetH} rx="8" fill={TARGET_COLOR.bg} stroke={TARGET_COLOR.border} strokeWidth="1.5" />
        <rect x={targetX} y={targetY} width={colW} height={headerH} rx="8" fill={TARGET_COLOR.header} />
        <rect x={targetX} y={targetY + headerH - 4} width={colW} height="4" fill={TARGET_COLOR.header} />
        <rect x={targetX + colW - 46} y={targetY + 10} width={38} height={16} rx="8" fill={TARGET_COLOR.badge} opacity="0.15" />
        <text x={targetX + colW - 27} y={targetY + 22} textAnchor="middle" fontSize="9" fill={TARGET_COLOR.badge} fontWeight="600">目标表</text>
        <text x={targetX + 10} y={targetY + 23} fontSize="11" fontWeight="600" fill={TARGET_COLOR.text}>
          {data.targetTable.length > 20 ? data.targetTable.slice(0, 20) + '…' : data.targetTable}
        </text>
        {targetFields.map((f, fi) => (
          <text key={fi} x={targetX + 14} y={targetY + headerH + fi * fieldH + 15} fontSize="10" fill="#475569">{f}</text>
        ))}
      </g>
    </svg>
  );
}

/* ── Tab: 数据血缘 ── */
function TabLineage({ lineage }: { lineage: LineageResponse }) {
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <LineageDiagram data={lineage} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {lineage.joinRelations && lineage.joinRelations.length > 0 && (
          <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
            <p className="text-xs font-semibold text-slate-700 mb-2">JOIN 关系</p>
            <div className="space-y-1.5">
              {lineage.joinRelations.map((j, i) => (
                <div key={i} className="text-[11px] text-slate-600">
                  <span className="font-medium text-indigo-600">{j.joinType}</span>{' '}{j.rightTable}
                  <span className="text-slate-400"> ON </span>
                  <span className="font-mono text-[10px]">{j.condition}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
          {lineage.groupBy && (
            <div className="mb-2">
              <p className="text-xs font-semibold text-slate-700 mb-1">GROUP BY</p>
              <p className="text-[11px] text-slate-600 font-mono">{lineage.groupBy}</p>
            </div>
          )}
          {lineage.filters && (
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-1">WHERE 条件</p>
              <p className="text-[11px] text-slate-600 font-mono">{lineage.filters}</p>
            </div>
          )}
          {!lineage.groupBy && !lineage.filters && (
            <p className="text-xs text-slate-400">无 GROUP BY 或 WHERE 条件</p>
          )}
        </div>
      </div>

      {lineage.fieldMappings && lineage.fieldMappings.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-700 mb-2">字段映射明细</p>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-slate-50">
                  <th className="px-3 py-2 text-left font-medium text-slate-600">目标字段</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">来源表</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">来源字段</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">加工逻辑</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">SQL 表达式</th>
                </tr>
              </thead>
              <tbody>
                {lineage.fieldMappings.map((m, i) => (
                  <tr key={i} className={i % 2 === 0 ? '' : 'bg-slate-50/50'}>
                    <td className="px-3 py-1.5 font-medium text-indigo-700">{m.targetField}</td>
                    <td className="px-3 py-1.5 text-slate-600">{m.sourceTable}</td>
                    <td className="px-3 py-1.5 text-slate-600">{m.sourceField}</td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        m.transform === '直接映射' || m.transform === '直接取值' ? 'bg-green-50 text-green-700' : 'bg-purple-50 text-purple-700'
                      }`}>{m.transform}</span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[10px] text-slate-500 max-w-[200px] truncate" title={m.expression}>{m.expression}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Tab: 加工 SQL ── */
function TabSql({ sql }: { sql: string }) {
  return (
    <div>
      <pre className="p-4 bg-slate-900 text-emerald-400 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
        {sql}
      </pre>
    </div>
  );
}

/* ── Tab: 加工逻辑摘要 ── */
function TabSummary({ summary, loading, hasChatHistory }: { summary: LineageSummary | null; loading: boolean; hasChatHistory: boolean }) {
  if (!hasChatHistory) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <AlertCircle className="w-4 h-4 mr-2" />
        <span className="text-sm">无对话历史，无法生成加工逻辑摘要</span>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        <span className="text-sm">正在分析对话历史，生成加工逻辑...</span>
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <span className="text-sm">摘要生成失败</span>
      </div>
    );
  }
  return (
    <div className="bg-indigo-50/50 rounded-lg p-4 border border-indigo-100 space-y-3 text-[12px]">
      <p className="font-semibold text-indigo-900 text-sm">{summary.title}</p>
      {summary.purpose && <p className="text-slate-600">{summary.purpose}</p>}
      <div>
        <p className="font-medium text-slate-700 mb-1">加工步骤：</p>
        <ol className="list-decimal list-inside space-y-0.5 text-slate-600">
          {summary.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </div>
      {summary.keyLogic && summary.keyLogic.length > 0 && (
        <div>
          <p className="font-medium text-slate-700 mb-1">关键逻辑：</p>
          <ul className="list-disc list-inside space-y-0.5 text-slate-600">
            {summary.keyLogic.map((k, i) => <li key={i}>{k}</li>)}
          </ul>
        </div>
      )}
      {summary.reuseTips && (
        <div className="bg-white/60 rounded p-2.5 border border-indigo-100">
          <p className="font-medium text-indigo-700 mb-0.5">复用建议：</p>
          <p className="text-slate-600">{summary.reuseTips}</p>
        </div>
      )}
    </div>
  );
}

export default function LineageModal({ table, onClose, onAddMetric }: Props) {
  const connectionString = useStore(s => s.connectionString);
  const [activeTab, setActiveTab] = useState<TabKey>('lineage');
  const [lineage, setLineage] = useState<LineageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<LineageSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const targetName = `${table.database}.${table.table}`;
  const hasChatHistory = !!(table.chatHistory && table.chatHistory.length > 0);

  useEffect(() => {
    if (!table.insertSql || !connectionString) {
      setLoading(false);
      setError(table.insertSql ? '请先连接数据库' : '暂无加工 SQL，无法分析血缘');
      return;
    }
    setLoading(true);
    setError('');
    fetchLineage({
      sql: table.insertSql,
      connectionString,
      targetTable: targetName,
      fieldMappings: table.fieldMappings,
      sourceTables: table.sourceTables,
    })
      .then(data => setLineage(data))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));

    if (hasChatHistory) {
      setSummaryLoading(true);
      fetchLineageSummary({
        chatHistory: table.chatHistory!,
        insertSql: table.insertSql,
        targetTable: targetName,
        sourceTables: table.sourceTables,
      })
        .then(data => setSummary(data))
        .catch(() => {})
        .finally(() => setSummaryLoading(false));
    }
  }, [table.insertSql, connectionString, targetName]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl mx-4 flex flex-col" style={{ maxHeight: '85vh' }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-indigo-500" />
            <h2 className="text-base font-semibold text-slate-900">{targetName}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { onAddMetric(table.id); onClose(); }}
              className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer"
            >
              基于此表添加监控
            </button>
            <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-6 pt-3 flex gap-1 border-b border-slate-100 flex-shrink-0">
          {TABS.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-t-lg transition-colors cursor-pointer -mb-px ${
                  isActive
                    ? 'bg-white text-indigo-700 border border-slate-100 border-b-white'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50 border border-transparent'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {activeTab === 'lineage' && (
            <>
              {loading && (
                <div className="flex items-center justify-center py-16 text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  <span className="text-sm">正在分析数据血缘...</span>
                </div>
              )}
              {error && !loading && (
                <div className="flex items-center justify-center py-16">
                  <AlertCircle className="w-5 h-5 text-red-400 mr-2" />
                  <span className="text-sm text-red-600">{error}</span>
                </div>
              )}
              {lineage && !loading && <TabLineage lineage={lineage} />}
            </>
          )}

          {activeTab === 'sql' && (
            table.insertSql
              ? <TabSql sql={table.insertSql} />
              : <div className="flex items-center justify-center py-16 text-slate-400"><span className="text-sm">暂无加工 SQL</span></div>
          )}

          {activeTab === 'summary' && (
            <TabSummary summary={summary} loading={summaryLoading} hasChatHistory={hasChatHistory} />
          )}
        </div>
      </div>
    </div>
  );
}
