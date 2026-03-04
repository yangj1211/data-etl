import { Database, User } from 'lucide-react';
import type { ChatMessage as Msg, ContentBlock } from '../types';

/** 检测未被 ``` 包裹的裸 SQL 块，自动包裹为 ```sql ... ``` */
function autoWrapSql(text: string): string {
  // 如果已经在代码块内就跳过
  const parts: string[] = [];
  const codeBlockRe = /```[\s\S]*?```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = codeBlockRe.exec(text)) !== null) {
    if (m.index > last) parts.push(wrapBareSql(text.slice(last, m.index)));
    parts.push(m[0]); // 保留已有代码块
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(wrapBareSql(text.slice(last)));
  return parts.join('');
}

function wrapBareSql(text: string): string {
  // 匹配以 SQL 关键字开头、跨多行的裸 SQL 语句（至少 2 行，以分号或末尾结束）
  return text.replace(
    /^([ \t]*(?:INSERT\s+INTO|SELECT\s+|CREATE\s+(?:TABLE|DATABASE)|DESCRIBE|SHOW\s+|ALTER\s+TABLE)\b[\s\S]*?);?\s*$/gim,
    (match) => {
      const trimmed = match.trim();
      // 只包裹多行 SQL（至少包含换行）
      if (!trimmed.includes('\n')) return match;
      return `\n\`\`\`sql\n${trimmed}\n\`\`\`\n`;
    },
  );
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(\*\*.*?\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="px-1.5 py-0.5 rounded bg-slate-100 text-indigo-600 text-xs font-mono">{part.slice(1, -1)}</code>;
    return <span key={i}>{part}</span>;
  });
}

function parseTableRows(lines: string[]): { header: string[]; rows: string[][] } | null {
  const rows: string[][] = [];
  let sepIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/^\|.+\|$/.test(line)) break;
    if (/^\|[\s\-:|]+\|$/.test(line)) {
      sepIndex = i;
      continue;
    }
    const cells = line.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
    if (cells.length === 0) break;
    rows.push(cells);
  }
  if (rows.length === 0) return null;
  const headerRow = sepIndex >= 1 ? rows[0] : null;
  const bodyRows = sepIndex >= 1 ? rows.slice(1) : rows;
  return headerRow ? { header: headerRow, rows: bodyRows } : { header: rows[0], rows: rows.slice(1) };
}

