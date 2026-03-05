"""Metric conversation LangGraph state graph (tool calling 版本)."""

import asyncio
import re
import json
import logging
from typing import TypedDict, Optional

from langgraph.graph import StateGraph, END

logger = logging.getLogger("etl.metric_graph")

from db.connection import get_connection_config
from db.operations import run_database_operation, safe_identifier
from llm.client import call_llm
from llm.tools import SQL_TOOLS, METRIC_CHAT_TOOLS, execute_tool_call, execute_create_metric_def
from utils.formatters import rows_to_markdown_table


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class MetricChatState(TypedDict):
    conversation: list
    connection_string: Optional[str]
    selected_tables: list
    processed_tables: list
    schema_context: str
    render_blocks: dict
    llm_response: dict


# ---------------------------------------------------------------------------
# Node 1: fetch_schema_context (保持不变)
# ---------------------------------------------------------------------------

async def fetch_schema_context_node(state: MetricChatState) -> dict:
    connection_string = state.get('connection_string')
    selected = state.get('selected_tables', [])
    schema_context = ''

    if not connection_string:
        return {'schema_context': schema_context}

    if len(selected) > 0:
        schema_lines = []
        for tbl in selected:
            parts = tbl.split('.')
            if len(parts) == 2:
                desc_result = await run_database_operation(
                    connection_string, 'describeTable',
                    {'database': parts[0], 'table': parts[1]},
                )
                if desc_result['ok'] and desc_result.get('data', {}).get('columns'):
                    cols = '\n'.join(
                        f'    {c["Field"]} {c["Type"]}'
                        f'{" -- " + c["Comment"] if c.get("Comment") else ""}'
                        for c in desc_result['data']['columns']
                    )
                    schema_lines.append(f'  {tbl}:\n{cols}')
        if len(schema_lines) > 0:
            schema_context = (
                f'\n\n**可用表结构（仅限用户选中的 {len(selected)} 张表，严禁使用其他表）**：\n'
                f'{chr(10).join(schema_lines)}'
            )
    else:
        try:
            db_result = await run_database_operation(connection_string, 'listDatabases', {})
            if db_result['ok']:
                system_dbs = {
                    'information_schema', 'mysql', 'performance_schema',
                    'sys', 'mo_catalog', 'system', 'system_metrics',
                }
                databases = [
                    d['database']
                    for d in (db_result['data'].get('databases') or [])
                    if d.get('database') and d['database'].lower() not in system_dbs
                ]

                schema_lines = []
                for db_name in databases[:10]:
                    tbl_result = await run_database_operation(
                        connection_string, 'listTables', {'database': db_name},
                    )
                    if tbl_result['ok'] and tbl_result['data'].get('tables'):
                        for tbl_name in tbl_result['data']['tables'][:20]:
                            desc_result = await run_database_operation(
                                connection_string, 'describeTable',
                                {'database': db_name, 'table': tbl_name},
                            )
                            if desc_result['ok'] and desc_result.get('data', {}).get('columns'):
                                cols = '\n'.join(
                                    f'    {c["Field"]} {c["Type"]}'
                                    f'{" -- " + c["Comment"] if c.get("Comment") else ""}'
                                    for c in desc_result['data']['columns']
                                )
                                schema_lines.append(f'  {db_name}.{tbl_name}:\n{cols}')

                if len(schema_lines) > 0:
                    schema_context = f'\n\n**可用表结构**：\n{chr(10).join(schema_lines)}'
        except Exception:
            pass

    return {'schema_context': schema_context}


# ---------------------------------------------------------------------------
# Node 2: tool_calling_loop_node
# ---------------------------------------------------------------------------

