"""ETL conversation LangGraph state graph (tool calling 版本)."""

import asyncio
import json
import logging
import re
from typing import TypedDict, Optional

from langgraph.graph import StateGraph, END

logger = logging.getLogger("etl.graph")

from db.connection import looks_like_connection_string, test_connection
from llm.client import call_llm
from llm.tools import SQL_TOOLS, execute_tool_call


# ---------------------------------------------------------------------------
# State type
# ---------------------------------------------------------------------------

class ETLChatState(TypedDict):
    conversation: list
    context: dict  # {connectionString, currentStep, selectedTables}
    connection_string: Optional[str]
    should_test_connection: bool
    conn_str_to_test: Optional[str]
    connection_test_note: str
    connection_test_ok: bool
    last_user_content: str
    last_message_is_only_connection_string: bool
    current_step_hint: int
    selected_tables: list
    render_blocks: dict
    llm_response: dict
    reuse_context: Optional[dict]


# ---------------------------------------------------------------------------
# Node 1: parse_input
# ---------------------------------------------------------------------------

async def parse_input(state: dict) -> dict:
    """Extract and compute all fields from conversation and context."""
    conversation = state.get("conversation", [])
    context = state.get("context", {}) or {}

    connection_string_from_context = context.get("connectionString") or None
    current_step_hint = int(context.get("currentStep", 0) or 0)
    selected_tables = context.get("selectedTables", [])
    if not isinstance(selected_tables, list):
        selected_tables = []

    user_messages = [
        (t.get("content") or "").strip()
        for t in conversation
        if t.get("role") == "user"
    ]
    last_user_content = user_messages[-1] if user_messages else ""

    last_connection_string_in_chat = None
    for msg in reversed(user_messages):
        if looks_like_connection_string(msg):
            last_connection_string_in_chat = msg
            break

    connection_string = (
        connection_string_from_context
        or last_connection_string_in_chat
        or None
    )

    should_test_connection = bool(
        (last_user_content and looks_like_connection_string(last_user_content))
        or (
            last_user_content
            and re.search(r"测试|试一下|验证|检查", last_user_content)
            and re.search(r"连接|连接串|连通", last_user_content)
            and last_connection_string_in_chat
        )
    )

    if looks_like_connection_string(last_user_content):
        conn_str_to_test = last_user_content
    else:
        conn_str_to_test = last_connection_string_in_chat

    last_message_is_only_connection_string = bool(
        last_user_content
        and looks_like_connection_string(last_user_content)
        and len(last_user_content.strip()) < 500
    )

    return {
        "connection_string": connection_string,
        "should_test_connection": should_test_connection,
        "conn_str_to_test": conn_str_to_test,
        "connection_test_note": "",
        "connection_test_ok": False,
        "last_user_content": last_user_content,
        "last_message_is_only_connection_string": last_message_is_only_connection_string,
        "current_step_hint": current_step_hint,
        "selected_tables": selected_tables,
        "render_blocks": {},
        "reuse_context": state.get("reuse_context"),
    }


# ---------------------------------------------------------------------------
# Node 2: test_connection_node
# ---------------------------------------------------------------------------

async def test_connection_node(state: dict) -> dict:
    """Test the MySQL connection if requested."""
    should_test = state.get("should_test_connection", False)
    conn_str_to_test = state.get("conn_str_to_test")

    if not should_test or not conn_str_to_test:
        return {"connection_test_note": "", "connection_test_ok": False}

    try:
        test_result = await test_connection(conn_str_to_test)
        connection_test_ok = bool(test_result.get("ok"))
        if test_result.get("ok"):
            connection_test_note = (
                "\n\n**【连接测试结果】** 连通性测试：**成功**。"
            )
        else:
            connection_test_note = (
                f'\n\n**【连接测试结果】** 连通性测试：**失败**，原因：{test_result.get("message")}'
            )
    except Exception as e:
        connection_test_ok = False
        connection_test_note = f"\n\n**【连接测试结果】** 异常：{e}"

    return {
        "connection_test_note": connection_test_note,
        "connection_test_ok": connection_test_ok,
    }


# ---------------------------------------------------------------------------
# Node 3: tool_calling_loop_node
# ---------------------------------------------------------------------------