function MarkdownTable({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-slate-300 bg-white shadow-sm">
      <table className="w-full min-w-[240px] text-sm border-collapse border border-slate-300">
        <thead>
          <tr className="bg-slate-100">
            {header.map((cell, ci) => (
              <th key={ci} className="border border-slate-300 px-3 py-2 text-left font-semibold text-slate-800 whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-slate-50/70'}>
              {row.map((cell, ci) => (
                <td key={ci} className="border border-slate-300 px-3 py-2 text-slate-700 whitespace-nowrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  // 先将未被 ``` 包裹的裸 SQL 块自动包裹为代码块
  const preprocessed = autoWrapSql(text);
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  const segments: { type: 'text' | 'code'; content: string; lang?: string }[] = [];
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(preprocessed)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: preprocessed.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', content: match[2].trim(), lang: match[1] || 'sql' });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < preprocessed.length) {
    segments.push({ type: 'text', content: preprocessed.slice(lastIndex) });
  }

  return (
    <div className="text-sm text-slate-700 leading-relaxed space-y-3">
      {segments.map((seg, si) => {
        if (seg.type === 'code') {
          return (
            <pre key={si} className="text-xs font-mono bg-slate-900 text-emerald-400 rounded-lg px-4 py-3 overflow-x-auto leading-relaxed whitespace-pre-wrap">
              {seg.content}
            </pre>
          );
        }
        const lines = seg.content.split('\n');
        const out: React.ReactNode[] = [];
        let i = 0;
        while (i < lines.length) {
          const trimmed = lines[i].trim();
          if (!trimmed) {
            out.push(<div key={i} className="h-1" />);
            i++;
            continue;
          }
          if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            const tableLines: string[] = [];
            while (i < lines.length && /^\|/.test(lines[i]?.trim() ?? '')) {
              tableLines.push(lines[i]);
              i++;
            }
            const parsed = parseTableRows(tableLines);
            if (parsed && parsed.header.length > 0) {
              out.push(<MarkdownTable key={`table-${i}`} header={parsed.header} rows={parsed.rows} />);
            }
            continue;
          }
          if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
            out.push(<div key={i} className="flex gap-2 ml-1"><span className="text-indigo-400">•</span><span>{renderInlineMarkdown(trimmed.slice(2))}</span></div>);
            i++;
            continue;
          }
          if (/^\d+[\.\)、]/.test(trimmed)) {
            const m = trimmed.match(/^(\d+[\.\)、])\s*(.*)/);
            out.push(<div key={i} className="flex gap-2 ml-1"><span className="text-indigo-500 font-medium">{m?.[1]}</span><span>{renderInlineMarkdown(m?.[2] || '')}</span></div>);
            i++;
            continue;
          }
          if (trimmed.startsWith('### ')) {
            out.push(<h3 key={i} className="text-base font-semibold text-slate-900 mt-2">{renderInlineMarkdown(trimmed.slice(4))}</h3>);
            i++;
            continue;
          }
          if (trimmed.startsWith('## ')) {
            out.push(<h2 key={i} className="text-lg font-semibold text-slate-900 mt-2">{renderInlineMarkdown(trimmed.slice(3))}</h2>);
            i++;
            continue;
          }
          if (trimmed.startsWith('# ')) {
            out.push(<h1 key={i} className="text-xl font-bold text-slate-900 mt-2">{renderInlineMarkdown(trimmed.slice(2))}</h1>);
            i++;
            continue;
          }
          out.push(<p key={i}>{renderInlineMarkdown(lines[i])}</p>);
          i++;
        }
        return <div key={si} className="space-y-1.5">{out}</div>;
      })}
    </div>
  );
}

function ContentBlockRenderer({ block }: { block: ContentBlock }) {
  if (block.type === 'text') return <TextBlock text={block.text} />;
  if (block.type === 'reuse_card') return <ReuseCard database={block.database} table={block.table} sourceTables={block.sourceTables} />;
  return null;
}

function ReuseCard({ database, table, sourceTables }: { database: string; table: string; sourceTables: string[] }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg mb-1">
      <div className="w-5 h-5 rounded bg-amber-100 flex items-center justify-center flex-shrink-0">
        <span className="text-amber-600 text-[10px] font-bold">复</span>
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-amber-800">{database}.{table}</span>
        {sourceTables.length > 0 && (
          <p className="text-[10px] text-amber-600 truncate">来源：{sourceTables.join(', ')}</p>
        )}
      </div>
    </div>
  );
}

export default function ChatMessage({ message }: { message: Msg }) {
  const isSystem = message.role === 'system';

  if (!isSystem) {
    return (
      <div className="flex justify-end gap-3 msg-enter px-4 sm:px-0">
        <div className="max-w-md">
          <div className="bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-5 py-3 shadow-sm space-y-2">
            {message.contents.map((block, i) => {
              if (block.type === 'reuse_card') return <ReuseCard key={i} database={block.database} table={block.table} sourceTables={block.sourceTables} />;
              return <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap">{block.text}</p>;
            })}
          </div>
        </div>
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center flex-shrink-0 mt-1">
          <User className="w-4 h-4 text-white" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 msg-enter px-4 sm:px-0">
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center flex-shrink-0 mt-1">
        <Database className="w-4 h-4 text-white" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm space-y-4">
          {message.contents.map((block, i) => (
            <ContentBlockRenderer key={i} block={block} />
          ))}
        </div>
      </div>
    </div>
  );
}