async def tool_calling_loop_node(state: MetricChatState) -> dict:
    """调用 LLM（带 execute_sql 工具），循环处理 tool calls。"""
    conversation = state.get('conversation', [])
    connection_string = state.get('connection_string')
    selected = state.get('selected_tables', [])
    schema_context = state.get('schema_context', '')
    processed_tables = state.get('processed_tables', [])

    logger.info("[Metric] processed_tables count=%d, selected_tables=%s",
                len(processed_tables) if isinstance(processed_tables, list) else 0,
                selected)

    render_blocks = {}
    block_counter = [1]
    write_ops = []  # type: list  # 记录成功的写操作（INSERT/UPDATE/ALTER）

    selected_tables_restriction = ''
    if len(selected) > 0:
        selected_tables_restriction = (
            f'\n**【严格限制】用户已在界面上选中了 {len(selected)} 张表'
            f'（{", ".join(selected)}）。'
            f'你必须且只能使用上方列出的表进行分析和建议。'
            f'绝对不要提及、推测或建议任何未列出的表。**\n'
        )

    # ── 构建已加工业务表上下文 ──
    processed_info = ''
    processed_table_names = set()
    processed_field_set = set()
    source_tables_from_processed = set()

    if isinstance(processed_tables, list) and len(processed_tables) > 0:
        processed_parts = ['\n**【已加工的业务表】**（优先使用这些表）：']
        for pt in processed_tables:
            pt_db = pt.get('database', '')
            pt_tbl = pt.get('table', '')
            pt_full = f'{pt_db}.{pt_tbl}'
            processed_table_names.add(pt_full)
            pt_sources = pt.get('sourceTables', [])
            pt_mappings = pt.get('fieldMappings', [])

            for src in pt_sources:
                source_tables_from_processed.add(src)

            processed_parts.append(f'\n  业务表 {pt_full}（来源基表：{", ".join(pt_sources)}）')
            if pt_mappings:
                processed_parts.append('  已加工字段映射：')
                for m in pt_mappings:
                    src_table = m.get('sourceTable', '')
                    src_expr = m.get('sourceExpr', '')
                    target_field = m.get('targetField', '')
                    transform = m.get('transform', '')
                    processed_parts.append(f'    - {target_field} <- {src_table}.{src_expr} ({transform})')
                    processed_field_set.add(f'{src_table}.{src_expr}')

        processed_info = '\n'.join(processed_parts)

    # ── 标注 schema_context 中基表已加工字段 ──
    if processed_field_set and schema_context:
        for field_key in processed_field_set:
            parts = field_key.split('.')
            if len(parts) >= 2:
                field_name = parts[-1]
                # 在 schema_context 中找到该字段行并追加标注
                marker = '  【已加工到业务表，无需再从基表取】'
                # 匹配 "    fieldName TYPE" 格式的行
                pattern = re.compile(
                    rf'^(\s+{re.escape(field_name)}\s+\S+.*)$',
                    re.MULTILINE,
                )
                def _annotate(match):
                    line = match.group(1)
                    if marker not in line:
                        return line + marker
                    return line
                schema_context = pattern.sub(_annotate, schema_context)

    # ── 加工建议指令（无论是否有已加工表，都提示 LLM 给出加工建议） ──
    etl_suggestion_instruction = """

**【智能建议规则】**：
当用户定义指标时，如果涉及到基表（非已加工的业务表）中的字段，你应该：
- 分析当前使用的字段是否适合先加工到业务表
- 灵活地给用户提供多种选择方案，例如：直接基于基表创建指标、先加工业务表再定义指标、或者两步都做
- **加工方式不限于新建表**：可以是在已有业务表上 ALTER TABLE ADD COLUMN 加字段再 UPDATE 填充数据，也可以是新建一张业务表，要根据实际情况判断哪种更合理
- 不要用固定模板，根据具体场景自然地给出建议和选项
- 如果用户选择了加工业务表，你可以直接帮用户完成整个 ETL 流程（建表/加字段、字段映射、INSERT/UPDATE 数据等）
- 让用户自己决定下一步怎么做，你只需要把选项和利弊说清楚"""

    system_prompt = f"""你是一个智能数据助手，同时具备**数据加工（ETL）**和**指标定义**两种能力，两种能力可以无缝衔接。
{selected_tables_restriction}

**你有一个工具 `execute_sql`**，可以在用户的 MySQL 数据库上执行任意 SQL。需要查数据、建库、建表、写入数据时，直接调用工具执行 SQL 即可。你可以多次调用工具来完成多步操作。**当有多条互相独立的 SQL 需要执行时（如同时查看多张表的结构、同时预览多张表的数据），你应该在同一轮回复中同时调用多次工具，系统会并行执行，大幅提升效率。**

## 能力一：数据加工（ETL）
你可以帮助用户完成完整的数据库操作，包括：
- 查看数据库列表、表列表、表结构、数据预览
- 创建数据库、创建表（需用户确认后执行）
- 执行 SQL 查询（SELECT 直接执行，INSERT/CREATE 等写操作需用户确认）
- 分析数据质量（空值率、异常值）
- 字段映射与数据加工（INSERT INTO ... SELECT）
- 从基表加工生成业务表（完整流程：建表 → 字段映射 → 数据写入）

**数据库操作规则（必须严格遵守）**：
- **一切会修改库表或数据的操作（DDL 与 DML）都必须先展示完整 SQL 并获用户明确确认后才能调用工具执行。** 包括但不限于：CREATE TABLE、CREATE DATABASE、ALTER TABLE、INSERT INTO、DROP、DELETE 等。你必须先展示完整 SQL 和业务含义解释，并明确提示用户「请确认后回复"确认"或"执行"」。只有用户明确回复「确认」「执行」「可以」「好的」后，才能调用 execute_sql 工具真实执行。**绝对不允许在用户未确认时执行任何写操作。**
- 只读操作（SELECT、DESCRIBE、SHOW）可直接调用工具执行，无需确认
- 所有 SQL 必须严格符合 MySQL 语法
- 展示数据时必须用 markdown 表格，禁止 JSON
- 若工具执行失败，必须如实展示失败原因，不得声称成功
- **所有生成的 SQL 下方必须附带业务含义解释**：用通俗易懂的中文说明这段 SQL 在做什么、每个关键部分的业务含义，让非技术人员也能看懂

## 能力二：指标定义
你可以帮助用户定义纯度量指标（不含维度）：
- 指标 = 一个度量（如"收入"、"订单量"、"活跃用户数"）
- 维度在后续"添加监控数据"时由用户指定
- 指标定义需要明确：指标名称、计算逻辑描述、聚合方式、度量字段、涉及的表

**指标定义流程**：
1. 用户描述想要的指标
2. 你根据可用表结构分析可用字段
3. 给出聚合方式和度量字段建议
4. 用户确认后生成指标定义

## 两种能力的无缝衔接
- 在定义指标的过程中，如果发现需要用到基表的原始字段，你应该智能地分析情况，给用户提供灵活的选择：
  - 可以直接基于基表定义指标
  - 可以建议先把相关字段加工到业务表，再定义指标
  - 可以两步都做：先创建指标，同时建议后续加工
  - 或者其他你认为合适的方案
- 不要用固定模板，根据具体场景自然地给出建议
- 如果用户选择加工业务表，你可以直接帮用户完成整个 ETL 流程（新建表、在已有表上加字段、字段映射、INSERT/UPDATE 数据），不需要跳转到其他页面
- 让用户自己决定下一步，你把选项和利弊说清楚就好

## 如何判断用户意图
- 用户说「看看有哪些库」「查看表结构」「建表」「执行SQL」「加工数据」等 → 数据加工能力
- 用户说「定义指标」「我想看收入」「统计订单量」「添加指标」等 → 指标定义能力
- 两种能力可以混合使用，比如用户可能先查看表结构再定义指标，或者定义指标时发现需要先加工数据

{schema_context}
{processed_info}
{etl_suggestion_instruction}

**【数据块引用机制】**：
execute_sql 工具返回的结果中会包含数据块 ID（如 TABLE_1、SQL_1、TABLE_2、SQL_2 等），这些 ID 对应真实的查询结果数据。
你在最终回复中**必须直接用 `{{TABLE_1}}`、`{{SQL_1}}` 这样的格式引用**，**严禁**自己手写或复制表格/SQL内容。
示例：工具返回 "可用数据块：SQL_1（执行的SQL）, TABLE_1（查询结果，10行）"
你的回复应写：`{{SQL_1}}\n\n{{TABLE_1}}`
后端会自动将 `{{TABLE_1}}` 替换为真实表格内容。
**注意**：直接写数据块 ID 本身，如 `{{{{TABLE_3}}}}`，不要写成其他格式。

**回复规则**：
- 用中文回复，简洁友好
- **【最高优先级规则 — 禁止空谈】** 用户的每一条消息都是一个指令，你必须对每个指令做出实质性响应。绝对禁止只回复过渡性文本而不执行任何操作。具体要求：
  - 如果用户要求查看/验证/检查/分析数据 → 你必须在本轮直接调用 execute_sql 工具执行相应 SQL，并在回复中展示结果。不允许只说「让我验证一下」「现在来检查」然后就结束。
  - 如果用户要求执行某个操作 → 你必须在本轮完成该操作（调用工具或展示 SQL 等待确认），不允许只描述你打算做什么。
  - 如果你的回复以冒号「：」结尾、或包含「让我」「现在来」「接下来」等词但没有实际内容跟随 → 这说明你没有完成用户的指令，这是严重错误。
  - **每轮回复必须包含实质性内容（工具调用结果、完整 SQL 方案、或基于已有信息的完整分析），绝不允许只有过渡性文字。**
- 若工具执行失败，必须如实输出失败原因，不得声称成功
- 若工具执行成功，必须以 markdown 表格展示数据。用 {{{{TABLE_N}}}} 引用数据块
- **【最重要的规则】所有写操作（CREATE TABLE、ALTER TABLE、INSERT、DELETE、DROP 等）必须先展示完整 SQL + 业务含义解释，然后提示用户确认，等用户回复「确认」「执行」后才能调用工具执行。绝对不能跳过确认直接执行！**
- **凡涉及表数据展示的回答**，回复中**禁止出现 JSON**，必须用「SQL 代码块 + markdown 表格 + 返回码」三部分展示
- 表格内容必须与工具返回结果完全一致，不得编造
- 如果你已经有足够的信息（如 schema_context 中已有表结构），直接基于已有信息回复，不需要再调用工具查询

**输出格式**：直接用 markdown 回复，不要包裹在 JSON 中。

**【创建指标的唯一方式】**：
当用户确认要创建指标时，你**必须调用 `create_metric_def` 工具**来创建指标。
- 只有调用 `create_metric_def` 工具才能真正创建指标
- 仅在回复文本中说"指标已创建"是无效的，指标不会被保存
- 用户确认后（说了"确认"、"可以"、"好的"、"创建"等），立即调用 `create_metric_def` 工具
- 工具调用成功后，再在回复中告知用户指标已创建"""

    messages = [
        {'role': 'system', 'content': system_prompt},
        *[{'role': t['role'], 'content': t['content']} for t in conversation],
    ]

    tools = METRIC_CHAT_TOOLS if connection_string else None
    created_metric_defs = []  # 通过 create_metric_def 工具真正创建的指标

    MAX_TOOL_ROUNDS = 8
    try:
        for round_i in range(MAX_TOOL_ROUNDS):
            result = await call_llm(
                messages, tools=tools,
                temperature=0.3, max_tokens=4096,
                caller=f"metric_chat_r{round_i}",
            )

            if not result.get('ok'):
                return {
                    'llm_response': {
                        '_error': result.get('error') or '指标对话失败',
                        '_status': result.get('status', 500),
                    }
                }

            tool_calls = result.get('tool_calls')

            if not tool_calls:
                return _process_metric_response(
                    result.get('content', ''), render_blocks,
                    write_ops, created_metric_defs, conversation,
                )

            messages.append({
                'role': 'assistant',
                'content': result.get('content'),
                'tool_calls': [
                    {
                        'id': tc.id,
                        'type': 'function',
                        'function': {
                            'name': tc.function.name,
                            'arguments': tc.function.arguments,
                        },
                    }
                    for tc in tool_calls
                ],
            })

            # 并行执行所有 tool calls
            async def _run_tool(tc):
                logger.info("[Tool] call: %s args=%s", tc.function.name, tc.function.arguments[:200])
                if tc.function.name == 'create_metric_def':
                    res = await execute_create_metric_def(tc, created_metric_defs)
                else:
                    res = await execute_tool_call(
                        tc, connection_string, render_blocks, block_counter, write_ops,
                    )
                logger.info("[Tool] result: %s", res[:200])
                return tc.id, res

            results = await asyncio.gather(*[_run_tool(tc) for tc in tool_calls])
            for tc_id, tool_result in results:
                messages.append({
                    'role': 'tool',
                    'tool_call_id': tc_id,
                    'content': tool_result,
                })

        # 超过最大轮次，再执行最后一个 tool call 然后强制总结
        if result.get('ok') and result.get('tool_calls'):
            last_tool_calls = result['tool_calls']
            messages.append({
                'role': 'assistant',
                'content': result.get('content'),
                'tool_calls': [
                    {'id': tc.id, 'type': 'function',
                     'function': {'name': tc.function.name, 'arguments': tc.function.arguments}}
                    for tc in last_tool_calls
                ],
            })
            async def _run_tool_final(tc):
                if tc.function.name == 'create_metric_def':
                    res = await execute_create_metric_def(tc, created_metric_defs)
                else:
                    res = await execute_tool_call(
                        tc, connection_string, render_blocks, block_counter, write_ops,
                    )
                return tc.id, res
            final_results = await asyncio.gather(*[_run_tool_final(tc) for tc in last_tool_calls])
            for tc_id, tool_result in final_results:
                messages.append({'role': 'tool', 'tool_call_id': tc_id, 'content': tool_result})

        # 最终总结（不带 tools，强制模型输出文本）
        messages.append({
            'role': 'user',
            'content': '请基于以上所有工具执行结果，直接给出最终回复。不要再调用工具。',
        })
        result = await call_llm(
            messages, temperature=0.3, max_tokens=4096,
            caller="metric_chat_final",
        )
        content = result.get('content', '') if result.get('ok') else '对话处理超时，请重试。'
        return _process_metric_response(content, render_blocks, write_ops, created_metric_defs, conversation)

    except Exception as e:
        logger.error("[Metric] tool_calling_loop error: %s", e)
        return {
            'llm_response': {
                '_error': str(e) or '指标对话失败',
                '_status': 500,
            }
        }


