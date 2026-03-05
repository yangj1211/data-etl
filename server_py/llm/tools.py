"""execute_sql tool 定义 + 执行器。"""

import json
import re
import logging
import asyncio
from typing import Optional, List
import aiomysql

from db.connection import get_connection_config
from utils.formatters import rows_to_markdown_table

logger = logging.getLogger("etl.tools")

# ---------------------------------------------------------------------------
# Tool 定义
# ---------------------------------------------------------------------------

EXECUTE_SQL_TOOL = {
    "type": "function",
    "function": {
        "name": "execute_sql",
        "description": (
            "在用户的 MySQL 数据库上执行 SQL 语句。"
            "支持：SELECT、SHOW、DESCRIBE、CREATE DATABASE、CREATE TABLE、ALTER TABLE、INSERT INTO...SELECT、UPDATE 等。"
            "禁止：DROP、TRUNCATE、DELETE。"
            "每次调用执行一条 SQL。你可以在同一轮回复中同时调用多次该工具来并行执行多条独立的 SQL（例如同时 DESCRIBE 多张表、同时查询多张表的数据），这样效率更高。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "要执行的完整 SQL 语句",
                }
            },
            "required": ["sql"],
        },
    },
}

CREATE_METRIC_DEF_TOOL = {
    "type": "function",
    "function": {
        "name": "create_metric_def",
        "description": (
            "创建一个指标定义。当用户确认要创建指标时，必须调用此工具来真正创建指标。"
            "只有调用此工具才能真正创建指标，仅在回复中说'指标已创建'是无效的。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "指标名称，如'收入'、'订单量'、'净毛利率'",
                },
                "definition": {
                    "type": "string",
                    "description": "指标计算逻辑描述，如'SUM(amount)'、'zjml / zxssr'",
                },
                "tables": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "涉及的表，格式为 database.table",
                },
                "aggregation": {
                    "type": "string",
                    "enum": ["SUM", "COUNT", "AVG", "COUNT_DISTINCT", "MAX", "MIN"],
                    "description": "聚合方式",
                },
                "measureField": {
                    "type": "string",
                    "description": "被聚合的度量字段名",
                },
            },
            "required": ["name", "definition", "tables", "aggregation", "measureField"],
        },
    },
}

SQL_TOOLS = [EXECUTE_SQL_TOOL]
METRIC_CHAT_TOOLS = [EXECUTE_SQL_TOOL, CREATE_METRIC_DEF_TOOL]

# 禁止的 SQL 模式（允许 UPDATE，ETL 流程需要用 ALTER TABLE + UPDATE）
_FORBIDDEN = re.compile(r"\b(DROP|TRUNCATE|DELETE)\b", re.IGNORECASE)


# ---------------------------------------------------------------------------
# create_metric_def 执行器
# ---------------------------------------------------------------------------

async def execute_create_metric_def(tool_call, created_metric_defs: list) -> str:
    """执行 create_metric_def 工具调用，将指标定义记录到 created_metric_defs 列表中。
    实际写入数据库由上层（router）根据 dashboard_id 完成。"""
    try:
        args = json.loads(tool_call.function.arguments)
    except (json.JSONDecodeError, AttributeError):
        return "参数解析失败"

    name = args.get("name", "").strip()
    if not name:
        return "指标名称不能为空"

    metric_def = {
        "name": name,
        "definition": args.get("definition", ""),
        "tables": args.get("tables", []),
        "aggregation": args.get("aggregation", "SUM"),
        "measureField": args.get("measureField", ""),
    }
    created_metric_defs.append(metric_def)
    logger.info("[Tool] create_metric_def: %s", name)
    return f"指标「{name}」已成功创建。定义：{metric_def['definition']}，聚合方式：{metric_def['aggregation']}，度量字段：{metric_def['measureField']}，涉及表：{', '.join(metric_def['tables'])}"


# ---------------------------------------------------------------------------
# execute_sql 执行器
# ---------------------------------------------------------------------------

