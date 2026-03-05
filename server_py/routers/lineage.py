from fastapi import APIRouter
from fastapi.responses import JSONResponse
from config import LLM_API_KEY
from llm.client import call_llm
from db.operations import run_database_operation
from utils.sql_parser import extract_table_refs_from_sql
import re
import json
import hashlib
import logging

logger = logging.getLogger("etl.lineage")

router = APIRouter()

# ────────── 缓存 ──────────
# 用于缓存血缘分析结果，避免重复调用 LLM
_lineage_cache: dict[str, dict] = {}
_metric_lineage_cache: dict[str, dict] = {}


def _make_cache_key(data: dict) -> str:
    """根据请求参数生成缓存 key"""
    raw = json.dumps(data, sort_keys=True, ensure_ascii=False)
    return hashlib.md5(raw.encode()).hexdigest()


def _classify_table_role_in_sql(sql: str, ref: dict) -> str:
    """判断一个表在 SQL 中是基表（FROM）还是维表（JOIN）。
    通过检查该表名在 SQL 中首次出现时的上下文来判断。"""
    table_name = ref.get('table', '')
    database = ref.get('database', '')

    # 构建可能的表名匹配模式
    patterns = []
    if database:
        patterns.append(f'`{database}`.`{table_name}`')
        patterns.append(f'{database}.{table_name}')
    patterns.append(f'`{table_name}`')
    patterns.append(table_name)

    sql_upper = sql.upper()

    for pat in patterns:
        idx = sql.find(pat)
        if idx < 0:
            idx = sql_upper.find(pat.upper())
        if idx >= 0:
            # 查看该表名前面最近的关键字
            prefix = sql_upper[:idx].rstrip()
            if prefix.endswith('JOIN'):
                return '维表'
            if prefix.endswith('FROM'):
                return '基表'
            # LEFT/RIGHT/INNER/CROSS JOIN
            if re.search(r'(LEFT|RIGHT|INNER|CROSS|FULL)\s+JOIN\s*$', prefix):
                return '维表'

    return '基表'


def _extract_join_relations(sql: str) -> list[dict]:
    """从 SQL 中提取 JOIN 关系。"""
    relations = []
    # 匹配 JOIN ... ON ... 模式
    join_pattern = re.compile(
        r'((?:LEFT|RIGHT|INNER|CROSS|FULL)\s+)?JOIN\s+'
        r'(?:`([^`]+)`\.`([^`]+)`|([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)|`([^`]+)`|([a-zA-Z0-9_]+))'
        r'(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?'
        r'(?:\s+ON\s+(.+?))?'
        r'(?=\s+(?:LEFT|RIGHT|INNER|CROSS|FULL|JOIN|WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|\Z))',
        re.IGNORECASE | re.DOTALL,
    )
    for m in join_pattern.finditer(sql):
        join_type = (m.group(1) or '').strip().upper() + 'JOIN'
        join_type = join_type.replace('JOIN', ' JOIN').strip()
        if not join_type.startswith(('LEFT', 'RIGHT', 'INNER', 'CROSS', 'FULL')):
            join_type = 'INNER JOIN'
        db = m.group(2) or m.group(4) or ''
        tbl = m.group(3) or m.group(5) or m.group(6) or m.group(7) or ''
        right_table = f'{db}.{tbl}' if db else tbl
        condition = (m.group(9) or '').strip()
        relations.append({
            'rightTable': right_table,
            'joinType': join_type,
            'condition': condition,
        })
    return relations


def _extract_sql_clause(sql: str, keyword: str) -> str:
    """提取 SQL 中指定子句（GROUP BY / WHERE / HAVING）"""
    pattern = re.compile(
        rf'{keyword}\s+(.+?)(?=\s+(?:HAVING|ORDER\s+BY|LIMIT|UNION)|$)',
        re.IGNORECASE | re.DOTALL,
    )
    m = pattern.search(sql)
    return m.group(1).strip() if m else ''