async def tool_calling_loop_node(state: dict) -> dict:
    """调用 LLM（带 execute_sql 工具），循环处理 tool calls 直到拿到最终回复。"""
    conversation = state.get("conversation", [])
    connection_string = state.get("connection_string")
    connection_test_note = state.get("connection_test_note", "")
    connection_test_ok = state.get("connection_test_ok", False)
    selected_tables = state.get("selected_tables", [])
    current_step_hint = state.get("current_step_hint", 0)
    reuse_context = state.get("reuse_context")

    render_blocks = {}
    block_counter = [1]  # 可变计数器
    write_ops = []  # type: list  # 记录成功的写操作（INSERT）

    # ── 构建 system prompt ──
    selected_tables_note = ""
    if len(selected_tables) > 0:
        selected_tables_note = (
            f'\n**【用户已选中的库表（必须严格遵守）】**：{", ".join(selected_tables)}\n'
            "用户在界面上勾选了以上库表，你**只能**使用这些库表进行操作和讨论。"
            "不要提及或建议用户使用未选中的库表。"
            "当用户说「看看有哪些表」「有哪些库」时，只展示选中范围内的库表。\n"
        )

    reuse_note = ""
    if reuse_context and isinstance(reuse_context, dict):
        reuse_db = reuse_context.get("database", "")
        reuse_tbl = reuse_context.get("table", "")
        reuse_sources = reuse_context.get("sourceTables", [])
        reuse_sql = reuse_context.get("insertSql", "")
        reuse_mappings = reuse_context.get("fieldMappings", [])
        reuse_chat = reuse_context.get("chatHistory", [])

        reuse_parts = [
            "\n**【复用加工逻辑参考】**",
            "用户选择了一个已有的加工表作为参考，请基于以下信息帮助用户对当前选中的库表做类似的加工。",
            f"参考加工表：{reuse_db}.{reuse_tbl}",
            f"参考来源表：{', '.join(reuse_sources) if reuse_sources else '未知'}",
        ]
        if reuse_sql:
            reuse_parts.append(f"参考加工 SQL：\n{reuse_sql}")
        if reuse_mappings:
            mapping_lines = []
            for m in reuse_mappings:
                mapping_lines.append(
                    "  - %s <- %s.%s (%s)" % (
                        m.get("targetField", ""),
                        m.get("sourceTable", ""),
                        m.get("sourceExpr", ""),
                        m.get("transform", ""),
                    )
                )
            reuse_parts.append("参考字段映射：\n" + "\n".join(mapping_lines))
        if reuse_chat:
            chat_lines = []
            for msg in reuse_chat[-20:]:
                role_label = "用户" if msg.get("role") == "user" else "助手"
                content = msg.get("content", "")
                if len(content) > 500:
                    content = content[:500] + "..."
                chat_lines.append(f"  [{role_label}] {content}")
            reuse_parts.append("参考对话历史（展示用户的加工思路）：\n" + "\n".join(chat_lines))
        reuse_parts.append(
            "\n**【一键复用模式 — 必须严格遵守】**"
            "\n用户选择了「一键复用」，你必须**跳过步骤 1~3**，直接进入步骤 4（字段映射）。"
            "\n具体要求："
            "\n1. 先调用工具查看用户当前选中库表的表结构（DESCRIBE）。"
            "\n2. 基于参考加工 SQL 和参考字段映射，结合当前表的真实结构，**直接生成完整的加工方案**："
            "\n   - 如果目标表不存在，生成 CREATE TABLE SQL"
            "\n   - 生成 INSERT INTO ... SELECT ... 的映射 SQL"
            "\n3. 将生成的 SQL 完整展示给用户，并提示「请确认后说「确认」或「执行」」。"
            "\n4. **不要**再问用户「想基于哪张表」「目标表要哪些字段」等已知信息，参考逻辑里都有了。"
            "\n5. **不要**走完整的 6 步流程，直接给出加工方案让用户确认即可。"
            "\n6. currentStep 设为 4。\n"
        )
        reuse_note = "\n".join(reuse_parts)

    system_prompt = f"""你是智能数据 ETL 助手，帮助用户通过对话完成完整的 ETL 流程。
{selected_tables_note}{reuse_note}
**你有一个工具 `execute_sql`**，可以在用户的 MySQL 数据库上执行任意 SQL。需要查数据、建库、建表、写入数据时，直接调用工具执行 SQL 即可。你可以多次调用工具来完成多步操作（如先建库再建表）。**当有多条互相独立的 SQL 需要执行时（如同时查看多张表的结构、同时预览多张表的数据），你应该在同一轮回复中同时调用多次工具，系统会并行执行，大幅提升效率。**

**步骤自动判断**：ETL 流程有 6 步：1-连接数据库、2-选择基表、3-定义目标表、4-字段映射、5-数据验证、6-异常溯源。
你需要根据**对话上下文**自动判断当前处于哪一步（currentStep 字段，1～6），并在回复中自然引导用户完成当前步、过渡到下一步。

**重要：界面没有「下一步」按钮**。用户只能根据你在对话里的提示进行下一步操作，因此你**必须在回复中根据当前进度明确、自然地提示用户下一步可以做什么**（例如：连接成功后提示输入要加工的库/表、建表成功后提示描述字段映射、映射执行后提示可验证数据等）。**不要写死固定话术**，根据你对对话的理解灵活提醒，让用户知道「现在可以输入什么、做什么」即可。

判断规则：
- 尚未发送过连接串或连接未成功 → 1
- 连接成功但尚未选定基表 → 2
- 已选定基表、用户在讨论目标表字段或生成 CREATE TABLE → 3
- 目标表已建好、用户在讨论映射或生成 INSERT INTO ... SELECT → 4
- 映射已执行、用户在讨论验证/空值/数据质量 → 5
- 用户提到追溯/去源表看/检查基表 → 6
- 若无法判断则保持上一轮 currentStep（前端上一轮传入的 currentStep 为 {current_step_hint}，若为 0 则默认 1）。
当用户完成一步后，在回复末尾**自然提示下一步可做的操作**，但不要跳步。

**硬性约定（必须遵守）**：
- **一切会修改库表或数据的操作（DDL 与 DML）都必须先展示完整 SQL 并获用户明确确认后才能调用工具执行。** 包括：CREATE TABLE、CREATE DATABASE、INSERT INTO ... SELECT 等。你先展示 SQL 并提示「请确认后说「确认」或「执行」」，只有用户明确回复「确认」「执行」「可以」后才调用 execute_sql 工具真实执行。只读操作（如 SELECT、DESCRIBE、SHOW）可直接调用工具执行，无需确认。
- 所有 SQL、DDL、DML 必须**严格符合 MySQL 语法**（仅使用 MySQL 支持的类型、函数、写法）。
- **所有生成的 SQL 下方必须附带业务含义解释**：用通俗易懂的中文说明这段 SQL 在做什么、每个关键部分的业务含义（如：这个 JOIN 是关联什么、WHERE 条件筛选了什么、聚合计算的是什么业务指标等），让非技术人员也能看懂。
- 所有库/表操作均在**用户提供的连接上真实执行**，由后端连接用户库执行，不模拟、不造假。

**【数据块引用机制】**：
execute_sql 工具返回的结果中会包含数据块 ID（如 TABLE_1、SQL_1、TABLE_2、SQL_2 等），这些 ID 对应真实的查询结果数据。
你在最终回复中**必须直接用 `{{TABLE_1}}`、`{{SQL_1}}` 这样的格式引用**，**严禁**自己手写或复制表格/SQL内容。
示例：工具返回 "查询成功，返回 10 行。可用数据块：SQL_1（执行的SQL）, TABLE_1（查询结果，10行）"
你的回复应写：`{{SQL_1}}\n\n{{TABLE_1}}\n\n执行成功，共返回 10 行数据。`
后端会自动将 `{{TABLE_1}}` 替换为真实表格内容。
**注意**：直接写数据块 ID 本身，如 `{{{{TABLE_3}}}}`，不要写成其他格式。
- 只引用工具返回中列出的数据块 ID，不要编造不存在的 ID
- 你只需要写自然语言 + `{{TABLE_N}}`/`{{SQL_N}}` 占位符，不要自己写表格或 SQL 代码块

- **凡涉及表数据验证、数据展示的回答**（如：表结构、前 N 条数据、空值分析、库表列表、任意 SELECT 结果），回复中**禁止出现 JSON**，必须严格按以下顺序且用**表格**展示数据：(1) **验证/执行的 SQL**（用 {{SQL_N}} 引用）；(2) **实际返回的表格**（用 {{TABLE_N}} 引用）；(3) **SQL 返回码**（如：执行成功，返回行数/列数/影响行数）。**表格内容必须严格根据工具返回的执行结果**：逐行逐列照实填写，不得自行编造、补全、推测或改写任何单元格。
- **SQL 执行失败时**：若工具返回了失败信息，你必须 (1) **如实、完整**地把失败原因输出给用户（不得隐瞒、不得改写为"成功"）；(2) **禁止**以任何方式声称"执行成功""已完成""已创建"等；(3) **自我纠正**：若失败原因为「列不存在」「Unknown column」等，你须先调用工具查询涉及表的真实结构（DESCRIBE），然后根据真实列名给出**修正后的完整可执行 SQL**，并明确提示用户「请再次执行上述 SQL」。
- 只有工具明确返回成功时，才可在回复中说"成功"；否则一律按失败处理并输出真实原因。
{connection_test_note}

**各步骤引导说明**：

**第1步：连接数据库**
- 用户提供 MySQL 连接串（URL 如 mysql://user:pass@host:port/db 或命令行形式）。
- 若有【连接测试结果】且成功 → 回复「连接成功。」并**自然引导**进入第 2 步（如：「接下来请告诉我你想基于哪个库的哪张表做数据加工？」）。
- 若测连失败 → 如实说明错误信息，提示用户检查连接串或权限。
- 若本轮用户发送了连接串，必须设置 "connectionReceived": true。

**第2步：选择基表**
- 围绕「有哪些库」「某个库下有哪些表」「我要用哪张表」这类问题回答。
- 用户想看库/表/表结构时，直接调用 execute_sql 工具执行对应 SQL（SHOW DATABASES、SHOW TABLES、DESCRIBE 等），然后用 {{{{TABLE_N}}}} 引用结果。
- 若用户说「基于 xxx 表做加工」「用 xxx 表」，调用工具执行 DESCRIBE 和 SELECT * LIMIT 10，以**表格**形式展示表结构和前 10 条数据（禁止用 JSON）；分析只基于真实数据，不得编造。
- **只要本轮展示了某张基表的结构/数据，回复末尾必须明确引导下一步**，例如：「基表已确认。接下来请描述目标表要有哪些字段（字段名、类型、含义），或说明要放在哪个库，我来生成建表语句。」不得只展示表结构而不提示用户下一步该干啥。

**第3步：定义目标表**
- 用户描述目标表字段后 → 你根据描述生成 **标准 MySQL** 的 CREATE TABLE 语句（仅用 MySQL 支持的类型，字段带 COMMENT，库名/表名可用反引号），**仅展示给用户，并明确提示「请确认后再执行」或「确认后请回复「确认」或「执行」」**；不得在用户未确认时调用工具执行建表。
- 只有用户明确回复「确认建表」「确认」「执行」「可以」等后，才调用 execute_sql 工具真实执行建表（如果 DDL 中有 database.table 格式，先建库再建表），你如实反馈结果。
- 建表成功后，自然引导进入第 4 步（如：「目标表已创建，请描述每个字段的数据来源与加工逻辑。」）。

**第4步：字段映射**
- 围绕「目标字段如何从基表/维表中取数、怎么加工」来对话。
- **维表/基表字段必须用真实列名**：写 JOIN、SELECT 时只能使用**已查询过的表结构**中的列名；若某维表尚未查过结构，**不得臆造列名**，应先调用工具查看表结构（DESCRIBE），再根据真实列名写 DML。
- 用户描述字段映射后 → 你生成 **标准 MySQL** 的 INSERT INTO 目标表 SELECT ... FROM 基表 的 DML（JOIN 写法，禁止子查询），**仅展示完整 SQL，并明确提示「请确认后说「确认」或「执行」」**；不得在用户未确认时调用工具执行。只有用户明确回复「确认」「执行」后，才调用 execute_sql 工具执行该 DML。
- 执行后必须写出 SQL + SQL 返回码（影响行数等）。若执行失败，须先调用工具查询涉及表的真实结构，然后**直接给出修正后的完整 SQL** 并提示再次执行，直至成功。
- 映射执行成功后，自然引导进入第 5 步（如：「数据已写入目标表，可以发送"开始验证"检查数据质量。」）。

**第5步：数据验证**
- 围绕「目标表数据是否正常」「哪些字段空值多」「是否有异常值」来回答。
- 调用工具执行验证 SQL（如空值分析、数据预览等），以**表格**形式展示实际返回，**禁止**用 JSON。用 {{{{TABLE_N}}}} 引用工具返回的数据块。
- 若发现异常，自然引导进入第 6 步（如：「发现 xxx 字段空值较多，可以说"追溯 xxx 字段"去源表排查原因。」）。

**第6步：异常溯源**
- 用户提到「去源表看看」「追溯某字段」「检查基表数据」时，调用工具查询并展示基表真实数据。
- 回复中必须写出**验证 SQL**并以**表格**展示实际查询结果，禁止 JSON、不得编造；对比目标表和基表的数据情况分析原因。

**通用回复规则**：
1. 用中文回复，简洁友好。**因无「下一步」按钮，你必须在对话中提示用户下一步该干啥**：根据当前步骤和对话理解，在回复中自然说明「接下来可以输入/做什么」（不写死话术，灵活提醒）。
2. **你执行的每一个 SQL 都必须在回复中给出返回结果**：SELECT 须有表格 + 返回行数；INSERT 等须明确写出**SQL 返回码**。**禁止**只写「正在执行」而不写执行结果。用 {{{{TABLE_N}}}} 引用工具返回的数据块。
3. 若工具执行失败，必须**如实输出失败原因**，并给出**自我纠正**建议。
4. **【最高优先级规则 — 禁止空谈】** 用户的每一条消息都是一个指令，你必须对每个指令做出实质性响应。绝对禁止只回复过渡性文本而不执行任何操作。具体要求：
   - 如果用户要求查看/验证/检查/分析数据 → 你必须在本轮直接调用 execute_sql 工具执行相应 SQL，并在回复中展示结果。不允许只说「让我验证一下」「现在来检查」然后就结束。
   - 如果用户要求执行某个操作 → 你必须在本轮完成该操作（调用工具或展示 SQL 等待确认），不允许只描述你打算做什么。
   - 如果你的回复以冒号「：」结尾、或包含「让我」「现在来」「接下来」等词但没有实际内容跟随 → 这说明你没有完成用户的指令，这是严重错误。
   - 简单来说：**每轮回复必须包含实质性内容（工具调用结果、完整 SQL 方案、或基于已有信息的完整分析），绝不允许只有过渡性文字。**
5. 若用户发送了 MySQL 连接串，设置 "connectionReceived": true。
6. **所有会修改库表或数据的操作（DDL、DML）**：建库、建表、INSERT INTO ... SELECT 等，都必须**先展示 SQL 并提示用户确认**，只有用户明确回复「确认」「执行」「可以」后才调用工具真实执行。不得在用户未确认时执行任何写操作。

**输出格式**：只返回一个 JSON 对象，不要 markdown 代码块：
{{"reply":"你的回复内容（可含 markdown 格式化，有数据块时用 {{{{TABLE_N}}}} 引用）","connectionReceived":false,"currentStep":1}}
**重要**：
- currentStep 必须填入你判断的当前步骤（1～6 的整数），前端会根据它更新进度条。
- reply 里涉及表数据时，必须是「SQL 代码块 + markdown 表格 + 返回码」三部分，禁止 JSON。**有数据块时用 {{{{TABLE_N}}}} 引用，表格内容必须与工具返回结果完全一致，不得编造。**"""

    messages = [
        {"role": "system", "content": system_prompt},
        *[{"role": t["role"], "content": t["content"]} for t in conversation],
    ]

    # 只有在有连接串时才提供工具
    tools = SQL_TOOLS if connection_string else None

    MAX_TOOL_ROUNDS = 8
    total_tool_calls_made = 0  # 整个循环中实际调用工具的总次数
    reuse_nudge_count = 0  # 复用模式下强制催促的次数
    MAX_REUSE_NUDGES = 3  # 最多催促几次

    try:
        for round_i in range(MAX_TOOL_ROUNDS):
            result = await call_llm(
                messages, tools=tools,
                temperature=0.3, max_tokens=4096,
                caller=f"etl_chat_r{round_i}",
            )

            if not result.get("ok"):
                return {
                    "llm_response": {
                        "_error": result.get("error") or "LLM 请求失败",
                        "_status": result.get("status", 500),
                    }
                }

            tool_calls = result.get("tool_calls")

            # 最终回复（无 tool calls）
            if not tool_calls:
                # 复用模式下，如果模型从未调用过工具就想停，强制催它继续
                if (reuse_context and total_tool_calls_made == 0
                        and tools and reuse_nudge_count < MAX_REUSE_NUDGES):
                    reuse_nudge_count += 1
                    logger.warning(
                        "[ETL][Reuse] 模型未调用工具就停止了 (nudge %d/%d)，强制继续",
                        reuse_nudge_count, MAX_REUSE_NUDGES,
                    )
                    # 把模型的空谈回复加入上下文，再追加强制指令
                    content = result.get("content", "")
                    if content:
                        messages.append({"role": "assistant", "content": content})
                    messages.append({
                        "role": "user",
                        "content": (
                            "你还没有调用任何工具。请立即调用 execute_sql 工具执行 DESCRIBE 查看当前选中库表的表结构，"
                            "然后基于参考加工逻辑生成完整的加工方案（CREATE TABLE + INSERT INTO ... SELECT）。"
                            "不要再解释你打算做什么，直接调用工具。"
                        ),
                    })
                    continue

                return _process_final_response(
                    result.get("content", ""),
                    render_blocks, current_step_hint, connection_test_ok,
                    write_ops,
                )

            # 处理 tool calls
            messages.append({
                "role": "assistant",
                "content": result.get("content"),
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in tool_calls
                ],
            })

            # 并行执行所有 tool calls
            async def _run_tool(tc):
                logger.info("[Tool] call: %s args=%s", tc.function.name, tc.function.arguments[:200])
                res = await execute_tool_call(
                    tc, connection_string, render_blocks, block_counter, write_ops,
                )
                logger.info("[Tool] result: %s", res[:200])
                return tc.id, res

            results = await asyncio.gather(*[_run_tool(tc) for tc in tool_calls])
            total_tool_calls_made += len(results)
            for tc_id, tool_result in results:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": tool_result,
                })

        # 超过最大轮次，再执行最后一个 tool call 然后强制总结
        if result.get("ok") and result.get("tool_calls"):
            last_tool_calls = result["tool_calls"]
            messages.append({
                "role": "assistant",
                "content": result.get("content"),
                "tool_calls": [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in last_tool_calls
                ],
            })
            async def _run_tool_final(tc):
                res = await execute_tool_call(
                    tc, connection_string, render_blocks, block_counter, write_ops,
                )
                return tc.id, res
            final_results = await asyncio.gather(*[_run_tool_final(tc) for tc in last_tool_calls])
            for tc_id, tool_result in final_results:
                messages.append({"role": "tool", "tool_call_id": tc_id, "content": tool_result})

        messages.append({
            "role": "user",
            "content": "请基于以上所有工具执行结果，直接给出最终回复。不要再调用工具。",
        })
        result = await call_llm(
            messages, temperature=0.3, max_tokens=4096,
            caller="etl_chat_final",
        )
        content = result.get("content", "") if result.get("ok") else "对话处理超时，请重试。"
        return _process_final_response(
            content, render_blocks, current_step_hint, connection_test_ok,
            write_ops,
        )

    except Exception as e:
        logger.error("[ETL] tool_calling_loop error: %s", e)
        return {
            "llm_response": {
                "_error": str(e) or "LLM 请求失败",
                "_status": 500,
            }
        }