async def execute_tool_call(
    tool_call,
    connection_string: str,
    render_blocks: dict,
    block_counter: list,  # [int] 可变计数器
    write_ops: Optional[list] = None,  # 记录成功的写操作信息
) -> str:
    """
    执行单个 tool_call，返回给 LLM 的文本摘要。
    完整数据存入 render_blocks。
    """
    try:
        args = json.loads(tool_call.function.arguments)
    except (json.JSONDecodeError, AttributeError):
        return "参数解析失败"

    sql = str(args.get("sql", "")).strip()
    if not sql:
        return "SQL 为空"

    # 安全检查
    if _FORBIDDEN.search(sql):
        return f"安全限制：禁止执行 DROP/TRUNCATE/DELETE 语句"

    # 解析连接
    parsed = get_connection_config(connection_string)
    if not parsed:
        return "连接串格式无法解析"

    conn = None
    try:
        conn = await asyncio.wait_for(
            aiomysql.connect(
                host=parsed["host"],
                port=parsed["port"],
                user=parsed["user"],
                password=parsed["password"],
                db=parsed.get("database") or None,
                connect_timeout=10,
            ),
            timeout=10,
        )
        cur = await conn.cursor(aiomysql.DictCursor)
        await cur.execute(sql)

        # 每次工具调用分配一个序号，同一次调用内 SQL_N 和 TABLE_N 共享 N
        n = block_counter[0]
        block_counter[0] = n + 1
        sql_bid = f"SQL_{n}"
        table_bid = f"TABLE_{n}"
        render_blocks[sql_bid] = f"```sql\n{sql}\n```"

        is_write = bool(re.match(r"^\s*(INSERT|REPLACE|CREATE|ALTER|UPDATE)", sql, re.IGNORECASE))

        if is_write:
            await conn.commit()
            affected = cur.rowcount

            if write_ops is not None:
                from utils.sql_parser import extract_table_refs_from_sql

                # 记录成功的 INSERT INTO ... SELECT 操作
                if re.match(r"^\s*INSERT\s+INTO\b", sql, re.IGNORECASE):
                    target_match = (
                        re.match(r"\s*INSERT\s+INTO\s+`([^`]+)`\s*\.\s*`([^`]+)`", sql, re.IGNORECASE)
                        or re.match(r"\s*INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\.\s*([a-zA-Z0-9_]+)", sql, re.IGNORECASE)
                    )
                    if target_match:
                        target_db = target_match.group(1)
                        target_tbl = target_match.group(2)
                        source_refs = extract_table_refs_from_sql(sql)
                        source_tables = [
                            (r["database"] + "." + r["table"]) if r.get("database") else r["table"]
                            for r in source_refs
                            if not (r.get("database") == target_db and r["table"] == target_tbl)
                        ]
                        field_mappings = _parse_field_mappings_from_sql(
                            sql, target_db, target_tbl, source_refs,
                        )
                        write_ops.append({
                            "type": "insert",
                            "database": target_db,
                            "table": target_tbl,
                            "insertSql": sql,
                            "sourceTables": source_tables,
                            "fieldMappings": field_mappings,
                            "affectedRows": affected,
                        })

                # 记录 ALTER TABLE ADD COLUMN 操作
                elif re.match(r"^\s*ALTER\s+TABLE\b", sql, re.IGNORECASE):
                    alter_target = (
                        re.match(r"\s*ALTER\s+TABLE\s+`([^`]+)`\s*\.\s*`([^`]+)`", sql, re.IGNORECASE)
                        or re.match(r"\s*ALTER\s+TABLE\s+([a-zA-Z0-9_]+)\s*\.\s*([a-zA-Z0-9_]+)", sql, re.IGNORECASE)
                    )
                    if alter_target:
                        target_db = alter_target.group(1)
                        target_tbl = alter_target.group(2)
                        # 提取新增的列名
                        new_columns = _parse_alter_add_columns(sql)
                        if new_columns:
                            write_ops.append({
                                "type": "alter",
                                "database": target_db,
                                "table": target_tbl,
                                "sql": sql,
                                "newColumns": new_columns,
                                "affectedRows": affected,
                            })

                # 记录 UPDATE ... JOIN/SET 操作（用于字段映射追踪）
                elif re.match(r"^\s*UPDATE\b", sql, re.IGNORECASE):
                    update_info = _parse_update_field_mappings(sql)
                    if update_info:
                        write_ops.append({
                            "type": "update",
                            "database": update_info["database"],
                            "table": update_info["table"],
                            "sql": sql,
                            "sourceTables": update_info["sourceTables"],
                            "fieldMappings": update_info["fieldMappings"],
                            "affectedRows": affected,
                        })

            return (
                f"执行成功，影响行数: {affected}。\n"
                f"可用数据块：\n"
                f"- {sql_bid}: 执行的SQL"
            )
        else:
            rows = await cur.fetchall()
            row_count = len(rows) if rows else 0

            if row_count > 0:
                render_blocks[table_bid] = rows_to_markdown_table(rows[:100])
                return (
                    f"查询成功，返回 {row_count} 行。\n"
                    f"可用数据块：\n"
                    f"- {sql_bid}: 执行的SQL\n"
                    f"- {table_bid}: 查询结果（{row_count}行）"
                )
            else:
                return (
                    f"查询成功，返回 0 行。\n"
                    f"可用数据块：\n"
                    f"- {sql_bid}: 执行的SQL"
                )

    except Exception as e:
        logger.error("[Tool] execute_sql error: %s", e)
        return f"执行失败，错误信息：\n{e}"
    finally:
        if conn:
            conn.close()