def _build_lineage_from_structured_data(
    sql: str,
    target_table: str,
    field_mappings: list[dict],
    source_tables: list[str],
) -> dict:
    """从结构化的 fieldMappings + SQL 直接构建血缘结果，无需 LLM。"""
    # 解析 SQL 获取表引用及角色
    refs = extract_table_refs_from_sql(sql)
    ref_map = {}
    for ref in refs:
        full = f'{ref["database"]}.{ref["table"]}' if ref.get('database') else ref['table']
        if full == target_table:
            continue
        role = _classify_table_role_in_sql(sql, ref)
        ref_map[full] = {'role': role, 'ref': ref}

    # 提取 JOIN 关系
    join_rels_raw = _extract_join_relations(sql)

    # 构建别名映射（alias → full_name）
    alias_map = _extract_alias_map(sql, ref_map)

    # 构建 sourceTables
    built_sources = []
    for full_name, info in ref_map.items():
        join_type = '无（主表）'
        join_cond = ''
        for jr in join_rels_raw:
            if jr['rightTable'].lower() == full_name.lower() or full_name.lower().endswith('.' + jr['rightTable'].lower()):
                join_type = jr['joinType']
                join_cond = jr['condition']
                break
        built_sources.append({
            'name': full_name,
            'alias': '',
            'role': info['role'],
            'joinType': join_type if info['role'] == '维表' else '无（主表）',
            'joinCondition': join_cond if info['role'] == '维表' else '',
        })
    existing_names = {s['name'] for s in built_sources}
    for st in source_tables:
        if st not in existing_names and st != target_table:
            built_sources.append({
                'name': st, 'alias': '', 'role': '基表',
                'joinType': '无（主表）', 'joinCondition': '',
            })

    # 解析 SELECT 表达式列表，用于生成自然语言描述
    select_exprs = _extract_select_expressions(sql)

    # 构建 fieldMappings（带自然语言 transform）
    built_field_mappings = []
    for fm in field_mappings:
        target_field = fm.get('targetField', '')
        source_expr = fm.get('sourceExpr', '')
        raw_transform = fm.get('transform', '直接映射')

        # 找到该字段对应的完整 SQL 表达式
        full_expr = _find_expr_for_field(target_field, select_exprs)

        # 生成自然语言描述
        transform_desc = _describe_transform(
            target_field, source_expr, full_expr, raw_transform,
            fm.get('sourceTable', ''), built_sources, join_rels_raw, alias_map,
        )

        built_field_mappings.append({
            'targetField': target_field,
            'sourceTable': fm.get('sourceTable', ''),
            'sourceField': source_expr,
            'transform': transform_desc,
            'expression': full_expr or source_expr,
        })

    # 构建 joinRelations
    built_joins = []
    main_table = ''
    for s in built_sources:
        if s['role'] == '基表':
            main_table = s['name']
            break
    for jr in join_rels_raw:
        right = jr['rightTable']
        for s in built_sources:
            if s['name'].lower() == right.lower() or s['name'].lower().endswith('.' + right.lower()):
                right = s['name']
                break
        built_joins.append({
            'leftTable': main_table,
            'rightTable': right,
            'joinType': jr['joinType'],
            'condition': jr['condition'],
        })

    return {
        'targetTable': target_table,
        'sourceTables': built_sources,
        'fieldMappings': built_field_mappings,
        'joinRelations': built_joins,
        'groupBy': _extract_sql_clause(sql, 'GROUP BY'),
        'filters': _extract_sql_clause(sql, 'WHERE'),
    }


def _extract_alias_map(sql: str, ref_map: dict) -> dict:
    """从 SQL 中提取表别名映射：alias → full_table_name"""
    alias_map = {}
    # 匹配 FROM/JOIN table AS alias 或 FROM/JOIN table alias
    pattern = re.compile(
        r'(?:FROM|JOIN)\s+'
        r'(?:`[^`]+`\.`[^`]+`|[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+|`[^`]+`|[a-zA-Z0-9_]+)'
        r'(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))',
        re.IGNORECASE,
    )
    # 更精确地提取：先找表名再找别名
    table_alias_re = re.compile(
        r'(?:FROM|JOIN)\s+'
        r'(?:`([^`]+)`\.`([^`]+)`|([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)|`([^`]+)`|([a-zA-Z0-9_]+))'
        r'\s+(?:AS\s+)?([a-zA-Z0-9_]+)'
        r'(?=\s+(?:ON|LEFT|RIGHT|INNER|CROSS|FULL|JOIN|WHERE|GROUP|ORDER|LIMIT|SET|\(|$))',
        re.IGNORECASE,
    )
    for m in table_alias_re.finditer(sql):
        db = m.group(1) or m.group(3) or ''
        tbl = m.group(2) or m.group(4) or m.group(5) or m.group(6) or ''
        alias = m.group(7)
        if alias and alias.upper() not in ('ON', 'LEFT', 'RIGHT', 'INNER', 'CROSS', 'FULL', 'JOIN', 'WHERE', 'GROUP', 'ORDER', 'SET'):
            full_name = f'{db}.{tbl}' if db else tbl
            # 匹配到 ref_map 中的全名
            for ref_full in ref_map:
                if ref_full.lower() == full_name.lower() or ref_full.lower().endswith('.' + full_name.lower()):
                    alias_map[alias.lower()] = ref_full
                    break
            if alias.lower() not in alias_map:
                alias_map[alias.lower()] = full_name
    return alias_map


def _extract_select_expressions(sql: str) -> list[dict]:
    """从 INSERT INTO ... SELECT ... 中提取每个 SELECT 表达式及其别名。"""
    # 找到 SELECT ... FROM 之间的部分
    m = re.search(r'\bSELECT\s+([\s\S]+?)\s+FROM\b', sql, re.IGNORECASE)
    if not m:
        return []
    select_part = m.group(1).strip()

    # 按逗号拆分（处理嵌套括号）
    exprs = []
    depth = 0
    current = ''
    for ch in select_part:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            exprs.append(current.strip())
            current = ''
        else:
            current += ch
    if current.strip():
        exprs.append(current.strip())

    result = []
    for expr in exprs:
        # 提取 AS alias
        alias_match = re.search(r'\s+AS\s+`?([a-zA-Z0-9_]+)`?\s*$', expr, re.IGNORECASE)
        alias = alias_match.group(1) if alias_match else ''
        raw_expr = expr[:alias_match.start()].strip() if alias_match else expr
        result.append({'expr': raw_expr, 'alias': alias, 'full': expr})
    return result