def _try_extract_confirmed_metric(conversation):
    """确定性兜底：如果用户最后一条消息是确认词，且对话历史中有指标定义方案，则提取。
    不依赖模型回复格式，纯规则匹配。"""
    if not conversation or len(conversation) < 2:
        return None

    # 1. 检查用户最后一条消息是否是确认
    last_user_msg = ''
    for msg in reversed(conversation):
        if msg.get('role') == 'user':
            last_user_msg = (msg.get('content') or '').strip()
            break

    if not last_user_msg:
        return None

    confirm_pattern = re.compile(
        r'^(确认|可以|没问题|好的|创建|是的|对|行|同意|确定|好|嗯|ok|yes|y|'
        r'没问题的|可以的|好的好的|是|对的|创建吧|确认创建|就这样|就这个|方案[一二三123])',
        re.IGNORECASE,
    )
    if len(last_user_msg) > 20 or not confirm_pattern.search(last_user_msg):
        return None

    # 2. 从对话历史中倒序找包含指标定义方案的 assistant 消息
    for msg in reversed(conversation):
        if msg.get('role') not in ('assistant',):
            continue
        text = msg.get('content') or ''
        if not text:
            continue

        # 必须包含"指标名称"关键词
        name_match = (
            re.search(r'\*\*指标名称\*\*[：:]\s*(.+)', text)
            or re.search(r'指标名称[：:]\s*(.+)', text)
        )
        if not name_match:
            continue

        metric_name = name_match.group(1).strip().rstrip('*').strip()

        # 提取计算逻辑
        definition = ''
        for pat in [r'\*\*计算逻辑\*\*[：:]\s*(.+)', r'计算逻辑[：:]\s*(.+)',
                    r'\*\*计算方式\*\*[：:]\s*(.+)', r'计算方式[：:]\s*(.+)']:
            m = re.search(pat, text)
            if m:
                definition = m.group(1).strip().rstrip('*').strip()
                break

        # 提取聚合方式
        aggregation = 'SUM'
        for pat in [r'\*\*聚合方式\*\*[：:]\s*(.+)', r'聚合方式[：:]\s*(.+)']:
            m = re.search(pat, text)
            if m:
                agg_text = m.group(1).strip().upper()
                for kw in ['COUNT_DISTINCT', 'SUM', 'COUNT', 'AVG', 'MAX', 'MIN']:
                    if kw in agg_text:
                        aggregation = kw
                        break
                break

        # 提取度量字段
        measure_field = ''
        for pat in [r'\*\*度量字段\*\*[：:]\s*(.+)', r'度量字段[：:]\s*(.+)']:
            m = re.search(pat, text)
            if m:
                measure_field = m.group(1).strip().rstrip('*').strip()
                break

        # 提取涉及表
        tables = []
        for pat in [r'\*\*涉及表\*\*[：:]\s*(.+)', r'涉及表[：:]\s*(.+)']:
            m = re.search(pat, text)
            if m:
                tbl_text = m.group(1).strip()
                tables = [t.strip().rstrip('*').strip() for t in re.split(r'[,，、\s]+', tbl_text) if '.' in t]
                break

        if metric_name:
            logger.info("[Metric] deterministic extraction: name=%s, agg=%s, measure=%s, tables=%s",
                        metric_name, aggregation, measure_field, tables)
            return {
                'name': metric_name,
                'definition': definition,
                'tables': tables,
                'aggregation': aggregation,
                'measureField': measure_field,
            }

    return None


