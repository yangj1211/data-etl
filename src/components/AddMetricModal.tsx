import { useState } from 'react';
import { Loader2, Sparkles, Check, X, BarChart3, ChevronDown, Search } from 'lucide-react';
import { useMetricStore } from '../metricStore';
import { useMetricDefStore } from '../metricDefStore';
import { useProcessedTableStore } from '../processedTableStore';
import { useStore } from '../store';
import { fetchMetricMatch } from '../api';
import type { ChartType, MetricDef } from '../types';

interface Props {
  dashboardId: string;
  onClose: () => void;
}

type Step = 'form' | 'match' | 'preview' | 'done';

const CHART_OPTIONS: { value: ChartType; label: string }[] = [
  { value: 'number', label: '数值' },
  { value: 'bar', label: '柱状图' },
  { value: 'line', label: '折线图' },
  { value: 'pie', label: '饼图' },
  { value: 'table', label: '表格' },
];

interface MatchResult {
  name: string;
  reason: string;
  def: MetricDef | null;
}

export default function AddMetricModal({ dashboardId, onClose }: Props) {
  const connectionString = useStore(s => s.connectionString);
  const { generating, generateMetric, confirmMetric } = useMetricStore();
  const allDefs = useMetricDefStore(s => s.defs);
  const metricDefs = allDefs.filter(d => d.dashboardId === dashboardId);
  const allProcessedTables = useProcessedTableStore(s => s.tables);
  const processedTables = allProcessedTables.filter(t => t.dashboardId === dashboardId);

  const [step, setStep] = useState<Step>('form');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [matching, setMatching] = useState(false);
  const [matchResults, setMatchResults] = useState<MatchResult[]>([]);
  const [suggestion, setSuggestion] = useState('');
  const [sql, setSql] = useState('');
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canMatch = name.trim() && description.trim() && connectionString && metricDefs.length > 0;

  const handleMatch = async () => {
    if (!canMatch) return;
    setError(null);
    setMatching(true);
    try {
      const result = await fetchMetricMatch({
        description: description.trim(),
        metricDefs: metricDefs.map(d => ({
          name: d.name, definition: d.definition, tables: d.tables,
          aggregation: d.aggregation, measureField: d.measureField,
        })),
      });
      const results: MatchResult[] = result.matches.map(m => ({
        name: m.name,
        reason: m.reason,
        def: metricDefs.find(d => d.name === m.name) || null,
      }));
      setMatchResults(results);
      setSuggestion(result.suggestion);
      setStep('match');
    } catch (e) {
      setError(e instanceof Error ? e.message : '匹配失败');
    } finally {
      setMatching(false);
    }
  };

  const handleGenerate = async () => {
    if (!connectionString) return;
    setError(null);
    try {
      const matchedDefs = matchResults.filter(m => m.def).map(m => m.def!);
      const result = await generateMetric({
        dashboardId,
        name: name.trim(),
        description: description.trim(),
        metricDefs: matchedDefs.map(d => ({
          name: d.name, definition: d.definition, tables: d.tables,
          aggregation: d.aggregation, measureField: d.measureField,
        })),
        connectionString: connectionString!,
        processedTables: processedTables.map(pt => ({
          database: pt.database,
          table: pt.table,
          sourceTables: pt.sourceTables,
          fieldMappings: pt.fieldMappings,
          insertSql: pt.insertSql,
        })),
      });
      setSql(result.sql);
      setChartType(result.chartType);
      setExplanation(result.explanation);
      setStep('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  const handleConfirm = async () => {
    if (!connectionString) return;
    setError(null);
    try {
      const matchedDefs = matchResults.filter(m => m.def).map(m => m.def!);
      const tables = [...new Set(matchedDefs.flatMap(d => d.tables))];
      await confirmMetric({ dashboardId, name: name.trim(), description: description.trim(), tables, sql, chartType, connectionString });
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : '查询失败');
    }
  };

  const stepTitle = { form: '添加监控数据', match: '匹配指标确认', preview: '预览 SQL', done: '完成' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-800">{stepTitle[step]}</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-slate-100 transition-colors cursor-pointer">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {step === 'form' && (<>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">数据名称</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="如：月度收入趋势、各品类订单量"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">数据描述（自然语言）</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                placeholder="用自然语言描述你想统计的数据，如：按月统计各行业的总收入，最近12个月"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 resize-none" />
            </div>
            {metricDefs.length === 0 && (
              <div className="text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-3 text-center">
                当前 Dashboard 还没有定义指标，请先通过 Agent 对话「添加指标」模式创建指标定义
              </div>
            )}
            {!connectionString && (
              <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">请先在 ETL Agent 对话中连接数据库</p>
            )}
            {error && <p className="text-xs text-red-500">{error}</p>}
          </>)}

          {step === 'match' && (<>
            {suggestion && (
              <div className="bg-indigo-50 rounded-lg px-3 py-2">
                <p className="text-xs text-indigo-700">{suggestion}</p>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">匹配到的指标</label>
              {matchResults.length === 0 ? (
                <div className="text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-3 text-center">
                  未找到匹配的指标，请修改描述后重试
                </div>
              ) : (
                <div className="space-y-2">
                  {matchResults.map((m, i) => (
                    <div key={i} className="border border-slate-200 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <BarChart3 className="w-3.5 h-3.5 text-emerald-500" />
                        <span className="text-xs font-medium text-slate-800">{m.name}</span>
                        {m.def && <span className="text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">已匹配</span>}
                      </div>
                      <p className="text-[11px] text-slate-500 ml-5">{m.reason}</p>
                      {m.def && (
                        <p className="text-[10px] text-slate-400 ml-5 mt-1">
                          {m.def.aggregation}({m.def.measureField}) · {m.def.definition}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
          </>)}

          {step === 'preview' && (<>
            {explanation && <div className="bg-indigo-50 rounded-lg px-3 py-2"><p className="text-xs text-indigo-700">{explanation}</p></div>}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">SQL（可编辑）</label>
              <textarea value={sql} onChange={e => setSql(e.target.value)} rows={6}
                className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 resize-none bg-slate-50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">图表类型</label>
              <div className="relative">
                <select value={chartType} onChange={e => setChartType(e.target.value as ChartType)}
                  className="w-full appearance-none px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 bg-white pr-8">
                  {CHART_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
          </>)}

          {step === 'done' && (
            <div className="text-center py-6">
              <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-3">
                <Check className="w-6 h-6 text-emerald-600" />
              </div>
              <p className="text-sm font-medium text-slate-800">监控数据已添加</p>
              <p className="text-xs text-slate-400 mt-1">「{name}」已保存到当前 Dashboard</p>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100">
          {step === 'form' && (<>
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 cursor-pointer">取消</button>
            <button onClick={handleMatch} disabled={!canMatch || matching}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer">
              {matching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              匹配指标
            </button>
          </>)}
          {step === 'match' && (<>
            <button onClick={() => { setStep('form'); setError(null); }} className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 cursor-pointer">返回修改</button>
            <button onClick={handleGenerate} disabled={generating || matchResults.filter(m => m.def).length === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer">
              {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              确认并生成 SQL
            </button>
          </>)}
          {step === 'preview' && (<>
            <button onClick={() => { setStep('match'); setError(null); }} className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 cursor-pointer">返回</button>
            <button onClick={handleConfirm} disabled={generating || !sql.trim()}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer">
              {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              确认并执行
            </button>
          </>)}
          {step === 'done' && (
            <button onClick={onClose} className="px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors cursor-pointer">关闭</button>
          )}
        </div>
      </div>
    </div>
  );
}