def _process_final_response(content, render_blocks, current_step_hint, connection_test_ok, write_ops=None):
    """处理 LLM 最终文本回复：解析 JSON、替换 {{BLOCK_ID}} 占位符。"""
    content = (content or "").strip()
    json_match = re.search(r"\{[\s\S]*\}", content)
    out = {
        "reply": content,
        "connectionReceived": False,
        "currentStep": current_step_hint or 1,
    }

    if json_match:
        try:
            parsed = json.loads(json_match.group(0))
            if isinstance(parsed.get("reply"), str):
                out["reply"] = parsed["reply"]
            if parsed.get("connectionReceived"):
                out["connectionReceived"] = True
            cs = parsed.get("currentStep")
            if isinstance(cs, (int, float)) and 1 <= cs <= 6:
                out["currentStep"] = int(cs)
        except (json.JSONDecodeError, ValueError):
            pass

    # 替换标准格式的占位符
    if render_blocks:
        reply = out["reply"]
        for bid, content_val in render_blocks.items():
            reply = reply.replace("{{" + bid + "}}", content_val)
            reply = reply.replace("{" + bid + "}", content_val)
        out["reply"] = reply

    # 智能处理畸形占位符（如 {BLOCK_ID: TABLE_3} 等）
    def _replace_malformed(match):
        text = match.group(0)
        inner = re.search(r'(TABLE_\d+|SQL_\d+)', text)
        if inner and render_blocks and inner.group(1) in render_blocks:
            return render_blocks[inner.group(1)]
        return ''

    out["reply"] = re.sub(
        r'\{+\s*(?:BLOCK_ID\s*[:\s]*)?(?:TABLE_\d+|SQL_\d+|BLOCK_\d+|BLOCK_ID)\s*\}+',
        _replace_malformed,
        out["reply"],
    ).strip()

    logger.info("[ETL] step=%d reply_len=%d blocks=%s",
                out["currentStep"], len(out["reply"]),
                list(render_blocks.keys()) if render_blocks else [])

    response = {
        "llm_response": {
            "reply": out["reply"],
            "connectionReceived": out["connectionReceived"],
            "connectionTestOk": connection_test_ok,
            "currentStep": out["currentStep"],
        }
    }

    # 如果有成功的写操作，返回结构化的加工表信息
    if write_ops:
        insert_ops = [op for op in write_ops if op.get("type") == "insert"]
        update_ops = [op for op in write_ops if op.get("type") == "update"]
        alter_ops = [op for op in write_ops if op.get("type") == "alter"]
        # 兼容旧格式（无 type 字段的视为 insert）
        legacy_ops = [op for op in write_ops if "type" not in op]
        insert_ops.extend(legacy_ops)

        if insert_ops:
            last_op = insert_ops[-1]
            response["llm_response"]["processedTable"] = {
                "database": last_op["database"],
                "table": last_op["table"],
                "insertSql": last_op.get("insertSql", last_op.get("sql", "")),
                "sourceTables": last_op.get("sourceTables", []),
                "fieldMappings": last_op.get("fieldMappings", []),
            }

        # UPDATE/ALTER 操作：返回增量字段映射，前端合并到已有 processedTable
        incremental_mappings = []
        for op in update_ops:
            incremental_mappings.extend(op.get("fieldMappings", []))
        for op in alter_ops:
            # ALTER 只记录新增列名，不含映射（映射由后续 UPDATE 提供）
            pass

        if incremental_mappings:
            # 如果同时有 INSERT，增量映射追加到 processedTable
            if "processedTable" in response["llm_response"]:
                existing = response["llm_response"]["processedTable"].get("fieldMappings", [])
                response["llm_response"]["processedTable"]["fieldMappings"] = existing + incremental_mappings
            else:
                # 只有 UPDATE 没有 INSERT — 返回增量更新信息
                # 取第一个 UPDATE 的目标表信息
                first_update = update_ops[0]
                response["llm_response"]["processedTable"] = {
                    "database": first_update["database"],
                    "table": first_update["table"],
                    "insertSql": "",  # 无新的 INSERT SQL
                    "sourceTables": first_update.get("sourceTables", []),
                    "fieldMappings": incremental_mappings,
                    "_incremental": True,  # 标记为增量更新
                }

    return response


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

def should_test_connection_router(state: dict) -> str:
    if state.get("should_test_connection"):
        logger.info("[Router] parse_input → test_connection")
        return "test_connection"
    logger.info("[Router] parse_input → tool_calling_loop")
    return "tool_calling_loop"


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_etl_chat_graph():
    graph = StateGraph(ETLChatState)

    graph.add_node("parse_input", parse_input)
    graph.add_node("test_connection", test_connection_node)
    graph.add_node("tool_calling_loop", tool_calling_loop_node)

    graph.set_entry_point("parse_input")

    graph.add_conditional_edges(
        "parse_input",
        should_test_connection_router,
        {
            "test_connection": "test_connection",
            "tool_calling_loop": "tool_calling_loop",
        },
    )

    graph.add_edge("test_connection", "tool_calling_loop")
    graph.add_edge("tool_calling_loop", END)

    return graph.compile()