def _process_metric_response(content, render_blocks, write_ops=None, created_metric_defs=None, conversation=None):
    """处理 LLM 最终回复：解析 JSON、替换占位符。metricDef 优先由工具调用决定，兜底从对话历史确定性提取。"""
    content = (content or '').strip()
    # 尝试从 JSON 格式回复中提取 reply 文本
    json_match = re.search(r'\{[\s\S]*\}', content)
    out = {'reply': content}
    if json_match:
        try:
            parsed = json.loads(json_match.group(0))
            if isinstance(parsed.get('reply'), str):
                out['reply'] = parsed['reply']
        except (json.JSONDecodeError, ValueError):
            pass

    # 优先：工具调用创建的指标
    if created_metric_defs and len(created_metric_defs) > 0:
        out['metricDef'] = created_metric_defs[-1]
        logger.info("[Metric] metricDef created via tool: %s", out['metricDef'].get('name', ''))
    else:
        # 兜底：确定性检查 — 用户确认了 + 对话中有指标方案 → 自动提取
        extracted = _try_extract_confirmed_metric(conversation)
        if extracted:
            out['metricDef'] = extracted
            logger.info("[Metric] metricDef extracted deterministically: %s", extracted.get('name', ''))

    # 替换标准格式的占位符
    if render_blocks:
        reply = out['reply']
        for bid, content_val in render_blocks.items():
            reply = reply.replace('{{' + bid + '}}', content_val)
            reply = reply.replace('{' + bid + '}', content_val)
        out['reply'] = reply

    # 智能处理畸形占位符
    def _replace_malformed(match):
        text = match.group(0)
        inner = re.search(r'(TABLE_\d+|SQL_\d+)', text)
        if inner and render_blocks and inner.group(1) in render_blocks:
            return render_blocks[inner.group(1)]
        return ''

    out['reply'] = re.sub(
        r'\{+\s*(?:BLOCK_ID\s*[:\s]*)?(?:TABLE_\d+|SQL_\d+|BLOCK_\d+|BLOCK_ID)\s*\}+',
        _replace_malformed,
        out['reply'],
    ).strip()

    logger.info("[Metric] reply_len=%d has_metricDef=%s blocks=%s",
                len(out['reply']), 'metricDef' in out,
                list(render_blocks.keys()) if render_blocks else [])

    response = {'llm_response': out}

    # 处理写操作（INSERT/UPDATE/ALTER），返回 processedTable 信息
    if write_ops:
        insert_ops = [op for op in write_ops if op.get("type") == "insert"]
        update_ops = [op for op in write_ops if op.get("type") == "update"]
        legacy_ops = [op for op in write_ops if "type" not in op]
        insert_ops.extend(legacy_ops)

        if insert_ops:
            last_op = insert_ops[-1]
            out["processedTable"] = {
                "database": last_op["database"],
                "table": last_op["table"],
                "insertSql": last_op.get("insertSql", last_op.get("sql", "")),
                "sourceTables": last_op.get("sourceTables", []),
                "fieldMappings": last_op.get("fieldMappings", []),
            }

        incremental_mappings = []
        for op in update_ops:
            incremental_mappings.extend(op.get("fieldMappings", []))

        if incremental_mappings:
            if "processedTable" in out:
                existing = out["processedTable"].get("fieldMappings", [])
                out["processedTable"]["fieldMappings"] = existing + incremental_mappings
            else:
                first_update = update_ops[0]
                out["processedTable"] = {
                    "database": first_update["database"],
                    "table": first_update["table"],
                    "insertSql": "",
                    "sourceTables": first_update.get("sourceTables", []),
                    "fieldMappings": incremental_mappings,
                    "_incremental": True,
                }

    return response


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_metric_chat_graph():
    graph = StateGraph(MetricChatState)
    graph.add_node("fetch_schema_context", fetch_schema_context_node)
    graph.add_node("tool_calling_loop", tool_calling_loop_node)

    graph.set_entry_point("fetch_schema_context")
    graph.add_edge("fetch_schema_context", "tool_calling_loop")
    graph.add_edge("tool_calling_loop", END)

    return graph.compile()
