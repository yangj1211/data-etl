from fastapi import APIRouter
from fastapi.responses import JSONResponse
from config import LLM_API_KEY
from llm.client import call_llm
from db.operations import run_database_operation
import re
import json

router = APIRouter()


# ────────── POST /api/metric/match — 根据描述匹配已有指标 ──────────

@router.post("/api/metric/match")
async def metric_match(request_body: dict):
    if not LLM_API_KEY:
        return JSONResponse(status_code=503, content={"error": "DEEPSEEK_API_KEY not configured"})

    description = request_body.get('description')
    metric_defs = request_body.get('metricDefs')

    if not description or not isinstance(metric_defs, list) or len(metric_defs) == 0:
        return JSONResponse(status_code=400, content={"error": "Missing description or metricDefs"})

    defs_context = '\n'.join(
        f'{i + 1}. {md["name"]}: {md["definition"]}（聚合: {md["aggregation"]}，度量字段: {md["measureField"]}，涉及表: {", ".join(md.get("tables") or [])}）'
        for i, md in enumerate(metric_defs)
    )

    system_prompt = f'''你是一个数据分析专家。用户描述了想要统计的数据，你需要从已有的指标定义中找出最匹配的指标。

**已有指标定义**：
{defs_context}

**用户描述**：{description}

请分析用户的需求，从已有指标中选出相关的指标（可以是一个或多个）。
对每个匹配的指标，说明匹配原因。

只返回 JSON，不要 markdown 代码块：
{{"matches":[{{"name":"指标名称","reason":"匹配原因"}}],"suggestion":"对用户需求的理解和建议"}}'''

    try:
        result = await call_llm(
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': description},
            ],
            temperature=0.2,
            max_tokens=1024,
        )
        if not result['ok']:
            return JSONResponse(status_code=result.get('status', 500), content={"error": result['error'] or "匹配失败"})

        content = (result.get('content') or '').strip()
        json_match = re.search(r'\{[\s\S]*\}', content)
        if not json_match:
            return JSONResponse(status_code=500, content={"error": "模型未返回有效 JSON"})
        parsed = json.loads(json_match.group(0))
        return {
            "matches": parsed['matches'] if isinstance(parsed.get('matches'), list) else [],
            "suggestion": parsed.get('suggestion', ''),
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e) or "匹配失败"})


# ────────── POST /api/metric/generate — 根据指标定义 + 维度描述生成 SQL ──────────