def _find_expr_for_field(target_field: str, select_exprs: list[dict]) -> str:
    """根据目标字段名找到对应的 SELECT 表达式。"""
    tf_lower = target_field.lower()
    for se in select_exprs:
        if se['alias'].lower() == tf_lower:
            return se['full']
        # 没有 alias 时，表达式本身可能就是字段名
        expr_field = se['expr'].rsplit('.', 1)[-1].strip('`').lower()
        if expr_field == tf_lower and not se['alias']:
            return se['full']
    return ''


def _describe_transform(
    target_field: str,
    source_expr: str,
    full_expr: str,
    raw_transform: str,
    source_table: str,
    sources: list[dict],
    join_rels: list[dict],
    alias_map: dict,
) -> str:
    """根据 SQL 表达式生成自然语言的加工逻辑描述。"""
    expr = (full_expr or source_expr or '').strip()
    expr_upper = expr.upper()

    # 聚合函数
    agg_match = re.match(r'^(SUM|COUNT|AVG|MAX|MIN|GROUP_CONCAT)\s*\(', expr, re.IGNORECASE)
    if agg_match:
        func = agg_match.group(1).upper()
        inner = expr[len(func) + 1:].rstrip(')')
        func_names = {
            'SUM': '求和', 'COUNT': '计数', 'AVG': '求平均',
            'MAX': '取最大值', 'MIN': '取最小值', 'GROUP_CONCAT': '拼接',
        }
        return f'对 {inner.strip()} {func_names.get(func, func)}'

    # CASE WHEN
    if 'CASE' in expr_upper and 'WHEN' in expr_upper:
        return f'条件判断转换：{_simplify_expr(expr)}'

    # COALESCE / IFNULL
    if 'COALESCE' in expr_upper or 'IFNULL' in expr_upper:
        return f'空值兜底处理：{_simplify_expr(expr)}'

    # CONCAT
    if 'CONCAT' in expr_upper:
        return f'字符串拼接：{_simplify_expr(expr)}'

    # DATE / TIME 函数
    date_funcs = ['DATE_FORMAT', 'DATE', 'YEAR', 'MONTH', 'DAY', 'NOW', 'CURDATE', 'DATEDIFF', 'DATE_ADD', 'DATE_SUB', 'STR_TO_DATE']
    for df in date_funcs:
        if df in expr_upper:
            return f'日期处理：{_simplify_expr(expr)}'

    # CAST / CONVERT
    if 'CAST' in expr_upper or 'CONVERT' in expr_upper:
        return f'类型转换：{_simplify_expr(expr)}'

    # ROUND / CEIL / FLOOR / ABS
    math_funcs = ['ROUND', 'CEIL', 'CEILING', 'FLOOR', 'ABS', 'MOD']
    for mf in math_funcs:
        if mf in expr_upper:
            return f'数值计算：{_simplify_expr(expr)}'

    # 算术运算（含 / * + -）
    if re.search(r'[+\-*/]', re.sub(r"'[^']*'", '', expr)):
        return f'计算：{_simplify_expr(expr)}'

    # 来自维表的 LEFT JOIN 关联取值 → 描述关联条件
    if source_table:
        for src in sources:
            if src['name'] == source_table and src['role'] == '维表':
                join_cond = src.get('joinCondition', '')
                if join_cond:
                    return f'通过关联 {source_table} 查找（{_simplify_expr(join_cond)}）'
                return f'通过关联 {source_table} 查找获取'

    # 检查表达式中的别名是否指向维表
    alias_prefix = re.match(r'^([a-zA-Z0-9_]+)\.', expr)
    if alias_prefix:
        alias = alias_prefix.group(1).lower()
        full_table = alias_map.get(alias, '')
        if full_table:
            for src in sources:
                if src['name'] == full_table and src['role'] == '维表':
                    join_cond = src.get('joinCondition', '')
                    if join_cond:
                        return f'通过关联 {full_table} 查找（{_simplify_expr(join_cond)}）'
                    return f'通过关联 {full_table} 查找获取'

    # 默认：直接映射
    return '直接取值'


def _simplify_expr(expr: str) -> str:
    """简化 SQL 表达式用于展示，截断过长内容。"""
    s = re.sub(r'\s+', ' ', expr).strip()
    if len(s) > 80:
        return s[:77] + '...'
    return s


