"""SQLite persistent store for all application data."""

import json
import sqlite3
import os
import logging
import time
import math
from typing import Optional, List

logger = logging.getLogger("etl.store")

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data.db')

def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c

def init_db():
    """Create tables if not exist."""
    c = _conn()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS etl_state (
        dashboard_id TEXT PRIMARY KEY,
        step INTEGER DEFAULT 1,
        connection_string TEXT,
        FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dashboard_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        role TEXT NOT NULL,
        contents TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_dashboard ON chat_messages(dashboard_id);

    CREATE TABLE IF NOT EXISTS metric_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dashboard_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        role TEXT NOT NULL,
        contents TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mchat_dashboard ON metric_chat_messages(dashboard_id);

    CREATE TABLE IF NOT EXISTS processed_tables (
        id TEXT NOT NULL,
        dashboard_id TEXT NOT NULL,
        database_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        source_tables TEXT DEFAULT '[]',
        field_mappings TEXT DEFAULT '[]',
        insert_sql TEXT DEFAULT '',
        chat_history TEXT DEFAULT '[]',
        processed_at INTEGER NOT NULL,
        PRIMARY KEY (id, dashboard_id),
        FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS metric_defs (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL,
        name TEXT NOT NULL,
        definition TEXT DEFAULT '',
        tables TEXT DEFAULT '[]',
        aggregation TEXT DEFAULT 'SUM',
        measure_field TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS metrics (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL,
        name TEXT NOT NULL,
        definition TEXT DEFAULT '',
        tables TEXT DEFAULT '[]',
        sql_text TEXT DEFAULT '',
        chart_type TEXT DEFAULT 'number',
        data TEXT DEFAULT 'null',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS connections (
        connection_string TEXT PRIMARY KEY,
        last_used INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_selections (
        dashboard_id TEXT PRIMARY KEY,
        selected_tables TEXT DEFAULT '[]',
        FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    );
    """)
    c.commit()
    c.close()
    logger.info("[Store] SQLite initialized at %s", DB_PATH)


# ─── Dashboards ───

def list_dashboards() -> List[dict]:
    c = _conn()
    rows = c.execute("SELECT * FROM dashboards ORDER BY updated_at DESC").fetchall()
    c.close()
    return [dict(r) for r in rows]

def get_dashboard(did: str) -> Optional[dict]:
    c = _conn()
    r = c.execute("SELECT * FROM dashboards WHERE id=?", (did,)).fetchone()
    c.close()
    return dict(r) if r else None

def create_dashboard(did: str, name: str, description: str = '') -> dict:
    now = _now()
    c = _conn()
    c.execute("INSERT INTO dashboards(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)",
              (did, name, description, now, now))
    c.execute("INSERT OR IGNORE INTO etl_state(dashboard_id,step,connection_string) VALUES(?,1,NULL)", (did,))
    c.commit()
    c.close()
    return {'id': did, 'name': name, 'description': description, 'createdAt': now, 'updatedAt': now}

def delete_dashboard(did: str):
    c = _conn()
    c.execute("DELETE FROM dashboards WHERE id=?", (did,))
    c.commit()
    c.close()

def rename_dashboard(did: str, name: str):
    now = _now()
    c = _conn()
    c.execute("UPDATE dashboards SET name=?, updated_at=? WHERE id=?", (name, now, did))
    c.commit()
    c.close()

# ─── ETL State ───

def get_etl_state(did: str) -> dict:
    c = _conn()
    r = c.execute("SELECT * FROM etl_state WHERE dashboard_id=?", (did,)).fetchone()
    c.close()
    if r:
        return {'step': r['step'], 'connectionString': r['connection_string']}
    return {'step': 1, 'connectionString': None}

def set_etl_state(did: str, step: int = None, connection_string: str = None):
    c = _conn()
    c.execute("INSERT OR IGNORE INTO etl_state(dashboard_id,step,connection_string) VALUES(?,1,NULL)", (did,))
    if step is not None:
        c.execute("UPDATE etl_state SET step=? WHERE dashboard_id=?", (step, did))
    if connection_string is not None:
        c.execute("UPDATE etl_state SET connection_string=? WHERE dashboard_id=?", (connection_string, did))
    c.commit()
    c.close()

# ─── Chat Messages ───

def get_chat_messages(did: str) -> List[dict]:
    c = _conn()
    rows = c.execute(
        "SELECT msg_id, role, contents, timestamp FROM chat_messages WHERE dashboard_id=? ORDER BY id",
        (did,)
    ).fetchall()
    c.close()
    return [{'id': r['msg_id'], 'role': r['role'], 'contents': json.loads(r['contents']), 'timestamp': r['timestamp']} for r in rows]

def save_chat_messages(did: str, messages: List[dict]):
    c = _conn()
    c.execute("DELETE FROM chat_messages WHERE dashboard_id=?", (did,))
    for m in messages:
        c.execute(
            "INSERT INTO chat_messages(dashboard_id,msg_id,role,contents,timestamp) VALUES(?,?,?,?,?)",
            (did, m['id'], m['role'], json.dumps(m['contents'], ensure_ascii=False), m['timestamp'])
        )
    c.commit()
    c.close()

def clear_chat_messages(did: str):
    c = _conn()
    c.execute("DELETE FROM chat_messages WHERE dashboard_id=?", (did,))
    c.commit()
    c.close()

# ─── Metric Chat Messages ───

def get_metric_chat_messages(did: str) -> List[dict]:
    c = _conn()
    rows = c.execute(
        "SELECT msg_id, role, contents, timestamp FROM metric_chat_messages WHERE dashboard_id=? ORDER BY id",
        (did,)
    ).fetchall()
    c.close()
    return [{'id': r['msg_id'], 'role': r['role'], 'contents': json.loads(r['contents']), 'timestamp': r['timestamp']} for r in rows]

def save_metric_chat_messages(did: str, messages: List[dict]):
    c = _conn()
    c.execute("DELETE FROM metric_chat_messages WHERE dashboard_id=?", (did,))
    for m in messages:
        c.execute(
            "INSERT INTO metric_chat_messages(dashboard_id,msg_id,role,contents,timestamp) VALUES(?,?,?,?,?)",
            (did, m['id'], m['role'], json.dumps(m['contents'], ensure_ascii=False), m['timestamp'])
        )
    c.commit()
    c.close()

def clear_metric_chat_messages(did: str):
    c = _conn()
    c.execute("DELETE FROM metric_chat_messages WHERE dashboard_id=?", (did,))
    c.commit()
    c.close()


# ─── Processed Tables ───

def get_processed_tables(did: str) -> List[dict]:
    c = _conn()
    rows = c.execute(
        "SELECT * FROM processed_tables WHERE dashboard_id=? ORDER BY processed_at DESC",
        (did,)
    ).fetchall()
    c.close()
    return [_row_to_pt(r) for r in rows]

def get_all_processed_tables() -> List[dict]:
    c = _conn()
    rows = c.execute("SELECT * FROM processed_tables ORDER BY processed_at DESC").fetchall()
    c.close()
    return [_row_to_pt(r) for r in rows]

def add_or_update_processed_table(did: str, entry: dict):
    pt_id = f"{entry['database']}.{entry['table']}"
    now = _now()
    c = _conn()
    existing = c.execute(
        "SELECT field_mappings, source_tables FROM processed_tables WHERE id=? AND dashboard_id=?",
        (pt_id, did)
    ).fetchone()

    if existing:
        # Merge fieldMappings
        old_fm = json.loads(existing['field_mappings'] or '[]')
        new_fm = entry.get('fieldMappings', [])
        existing_keys = {m.get('targetField') for m in old_fm}
        merged_fm = old_fm + [m for m in new_fm if m.get('targetField') not in existing_keys]

        # Merge sourceTables
        old_src = json.loads(existing['source_tables'] or '[]')
        new_src = entry.get('sourceTables', [])
        merged_src = list(dict.fromkeys(old_src + new_src))  # dedup preserving order

        insert_sql = entry.get('insertSql') or ''

        c.execute("""UPDATE processed_tables
            SET source_tables=?, field_mappings=?, insert_sql=CASE WHEN ?='' THEN insert_sql ELSE ? END,
                chat_history=?, processed_at=?
            WHERE id=? AND dashboard_id=?""",
            (json.dumps(merged_src, ensure_ascii=False),
             json.dumps(merged_fm, ensure_ascii=False),
             insert_sql, insert_sql,
             json.dumps(entry.get('chatHistory', []), ensure_ascii=False),
             now, pt_id, did))
    else:
        c.execute("""INSERT INTO processed_tables(id,dashboard_id,database_name,table_name,
            source_tables,field_mappings,insert_sql,chat_history,processed_at)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            (pt_id, did, entry['database'], entry['table'],
             json.dumps(entry.get('sourceTables', []), ensure_ascii=False),
             json.dumps(entry.get('fieldMappings', []), ensure_ascii=False),
             entry.get('insertSql', ''),
             json.dumps(entry.get('chatHistory', []), ensure_ascii=False),
             now))
    c.commit()
    c.close()

def remove_processed_table(pt_id: str, did: str):
    c = _conn()
    c.execute("DELETE FROM processed_tables WHERE id=? AND dashboard_id=?", (pt_id, did))
    c.commit()
    c.close()

def clear_processed_tables(did: str):
    c = _conn()
    c.execute("DELETE FROM processed_tables WHERE dashboard_id=?", (did,))
    c.commit()
    c.close()

def _row_to_pt(r) -> dict:
    return {
        'id': r['id'],
        'dashboardId': r['dashboard_id'],
        'database': r['database_name'],
        'table': r['table_name'],
        'sourceTables': json.loads(r['source_tables'] or '[]'),
        'fieldMappings': json.loads(r['field_mappings'] or '[]'),
        'insertSql': r['insert_sql'] or '',
        'chatHistory': json.loads(r['chat_history'] or '[]'),
        'processedAt': r['processed_at'],
    }

# ─── Metric Defs ───

def get_metric_defs(did: str) -> List[dict]:
    c = _conn()
    rows = c.execute(
        "SELECT * FROM metric_defs WHERE dashboard_id=? ORDER BY created_at DESC",
        (did,)
    ).fetchall()
    c.close()
    return [_row_to_md(r) for r in rows]

def add_metric_def(entry: dict) -> dict:
    mid = entry.get('id') or f"md-{_now()}-{os.urandom(3).hex()}"
    now = _now()
    c = _conn()
    c.execute("""INSERT INTO metric_defs(id,dashboard_id,name,definition,tables,aggregation,measure_field,created_at)
        VALUES(?,?,?,?,?,?,?,?)""",
        (mid, entry['dashboardId'], entry['name'], entry.get('definition', ''),
         json.dumps(entry.get('tables', []), ensure_ascii=False),
         entry.get('aggregation', 'SUM'), entry.get('measureField', ''), now))
    c.commit()
    c.close()
    return {**entry, 'id': mid, 'createdAt': now}

def remove_metric_def(mid: str):
    c = _conn()
    c.execute("DELETE FROM metric_defs WHERE id=?", (mid,))
    c.commit()
    c.close()

def _row_to_md(r) -> dict:
    return {
        'id': r['id'],
        'dashboardId': r['dashboard_id'],
        'name': r['name'],
        'definition': r['definition'] or '',
        'tables': json.loads(r['tables'] or '[]'),
        'aggregation': r['aggregation'] or 'SUM',
        'measureField': r['measure_field'] or '',
        'createdAt': r['created_at'],
    }

# ─── Connections ───

def list_connections() -> List[str]:
    c = _conn()
    rows = c.execute("SELECT connection_string FROM connections ORDER BY last_used DESC").fetchall()
    c.close()
    return [r['connection_string'] for r in rows]

def save_connection(cs: str):
    c = _conn()
    c.execute("INSERT OR REPLACE INTO connections(connection_string, last_used) VALUES(?,?)", (cs, _now()))
    c.commit()
    c.close()

def remove_connection(cs: str):
    c = _conn()
    c.execute("DELETE FROM connections WHERE connection_string=?", (cs,))
    c.commit()
    c.close()

# ─── Schema Selections ───

def get_schema_selection(did: str) -> List[str]:
    c = _conn()
    r = c.execute("SELECT selected_tables FROM schema_selections WHERE dashboard_id=?", (did,)).fetchone()
    c.close()
    return json.loads(r['selected_tables']) if r else []

def save_schema_selection(did: str, tables: List[str]):
    c = _conn()
    c.execute("INSERT OR REPLACE INTO schema_selections(dashboard_id, selected_tables) VALUES(?,?)",
              (did, json.dumps(tables, ensure_ascii=False)))
    c.commit()
    c.close()

# ─── Helpers ───

def _now() -> int:
    return int(time.time() * 1000)


# ─── Metrics (monitoring data) ───

def get_metrics(did: str) -> List[dict]:
    c = _conn()
    rows = c.execute(
        "SELECT * FROM metrics WHERE dashboard_id=? ORDER BY created_at DESC",
        (did,)
    ).fetchall()
    c.close()
    return [_row_to_metric(r) for r in rows]

def add_metric(entry: dict) -> dict:
    mid = entry.get('id') or f"m-{_now()}-{os.urandom(3).hex()}"
    now = entry.get('createdAt') or _now()
    c = _conn()
    c.execute("""INSERT OR REPLACE INTO metrics(id,dashboard_id,name,definition,tables,sql_text,chart_type,data,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)""",
        (mid, entry['dashboardId'], entry['name'], entry.get('definition', ''),
         json.dumps(entry.get('tables', []), ensure_ascii=False),
         entry.get('sql', ''), entry.get('chartType', 'number'),
         json.dumps(entry.get('data'), ensure_ascii=False), now))
    c.commit()
    c.close()
    return {**entry, 'id': mid, 'createdAt': now}

def update_metric(mid: str, updates: dict):
    c = _conn()
    sets = []
    vals = []
    if 'sql' in updates:
        sets.append("sql_text=?"); vals.append(updates['sql'])
    if 'chartType' in updates:
        sets.append("chart_type=?"); vals.append(updates['chartType'])
    if 'data' in updates:
        sets.append("data=?"); vals.append(json.dumps(updates['data'], ensure_ascii=False))
    if 'definition' in updates:
        sets.append("definition=?"); vals.append(updates['definition'])
    if sets:
        vals.append(mid)
        c.execute(f"UPDATE metrics SET {','.join(sets)} WHERE id=?", vals)
        c.commit()
    c.close()

def delete_metric(mid: str):
    c = _conn()
    c.execute("DELETE FROM metrics WHERE id=?", (mid,))
    c.commit()
    c.close()

def clear_metrics(did: str):
    c = _conn()
    c.execute("DELETE FROM metrics WHERE dashboard_id=?", (did,))
    c.commit()
    c.close()

def reorder_metrics(did: str, ordered_ids: List[str]):
    """Not stored in DB order — frontend handles display order."""
    pass

def _row_to_metric(r) -> dict:
    data_raw = r['data']
    try:
        data = json.loads(data_raw) if data_raw else None
    except (json.JSONDecodeError, TypeError):
        data = None
    return {
        'id': r['id'],
        'dashboardId': r['dashboard_id'],
        'name': r['name'],
        'definition': r['definition'] or '',
        'tables': json.loads(r['tables'] or '[]'),
        'sql': r['sql_text'] or '',
        'chartType': r['chart_type'] or 'number',
        'data': data,
        'createdAt': r['created_at'],
    }