def _parse_field_mappings_from_sql(
    sql: str, target_db: str, target_tbl: str, source_refs: list,
) -> list:
    """从 INSERT INTO ... SELECT SQL 中解析字段映射关系。"""
    # 提取目标字段列表 INSERT INTO db.table (f1, f2, ...)
    fields_match = re.search(
        r'INSERT\s+INTO\s+[^\(]+\(([^)]+)\)', sql, re.IGNORECASE,
    )
    if not fields_match:
        return []
    target_fields = [
        f.strip().strip('`') for f in fields_match.group(1).split(',')
    ]

    # 提取 SELECT 表达式
    select_match = re.search(r'\bSELECT\s+([\s\S]+?)\s+FROM\b', sql, re.IGNORECASE)
    if not select_match:
        return []

    # 按逗号拆分（处理嵌套括号）
    select_part = select_match.group(1).strip()
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

    # 构建别名→全表名映射
    alias_map = {}
    alias_re = re.compile(
        r'(?:FROM|JOIN)\s+'
        r'(?:`([^`]+)`\.`([^`]+)`|([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+))'
        r'\s+(?:AS\s+)?([a-zA-Z0-9_]+)',
        re.IGNORECASE,
    )
    for m in alias_re.finditer(sql):
        db = m.group(1) or m.group(3) or ''
        tbl = m.group(2) or m.group(4) or ''
        alias = m.group(5)
        if alias and alias.upper() not in (
            'ON', 'LEFT', 'RIGHT', 'INNER', 'JOIN', 'WHERE', 'GROUP', 'ORDER', 'SET',
        ):
            alias_map[alias.lower()] = f'{db}.{tbl}' if db else tbl

    # 构建来源表全名列表（排除目标表）
    source_full_names = []
    for r in source_refs:
        full = (r['database'] + '.' + r['table']) if r.get('database') else r['table']
        if not (r.get('database') == target_db and r['table'] == target_tbl):
            source_full_names.append(full)

    mappings = []
    for i, expr in enumerate(exprs):
        if i >= len(target_fields):
            break
        target_field = target_fields[i]
        expr_stripped = expr.strip()

        # 去掉 AS alias
        as_match = re.search(r'\s+AS\s+`?[a-zA-Z0-9_]+`?\s*$', expr_stripped, re.IGNORECASE)
        raw_expr = expr_stripped[:as_match.start()].strip() if as_match else expr_stripped

        # 判断加工类型
        transform = '直接映射'
        agg_match = re.match(r'^(SUM|COUNT|AVG|MAX|MIN)\s*\(', raw_expr, re.IGNORECASE)
        if agg_match:
            transform = agg_match.group(1).upper()
        elif 'CASE' in raw_expr.upper():
            transform = 'CASE条件转换'
        elif 'COALESCE' in raw_expr.upper() or 'IFNULL' in raw_expr.upper():
            transform = '空值处理'

        # 提取来源表（从 alias.field 模式）
        source_table = ''
        alias_prefix = re.match(r'^([a-zA-Z0-9_]+)\.', raw_expr)
        if alias_prefix:
            alias = alias_prefix.group(1).lower()
            source_table = alias_map.get(alias, '')

        # 提取来源字段
        field_match = re.search(r'\.`?([a-zA-Z0-9_]+)`?', raw_expr)
        source_expr = field_match.group(1) if field_match else raw_expr

        if not source_table and source_full_names:
            source_table = source_full_names[0]

        mappings.append({
            'targetField': target_field,
            'sourceTable': source_table,
            'sourceExpr': source_expr,
            'transform': transform,
        })

    return mappings


def _parse_alter_add_columns(sql: str) -> List[str]:
    """从 ALTER TABLE ... ADD COLUMN 语句中提取新增的列名。"""
    columns = []
    # 匹配 ADD COLUMN `col_name` 或 ADD `col_name` 或 ADD col_name
    pattern = re.compile(
        r'ADD\s+(?:COLUMN\s+)?`?([a-zA-Z0-9_]+)`?',
        re.IGNORECASE,
    )
    for m in pattern.finditer(sql):
        col = m.group(1)
        if col.upper() not in ('INDEX', 'KEY', 'PRIMARY', 'UNIQUE', 'CONSTRAINT', 'FOREIGN'):
            columns.append(col)
    return columns


