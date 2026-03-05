"""execute_sql tool 定义 + 执行器。"""

import json
import re
import logging
import asyncio
from typing import Optional
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

SQL_TOOLS = [EXECUTE_SQL_TOOL]

# 禁止的 SQL 模式（允许 UPDATE，ETL 流程需要用 ALTER TABLE + UPDATE）
_FORBIDDEN = re.compile(r"\b(DROP|TRUNCATE|DELETE)\b", re.IGNORECASE)


# ---------------------------------------------------------------------------
# 执行器
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

        is_write = bool(re.match(r"^\s*(INSERT|REPLACE|CREATE|ALTER)", sql, re.IGNORECASE))

        if is_write:
            await conn.commit()
            affected = cur.rowcount

            # 记录成功的 INSERT INTO ... SELECT 操作
            if write_ops is not None and re.match(r"^\s*INSERT\s+INTO\b", sql, re.IGNORECASE):
                from utils.sql_parser import extract_table_refs_from_sql
                # 提取目标表（INSERT INTO db.table）
                target_match = (
                    re.match(r"\s*INSERT\s+INTO\s+`([^`]+)`\s*\.\s*`([^`]+)`", sql, re.IGNORECASE)
                    or re.match(r"\s*INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\.\s*([a-zA-Z0-9_]+)", sql, re.IGNORECASE)
                )
                if target_match:
                    target_db = target_match.group(1)
                    target_tbl = target_match.group(2)
                    # 提取来源表（FROM / JOIN）
                    source_refs = extract_table_refs_from_sql(sql)
                    source_tables = [
                        (r["database"] + "." + r["table"]) if r.get("database") else r["table"]
                        for r in source_refs
                        if not (r.get("database") == target_db and r["table"] == target_tbl)
                    ]
                    # 提取字段映射
                    field_mappings = _parse_field_mappings_from_sql(
                        sql, target_db, target_tbl, source_refs,
                    )
                    write_ops.append({
                        "database": target_db,
                        "table": target_tbl,
                        "insertSql": sql,
                        "sourceTables": source_tables,
                        "fieldMappings": field_mappings,
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
