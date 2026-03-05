import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import PORT
from routers import chat, metric_chat, mapping, dml, tables, metric, lineage, debug, storage
from db.store import init_db

# 配置 etl.* 日志：同时输出到终端和文件
_log_fmt = logging.Formatter("%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
_etl_logger = logging.getLogger("etl")
_etl_logger.setLevel(logging.INFO)
# 终端
_sh = logging.StreamHandler()
_sh.setFormatter(_log_fmt)
_etl_logger.addHandler(_sh)
# 文件：server_py/etl.log
_fh = logging.FileHandler("etl.log", encoding="utf-8")
_fh.setFormatter(_log_fmt)
_etl_logger.addHandler(_fh)


def create_app() -> FastAPI:
    app = FastAPI()

    # Initialize SQLite database
    init_db()

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 2 MB request body size limit
    from starlette.requests import Request
    from starlette.responses import JSONResponse

    @app.middleware("http")
    async def limit_request_body(request: Request, call_next):
        max_body_size = 2 * 1024 * 1024  # 2 MB
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > max_body_size:
            return JSONResponse(
                status_code=413,
                content={"detail": "Request body too large. Max size is 2MB."},
            )
        return await call_next(request)

    # Register all routers
    app.include_router(chat.router)
    app.include_router(metric_chat.router)
    app.include_router(mapping.router)
    app.include_router(dml.router)
    app.include_router(tables.router)
    app.include_router(metric.router)
    app.include_router(lineage.router)
    app.include_router(debug.router)
    app.include_router(storage.router)

    @app.get("/")
    async def root():
        return {
            "name": "ETL API",
            "message": "后端已运行",
            "endpoints": {
                "POST /api/chat": "ETL 六步对话",
                "POST /api/mapping": "字段映射",
                "POST /api/dml": "生成 DML",
                "GET /api/debug-deepseek": "测试 DeepSeek",
            },
        }

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)