def _build_metric_lineage_from_data(
    metric_def: dict,
    relevant_processed: list[dict],
    unique_sources: list[dict],
    processed_table_names: set,
) -> dict:
    """从结构化数据直接构建指标全链路血缘，无需 LLM。"""
    metric_name = metric_def.get('name', '')
    metric_aggregation = metric_def.get('aggregation', '')
    metric_measure_field = metric_def.get('measureField', '')
    relevant_tables = metric_def.get('tables') or []

    # source 层
    source_tables = []
    for s in unique_sources:
        source_tables.append({
            'name': s['name'],
            'role': s['role'],
            'fields': [],  # 后面填充
        })

    # 收集与指标相关的字段
    measure_fields = set()
    if metric_measure_field:
        for f in re.split(r'[/\*\+\-\s,()]+', metric_measure_field):
            f = f.strip()
            if f and not f.isdigit():
                measure_fields.add(f)

    # processed 层
    processed_layer_tables = []
    for pt in relevant_processed:
        pt_full = f'{pt["database"]}.{pt["table"]}'
        if pt_full in processed_table_names:
            # 只列出与指标相关的原始字段（不是计算表达式）
            related_fields = []
            fm_list = pt.get('fieldMappings') or []
            for fm in fm_list:
                tf = fm.get('targetField', '')
                if tf in measure_fields or not measure_fields:
                    related_fields.append(tf)
            # 如果 fieldMappings 没匹配上，用拆分后的度量字段
            if not related_fields and measure_fields:
                related_fields = sorted(measure_fields)
            elif not related_fields and metric_measure_field:
                related_fields = [metric_measure_field]
            processed_layer_tables.append({
                'name': pt_full,
                'role': '业务表',
                'fields': related_fields,
            })

    # 填充 source 层字段（从 fieldMappings 中筛选与指标相关的）
    for st in source_tables:
        fields = set()
        for pt in relevant_processed:
            for fm in (pt.get('fieldMappings') or []):
                if fm.get('sourceTable', '') == st['name']:
                    target_f = fm.get('targetField', '')
                    if target_f in measure_fields or not measure_fields:
                        fields.add(fm.get('sourceExpr', '') or target_f)
        st['fields'] = list(fields) if fields else []

    # 如果无加工表，指标涉及的表直接作为 source
    if not processed_layer_tables and not source_tables:
        for t in relevant_tables:
            source_tables.append({'name': t, 'role': '基表', 'fields': [metric_measure_field] if metric_measure_field else []})

    # 构建 edges
    edges = []
    # source → processed
    for pt in relevant_processed:
        pt_full = f'{pt["database"]}.{pt["table"]}'
        for fm in (pt.get('fieldMappings') or []):
            target_f = fm.get('targetField', '')
            if target_f in measure_fields or not measure_fields:
                edges.append({
                    'from': {'table': fm.get('sourceTable', ''), 'field': fm.get('sourceExpr', '')},
                    'to': {'table': pt_full, 'field': target_f},
                    'transform': fm.get('transform', '直接映射'),
                })
    # processed → metric
    for pt_tbl in processed_layer_tables:
        # 如果度量字段是表达式（如 zxsgscbhj - zzzcbhj），用一条 edge 表示计算逻辑
        if len(measure_fields) > 1 and metric_measure_field:
            edges.append({
                'from': {'table': pt_tbl['name'], 'field': ', '.join(sorted(measure_fields))},
                'to': {'table': metric_name, 'field': f'{metric_aggregation}({metric_measure_field})'},
                'transform': f'{metric_aggregation} 聚合',
            })
        else:
            for f in measure_fields or [metric_measure_field]:
                edges.append({
                    'from': {'table': pt_tbl['name'], 'field': f},
                    'to': {'table': metric_name, 'field': f'{metric_aggregation}({metric_measure_field})'},
                    'transform': f'{metric_aggregation} 聚合',
                })
    # 无 processed 时 source → metric
    if not processed_layer_tables:
        for st in source_tables:
            for f in measure_fields or [metric_measure_field]:
                edges.append({
                    'from': {'table': st['name'], 'field': f},
                    'to': {'table': metric_name, 'field': f'{metric_aggregation}({metric_measure_field})'},
                    'transform': f'{metric_aggregation} 聚合',
                })

    layers = [
        {'level': 'source', 'label': '基表/维表', 'tables': source_tables},
        {'level': 'processed', 'label': '加工业务表', 'tables': processed_layer_tables},
        {'level': 'metric', 'label': '指标', 'tables': [
            {'name': metric_name, 'role': '指标', 'fields': [f'{metric_aggregation}({metric_measure_field})']}
        ]},
    ]

    # summary
    src_names = ', '.join(s['name'] for s in source_tables)
    proc_names = ', '.join(p['name'] for p in processed_layer_tables)
    if proc_names:
        summary = f'指标「{metric_name}」源自 {src_names}，经 ETL 加工为 {proc_names}，对 {metric_measure_field} 进行 {metric_aggregation} 聚合。'
    else:
        summary = f'指标「{metric_name}」直接基于 {src_names} 的 {metric_measure_field} 进行 {metric_aggregation} 聚合。'

    return {'layers': layers, 'edges': edges, 'summary': summary}


# ────────── POST /api/lineage/summary — 从对话历史总结加工逻辑 ──────────

_summary_cache: dict[str, dict] = {}