def _parse_update_field_mappings(sql: str) -> Optional[dict]:
    """从 UPDATE ... SET ... 语句中解析目标表、来源表和字段映射。

    支持的模式：
    - UPDATE db.table SET col = expr
    - UPDATE db.table r JOIN source_table b ON ... SET r.col = b.col
    - UPDATE db.table r JOIN source_table b ON ... SET r.col = b.col1 - b.col2
    """
    # 提取目标表
    target_match = (
        re.match(
            r"\s*UPDATE\s+`([^`]+)`\s*\.\s*`([^`]+)`",
            sql, re.IGNORECASE,
        )
        or re.match(
            r"\s*UPDATE\s+([a-zA-Z0-9_]+)\s*\.\s*([a-zA-Z0-9_]+)",
            sql, re.IGNORECASE,
        )
    )
    if not target_match:
        return None

    target_db = target_match.group(1)
    target_tbl = target_match.group(2)

    # 提取来源表（FROM / JOIN 子句）
    from utils.sql_parser import extract_table_refs_from_sql
    source_refs = extract_table_refs_from_sql(sql)
    source_tables = [
        (r["database"] + "." + r["table"]) if r.get("database") else r["table"]
        for r in source_refs
        if not (r.get("database") == target_db and r["table"] == target_tbl)
    ]

    # 构建别名映射
    alias_map = {}
    alias_re = re.compile(
        r'(?:UPDATE|FROM|JOIN)\s+'
        r'(?:`([^`]+)`\.`([^`]+)`|([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+))'
        r'\s+(?:AS\s+)?([a-zA-Z0-9_]+)',
        re.IGNORECASE,
    )
    for m in alias_re.finditer(sql):
        db = m.group(1) or m.group(3) or ''
        tbl = m.group(2) or m.group(4) or ''
        alias = m.group(5)
        if alias and alias.upper() not in (
            'ON', 'LEFT', 'RIGHT', 'INNER', 'JOIN', 'WHERE', 'SET',
        ):
            alias_map[alias.lower()] = f'{db}.{tbl}' if db else tbl

    # 提取 SET 子句
    set_match = re.search(r'\bSET\s+([\s\S]+?)(?:\s+WHERE\b|\s*$)', sql, re.IGNORECASE)
    if not set_match:
        return None

    set_clause = set_match.group(1).strip()

    # 按逗号拆分 SET 赋值（处理嵌套括号）
    assignments = []
    depth = 0
    current = ''
    for ch in set_clause:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            assignments.append(current.strip())
            current = ''
        else:
            current += ch
    if current.strip():
        assignments.append(current.strip())

    field_mappings = []
    for assign in assignments:
        # 解析 target_alias.field = expr 或 field = expr
        eq_idx = assign.find('=')
        if eq_idx < 0:
            continue
        left = assign[:eq_idx].strip()
        right = assign[eq_idx + 1:].strip()

        # 提取目标字段名（去掉别名前缀）
        target_field = left.rsplit('.', 1)[-1].strip('`').strip()

        # 判断加工类型
        transform = '直接映射'
        right_upper = right.upper()
        agg_match = re.match(r'^(SUM|COUNT|AVG|MAX|MIN)\s*\(', right, re.IGNORECASE)
        if agg_match:
            transform = agg_match.group(1).upper()
        elif 'CASE' in right_upper:
            transform = 'CASE条件转换'
        elif 'COALESCE' in right_upper or 'IFNULL' in right_upper:
            transform = '空值处理'
        elif re.search(r'[+\-*/]', re.sub(r"'[^']*'", '', right)):
            transform = '计算'

        # 提取来源表（从 alias.field 模式）
        source_table = ''
        alias_prefix = re.match(r'^([a-zA-Z0-9_]+)\.', right)
        if alias_prefix:
            alias = alias_prefix.group(1).lower()
            source_table = alias_map.get(alias, '')

        # 提取来源字段/表达式
        field_match = re.search(r'\.`?([a-zA-Z0-9_]+)`?', right)
        source_expr = field_match.group(1) if field_match else right

        if not source_table and source_tables:
            source_table = source_tables[0]

        field_mappings.append({
            'targetField': target_field,
            'sourceTable': source_table,
            'sourceExpr': source_expr,
            'transform': transform,
        })

    if not field_mappings:
        return None

    return {
        "database": target_db,
        "table": target_tbl,
        "sourceTables": source_tables,
        "fieldMappings": field_mappings,
    }