@router.post("/api/metric/generate")
async def metric_generate(request_body: dict):
    if not LLM_API_KEY:
        return JSONResponse(status_code=503, content={"error": "DEEPSEEK_API_KEY not configured"})

    metric_name = request_body.get('metricName')
    definition = request_body.get('definition')
    description = request_body.get('description')
    metric_defs = request_body.get('metricDefs')
    connection_string = request_body.get('connectionString')
    processed_tables = request_body.get('processedTables') or []

    if not metric_name or not description:
        return JSONResponse(status_code=400, content={"error": "Missing metricName or description"})

    # 从 metricDefs 收集涉及的表
    all_tables = set()
    if isinstance(metric_defs, list):
        for md in metric_defs:
            if isinstance(md.get('tables'), list):
                for t in md['tables']:
                    all_tables.add(t)

    # 收集已加工表信息：哪些基表字段已被加工过
    processed_info = ''
    processed_table_names = set()  # 已加工的业务表名（db.table）
    processed_field_set = set()    # 已加工的基表字段（sourceTable.sourceField）
    source_tables_from_processed = set()  # 已加工表的基表

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
                    # 记录已加工的基表字段
                    processed_field_set.add(f'{src_table}.{src_expr}')

            # 把业务表也加入需要查结构的表
            all_tables.add(pt_full)

        processed_info = '\n'.join(processed_parts)

    # 把基表也加入需要查结构的表（用于对比）
    for src in source_tables_from_processed:
        all_tables.add(src)

    # 获取所有涉及表的结构
    schema_info = ''
    if connection_string:
        for tbl in all_tables:
            parts = tbl.split('.')
            if len(parts) == 2:
                params = {'database': parts[0], 'table': parts[1]}
            else:
                params = {'table': parts[0]}
            result = await run_database_operation(connection_string, 'describeTable', params)
            if result['ok']:
                cols = result['data'].get('columns') or []

                # 标注基表中已被加工过的字段
                is_source_table = tbl in source_tables_from_processed
                col_lines = []
                for c in cols:
                    field_key = f'{tbl}.{c["Field"]}'
                    already_processed = is_source_table and field_key in processed_field_set
                    line = '  {} {}{}{}{}'.format(
                        c["Field"], c["Type"],
                        "  PRIMARY KEY" if c.get("Key") == "PRI" else "",
                        " -- " + c["Comment"] if c.get("Comment") else "",
                        "  【已加工到业务表，无需再从基表取】" if already_processed else "",
                    )
                    col_lines.append(line)

                table_label = ''
                if tbl in processed_table_names:
                    table_label = '（已加工业务表 ✓）'
                elif tbl in source_tables_from_processed:
                    table_label = '（基表）'

                schema_info += f'\n表 {tbl}{table_label}:\n' + '\n'.join(col_lines) + '\n'

    # 构建指标定义上下文
    if isinstance(metric_defs, list) and len(metric_defs) > 0:
        metric_defs_context = '\n'.join(
            f'- {md["name"]}: {md["definition"]}（聚合: {md["aggregation"]}，度量字段: {md["measureField"]}，涉及表: {", ".join(md.get("tables") or [])}）'
            for md in metric_defs
        )
    else:
        metric_defs_context = '（无指标定义）'

    system_prompt = f'''你是一个数据分析 SQL 专家。用户要基于已定义的指标创建一个监控数据查询。

**已定义的指标**：
{metric_defs_context}
{processed_info}

**用户的监控数据需求**：
- 名称：{metric_name}
- 描述：{description}

你需要：
1. **优先使用已存在的指标**：如果已定义的指标中有可以直接用于计算的，优先基于这些指标的定义（聚合方式 + 度量字段）来生成 SQL，不要重复造轮子
2. **优先使用已加工的业务表**：如果已加工业务表中有需要的字段，直接从业务表取数，不要回到基表
3. **同时参考业务表和基表**：如果业务表不能满足需求，再看基表中**尚未被加工过的字段**（标注了「已加工到业务表」的字段不需要再从基表取）
4. **加工建议**：如果发现需要用到基表中未加工的字段，在 explanation 中给出建议，提示用户是否需要先通过 ETL 加工把这些字段加工到业务表中，以便后续复用
5. 推荐最佳的可视化类型

**SQL 语法要求（必须严格遵守）**：
- 兼容 MySQL 5.7+ 语法
- **所有中文别名必须用反引号包裹**
- 库名.表名 格式引用表

**可用表结构**：
{schema_info or '（未提供表结构，请根据指标定义合理推断）'}

**可视化类型选择规则**：
- number: 结果是单个数值（如总数、平均值、求和）
- bar: 结果是分类对比（如按类目/地区/状态分组的数值）
- line: 结果是时间序列趋势（如按日/月的变化）
- pie: 结果是占比分布（如各类目占比，分组数 ≤ 8）
- table: 结果是多列明细或复杂结构

只返回 JSON，不要 markdown 代码块：
{{"sql":"SELECT ...","chartType":"number|bar|line|pie|table","explanation":"简要说明查询逻辑。如果用到了基表中未加工的字段，请在此说明并建议用户是否需要先加工到业务表","usedBaseTables":true|false,"etlSuggestion":"如果 usedBaseTables 为 true，给出具体的加工建议（如：建议先将基表 xxx 的 yyy 字段加工到业务表 zzz 中）；否则为 null","derivedMetricDef":{{"name":"...","definition":"...","tables":[...],"aggregation":"...","measureField":"..."}}}}

**派生指标建议（非常重要，必须认真分析）**：
你必须分析用户的监控数据是否涉及一个**新的度量概念**，如果是，则**必须**在 derivedMetricDef 中返回派生指标定义。

**必须建议派生指标的场景**：
1. 监控数据涉及**比率/比值**计算（如毛利率、转化率、占比、净利率等）→ 派生指标为该比率本身
2. 监控数据涉及**增长率/变化率**（如同比增长率、环比增长率）→ 派生指标为该增长率
3. 监控数据涉及**复合计算**（如客单价=收入/订单数、人均消费等）→ 派生指标为该复合指标
4. 监控数据的核心度量概念**不在已定义指标列表中**（即使它是由已有指标组合而来）

**不需要建议的场景**：
- 监控数据只是对已有指标加维度（如"按月的收入"，收入指标已存在）
- 监控数据名称和已有指标完全相同

派生指标格式：
- name: 指标名称（如"净毛利率"、"客单价"、"同比增长率"）
- definition: 计算逻辑的自然语言描述（如"净毛利除以销售收入的百分比"）
- tables: 涉及的表
- aggregation: 最接近的聚合方式（比率类用 "自定义"，简单聚合用 SUM/COUNT/AVG 等）
- measureField: 核心度量字段（比率类填主要的分子字段）

如果确实不需要建议（仅限上述"不需要"场景），derivedMetricDef 设为 null。

**重要：SQL 兼容性**：
- 目标数据库可能不支持所有 MySQL 函数。避免使用 QUARTER()、STR_TO_DATE()、WEEK()、DAYOFWEEK() 等高级函数。
- 用简单的字符串拼接和基础函数替代：CONCAT、LPAD、SUBSTRING、FLOOR、MOD 等。
- 季度计算用 CEIL(month/3) 或 FLOOR((month-1)/3)+1 替代 QUARTER()。
- 窗口函数 LAG/LEAD 可能不被支持，改用子查询或自连接。'''

    # ── 生成 SQL 并验证，最多重试 3 次 ──
    MAX_RETRIES = 3
    last_sql = ''
    last_chart_type = 'table'
    last_explanation = ''
    last_derived_metric_def = None
    last_error = None
    chat_messages = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': f'请为监控数据「{metric_name}」生成查询 SQL。需求描述：{description}'},
    ]

    try:
        for attempt in range(MAX_RETRIES):
            result = await call_llm(chat_messages, temperature=0.2, max_tokens=2048)
            if not result['ok']:
                return JSONResponse(status_code=result.get('status', 500), content={"error": result['error'] or "生成失败"})

            content = (result.get('content') or '').strip()
            json_match = re.search(r'\{[\s\S]*\}', content)
            if not json_match:
                if attempt < MAX_RETRIES - 1:
                    chat_messages.append({'role': 'assistant', 'content': content})
                    chat_messages.append({'role': 'user', 'content': '请返回有效的 JSON 格式，包含 sql、chartType、explanation 字段。'})
                    continue
                return JSONResponse(status_code=500, content={"error": "模型未返回有效 JSON"})

            try:
                parsed = json.loads(json_match.group(0))
            except Exception:
                if attempt < MAX_RETRIES - 1:
                    chat_messages.append({'role': 'assistant', 'content': content})
                    chat_messages.append({'role': 'user', 'content': 'JSON 解析失败，请返回合法的 JSON。'})
                    continue
                return JSONResponse(status_code=500, content={"error": "JSON 解析失败"})

            last_sql = parsed.get('sql', '')
            last_chart_type = parsed.get('chartType', 'table')
            last_explanation = parsed.get('explanation', '')
            last_derived_metric_def = parsed.get('derivedMetricDef') or None

            # 验证 SQL：尝试执行，如果报错则让模型修正
            if last_sql and connection_string:
                try:
                    validate_result = await run_database_operation(connection_string, 'executeSQL', {'sql': last_sql})
                    if not validate_result['ok']:
                        last_error = validate_result.get('error') or '执行失败'
                        if attempt < MAX_RETRIES - 1:
                            chat_messages.append({'role': 'assistant', 'content': content})
                            chat_messages.append({'role': 'user', 'content': f'上面生成的 SQL 执行报错：{last_error}\n\n请修正 SQL 后重新返回 JSON。注意：\n1. 不要使用 QUARTER()、STR_TO_DATE()、WEEK() 等可能不被支持的函数\n2. 季度用 CEIL(月份/3) 计算\n3. 避免窗口函数 LAG/LEAD，改用子查询或自连接\n4. 确保所有列名和表名正确'})
                            continue
                        # 最后一次仍然失败，返回 SQL 和错误信息让用户手动修改
                    else:
                        last_error = None
                        break  # SQL 验证通过
                except Exception:
                    # 验证过程异常，不阻塞，返回 SQL 让用户决定
                    break
            else:
                break  # 没有连接串，无法验证

        # 模型返回的派生指标
        derived_metric_def = last_derived_metric_def

        # 如果模型没返回，服务端自动检测是否应该建议派生指标
        if not derived_metric_def:
            name_and_desc = f'{metric_name or ""} {description or ""}'.lower()
            sql_str = (last_sql or '').lower()
            existing_names = set(d['name'] for d in (metric_defs if isinstance(metric_defs, list) else []))

            # 检测比率/比值类
            ratio_patterns = [
                {
                    'pattern': re.compile(r'毛利率|利润率|净利率'),
                    'name': lambda nad=name_and_desc: (
                        (re.search(r'([\u4e00-\u9fa5]*毛利率|[\u4e00-\u9fa5]*利润率|[\u4e00-\u9fa5]*净利率)', nad) or type('', (), {'group': lambda self, x: '毛利率'})()).group(1)
                    ),
                    'def': '利润与收入的比值百分比',
                },
                {
                    'pattern': re.compile(r'转化率|转换率'),
                    'name': lambda: '转化率',
                    'def': '转化数量与总数量的比值',
                },
                {
                    'pattern': re.compile(r'占比|比例|比重'),
                    'name': lambda nad=name_and_desc: (
                        (re.search(r'([\u4e00-\u9fa5]*占比|[\u4e00-\u9fa5]*比例)', nad) or type('', (), {'group': lambda self, x: '占比'})()).group(1)
                    ),
                    'def': '部分与整体的比值',
                },
                {
                    'pattern': re.compile(r'客单价|均价|平均价'),
                    'name': lambda: '客单价',
                    'def': '总金额除以总订单数',
                },
                {
                    'pattern': re.compile(r'同比|环比|增长率|变化率'),
                    'name': lambda nad=name_and_desc: (
                        (re.search(r'([\u4e00-\u9fa5]*同比[\u4e00-\u9fa5]*|[\u4e00-\u9fa5]*环比[\u4e00-\u9fa5]*|[\u4e00-\u9fa5]*增长率)', nad) or type('', (), {'group': lambda self, x: '增长率'})()).group(1)
                    ),
                    'def': '与上期相比的变化百分比',
                },
                {
                    'pattern': re.compile(r'完成率|达成率'),
                    'name': lambda: '完成率',
                    'def': '实际值与目标值的比值',
                },
            ]

            # 也检测 SQL 中的除法运算（比率的标志）
            has_division = (
                bool(re.search(r'/\s*(?:SUM|COUNT|AVG|MAX|MIN)\s*\(', sql_str, re.IGNORECASE))
                or bool(re.search(r'SUM\s*\([^)]+\)\s*/\s*SUM', sql_str, re.IGNORECASE))
            )

            for rp in ratio_patterns:
                if rp['pattern'].search(name_and_desc):
                    derived_name = rp['name']()
                    if derived_name not in existing_names:
                        # 从已有 metricDefs 中提取涉及的表
                        tables = list(set(
                            t for d in (metric_defs if isinstance(metric_defs, list) else [])
                            for t in (d.get('tables') or [])
                        ))
                        # 从 SQL 中提取可能的度量字段
                        field_match = re.search(r'SUM\s*\(\s*(\w+)\s*\)', last_sql or '', re.IGNORECASE)
                        measure_field = field_match.group(1) if field_match else (
                            (metric_defs[0].get('measureField', '') if isinstance(metric_defs, list) and len(metric_defs) > 0 else '')
                        )
                        derived_metric_def = {
                            'name': derived_name,
                            'definition': rp['def'],
                            'tables': tables,
                            'aggregation': '自定义',
                            'measureField': measure_field,
                        }
                        break

            # 如果名称没匹配到但 SQL 有除法运算，也建议
            if not derived_metric_def and has_division:
                clean_name = re.sub(r'近半年|最近|每月|月度|年度|趋势|统计', '', metric_name or '').strip()
                if clean_name and clean_name not in existing_names:
                    tables = list(set(
                        t for d in (metric_defs if isinstance(metric_defs, list) else [])
                        for t in (d.get('tables') or [])
                    ))
                    field_match = re.search(r'SUM\s*\(\s*(\w+)\s*\)', last_sql or '', re.IGNORECASE)
                    derived_metric_def = {
                        'name': clean_name,
                        'definition': f'{description or clean_name}（派生计算指标）',
                        'tables': tables,
                        'aggregation': '自定义',
                        'measureField': field_match.group(1) if field_match else '',
                    }

        valid_chart_types = ['number', 'bar', 'line', 'pie', 'table']
        etl_suggestion = None
        if isinstance(last_derived_metric_def, dict):
            # 模型可能在 derivedMetricDef 旁边返回了 etlSuggestion
            pass

        # 从最后一次 LLM 返回中提取 etlSuggestion
        # 重新解析最后一次成功的 JSON
        if chat_messages:
            for msg in reversed(chat_messages):
                if msg.get('role') == 'assistant' and msg.get('content'):
                    jm = re.search(r'\{[\s\S]*\}', msg['content'])
                    if jm:
                        try:
                            p = json.loads(jm.group(0))
                            if p.get('etlSuggestion'):
                                etl_suggestion = p['etlSuggestion']
                            if p.get('usedBaseTables') and not etl_suggestion:
                                etl_suggestion = p.get('explanation', '')
                        except Exception:
                            pass
                        break

        explanation_text = last_explanation
        if etl_suggestion:
            explanation_text += f'\n\n💡 加工建议：{etl_suggestion}'

        return {
            "sql": last_sql,
            "chartType": last_chart_type if last_chart_type in valid_chart_types else 'table',
            "explanation": explanation_text + (f'\n\n⚠️ SQL 验证失败（已尝试 {MAX_RETRIES} 次自动修正）：{last_error}' if last_error else ''),
            "derivedMetricDef": derived_metric_def,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e) or "生成失败"})


# ────────── POST /api/metric/query — 执行指标 SQL 并返回数据 ──────────

@router.post("/api/metric/query")
async def metric_query(request_body: dict):
    sql = request_body.get('sql')
    connection_string = request_body.get('connectionString')

    if not sql or not connection_string:
        return JSONResponse(status_code=400, content={"error": "Missing sql or connectionString"})

    forbidden = re.compile(r'\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|CREATE|ALTER)\b', re.IGNORECASE)
    if forbidden.search(sql):
        return JSONResponse(status_code=400, content={"error": "指标查询仅允许 SELECT 语句"})

    try:
        result = await run_database_operation(connection_string, 'executeSQL', {'sql': sql})
        if not result['ok']:
            return JSONResponse(status_code=400, content={"error": result['error']})
        return {
            "rows": result['data'].get('rows') or [],
            "rowCount": (result['data'].get('executionSummary') or {}).get('rowCount', 0),
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e) or "查询失败"})