@router.post("/api/lineage/summary")
async def lineage_summary(request_body: dict):
    """根据对话历史和加工 SQL，总结出可复用的加工逻辑描述。"""
    chat_history = request_body.get('chatHistory', [])
    insert_sql = request_body.get('insertSql', '')
    target_table = request_body.get('targetTable', '')
    source_tables = request_body.get('sourceTables', [])

    if not chat_history and not insert_sql:
        return JSONResponse(status_code=400, content={"error": "缺少对话历史或加工 SQL"})

    if not LLM_API_KEY:
        return JSONResponse(status_code=503, content={"error": "LLM API 未配置"})

    # 缓存
    cache_key = _make_cache_key({
        'type': 'lineage-summary',
        'sql': insert_sql,
        'target': target_table,
    })
    if cache_key in _summary_cache:
        return _summary_cache[cache_key]

    # 精简对话历史（只保留最近 30 轮，避免 token 过长）
    trimmed_history = chat_history[-30:] if len(chat_history) > 30 else chat_history
    conversation_text = '\n'.join(
        f'{"用户" if m.get("role") == "user" else "助手"}: {m.get("content", "")[:500]}'
        for m in trimmed_history
    )

    system_prompt = f'''你是一个数据加工流程分析专家。请根据以下用户与 ETL 助手的对话记录和最终生成的加工 SQL，总结出一套完整的、可复用的数据加工逻辑。

**目标表**: {target_table}
**来源表**: {', '.join(source_tables) if source_tables else '见 SQL'}

**最终加工 SQL**:
```sql
{insert_sql}
```

**对话记录**:
{conversation_text}

请输出 JSON（不要 markdown 代码块），格式如下：
{{
  "title": "一句话概括这个加工任务（如：合并收入成本数据并关联公司和利润中心维表）",
  "purpose": "加工目的：为什么要做这个加工，解决什么业务问题",
  "steps": [
    "步骤1：具体描述（如：从事实表 xxx 中取出基础字段 bic_zsys_id, ctgry, gjahr 等）",
    "步骤2：具体描述（如：LEFT JOIN 公司代码维表 xxx，通过 sysid 和 bukrs 关联，获取公司名称）",
    "步骤3：..."
  ],
  "keyLogic": [
    "关键逻辑1：描述重要的加工规则（如：公司代码匹配时需同时满足 sysid 和 bukrs 两个条件）",
    "关键逻辑2：..."
  ],
  "reuseTips": "复用建议：说明这套逻辑可以如何复用到类似场景（如：同类维表关联可复用 JOIN 条件模板）"
}}

**要求**：
- 用中文，语言简洁专业
- steps 要按实际加工顺序描述，每步说清楚做了什么、用了哪张表、关联条件是什么
- keyLogic 提炼出容易出错或需要特别注意的逻辑点
- 基于对话中用户的真实意图和助手的实际操作来总结，不要编造'''

    try:
        result = await call_llm(
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': '请总结这次数据加工的完整逻辑。'},
            ],
            temperature=0.2,
            max_tokens=2048,
        )
        if not result.get('ok'):
            return JSONResponse(
                status_code=result.get('status', 500),
                content={"error": result.get('error', '总结失败')},
            )

        content = (result.get('content') or '').strip()
        json_match = re.search(r'\{[\s\S]*\}', content)
        if not json_match:
            return {"title": "加工逻辑摘要", "steps": [content], "keyLogic": [], "reuseTips": ""}

        parsed = json.loads(json_match.group(0))
        _summary_cache[cache_key] = parsed
        return parsed
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ────────── POST /api/lineage — 解析 SQL 返回数据血缘 ──────────

