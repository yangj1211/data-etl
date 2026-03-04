export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reuse_card'; database: string; table: string; sourceTables: string[] };

export interface ChatMessage {
  id: string;
  role: 'system' | 'user';
  contents: ContentBlock[];
  timestamp: number;
}

/** ETL 向导步骤 1～6 */
export type EtlStep = 1 | 2 | 3 | 4 | 5 | 6;

export const ETL_STEP_LABELS: Record<EtlStep, string> = {
  1: '连接数据库',
  2: '选择基表',
  3: '定义目标表',
  4: '字段映射',
  5: '数据验证',
  6: '异常溯源',
};

/** 每步的一句话说明，显示在进度条下方 */
export const ETL_STEP_DESC: Record<EtlStep, string> = {
  1: '输入 MySQL 连接串，系统会自动验证连通性',
  2: '告诉我你要加工哪张基表，我会展示表结构与样例数据',
  3: '描述目标表要有哪些字段，我来生成建表 SQL 并执行',
  4: '描述每个目标字段的来源与加工规则，我生成 INSERT SQL',
  5: '执行完成后分析目标表数据质量：空值率、异常值分布',
  6: '若发现异常，回溯基表源数据，定位是源头问题还是加工问题',
};

/** 进入该步时自动展示的引导文案（点击「下一步」后显示） */
export const ETL_STEP_INTRO: Record<EtlStep, string> = {
  1: '', // 第1步用欢迎语，不在此展示
  2: '第 2 步：选择基表。\n\n请告诉我你想基于**哪个库的哪张表**做数据加工？',
  3: '第 3 步：定义目标表。\n\n请描述目标表要有哪些字段（字段名、类型、含义），以及这个表要放在哪个库里（库不存在可新建）。',
  4: '第 4 步：字段映射。\n\n请描述每个目标字段的数据来源与加工逻辑，例如「user_id 取基表 user_id」「金额按订单汇总」等。',
  5: '第 5 步：数据验证。\n\n可以发送「开始验证」或「分析目标表」，我会帮你检查空值比例和异常值并给出总结。',
  6: '第 6 步：异常溯源。\n\n若发现某字段异常，可发送「追溯 xxx 字段」，我会去基表查看该字段的源数据情况并分析原因。',
};

/** 每步输入框的引导提示 */
export const ETL_STEP_PLACEHOLDER: Record<EtlStep, string> = {
  1: '输入连接串，如 mysql://user:pass@host:3306/dbname',
  2: '说出要加工的基表名，或先「看看有哪些库 / 哪些表」',
  3: '描述目标表字段：字段名、类型、含义，以及放入哪个库',
  4: '描述每个字段的数据来源，如「amount 取基表的 total_price，按 order_id 汇总」',
  5: '发送「开始验证」，我会分析目标表的空值与异常值',
  6: '发送「追溯 xxx 字段」，我去基表查看该字段的源数据情况',
};

/** Dashboard 相关类型 */
export interface Dashboard {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

/** 指标可视化类型 */
export type ChartType = 'number' | 'bar' | 'line' | 'pie' | 'table';

/** 指标定义 */
export interface Metric {
  id: string;
  dashboardId: string;
  name: string;
  definition: string;
  tables: string[];
  sql: string;
  chartType: ChartType;
  data: Record<string, unknown>[] | null;
  createdAt: number;
}

/** 字段映射关系 */
export interface FieldMapping {
  /** 目标字段名 */
  targetField: string;
  /** 来源表（database.table） */
  sourceTable: string;
  /** 来源字段或表达式 */
  sourceExpr: string;
  /** 加工逻辑描述（如 SUM、COUNT 等） */
  transform: string;
}

/** 已加工表记录 */
export interface ProcessedTable {
  /** 唯一标识：database.table */
  id: string;
  dashboardId: string;
  database: string;
  table: string;
  /** 基表来源（如有） */
  sourceTables: string[];
  /** 字段映射关系 */
  fieldMappings: FieldMapping[];
  /** 加工 SQL（INSERT INTO ... SELECT） */
  insertSql: string;
  /** 加工时的对话历史（用于生成加工逻辑摘要） */
  chatHistory?: { role: string; content: string }[];
  /** 最近加工时间 */
  processedAt: number;
}

/** Re-export MetricAction so other modules can import from types */
export type { MetricAction } from './api';

/** 指标定义（通过对话创建，可用于生成监控数据） */
export interface MetricDef {
  id: string;
  /** 所属 Dashboard */
  dashboardId: string;
  /** 指标名称，如"收入"、"订单量" */
  name: string;
  /** 指标描述/计算逻辑，如"SUM(amount)"、"COUNT(DISTINCT user_id)" */
  definition: string;
  /** 涉及的表 */
  tables: string[];
  /** 聚合方式：SUM / COUNT / AVG / COUNT_DISTINCT / MAX / MIN / 自定义 */
  aggregation: string;
  /** 度量字段（如 amount、order_id） */
  measureField: string;
  /** 创建时间 */
  createdAt: number;
}
