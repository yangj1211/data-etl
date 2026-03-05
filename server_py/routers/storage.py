"""REST API for persistent storage (SQLite)."""

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from db.store import (
    list_dashboards, create_dashboard, delete_dashboard, rename_dashboard,
    get_etl_state, set_etl_state,
    get_chat_messages, save_chat_messages, clear_chat_messages,
    get_metric_chat_messages, save_metric_chat_messages, clear_metric_chat_messages,
    get_processed_tables, add_or_update_processed_table, remove_processed_table, clear_processed_tables,
    get_metric_defs, add_metric_def, remove_metric_def,
    get_metrics, add_metric, update_metric, delete_metric, clear_metrics,
    list_connections, save_connection, remove_connection,
    get_schema_selection, save_schema_selection,
)

router = APIRouter(prefix="/api/store")

# ─── Dashboards ───

@router.get("/dashboards")
async def api_list_dashboards():
    rows = list_dashboards()
    return [{'id': r['id'], 'name': r['name'], 'description': r['description'],
             'createdAt': r['created_at'], 'updatedAt': r['updated_at']} for r in rows]

@router.post("/dashboards")
async def api_create_dashboard(body: dict):
    name = body.get('name', 'Untitled')
    desc = body.get('description', '')
    did = body.get('id') or f"db-{int(__import__('time').time()*1000)}-{__import__('os').urandom(3).hex()}"
    return create_dashboard(did, name, desc)

@router.delete("/dashboards/{did}")
async def api_delete_dashboard(did: str):
    delete_dashboard(did)
    return {"ok": True}

@router.patch("/dashboards/{did}")
async def api_rename_dashboard(did: str, body: dict):
    rename_dashboard(did, body.get('name', ''))
    return {"ok": True}

# ─── ETL State ───

@router.get("/etl-state/{did}")
async def api_get_etl_state(did: str):
    return get_etl_state(did)

@router.put("/etl-state/{did}")
async def api_set_etl_state(did: str, body: dict):
    set_etl_state(did, step=body.get('step'), connection_string=body.get('connectionString'))
    return {"ok": True}

# ─── Chat Messages ───

@router.get("/chat-messages/{did}")
async def api_get_chat_messages(did: str):
    return get_chat_messages(did)

@router.put("/chat-messages/{did}")
async def api_save_chat_messages(did: str, body: dict):
    save_chat_messages(did, body.get('messages', []))
    return {"ok": True}

@router.delete("/chat-messages/{did}")
async def api_clear_chat_messages(did: str):
    clear_chat_messages(did)
    return {"ok": True}

# ─── Metric Chat Messages ───

@router.get("/metric-chat-messages/{did}")
async def api_get_metric_chat_messages(did: str):
    return get_metric_chat_messages(did)

@router.put("/metric-chat-messages/{did}")
async def api_save_metric_chat_messages(did: str, body: dict):
    save_metric_chat_messages(did, body.get('messages', []))
    return {"ok": True}

@router.delete("/metric-chat-messages/{did}")
async def api_clear_metric_chat_messages(did: str):
    clear_metric_chat_messages(did)
    return {"ok": True}

# ─── Processed Tables ───

@router.get("/processed-tables/{did}")
async def api_get_processed_tables(did: str):
    return get_processed_tables(did)

@router.post("/processed-tables/{did}")
async def api_add_or_update_processed_table(did: str, body: dict):
    add_or_update_processed_table(did, body)
    return {"ok": True}

@router.delete("/processed-tables/{did}/{pt_id:path}")
async def api_remove_processed_table(did: str, pt_id: str):
    remove_processed_table(pt_id, did)
    return {"ok": True}

@router.delete("/processed-tables-all/{did}")
async def api_clear_processed_tables(did: str):
    clear_processed_tables(did)
    return {"ok": True}

# ─── Metric Defs ───

@router.get("/metric-defs/{did}")
async def api_get_metric_defs(did: str):
    return get_metric_defs(did)

@router.post("/metric-defs")
async def api_add_metric_def(body: dict):
    return add_metric_def(body)

@router.delete("/metric-defs/{mid}")
async def api_remove_metric_def(mid: str):
    remove_metric_def(mid)
    return {"ok": True}

# ─── Connections ───

@router.get("/connections")
async def api_list_connections():
    return list_connections()

@router.post("/connections")
async def api_save_connection(body: dict):
    save_connection(body.get('connectionString', ''))
    return {"ok": True}

@router.delete("/connections")
async def api_remove_connection(body: dict):
    remove_connection(body.get('connectionString', ''))
    return {"ok": True}

# ─── Schema Selections ───

@router.get("/schema-selection/{did}")
async def api_get_schema_selection(did: str):
    return get_schema_selection(did)

@router.put("/schema-selection/{did}")
async def api_save_schema_selection(did: str, body: dict):
    save_schema_selection(did, body.get('selectedTables', []))
    return {"ok": True}


# ─── Metrics (monitoring data) ───

@router.get("/metrics/{did}")
async def api_get_metrics(did: str):
    return get_metrics(did)

@router.post("/metrics")
async def api_add_metric(body: dict):
    return add_metric(body)

@router.patch("/metrics/{mid}")
async def api_update_metric(mid: str, body: dict):
    update_metric(mid, body)
    return {"ok": True}

@router.delete("/metrics/{mid}")
async def api_delete_metric(mid: str):
    delete_metric(mid)
    return {"ok": True}

@router.delete("/metrics-all/{did}")
async def api_clear_metrics(did: str):
    clear_metrics(did)
    return {"ok": True}