@router.post("/api/lineage")
async def lineage(request_body: dict):
    sql = request_body.get('sql')
    connection_string = request_body.get('connectionString')
    target_table = request_body.get('targetTable')
    # 结构化数据（来自 ETL 过程的记录）
    field_mappings = request_body.get('fieldMappings')
    source_tables = request_body.get('sourceTables')

    if not sql:
        return JSONResponse(status_code=400, content={"error": "Missing sql"})

    # ── 补全 fieldMappings：对比数据库实际表结构，找出缺失的字段映射 ──
    if connection_string and target_table and isinstance(field_mappings, list):
        parts = target_table.split('.')
        if len(parts) == 2:
            desc_result = await run_database_operation(
                connection_string, 'describeTable',
                {'database': parts[0], 'table': parts[1]},
            )
            if desc_result.get('ok'):
                actual_columns = [
                    c['Field'] for c in (desc_result.get('data', {}).get('columns') or [])
                ]
                existing_target_fields = {fm.get('targetField', '') for fm in field_mappings}
                missing_fields = [col for col in actual_columns if col not in existing_target_fields]
                if missing_fields:
                    logger.info("[Lineage] %s missing fields: %s", target_table, missing_fields)
                    # 从 source tables 的表结构中匹配
                    source_columns_map = {}
                    for src in (source_tables or []):
                        src_parts = src.split('.')
                        if len(src_parts) != 2:
                            continue
                        src_desc = await run_database_operation(
                            connection_string, 'describeTable',
                            {'database': src_parts[0], 'table': src_parts[1]},
                        )
                        if src_desc.get('ok'):
                            for c in (src_desc.get('data', {}).get('columns') or []):
                                if c['Field'] not in source_columns_map:
                                    source_columns_map[c['Field']] = src
                    for field in missing_fields:
                        field_mappings.append({
                            'targetField': field,
                            'sourceTable': source_columns_map.get(field, ''),
                            'sourceExpr': field,
                            'transform': '直接映射',
                        })

    # ★ 有结构化数据时优先直接构建，结果不完整则回退 LLM
    if isinstance(field_mappings, list) and len(field_mappings) > 0:
        result = _build_lineage_from_structured_data(
            sql, target_table or '', field_mappings, source_tables or [],
        )
        # 验证：至少有源表和字段映射才算有效
        if result.get('sourceTables') and result.get('fieldMappings'):
            return result
        # 否则继续走 LLM 回退

    if not LLM_API_KEY:
        return JSONResponse(status_code=503, content={"error": "DEEPSEEK_API_KEY not configured"})

    # 获取涉及表的结构
    schema_info = ''
    if connection_string:
        table_refs = extract_table_refs_from_sql(sql)
        for ref in table_refs:
            result = await run_database_operation(
                connection_string, 'describeTable',
                {'database': ref['database'], 'table': ref['table']},
            )
            if result['ok']:
                cols = result['data'].get('columns') or []
                full_name = f'{ref["database"]}.{ref["table"]}' if ref['database'] else ref['table']
                col_list = '\n'.join(
                    f'  {c["Field"]} {c["Type"]}{" -- " + c["Comment"] if c.get("Comment") else ""}'
                    for c in cols
                )
                schema_info += f'\n表 {full_name}:\n{col_list}\n'

    system_prompt = f'''你是一个 SQL 血缘分析专家。分析以下 INSERT INTO ... SELECT SQL，提取完整的数据血缘关系。

**SQL**:
```sql
{sql}
```

**涉及表的结构**:
{schema_info or '（未提供）'}

**目标表**: {target_table or '从 SQL 中提取'}

请分析并返回 JSON（不要 markdown 代码块），格式如下：
{{
  "targetTable": "库名.表名",
  "sourceTables": [
    {{
      "name": "库名.表名",
      "alias": "SQL中的别名（如有）",
      "role": "基表|维表|关联表",
      "joinType": "LEFT JOIN|INNER JOIN|无（主表）",
      "joinCondition": "ON 条件（如有）"
    }}
  ],
  "fieldMappings": [
    {{
      "targetField": "目标字段名",
      "sourceTable": "来源表全名（库名.表名）",
      "sourceField": "来源字段名",
      "transform": "用自然语言描述真实的加工逻辑。例如：直接取值、对销售额求和、通过关联公司代码表查找公司名称（ON 主表.bukrs = 公司表.bukrs）、空值时默认为0、按日期格式化为年月、条件判断：金额>0为收入否则为支出。要具体，不要只写 LEFT JOIN关联取值 这种笼统描述",
      "expression": "原始SQL表达式片段"
    }}
  ],
  "joinRelations": [
    {{
      "leftTable": "库名.表名",
      "rightTable": "库名.表名",
      "joinType": "LEFT JOIN|INNER JOIN",
      "condition": "ON 条件"
    }}
  ],
  "groupBy": "GROUP BY 字段列表（如有）",
  "filters": "WHERE 条件（如有）"
}}

**要求**：
- 每个目标字段都必须追溯到具体的来源表和来源字段
- 如果一个目标字段涉及多个来源表/字段（如 JOIN 后取值），列出主要来源
- transform 必须用自然语言描述真实的业务加工逻辑，要具体说明做了什么操作、为什么这样做。例如：「通过公司代码关联公司主数据表查找公司名称」「对各期间的销售额求和汇总」「当字段为空时取默认值0」。不要只写「直接映射」「LEFT JOIN关联取值」这种笼统描述
- 维表（通过 JOIN 关联的查找表）的 role 标记为"维表"
- 主要数据来源表的 role 标记为"基表"
- sourceTables 必须包含 SQL 中 FROM 和所有 JOIN 涉及的表'''

    # 检查缓存
    cache_key = _make_cache_key({'type': 'lineage', 'sql': sql, 'targetTable': target_table})
    if cache_key in _lineage_cache:
        return _lineage_cache[cache_key]

    try:
        llm_result = await call_llm(
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': '请分析这条 SQL 的数据血缘关系。'},
            ],
            temperature=0.1,
            max_tokens=4096,
        )
        if not llm_result['ok']:
            return JSONResponse(status_code=llm_result.get('status', 500), content={"error": llm_result['error'] or "血缘分析失败"})

        content = (llm_result.get('content') or '').strip()
        json_match = re.search(r'\{[\s\S]*\}', content)
        if not json_match:
            return JSONResponse(status_code=500, content={"error": "模型未返回有效 JSON"})
        parsed = json.loads(json_match.group(0))
        _lineage_cache[cache_key] = parsed
        return parsed
    except Exception as e:
        print(f'[/api/lineage] {e}')
        return JSONResponse(status_code=500, content={"error": str(e) or "血缘分析失败"})


# ────────── POST /api/metric-lineage — 指标全链路血缘 ──────────

