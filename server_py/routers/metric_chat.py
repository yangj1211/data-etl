from fastapi import APIRouter
from fastapi.responses import JSONResponse
from config import LLM_API_KEY
from graphs.metric_chat_graph import build_metric_chat_graph

router = APIRouter()


@router.post("/api/metric-chat")
async def metric_chat(request_body: dict):
    if not LLM_API_KEY:
        return JSONResponse(status_code=503, content={"error": "DEEPSEEK_API_KEY not configured"})

    conversation = request_body.get('conversation')
    connection_string = request_body.get('connectionString')
    selected_tables = request_body.get('selectedTables', [])
    processed_tables = request_body.get('processedTables', [])

    if not isinstance(conversation, list) or len(conversation) == 0:
        return JSONResponse(status_code=400, content={"error": "Missing conversation"})

    try:
        graph = build_metric_chat_graph()
        initial_state = {
            'conversation': conversation,
            'connection_string': connection_string,
            'selected_tables': selected_tables if isinstance(selected_tables, list) else [],
            'processed_tables': processed_tables if isinstance(processed_tables, list) else [],
            'schema_context': '',
            'render_blocks': {},
            'llm_response': {},
        }
        result = await graph.ainvoke(initial_state)
        response = result.get('llm_response', {})
        if '_error' in response:
            status = response.get('_status', 500)
            return JSONResponse(status_code=status, content={"error": response['_error']})
        return response
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e) or "指标对话失败"})