@router.post("/api/metric-lineage")
async def metric_lineage(request_body: dict):
    if not LLM_API_KEY:
        return JSONResponse(status_code=503, content={"error": "DEEPSEEK_API_KEY not configured"})

    metric_def = request_body.get('metricDef')
    processed_tables = request_body.get('processedTables', [])
    connection_string = request_body.get('connectionString')

    if not metric_def:
        return JSONResponse(status_code=400, content={"error": "Missing metricDef"})

    logger.info("[MetricLineage] metric=%s, measure=%s, tables=%s",
                metric_def.get('name'), metric_def.get('measureField'), metric_def.get('tables'))
    for pt in (processed_tables or []):
        fm_count = len(pt.get('fieldMappings') or [])
        fm_fields = [fm.get('targetField') for fm in (pt.get('fieldMappings') or [])]
        logger.info("[MetricLineage] processedTable=%s.%s fieldMappings(%d)=%s sourceTables=%s insertSql_len=%d",
                    pt.get('database'), pt.get('table'), fm_count, fm_fields,
                    pt.get('sourceTables'), len(pt.get('insertSql') or ''))

    # ── 补全 fieldMappings：对比数据库实际表结构，找出缺失的字段映射 ──
    if connection_string and processed_tables:
        for pt in processed_tables:
            pt_db = pt.get('database', '')
            pt_tbl = pt.get('table', '')
            existing_fm = pt.get('fieldMappings') or []
            existing_target_fields = {fm.get('targetField', '') for fm in existing_fm}

            # 查询业务表的实际列
            desc_result = await run_database_operation(
                connection_string, 'describeTable',
                {'database': pt_db, 'table': pt_tbl},
            )
            if not desc_result.get('ok'):
                continue
            actual_columns = [
                c['Field'] for c in (desc_result.get('data', {}).get('columns') or [])
            ]

            # 找出 fieldMappings 中缺失的列
            missing_fields = [
                col for col in actual_columns
                if col not in existing_target_fields
            ]
            if not missing_fields:
                continue

            logger.info("[MetricLineage] %s.%s missing fields in fieldMappings: %s",
                        pt_db, pt_tbl, missing_fields)

            # 尝试从 source tables 的表结构中匹配缺失字段的来源
            source_columns_map = {}  # field_name -> source_table
            for src in (pt.get('sourceTables') or []):
                parts = src.split('.')
                if len(parts) != 2:
                    continue
                src_desc = await run_database_operation(
                    connection_string, 'describeTable',
                    {'database': parts[0], 'table': parts[1]},
                )
                if src_desc.get('ok'):
                    for c in (src_desc.get('data', {}).get('columns') or []):
                        fname = c['Field']
                        if fname not in source_columns_map:
                            source_columns_map[fname] = src

            # 为缺失字段生成映射
            new_mappings = []
            for field in missing_fields:
                source_table = source_columns_map.get(field, '')
                new_mappings.append({
                    'targetField': field,
                    'sourceTable': source_table,
                    'sourceExpr': field,
                    'transform': '直接映射',
                })
            if new_mappings:
                pt['fieldMappings'] = existing_fm + new_mappings
                logger.info("[MetricLineage]补全 %s.%s fieldMappings: +%d fields",
                            pt_db, pt_tbl, len(new_mappings))

    # 收集所有相关的加工 SQL
    relevant_tables = metric_def.get('tables') or []
    all_processed = processed_tables or []

    # 直接匹配指标涉及的表
    direct_match = [
        pt for pt in all_processed
        if any(t == f'{pt["database"]}.{pt["table"]}' for t in relevant_tables)
    ]
    # 如果直接匹配为空，使用所有传入的加工表（前端已按 dashboard 过滤）
    relevant_processed = direct_match if len(direct_match) > 0 else all_processed

    # 从 insertSql 中解析出真正的源表（基表/维表），区分 FROM（基表）和 JOIN（维表）
    parsed_source_tables: list[dict] = []  # {name, role: 基表|维表, from_processed: 业务表名}
    processed_table_names = set()
    for pt in relevant_processed:
        pt_full = f'{pt["database"]}.{pt["table"]}'
        processed_table_names.add(pt_full)
        insert_sql = pt.get('insertSql') or ''
        if insert_sql:
            refs = extract_table_refs_from_sql(insert_sql)
            for ref in refs:
                ref_full = f'{ref["database"]}.{ref["table"]}' if ref.get('database') else ref['table']
                # 排除目标表本身（INSERT INTO 的目标）
                if ref_full == pt_full:
                    continue
                # 判断是 FROM（基表）还是 JOIN（维表）
                role = _classify_table_role_in_sql(insert_sql, ref)
                parsed_source_tables.append({
                    'name': ref_full,
                    'role': role,
                    'from_processed': pt_full,
                })

    # 去重
    seen_sources = set()
    unique_sources = []
    for s in parsed_source_tables:
        if s['name'] not in seen_sources:
            seen_sources.add(s['name'])
            unique_sources.append(s)

    # 获取表结构（包括解析出的真正源表）
    schema_info = ''
    if connection_string:
        all_tbls = set(relevant_tables)
        for s in unique_sources:
            all_tbls.add(s['name'])
        for pt in relevant_processed:
            for s in (pt.get('sourceTables') or []):
                all_tbls.add(s)
        for tbl in all_tbls:
            parts = tbl.split('.')
            if len(parts) == 2:
                result = await run_database_operation(
                    connection_string, 'describeTable',
                    {'database': parts[0], 'table': parts[1]},
                )
                if result['ok']:
                    cols_list = result['data'].get('columns') or []
                    col_str = '\n'.join(
                        f'  {c["Field"]} {c["Type"]}{" -- " + c["Comment"] if c.get("Comment") else ""}'
                        for c in cols_list
                    )
                    schema_info += f'\n表 {tbl}:\n{col_str}\n'

    # 收集加工 SQL 和字段映射信息
    etl_info_parts = []
    for pt in relevant_processed:
        mapping_info = ''
        if isinstance(pt.get('fieldMappings'), list) and len(pt['fieldMappings']) > 0:
            mapping_lines = '\n'.join(
                f'    {fm["targetField"]} ← {fm["sourceTable"]}.{fm["sourceExpr"]} ({fm["transform"]})'
                for fm in pt['fieldMappings']
            )
            mapping_info = f'  字段映射:\n{mapping_lines}'
        source_tables_str = ', '.join(pt.get('sourceTables') or [])
        entry = f'加工表 {pt["database"]}.{pt["table"]}:\n  来源表: {source_tables_str}'
        if mapping_info:
            entry += '\n' + mapping_info
        entry += f'\n  加工SQL: {pt.get("insertSql") or "无"}'
        etl_info_parts.append(entry)
    etl_info = '\n\n'.join(etl_info_parts)

    # 构建从 SQL 解析出的源表清单，明确告知 LLM
    if unique_sources:
        parsed_source_info = '\n'.join(
            f'  - {s["name"]}（角色：{s["role"]}，用于加工 {s["from_processed"]}）'
            for s in unique_sources
        )
    else:
        parsed_source_info = '  （未从加工SQL中解析到源表）'

    metric_name = metric_def.get('name', '')
    metric_definition = metric_def.get('definition', '')
    metric_aggregation = metric_def.get('aggregation', '')
    metric_measure_field = metric_def.get('measureField', '')

    # ★ 有结构化数据 或 无加工表时，优先直接构建，结果不完整则回退 LLM
    has_structured = any(
        isinstance(pt.get('fieldMappings'), list) and len(pt['fieldMappings']) > 0
        for pt in relevant_processed
    )
    no_processed = len(relevant_processed) == 0
    if has_structured or unique_sources or no_processed:
        result = _build_metric_lineage_from_data(
            metric_def, relevant_processed, unique_sources, processed_table_names,
        )
        # 验证：至少 source 或 processed 层有表才算有效
        source_ok = any(t.get('tables') for t in result.get('layers', []) if t.get('level') == 'source')
        processed_ok = any(t.get('tables') for t in result.get('layers', []) if t.get('level') == 'processed')
        if source_ok or processed_ok or no_processed:
            return result
        # 否则继续走 LLM 回退

    # 构建业务表名列表（用于在 prompt 中明确哪些是业务表）
    processed_names_list = ', '.join(processed_table_names) if processed_table_names else '（无）'

    system_prompt = f'''你是一个数据血缘分析专家。请分析指标的全链路血缘，从最底层的基表/维表到加工后的业务表，再到指标本身。

**指标信息**：
- 名称：{metric_name}
- 定义：{metric_definition}
- 聚合方式：{metric_aggregation}
- 度量字段：{metric_measure_field}
- 涉及表：{', '.join(relevant_tables)}

**ETL 加工信息（这是真实的加工记录）**：
{etl_info or '（无加工信息）'}

**从加工SQL中解析出的原始源表（已自动解析，请直接使用）**：
{parsed_source_info}

**已确认的加工业务表**：{processed_names_list}

**核心规则（必须严格遵守）**：
1. source 层（基表/维表）**必须**使用上方「从加工SQL中解析出的原始源表」中列出的表，这些是加工业务表的真正数据来源。
2. source 层的表**绝对不能**与 processed 层的业务表相同。如果一个表既出现在源表中又出现在业务表中，它只能放在 processed 层。
3. processed 层应放置指标直接涉及的加工业务表（即 {processed_names_list}）。
4. 如果没有从加工SQL中解析到源表，则指标涉及的表本身就是基表，直接放在 source 层，processed 层留空。
5. 只列出与该指标相关的字段，不要列出无关字段。

**表结构**：
{schema_info or '（未提供）'}

返回 JSON（不要 markdown 代码块）：
{{
  "layers": [
    {{
      "level": "source",
      "label": "基表/维表",
      "tables": [
        {{
          "name": "db.table",
          "role": "基表|维表",
          "fields": ["只列出与指标相关的字段"]
        }}
      ]
    }},
    {{
      "level": "processed",
      "label": "加工业务表",
      "tables": [
        {{
          "name": "db.table",
          "role": "业务表",
          "fields": ["只列出与指标相关的字段"]
        }}
      ]
    }},
    {{
      "level": "metric",
      "label": "指标",
      "tables": [
        {{
          "name": "{metric_name}",
          "role": "指标",
          "fields": ["{metric_aggregation}({metric_measure_field})"]
        }}
      ]
    }}
  ],
  "edges": [
    {{
      "from": {{"table": "源表名", "field": "源字段"}},
      "to": {{"table": "目标表名", "field": "目标字段"}},
      "transform": "加工逻辑（如直接映射、SUM、JOIN等）"
    }}
  ],
  "summary": "一句话总结该指标的数据流转路径"
}}'''

    # 检查缓存
    cache_key = _make_cache_key({
        'type': 'metric-lineage',
        'metric': metric_name,
        'tables': relevant_tables,
        'processed': [f'{pt["database"]}.{pt["table"]}' for pt in relevant_processed],
    })
    if cache_key in _metric_lineage_cache:
        return _metric_lineage_cache[cache_key]

    try:
        llm_result = await call_llm(
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': f'请分析指标「{metric_name}」的全链路血缘'},
            ],
            temperature=0.1,
            max_tokens=4096,
        )
        if not llm_result['ok']:
            return JSONResponse(status_code=llm_result.get('status', 500), content={"error": llm_result['error'] or "指标血缘分析失败"})

        content = (llm_result.get('content') or '').strip()
        json_match = re.search(r'\{[\s\S]*\}', content)
        if not json_match:
            return JSONResponse(status_code=500, content={"error": "模型未返回有效 JSON"})
        parsed = json.loads(json_match.group(0))
        _metric_lineage_cache[cache_key] = parsed
        return parsed
    except Exception as e:
        print(f'[/api/metric-lineage] {e}')
        return JSONResponse(status_code=500, content={"error": str(e) or "指标血缘分析失败"})
