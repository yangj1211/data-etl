const path = require('path');
const express = require('express');
const cors = require('cors');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: false });

let mysql2;
try {
  mysql2 = require('mysql2/promise');
} catch (_) {}

function looksLikeConnectionString(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (/^mysql:\/\//i.test(s) || (/^[a-z]+:\/\//i.test(s) && s.includes('@') && /:\d+/.test(s))) return true;
  return /mysql\s+.+-h\s+/i.test(s) && (/-u\s/i.test(s) || /-u'/.test(s)) && (/-p\s/i.test(s) || /-p\S/.test(s));
}

function parseConnectionStringUrl(str) {
  const s = str.trim();
  try {
    const u = new URL(s);
    const type = (u.protocol || '').replace(':', '').toLowerCase();
    if (!type.includes('mysql')) return null;
    return {
      host: u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      database: (u.pathname || '/').replace(/^\//, '').replace(/\/$/, '') || null,
    };
  } catch (e) {
    return null;
  }
}

function parseMysqlCliConnectionString(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (!/mysql\s+/i.test(s)) return null;
  const hostMatch = s.match(/-h\s+(\S+)/i);
  const portMatch = s.match(/-P\s+(\d+)/i);
  const userMatch = s.match(/-u\s*'([^']*)'|-u\s*(\S+)/i);
  const passwordMatch = s.match(/-p\s*(\S+)/i) || s.match(/-p(\S+)/i);
  if (!hostMatch || !userMatch) return null;
  const host = hostMatch[1].trim();
  const port = portMatch ? Number(portMatch[1]) : 3306;
  const user = (userMatch[1] || userMatch[2] || '').trim();
  const password = (passwordMatch && (passwordMatch[1] || passwordMatch[2])) ? (passwordMatch[1] || passwordMatch[2]).trim() : '';
  const dbMatch = s.match(/-D\s+(\S+)/i);
  const database = dbMatch ? dbMatch[1].trim() : null;
  return { host, port, user, password, database };
}

function getConnectionConfig(connectionString) {
  if (!connectionString) return null;
  const urlParsed = parseConnectionStringUrl(connectionString);
  if (urlParsed) return urlParsed;
  return parseMysqlCliConnectionString(connectionString);
}

async function testConnection(connectionString) {
  const parsed = getConnectionConfig(connectionString);
  if (!parsed) {
    return { ok: false, message: '连接串格式无法解析' };
  }
  const { host, port, user, password, database } = parsed;
  if (!mysql2) return { ok: false, message: '服务端未安装 mysql2 驱动' };
  try {
    const conn = await Promise.race([
      mysql2.createConnection({ host, port, user, password, database: database || undefined, connectTimeout: 8000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 8000)),
    ]);
    await conn.ping();
    conn.destroy();
    return { ok: true, message: '连接成功' };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

function safeIdentifier(name) {
  if (!name || typeof name !== 'string') return null;
  const s = name.trim();
  return /^[a-zA-Z0-9_]+$/.test(s) ? s : null;
}

/** 从 CREATE TABLE DDL 中解析出目标库名（若为 db.table 形式）。返回库名或 null（表未指定库则用当前连接库） */
function extractDatabaseFromCreateTable(ddl) {
  const s = String(ddl).trim();
  const afterCreate = s.replace(/^\s*CREATE\s+TABLE\s+/i, '').trim();
  // 匹配 `db`.`tbl` 或 db.tbl 或 `db`.tbl 或 db.`tbl`，取第一个标识符为库名
  const m = afterCreate.match(/^(`[^`]+`|\w+)\s*\.\s*(`[^`]+`|\w+)/);
  if (!m) return null;
  const db = (m[1].startsWith('`') ? m[1].slice(1, -1) : m[1]).trim();
  return safeIdentifier(db) ? db : null;
}

async function getMysqlConnection(connectionString) {
  const parsed = getConnectionConfig(connectionString);
  if (!parsed) throw new Error('连接串格式无法解析');
  if (!mysql2) throw new Error('服务端未安装 mysql2 驱动');
  const { host, port, user, password, database } = parsed;
  return Promise.race([
    mysql2.createConnection({ host, port, user, password, database: database || undefined, connectTimeout: 10000 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 10000)),
  ]);
}

const VALID_INTENTS = ['createDatabase','listDatabases','listTables','describeTable','previewData','createTable','executeSQL','analyzeNulls'];

/** 从 SQL 中解析 FROM / JOIN 涉及的表，返回 { database, table } 列表（去重、合法标识符） */
function extractTableRefsFromSql(sql) {
  if (!sql || typeof sql !== 'string') return [];
  const refs = [];
  const re = /(?:FROM|JOIN)\s+(?:`([^`]+)`\.`([^`]+)`|([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)|`([^`]+)`|([a-zA-Z0-9_]+))/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    let database = null;
    let table = null;
    if (m[1] != null && m[2] != null) {
      database = m[1].trim();
      table = m[2].trim();
    } else if (m[3] != null && m[4] != null) {
      database = m[3].trim();
      table = m[4].trim();
    } else if (m[5] != null) {
      table = m[5].trim();
    } else if (m[6] != null) {
      table = m[6].trim();
    }
    if (table && /^[a-zA-Z0-9_]+$/.test(table) && (!database || /^[a-zA-Z0-9_]+$/.test(database))) {
      const key = (database ? database + '.' : '') + table;
      if (!refs.some((r) => (r.database || '') + '.' + r.table === key)) refs.push({ database: database || null, table });
    }
  }
  return refs;
}

/** 将行数据格式化为 Markdown 表格（用于注入给模型，模型必须用表格展示、禁止用 JSON） */
function rowsToMarkdownTable(rows, columns) {
  if (!rows || rows.length === 0) return '';
  const cols = columns || (Array.isArray(rows[0]) ? null : Object.keys(rows[0]));
  if (!cols || cols.length === 0) return '';
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const body = rows.map((r) => {
    const cells = Array.isArray(r) ? r : cols.map((c) => (r[c] == null ? '' : String(r[c])));
    return '| ' + cells.join(' | ') + ' |';
  }).join('\n');
  return header + '\n' + sep + '\n' + body;
}

/** 在用户提供的 MySQL 连接上真实执行库/表操作，所有 SQL 均为标准 MySQL 语法 */
async function runDatabaseOperation(connectionString, intent, params = {}) {
  let conn;
  try {
    conn = await getMysqlConnection(connectionString);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  const parsed = getConnectionConfig(connectionString);
  const database = parsed?.database || null;
  const esc = (n) => `\`${String(n).replace(/`/g, '``')}\``;

  try {
    if (intent === 'listDatabases') {
      const [rows] = await conn.query('SHOW DATABASES');
      const dbList = (rows || []).map((r) => r['Database'] || Object.values(r)[0]).filter(Boolean);
      const withCounts = [];
      for (const db of dbList) {
        if (!safeIdentifier(db)) continue;
        const [tblRows] = await conn.query(`SHOW TABLES FROM ${esc(db)}`);
        withCounts.push({ database: db, tableCount: Array.isArray(tblRows) ? tblRows.length : 0 });
      }
      return { ok: true, data: { databases: withCounts, totalDatabases: withCounts.length } };
    }

    if (intent === 'listTables') {
      const db = (params.database && safeIdentifier(params.database)) || (database && safeIdentifier(database));
      const sql = db ? `SHOW TABLES FROM ${esc(db)}` : 'SHOW TABLES';
      const [rows] = await conn.query(sql);
      const tables = (rows || []).map((r) => Object.values(r)[0]).filter(Boolean);
      return { ok: true, data: { database: db || database || '(当前库)', tables } };
    }

    if (intent === 'createDatabase' && params.name) {
      const name = safeIdentifier(params.name);
      if (!name) return { ok: false, error: '无效的数据库名（仅允许字母、数字、下划线）' };
      await conn.query(`CREATE DATABASE IF NOT EXISTS ${esc(name)}`);
      return { ok: true, data: { message: `数据库 ${name} 已创建` } };
    }

    if (intent === 'describeTable' && params.table) {
      const db = (params.database && safeIdentifier(params.database)) || (database && safeIdentifier(database));
      const tbl = safeIdentifier(params.table);
      if (!tbl) return { ok: false, error: '无效的表名' };
      const fullName = db ? `${esc(db)}.${esc(tbl)}` : esc(tbl);
      const [cols] = await conn.query(`DESCRIBE ${fullName}`);
      return { ok: true, data: { database: db || database, table: tbl, columns: cols } };
    }

    if (intent === 'previewData' && params.table) {
      const db = (params.database && safeIdentifier(params.database)) || (database && safeIdentifier(database));
      const tbl = safeIdentifier(params.table);
      if (!tbl) return { ok: false, error: '无效的表名' };
      const fullName = db ? `${esc(db)}.${esc(tbl)}` : esc(tbl);
      const limit = Math.min(Number(params.limit) || 10, 50);
      const [rows] = await conn.query(`SELECT * FROM ${fullName} LIMIT ${limit}`);
      return { ok: true, data: { database: db || database, table: tbl, rows, rowCount: Array.isArray(rows) ? rows.length : 0 } };
    }

    if (intent === 'createTable' && params.ddl) {
      const ddl = String(params.ddl).trim();
      if (!/^\s*CREATE\s+TABLE/i.test(ddl)) return { ok: false, error: 'DDL 必须以 CREATE TABLE 开头' };

      let databaseCreated = false;
      const targetDb = extractDatabaseFromCreateTable(ddl);
      if (targetDb) {
        const [dbRows] = await conn.query('SHOW DATABASES');
        const existing = (dbRows || []).map((r) => (r['Database'] || Object.values(r)[0])).filter(Boolean);
        if (!existing.includes(targetDb)) {
          await conn.query(`CREATE DATABASE ${esc(targetDb)}`);
          databaseCreated = true;
        }
      }

      await conn.query(ddl);
      return {
        ok: true,
        data: {
          message: databaseCreated ? `数据库已创建，表已创建` : `表已创建`,
          databaseCreated,
          ddl,
        },
      };
    }

    if (intent === 'executeSQL' && params.sql) {
      const sql = String(params.sql).trim();
      const forbidden = /\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i;
      if (forbidden.test(sql)) return { ok: false, error: '仅允许 SELECT / SHOW / DESCRIBE / CREATE / INSERT INTO ... SELECT 语句' };
      const [result] = await conn.query(sql);
      const isWrite = /^\s*(INSERT|REPLACE|DELETE|TRUNCATE)/i.test(sql);
      const affectedRows = result && typeof result.affectedRows === 'number' ? result.affectedRows : null;
      const insertId = result && (result.insertId !== undefined && result.insertId !== null) ? result.insertId : null;
      const executionSummary = isWrite
        ? { executed: true, affectedRows, insertId: insertId ?? undefined, message: `执行完成。影响行数: ${affectedRows ?? '-'}${insertId != null ? `，自增 ID: ${insertId}` : ''}` }
        : { executed: true, rowCount: Array.isArray(result) ? result.length : 0, message: `查询完成。返回行数: ${Array.isArray(result) ? result.length : 0}` };
      return {
        ok: true,
        data: {
          executionSummary,
          affectedRows: affectedRows ?? undefined,
          insertId: insertId ?? undefined,
          rows: Array.isArray(result) ? result.slice(0, 100) : undefined,
        },
      };
    }

    if (intent === 'analyzeNulls' && params.table) {
      const db = (params.database && safeIdentifier(params.database)) || (database && safeIdentifier(database));
      const tbl = safeIdentifier(params.table);
      if (!tbl) return { ok: false, error: '无效的表名' };
      const fullName = db ? `${esc(db)}.${esc(tbl)}` : esc(tbl);
      const [cols] = await conn.query(`DESCRIBE ${fullName}`);
      const colNames = cols.map((c) => c.Field);
      const [countRows] = await conn.query(`SELECT COUNT(*) AS total FROM ${fullName}`);
      const totalRows = countRows[0]?.total ?? 0;
      const nullChecks = colNames.map((c) => `SUM(CASE WHEN ${esc(c)} IS NULL THEN 1 ELSE 0 END) AS ${esc(c)}`).join(', ');
      const [nullRows] = await conn.query(`SELECT ${nullChecks} FROM ${fullName}`);
      const nullCounts = nullRows[0] || {};
      const analysis = colNames.map((c) => ({
        column: c,
        nullCount: Number(nullCounts[c] || 0),
        nullRate: totalRows > 0 ? ((Number(nullCounts[c] || 0) / totalRows) * 100).toFixed(2) + '%' : '0%',
      }));
      return { ok: true, data: { database: db || database, table: tbl, totalRows, columns: analysis } };
    }

    return { ok: false, error: '不支持的操作' };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    conn.destroy();
  }
}

async function extractDbIntentFromModel(conversation, LLM_API_KEY, LLM_CHAT_URL) {
  if (!LLM_API_KEY || !Array.isArray(conversation) || conversation.length === 0) return { intent: null, params: {} };
  const systemContent = `你是一个意图解析器。根据用户与助手的对话，判断用户**最后一条消息**是否需要对 MySQL 数据库执行操作。

**支持的 intent 与 params**：
1. listDatabases - 列出数据库/有多少库/有哪些库等。params: {}
2. listTables - 列出表/show tables/有哪些表/某库下的表等。params: { database?: "库名" }
3. createDatabase - **仅当用户明确确认创建数据库时**（如回复「确认」「执行」「可以」），且助手**上一轮**消息中明确提到要创建的数据库名（如「将创建数据库 xxx」「建库 xxx」）。params: { name: "从助手上一轮消息中提取的库名" }。若用户只是首次说「建库 xxx」而助手尚未回复确认提示，则 intent 填 null。
4. describeTable - 查看表结构/describe/schema/看看这张表长什么样/基于某表做加工/用某表。params: { database?: "库名", table: "表名" }
5. previewData - 看前几条数据/preview/select/看看数据/给我看10条/去源表看一下。params: { database?: "库名", table: "表名", limit?: 10 }
6. createTable - **仅当用户明确确认建表时**（如「确认」「好的」「执行」「可以」），且助手**上一轮**消息中包含 CREATE TABLE 语句。params: { ddl: "完整的 CREATE TABLE SQL（从助手上一轮消息中提取）" }。
7. executeSQL - 分两类：(A) **只读 SQL**（SELECT、DESCRIBE、SHOW）：用户说出或确认要执行即可，params: { sql: "完整 SQL" }。(B) **写操作**（INSERT INTO ... SELECT 等）：**仅当用户明确说「确认」「执行」且助手上一轮消息中包含该写操作 SQL 时**，从助手消息中提取完整 SQL 填入 params.sql；若助手刚展示 INSERT SQL 而用户尚未回复确认，则 intent 填 null。用户说「执行」且上一轮是建表 DDL → createTable；上一轮是 INSERT/DML → executeSQL。
8. analyzeNulls - 分析空值/异常值/数据质量/验证结果/检查这张表。params: { database?: "库名", table: "表名" }

**特殊场景**：
- 用户说「基于 xxx 表做加工」「用 xxx 表」「我要加工 xxx 表」→ describeTable，后端会同时返回 schema 和前10条数据。
- 用户**首次**说「建库 xxx」→ intent 为 null（助手应先回复「将创建数据库 xxx，请确认后说「确认」或「执行」」）；用户**随后**说「确认」「执行」且助手上一轮提到要建该库 → createDatabase。
- 用户说「确认」「好的」「执行」且助手上一轮消息中包含 CREATE TABLE 语句 → createTable，从助手消息中提取完整 DDL 填入 params.ddl。
- 用户**首次**描述字段映射或助手**刚展示** INSERT INTO ... SELECT 而用户尚未说「确认」「执行」→ intent 填 null；用户**随后**说「确认」「执行」且助手上一轮包含该 INSERT/DML → executeSQL，从助手消息中提取完整 SQL。
- 若用户说「去源表看一下」「看看源数据有没有」「检查基表数据」→ previewData。
- 若用户在描述目标表的字段/schema（如「目标表要有 user_id, name, amount 这些字段」），这属于对话设计讨论，intent 为 null。

**要求**：
- 用户表述千奇百怪，理解语义即可。
- 不符合以上任何一项则 intent 填 null。
- 只返回一个 JSON 对象，不要 markdown 代码块。格式：
{"intent":"xxx"|null,"params":{}}`;

  const messages = [
    { role: 'system', content: systemContent },
    ...conversation.slice(-8).map((t) => ({ role: t.role, content: t.content })),
  ];

  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, messages, stream: false, temperature: 0.1, max_tokens: 1024 }),
    });
    const text = await response.text();
    if (!response.ok) return { intent: null, params: {} };
    let data;
    try { data = JSON.parse(text); } catch (_) { return { intent: null, params: {} }; }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { intent: null, params: {} };
    const out = JSON.parse(jsonMatch[0]);
    const intent = VALID_INTENTS.includes(out.intent) ? out.intent : null;
    const params = out.params && typeof out.params === 'object' ? out.params : {};
    return { intent, params };
  } catch (e) {
    console.error('[extractDbIntentFromModel]', e.message);
    return { intent: null, params: {} };
  }
}

// ── Express ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const LLM_API_KEY = process.env.LLM_API_KEY || 'sk-8e7a35e7fa784756b2459cb228599ab9';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen3-max';
const LLM_CHAT_URL = `${LLM_BASE_URL}/chat/completions`;

app.get('/', (req, res) => {
  res.json({
    name: 'ETL API',
    message: '后端已运行',
    endpoints: {
      'POST /api/chat': 'ETL 六步对话',
      'POST /api/mapping': '字段映射',
      'POST /api/dml': '生成 DML',
      'GET /api/debug-llm': '测试 LLM',
    },
  });
});

// ────────── /api/chat — ETL 六步对话主入口 ──────────
app.post('/api/chat', async (req, res) => {
  if (!LLM_API_KEY) return res.status(503).json({ error: 'LLM_API_KEY not configured' });

  const { conversation, context } = req.body;
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid conversation' });
  }
  const connectionStringFromContext = context?.connectionString || null;
  const currentStepHint = Number(context?.currentStep) || 0;
  const selectedTables = Array.isArray(context?.selectedTables) ? context.selectedTables : [];
  const userMessages = conversation.filter((t) => t.role === 'user').map((t) => (t.content || '').trim());
  const lastUserContent = userMessages[userMessages.length - 1] || '';
  const lastConnectionStringInChat = [...userMessages].reverse().find(looksLikeConnectionString);
  const connectionString = connectionStringFromContext || lastConnectionStringInChat || null;

  // ── 连接测试 ──
  let connectionTestNote = '';
  let connectionTestOk = false;
  const shouldTestConnection =
    (lastUserContent && looksLikeConnectionString(lastUserContent)) ||
    (lastUserContent && /测试|试一下|验证|检查/.test(lastUserContent) && /连接|连接串|连通/.test(lastUserContent) && lastConnectionStringInChat);
  const connStrToTest = looksLikeConnectionString(lastUserContent) ? lastUserContent : lastConnectionStringInChat;
  if (shouldTestConnection && connStrToTest) {
    try {
      const testResult = await testConnection(connStrToTest);
      connectionTestOk = !!testResult.ok;
      connectionTestNote = testResult.ok
        ? '\n\n**【连接测试结果】** 连通性测试：**成功**。'
        : `\n\n**【连接测试结果】** 连通性测试：**失败**，原因：${testResult.message}`;
    } catch (e) {
      connectionTestNote = `\n\n**【连接测试结果】** 异常：${e.message || e}`;
    }
  }

  // ── 数据库操作 ──
  let dbOperationNote = '';
  const lastMessageIsOnlyConnectionString =
    lastUserContent && looksLikeConnectionString(lastUserContent) && lastUserContent.trim().length < 500;
  const dbIntent =
    connectionString && lastUserContent && !lastMessageIsOnlyConnectionString
      ? await extractDbIntentFromModel(conversation, LLM_API_KEY, LLM_CHAT_URL)
      : { intent: null, params: {} };

  if (connectionString && dbIntent.intent) {
    const esc = (n) => { const s = safeIdentifier(n); return s ? '`' + s + '`' : ''; };
    const db = safeIdentifier(dbIntent.params.database) || null;
    const tbl = safeIdentifier(dbIntent.params.table) || null;
    const fullTbl = tbl ? (db ? `${esc(db)}.${esc(tbl)}` : esc(tbl)) : '';

    // 解析 selectedTables 为 { db -> Set<table> } 映射
    const selectedDbTables = new Map();
    for (const st of selectedTables) {
      const dot = st.indexOf('.');
      if (dot > 0) {
        const sdb = st.slice(0, dot);
        const stbl = st.slice(dot + 1);
        if (!selectedDbTables.has(sdb)) selectedDbTables.set(sdb, new Set());
        selectedDbTables.get(sdb).add(stbl);
      }
    }
    const hasSelection = selectedDbTables.size > 0;

    if (dbIntent.intent === 'describeTable') {
      const schemaResult = await runDatabaseOperation(connectionString, 'describeTable', dbIntent.params);
      const previewResult = await runDatabaseOperation(connectionString, 'previewData', { ...dbIntent.params, limit: 10 });
      const parts = [];
      const sqlDescribe = `DESCRIBE ${fullTbl};`;
      const sqlPreview = `SELECT * FROM ${fullTbl} LIMIT 10;`;
      const returnCodes = [];
      if (schemaResult.ok) {
        const cols = schemaResult.data.columns || [];
        const tableSchema = rowsToMarkdownTable(cols, ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra']);
        returnCodes.push(`DESCRIBE 执行成功，返回列数: ${cols.length}`);
        parts.push(`**验证 SQL（表结构）**：\n\`\`\`sql\n${sqlDescribe}\n\`\`\`\n**实际返回（表结构）**：\n${tableSchema}`);
      } else {
        returnCodes.push(`DESCRIBE 执行失败: ${schemaResult.error}`);
        parts.push(`**表结构查询失败**：${schemaResult.error}`);
      }
      if (previewResult.ok) {
        const rows = previewResult.data.rows || [];
        const tablePreview = rowsToMarkdownTable(rows);
        returnCodes.push(`SELECT 执行成功，返回行数: ${rows.length}`);
        parts.push(`**验证 SQL（前10条数据）**：\n\`\`\`sql\n${sqlPreview}\n\`\`\`\n**实际返回（前10条数据）**：\n${tablePreview}`);
      } else {
        returnCodes.push(`SELECT 执行失败: ${previewResult.error}`);
        parts.push(`**数据预览失败**：${previewResult.error}`);
      }
      parts.push(`**SQL 返回码**：${returnCodes.join('；')}`);
      dbOperationNote = `\n\n**【数据库操作结果】** 已查询表结构和数据预览。你必须在回复中按顺序给出：(1) 验证 SQL（代码块）；(2) 实际返回的表格（用 markdown 表格，禁止 JSON）；(3) SQL 返回码。**表格内容必须与下方「实际返回」完全一致，不得编造或修改任何行列。**\n${parts.join('\n\n')}`;
    } else {
      const opResult = await runDatabaseOperation(connectionString, dbIntent.intent, dbIntent.params);
      if (opResult.ok) {
        const d = opResult.data;
        let sqlAndTable = '';
        if (dbIntent.intent === 'listDatabases') {
          // 如果有选中的表，只显示选中的库
          let databases = d.databases || [];
          if (hasSelection) {
            databases = databases.filter(item => selectedDbTables.has(item.database));
          }
          const sql = hasSelection ? 'SHOW DATABASES;（已按用户选择过滤）' : 'SHOW DATABASES;（并 SHOW TABLES FROM 各库统计表数）';
          const table = rowsToMarkdownTable(databases, ['database', 'tableCount']);
          const code = `执行成功，返回数据库数: ${databases.length}`;
          sqlAndTable = `**验证 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'listTables') {
          // 如果有选中的表，只显示选中的表
          let tables = d.tables || [];
          const queryDb = db || null;
          if (hasSelection && queryDb && selectedDbTables.has(queryDb)) {
            const allowedTables = selectedDbTables.get(queryDb);
            tables = tables.filter(t => allowedTables.has(t));
          } else if (hasSelection && !queryDb) {
            // 没指定库时，显示所有选中库的表
            tables = [];
          }
          const sql = db ? `SHOW TABLES FROM ${esc(db)};` : 'SHOW TABLES;';
          const rows = tables.map((t) => ({ '表名': t }));
          const table = rowsToMarkdownTable(rows, ['表名']);
          const code = `执行成功，返回表数量: ${(d.tables || []).length}`;
          sqlAndTable = `**验证 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'previewData') {
          const sql = `SELECT * FROM ${fullTbl} LIMIT ${Math.min(Number(dbIntent.params.limit) || 10, 50)};`;
          const table = rowsToMarkdownTable(d.rows || []);
          const code = `执行成功，返回行数: ${d.rowCount ?? (d.rows || []).length}`;
          sqlAndTable = `**验证 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'analyzeNulls') {
          const sql = `SELECT COUNT(*) AS total FROM ${fullTbl}; 以及各列空值统计的 SELECT SUM(CASE WHEN 列 IS NULL THEN 1 ELSE 0 END)... FROM ${fullTbl};`;
          const table = rowsToMarkdownTable(d.columns || [], ['column', 'nullCount', 'nullRate']);
          const code = `执行成功，总行数: ${d.totalRows ?? '-'}，统计列数: ${(d.columns || []).length}`;
          sqlAndTable = `**验证 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回（空值统计）**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'executeSQL' && d.rows != null && d.rows.length > 0) {
          const sql = String(dbIntent.params.sql || '').trim();
          const table = rowsToMarkdownTable(d.rows);
          const code = d.executionSummary?.message || `执行成功，返回行数: ${d.rows.length}`;
          sqlAndTable = `**执行的 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'executeSQL') {
          const sql = String(dbIntent.params.sql || '').trim();
          const code = d.executionSummary?.message || '执行完成。';
          sqlAndTable = `**执行的 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**SQL 返回码（你必须原样写进回复，不得只写「正在执行」而不写本行）**：${code}`;
        } else {
          sqlAndTable = `\n\`\`\`json\n${JSON.stringify(d, null, 2)}\n\`\`\``;
        }
        dbOperationNote = `\n\n**【数据库操作结果】** 执行「${dbIntent.intent}」**成功**。你必须在回复中按顺序给出：(1) 验证/执行的 SQL（代码块）；(2) 实际返回的**表格**（markdown 表格，禁止 JSON）；(3) SQL 返回码。**表格内容必须与下方「实际返回」完全一致，不得编造或修改任何行列。**\n${sqlAndTable}`;
      } else {
        const errMsg = opResult.error || '';
        const isColumnError = /column\s+['\`]?\w+['\`]?\s+does not exist|Unknown column|doesn't have column|invalid input.*column/i.test(errMsg);
        let schemaBlock = '';
        if (dbIntent.intent === 'executeSQL' && isColumnError && dbIntent.params.sql) {
          const tableRefs = extractTableRefsFromSql(dbIntent.params.sql);
          const schemaParts = [];
          for (const ref of tableRefs) {
            const desc = await runDatabaseOperation(connectionString, 'describeTable', { database: ref.database, table: ref.table });
            if (desc.ok && desc.data && desc.data.columns) {
              const fullName = ref.database ? `${ref.database}.${ref.table}` : ref.table;
              const tableSchema = rowsToMarkdownTable(desc.data.columns, ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra']);
              schemaParts.push(`**表 ${fullName} 的真实结构（已自动查询）**：\n${tableSchema}`);
            }
          }
          if (schemaParts.length > 0) {
            schemaBlock = `\n\n**【自我纠正】** 已根据失败 SQL 自动查询涉及表的结构（真实列名）。你**必须**在回复中：(1) 如实转述失败原因；(2) 根据下方真实列名写出**修正后的完整 SQL**（代码块）；(3) 明确提示用户「请再次执行上述 SQL」直至成功。不得只建议用户自己去 DESCRIBE，而要直接给出可执行的修正 SQL。\n\n${schemaParts.join('\n\n')}`;
          }
        }
        dbOperationNote = `\n\n**【数据库操作结果】** 执行「${dbIntent.intent}」**失败**。\n**失败原因（你必须原样或完整转述给用户，不得隐瞒、不得声称成功）**：\n${errMsg}\n\n请根据上述原因给出修改建议（如：SQL 语法、表名/库名、权限、列名不存在等），并请用户修正后重试。${schemaBlock}`;
      }
    }
  }

  const selectedTablesNote = selectedTables.length > 0
    ? `\n**【用户已选中的库表（必须严格遵守）】**：${selectedTables.join(', ')}\n用户在界面上勾选了以上库表，你**只能**使用这些库表进行操作和讨论。不要提及或建议用户使用未选中的库表。当用户说「看看有哪些表」「有哪些库」时，只展示选中范围内的库表。\n`
    : '';

  const systemPrompt = `你是智能数据 ETL 助手，帮助用户通过对话完成完整的 ETL 流程。
${selectedTablesNote}
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
- 若无法判断则保持上一轮 currentStep（前端上一轮传入的 currentStep 为 ${currentStepHint}，若为 0 则默认 1）。
当用户完成一步后，在回复末尾**自然提示下一步可做的操作**，但不要跳步。

**硬性约定（必须遵守）**：
- **一切会修改库表或数据的操作（DDL 与 DML）都必须先展示完整 SQL 并获用户明确确认后才能执行。** 包括：CREATE TABLE、CREATE DATABASE、INSERT INTO ... SELECT 等。你先展示 SQL 并提示「请确认后说「确认」或「执行」」，只有用户明确回复「确认」「执行」「可以」后才会真实执行。只读操作（如 SELECT、DESCRIBE、SHOW）可直接执行，无需确认。
- 所有 SQL、DDL、DML 必须**严格符合 MySQL 语法**（仅使用 MySQL 支持的类型、函数、写法）。
- 所有库/表操作均在**用户提供的连接上真实执行**，由后端连接用户库执行，不模拟、不造假。
- **凡涉及表数据验证、数据展示的回答**（如：表结构、前 N 条数据、空值分析、库表列表、任意 SELECT 结果），回复中**禁止出现 JSON**，必须严格按以下顺序且用**表格**展示数据：(1) **验证/执行的 SQL**（用 \`\`\`sql 代码块写出）；(2) **实际返回的表格**（用 markdown 表格，表头与数据行清晰对齐）；(3) **SQL 返回码**（如：执行成功，返回行数/列数/影响行数）。**表格内容必须严格根据【数据库操作结果】中给出的执行结果**：逐行逐列照实填写，不得自行编造、补全、推测或改写任何单元格；若某列为空则写空，不得虚构行列或数据。
- **SQL 执行失败时**：若上方【数据库操作结果】标明**失败**，你必须 (1) **如实、完整**地把失败原因输出给用户（不得隐瞒、不得改写为“成功”）；(2) **禁止**以任何方式声称“执行成功”“已完成”“已创建”等；(3) **自我纠正**：若失败原因为「列不存在」「Unknown column」等且上方已注入**涉及表的结构（已自动查询）**，你须**直接**在回复中给出根据真实列名修正后的**完整可执行 SQL**（代码块），并明确提示用户「请再次执行上述 SQL」，直至成功；不得只建议用户自己去查表或只贴 DESCRIBE 让用户执行。若为其他错误类型，给出修改建议并请用户修正后重试。
- 只有后端明确返回成功时，才可在回复中说“成功”；否则一律按失败处理并输出真实原因。
${connectionTestNote}
${dbOperationNote}

**各步骤引导说明**：

**第1步：连接数据库**
- 用户提供 MySQL 连接串（URL 如 mysql://user:pass@host:port/db 或命令行形式）。
- 若有【连接测试结果】且成功 → 回复「连接成功。」并**自然引导**进入第 2 步（如：「接下来请告诉我你想基于哪个库的哪张表做数据加工？」）。
- 若测连失败 → 如实说明错误信息，提示用户检查连接串或权限。
- 若本轮用户发送了连接串，必须设置 "connectionReceived": true。

**第2步：选择基表**
- 围绕「有哪些库」「某个库下有哪些表」「我要用哪张表」这类问题回答。
- 若有 describeTable 相关的【数据库操作结果】→ 必须先写出验证 SQL，再以**表格**形式展示表结构和前 10 条数据（禁止用 JSON）；分析只基于真实数据，不得编造。
- **只要本轮展示了某张基表的结构/数据，回复末尾必须明确引导下一步**，例如：「基表已确认。接下来请描述目标表要有哪些字段（字段名、类型、含义），或说明要放在哪个库，我来生成建表语句。」不得只展示表结构而不提示用户下一步该干啥。

**第3步：定义目标表**
- 用户描述目标表字段后 → 你根据描述生成 **标准 MySQL** 的 CREATE TABLE 语句（仅用 MySQL 支持的类型，字段带 COMMENT，库名/表名可用反引号），**仅展示给用户，并明确提示「请确认后再执行」或「确认后请回复「确认」或「执行」」**；不得在用户未确认时执行建表。
- 只有用户明确回复「确认建表」「确认」「执行」「可以」等后，后端才会真实执行建表，你如实反馈结果。
- 建表成功后，自然引导进入第 4 步（如：「目标表已创建，请描述每个字段的数据来源与加工逻辑。」）。

**第4步：字段映射**
- 围绕「目标字段如何从基表/维表中取数、怎么加工」来对话。
- **维表/基表字段必须用真实列名**：写 JOIN、SELECT 时只能使用**已查询过的表结构**中的列名；若某维表尚未查过结构，**不得臆造列名**，应先让用户查看表结构，再根据真实列名写 DML。
- 用户描述字段映射后 → 你生成 **标准 MySQL** 的 INSERT INTO 目标表 SELECT ... FROM 基表 的 DML（JOIN 写法，禁止子查询），**仅展示完整 SQL，并明确提示「请确认后说「确认」或「执行」」**；不得在用户未确认时执行。只有用户明确回复「确认」「执行」后，后端才会执行该 DML。
- 执行后必须写出 SQL + SQL 返回码（影响行数等）。若执行失败且上方已注入涉及表的真实结构，须**直接给出修正后的完整 SQL** 并提示再次执行，直至成功。
- 映射执行成功后，自然引导进入第 5 步（如：「数据已写入目标表，可以发送"开始验证"检查数据质量。」）。

**第5步：数据验证**
- 围绕「目标表数据是否正常」「哪些字段空值多」「是否有异常值」来回答。
- 若有表数据相关的【数据库操作结果】→ 必须先写出**验证 SQL**，再以**表格**形式展示实际返回，**禁止**用 JSON。
- 若发现异常，自然引导进入第 6 步（如：「发现 xxx 字段空值较多，可以说"追溯 xxx 字段"去源表排查原因。」）。

**第6步：异常溯源**
- 用户提到「去源表看看」「追溯某字段」「检查基表数据」时，查询并展示基表真实数据。
- 回复中必须写出**验证 SQL**并以**表格**展示实际查询结果，禁止 JSON、不得编造；对比目标表和基表的数据情况分析原因。

**通用回复规则**：
1. 用中文回复，简洁友好。**因无「下一步」按钮，你必须在对话中提示用户下一步该干啥**：根据当前步骤和对话理解，在回复中自然说明「接下来可以输入/做什么」（不写死话术，灵活提醒）。
2. **你执行的每一个 SQL 都必须在回复中给出返回结果**：SELECT 须有表格 + 返回行数；INSERT 等须明确写出**SQL 返回码**。**禁止**只写「正在执行」而不写执行结果。
3. 若有【数据库操作结果】且为**失败**，必须**如实输出失败原因**，并给出**自我纠正**建议。
4. 若本轮**没有【数据库操作结果】**，**不得声称**已执行任何数据库操作。
5. 若用户发送了 MySQL 连接串，设置 "connectionReceived": true。
6. **所有会修改库表或数据的操作（DDL、DML）**：建库、建表、INSERT INTO ... SELECT 等，都必须**先展示 SQL 并提示用户确认**，只有用户明确回复「确认」「执行」「可以」后才会真实执行。不得在用户未确认时执行任何写操作。

**输出格式**：只返回一个 JSON 对象，不要 markdown 代码块：
{"reply":"你的回复内容（可含 markdown 格式化）","connectionReceived":false,"currentStep":1}
**重要**：
- currentStep 必须填入你判断的当前步骤（1～6 的整数），前端会根据它更新进度条。
- reply 里涉及表数据时，必须是「SQL 代码块 + markdown 表格 + 返回码」三部分，禁止 JSON。**表格内容必须与【数据库操作结果】完全一致，不得编造。**`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversation.map((t) => ({ role: t.role, content: t.content })),
  ];

  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, messages, stream: false, temperature: 0.3, max_tokens: 4096 }),
    });
    const errBody = await response.text();
    if (!response.ok) {
      let errMsg = errBody || response.statusText;
      try { const j = JSON.parse(errBody); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(errBody); } catch (e) { return res.status(500).json({ error: 'LLM 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    let out = { reply: content, connectionReceived: false, currentStep: currentStepHint || 1 };
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.reply === 'string') out.reply = parsed.reply;
        if (parsed.connectionReceived) out.connectionReceived = true;
        if (parsed.currentStep >= 1 && parsed.currentStep <= 6) out.currentStep = parsed.currentStep;
      } catch (_) {}
    }
    return res.json({ ...out, connectionTestOk });
  } catch (e) {
    console.error('[LLM /api/chat]', e.message);
    return res.status(500).json({ error: e.message || 'LLM 请求失败' });
  }
});

// ────────── /api/mapping ──────────
function buildSystemPrompt(targetTableName, targetFields, existingMappings) {
  const mapped = existingMappings.filter(m => m.status !== 'unmapped');
  const fieldList = targetFields.map(f => `- ${f.name} (${f.type}) ${f.comment ? `— ${f.comment}` : ''}`).join('\n');

  return `你是一个数据 ETL 助手。用户正在为**目标表**的每个字段配置数据来源（库、表、字段或表达式）。

**目标表名**：${targetTableName}

**目标表字段列表**（name 为英文字段名，comment 为中文说明）：
${fieldList}

${mapped.length > 0 ? `**已映射的字段**：${mapped.map(m => m.targetField).join(', ')}` : ''}

**重要——一律用 JOIN 写法，禁止子查询；仅用 MySQL 语法**：
- sql 只能是「表别名.列名」或简单表达式（如 COALESCE、CAST、CONCAT 等 **MySQL 支持**的写法），**禁止**标量子查询。
- 用户用中文说字段时，对应到 comment 或 name 匹配的英文名。

**必须**返回合法 JSON，不要 markdown 代码块：
{
  "mappings": [
    {
      "targetField": "目标表字段英文名",
      "source": "库.表",
      "logic": "简短说明（含关联键）",
      "sql": "表别名.列名 或简单表达式"
    }
  ]
}

若无法对应到任何字段，返回 {"mappings":[]}`;
}

app.post('/api/mapping', async (req, res) => {
  if (!LLM_API_KEY) return res.status(503).json({ error: 'LLM_API_KEY not configured' });

  const { message, conversation, targetTableName, targetFields, existingMappings } = req.body;
  if (!message || !targetTableName || !Array.isArray(targetFields)) {
    return res.status(400).json({ error: 'Missing message, targetTableName or targetFields' });
  }

  const systemPrompt = buildSystemPrompt(targetTableName, targetFields, Array.isArray(existingMappings) ? existingMappings : []);
  let chatMessages;
  if (Array.isArray(conversation) && conversation.length > 0) {
    const normalized = conversation
      .map((t) => ({ role: t.role, content: String(t.content || '').trim() }))
      .filter((t) => t.content.length > 0);
    while (normalized.length > 0 && normalized[0].role === 'assistant') normalized.shift();
    chatMessages = normalized.length === 0
      ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }]
      : [{ role: 'system', content: systemPrompt }, ...normalized];
  } else {
    chatMessages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }];
  }

  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, messages: chatMessages, stream: false, temperature: 0.2, max_tokens: 4096 }),
    });
    const errBody = await response.text();
    if (!response.ok) {
      let errMsg = errBody || response.statusText;
      try { const j = JSON.parse(errBody); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(errBody); } catch (e) { return res.status(500).json({ error: 'LLM 返回格式异常' }); }
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    let parsed = { mappings: [] };
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {} }
    if (!Array.isArray(parsed.mappings)) parsed.mappings = [];
    return res.json(parsed);
  } catch (e) {
    console.error('[LLM /api/mapping]', e.message);
    return res.status(500).json({ error: e.message || 'LLM 请求失败' });
  }
});

// ────────── /api/dml ──────────
app.post('/api/dml', async (req, res) => {
  if (!LLM_API_KEY) return res.status(503).json({ error: 'LLM_API_KEY not configured' });

  const { targetTableFullName, mappings } = req.body;
  if (!targetTableFullName || !Array.isArray(mappings) || mappings.length === 0) {
    return res.status(400).json({ error: 'Missing targetTableFullName or mappings' });
  }

  const mappingList = mappings
    .map((m) => ({ targetField: m.targetField, source: m.source || '', logic: m.logic || '', sql: m.sql || m.targetField }))
    .filter((m) => m.targetField && m.sql);

  const systemPrompt = `你是 MySQL SQL 专家。生成**标准 MySQL 语法**的 DML：仅使用 MySQL 支持的类型与函数，表名/列名可用反引号。用多表 JOIN，禁止标量子查询。

**目标表**：${targetTableFullName}

**字段映射**：
${mappingList.map((m) => `- ${m.targetField}: source=${m.source}, logic=${m.logic}, sql=${m.sql}`).join('\n')}

**输出**：1) TRUNCATE TABLE 目标表; 2) INSERT INTO 目标表 (列...) SELECT ... FROM 主表 LEFT JOIN ... 只输出 MySQL 可执行的 SQL，无 markdown。`;

  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请用 JOIN 写法生成 DML。' },
        ],
        stream: false, temperature: 0.1, max_tokens: 4096,
      }),
    });
    const errBody = await response.text();
    if (!response.ok) {
      let errMsg = errBody || response.statusText;
      try { const j = JSON.parse(errBody); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(errBody); } catch (e) { return res.status(500).json({ error: 'LLM 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const dml = content.replace(/^```\w*\n?|```\s*$/g, '').trim();
    return res.json({ dml: dml || content });
  } catch (e) {
    console.error('[LLM /api/dml]', e.message);
    return res.status(500).json({ error: e.message || 'LLM 请求失败' });
  }
});

// ────────── /api/dml/optimize ──────────
app.post('/api/dml/optimize', async (req, res) => {
  if (!LLM_API_KEY) return res.status(503).json({ error: 'LLM_API_KEY not configured' });
  const { dml } = req.body;
  if (!dml || typeof dml !== 'string') return res.status(400).json({ error: 'Missing dml' });

  const systemPrompt = `你是 MySQL SQL 优化专家。将标量子查询改为 JOIN，保持语义不变。输出必须为**标准 MySQL 语法**、可直接在 MySQL 中执行。只输出优化后的完整 SQL，不要 markdown 或解释。`;
  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请优化：\n\n${dml}` },
        ],
        stream: false, temperature: 0.1, max_tokens: 4096,
      }),
    });
    const errBody = await response.text();
    if (!response.ok) {
      let errMsg = errBody || response.statusText;
      try { const j = JSON.parse(errBody); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(errBody); } catch (e) { return res.status(500).json({ error: 'LLM 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    return res.json({ dml: content.replace(/^```\w*\n?|```\s*$/g, '').trim() || content });
  } catch (e) {
    console.error('[LLM /api/dml/optimize]', e.message);
    return res.status(500).json({ error: e.message || 'LLM 请求失败' });
  }
});

// ────────── /api/debug-llm ──────────
app.get('/api/debug-llm', async (req, res) => {
  const hasKey = !!LLM_API_KEY;
  if (!hasKey) return res.json({ ok: false, reason: 'LLM_API_KEY 未设置' });
  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Say hello in one word.' }],
        stream: false,
      }),
    });
    const bodyText = await response.text();
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch (_) {}
    if (!response.ok) return res.json({ ok: false, status: response.status, body: bodyJson || bodyText });
    return res.json({ ok: true, reply: bodyJson?.choices?.[0]?.message?.content || bodyText?.slice(0, 200) });
  } catch (e) {
    return res.json({ ok: false, error: e.message, code: e.code });
  }
});

const PORT = process.env.PORT || 3001;

// ────────── /api/tables — 列出连接中所有库的所有表 ──────────
app.post('/api/tables', async (req, res) => {
  const { connectionString } = req.body;
  if (!connectionString) return res.status(400).json({ error: 'Missing connectionString' });

  try {
    const dbResult = await runDatabaseOperation(connectionString, 'listDatabases', {});
    if (!dbResult.ok) return res.status(400).json({ error: dbResult.error });

    const systemDbs = new Set(['information_schema', 'mysql', 'performance_schema', 'sys', 'mo_catalog', 'system', 'system_metrics']);
    const databases = (dbResult.data.databases || [])
      .filter(d => !systemDbs.has(d.database.toLowerCase()))
      .map(d => d.database);

    const tree = [];
    for (const db of databases) {
      const tblResult = await runDatabaseOperation(connectionString, 'listTables', { database: db });
      if (tblResult.ok) {
        tree.push({ database: db, tables: tblResult.data.tables || [] });
      }
    }
    return res.json({ databases: tree });
  } catch (e) {
    return res.status(500).json({ error: e.message || '获取表列表失败' });
  }
});

// ────────── /api/metric/match — 根据描述匹配已有指标 ──────────
app.post('/api/metric/match', async (req, res) => {
  if (!LLM_API_KEY) return res.status(503).json({ error: 'LLM_API_KEY not configured' });

  const { description, metricDefs } = req.body;
  if (!description || !Array.isArray(metricDefs) || metricDefs.length === 0) {
    return res.status(400).json({ error: 'Missing description or metricDefs' });
  }

  const defsContext = metricDefs.map((md, i) =>
    `${i + 1}. ${md.name}: ${md.definition}（聚合: ${md.aggregation}，度量字段: ${md.measureField}，涉及表: ${(md.tables || []).join(', ')}）`
  ).join('\n');

  const systemPrompt = `你是一个数据分析专家。用户描述了想要统计的数据，你需要从已有的指标定义中找出最匹配的指标。

**已有指标定义**：
${defsContext}

**用户描述**：${description}

请分析用户的需求，从已有指标中选出相关的指标（可以是一个或多个）。
对每个匹配的指标，说明匹配原因。

只返回 JSON，不要 markdown 代码块：
{"matches":[{"name":"指标名称","reason":"匹配原因"}],"suggestion":"对用户需求的理解和建议"}`;

  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: description },
        ],
        stream: false, temperature: 0.2, max_tokens: 1024,
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      let errMsg = bodyText || response.statusText;
      try { const j = JSON.parse(bodyText); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(bodyText); } catch (e) { return res.status(500).json({ error: 'LLM 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: '模型未返回有效 JSON' });
    const parsed = JSON.parse(jsonMatch[0]);
    return res.json({
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      suggestion: parsed.suggestion || '',
    });
  } catch (e) {
    console.error('[/api/metric/match]', e.message);
    return res.status(500).json({ error: e.message || '匹配失败' });
  }
});

// ────────── /api/metric/generate — 根据指标定义 + 维度描述生成 SQL ──────────
app.post('/api/metric/generate', async (req, res) => {
  if (!LLM_API_KEY) return res.status(503).json({ error: 'LLM_API_KEY not configured' });

  const { metricName, definition, description, metricDefs, connectionString } = req.body;
  if (!metricName || !description) {
    return res.status(400).json({ error: 'Missing metricName or description' });
  }

  // 从 metricDefs 收集涉及的表
  const allTables = new Set();
  if (Array.isArray(metricDefs)) {
    for (const md of metricDefs) {
      if (Array.isArray(md.tables)) md.tables.forEach(t => allTables.add(t));
    }
  }

  // 获取所有涉及表的结构
  let schemaInfo = '';
  if (connectionString) {
    for (const tbl of allTables) {
      const parts = tbl.split('.');
      const params = parts.length === 2 ? { database: parts[0], table: parts[1] } : { table: parts[0] };
      const result = await runDatabaseOperation(connectionString, 'describeTable', params);
      if (result.ok) {
        const cols = result.data.columns || [];
        const colList = cols.map(c => `  ${c.Field} ${c.Type}${c.Key === 'PRI' ? ' PRIMARY KEY' : ''}${c.Comment ? ` -- ${c.Comment}` : ''}`).join('\n');
        schemaInfo += `\n表 ${tbl}:\n${colList}\n`;
      }
    }
  }

  // 构建指标定义上下文
  const metricDefsContext = Array.isArray(metricDefs) && metricDefs.length > 0
    ? metricDefs.map(md => `- ${md.name}: ${md.definition}（聚合: ${md.aggregation}，度量字段: ${md.measureField}，涉及表: ${(md.tables || []).join(', ')}）`).join('\n')
    : '（无指标定义）';

  const systemPrompt = `你是一个数据分析 SQL 专家。用户要基于已定义的指标创建一个监控数据查询。

**已定义的指标**：
${metricDefsContext}

**用户的监控数据需求**：
- 名称：${metricName}
- 描述：${description}

你需要：
1. 根据用户描述，理解他想要的维度和筛选条件
2. 结合已定义的指标（聚合方式 + 度量字段），生成带维度的查询 SQL
3. 推荐最佳的可视化类型

**SQL 语法要求（必须严格遵守）**：
- 兼容 MySQL 5.7+ 语法
- **所有中文别名必须用反引号包裹**
- 库名.表名 格式引用表

**可用表结构**：
${schemaInfo || '（未提供表结构，请根据指标定义合理推断）'}

**可视化类型选择规则**：
- number: 结果是单个数值（如总数、平均值、求和）
- bar: 结果是分类对比（如按类目/地区/状态分组的数值）
- line: 结果是时间序列趋势（如按日/月的变化）
- pie: 结果是占比分布（如各类目占比，分组数 ≤ 8）
- table: 结果是多列明细或复杂结构

只返回 JSON，不要 markdown 代码块：
{"sql":"SELECT ...","chartType":"number|bar|line|pie|table","explanation":"简要说明查询逻辑","derivedMetricDef":{"name":"...","definition":"...","tables":[...],"aggregation":"...","measureField":"..."}}

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
- 窗口函数 LAG/LEAD 可能不被支持，改用子查询或自连接。`;

  // ── 生成 SQL 并验证，最多重试 3 次 ──
  const MAX_RETRIES = 3;
  let lastSql = '';
  let lastChartType = 'table';
  let lastExplanation = '';
  let lastDerivedMetricDef = null;
  let lastError = null;
  let chatMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请为监控数据「${metricName}」生成查询 SQL。需求描述：${description}` },
  ];

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const response = await fetch(LLM_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: chatMessages,
          stream: false, temperature: 0.2, max_tokens: 2048,
        }),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        let errMsg = bodyText || response.statusText;
        try { const j = JSON.parse(bodyText); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
        return res.status(response.status).json({ error: errMsg });
      }
      let data;
      try { data = JSON.parse(bodyText); } catch (e) { return res.status(500).json({ error: 'LLM 返回格式异常' }); }
      const content = (data.choices?.[0]?.message?.content || '').trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        if (attempt < MAX_RETRIES - 1) {
          chatMessages.push({ role: 'assistant', content });
          chatMessages.push({ role: 'user', content: '请返回有效的 JSON 格式，包含 sql、chartType、explanation 字段。' });
          continue;
        }
        return res.status(500).json({ error: '模型未返回有效 JSON' });
      }

      let parsed;
      try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {
        if (attempt < MAX_RETRIES - 1) {
          chatMessages.push({ role: 'assistant', content });
          chatMessages.push({ role: 'user', content: 'JSON 解析失败，请返回合法的 JSON。' });
          continue;
        }
        return res.status(500).json({ error: 'JSON 解析失败' });
      }

      lastSql = parsed.sql || '';
      lastChartType = parsed.chartType || 'table';
      lastExplanation = parsed.explanation || '';
      lastDerivedMetricDef = parsed.derivedMetricDef || null;

      // 验证 SQL：尝试执行，如果报错则让模型修正
      if (lastSql && connectionString) {
        try {
          const validateResult = await runDatabaseOperation(connectionString, 'executeSQL', { sql: lastSql });
          if (!validateResult.ok) {
            lastError = validateResult.error || '执行失败';
            if (attempt < MAX_RETRIES - 1) {
              chatMessages.push({ role: 'assistant', content });
              chatMessages.push({ role: 'user', content: `上面生成的 SQL 执行报错：${lastError}\n\n请修正 SQL 后重新返回 JSON。注意：\n1. 不要使用 QUARTER()、STR_TO_DATE()、WEEK() 等可能不被支持的函数\n2. 季度用 CEIL(月份/3) 计算\n3. 避免窗口函数 LAG/LEAD，改用子查询或自连接\n4. 确保所有列名和表名正确` });
              continue;
            }
            // 最后一次仍然失败，返回 SQL 和错误信息让用户手动修改
          } else {
            lastError = null;
            break; // SQL 验证通过
          }
        } catch (e) {
          // 验证过程异常，不阻塞，返回 SQL 让用户决定
          break;
        }
      } else {
        break; // 没有连接串，无法验证
      }
    }

    // 模型返回的派生指标
    let derivedMetricDef = lastDerivedMetricDef;
    const parsed = { sql: lastSql, derivedMetricDef: lastDerivedMetricDef };

    // 如果模型没返回，服务端自动检测是否应该建议派生指标
    if (!derivedMetricDef) {
      const nameAndDesc = `${metricName || ''} ${description || ''}`.toLowerCase();
      const sqlStr = (parsed.sql || '').toLowerCase();
      const existingNames = new Set((Array.isArray(metricDefs) ? metricDefs : []).map(d => d.name));

      // 检测比率/比值类
      const ratioPatterns = [
        { pattern: /毛利率|利润率|净利率/, name: () => nameAndDesc.match(/([\u4e00-\u9fa5]*毛利率|[\u4e00-\u9fa5]*利润率|[\u4e00-\u9fa5]*净利率)/)?.[1] || '毛利率', def: '利润与收入的比值百分比' },
        { pattern: /转化率|转换率/, name: () => '转化率', def: '转化数量与总数量的比值' },
        { pattern: /占比|比例|比重/, name: () => nameAndDesc.match(/([\u4e00-\u9fa5]*占比|[\u4e00-\u9fa5]*比例)/)?.[1] || '占比', def: '部分与整体的比值' },
        { pattern: /客单价|均价|平均价/, name: () => '客单价', def: '总金额除以总订单数' },
        { pattern: /同比|环比|增长率|变化率/, name: () => nameAndDesc.match(/([\u4e00-\u9fa5]*同比[\u4e00-\u9fa5]*|[\u4e00-\u9fa5]*环比[\u4e00-\u9fa5]*|[\u4e00-\u9fa5]*增长率)/)?.[1] || '增长率', def: '与上期相比的变化百分比' },
        { pattern: /完成率|达成率/, name: () => '完成率', def: '实际值与目标值的比值' },
      ];

      // 也检测 SQL 中的除法运算（比率的标志）
      const hasDivision = /\/\s*(?:SUM|COUNT|AVG|MAX|MIN)\s*\(/i.test(sqlStr) || /SUM\s*\([^)]+\)\s*\/\s*SUM/i.test(sqlStr);

      for (const rp of ratioPatterns) {
        if (rp.pattern.test(nameAndDesc)) {
          const derivedName = rp.name();
          if (!existingNames.has(derivedName)) {
            // 从已有 metricDefs 中提取涉及的表
            const tables = [...new Set((Array.isArray(metricDefs) ? metricDefs : []).flatMap(d => d.tables || []))];
            // 从 SQL 中提取可能的度量字段
            const fieldMatch = (parsed.sql || '').match(/SUM\s*\(\s*(\w+)\s*\)/i);
            const measureField = fieldMatch ? fieldMatch[1] : (Array.isArray(metricDefs) && metricDefs[0]?.measureField) || '';
            derivedMetricDef = {
              name: derivedName,
              definition: rp.def,
              tables: tables,
              aggregation: '自定义',
              measureField: measureField,
            };
            break;
          }
        }
      }

      // 如果名称没匹配到但 SQL 有除法运算，也建议
      if (!derivedMetricDef && hasDivision) {
        const cleanName = (metricName || '').replace(/近半年|最近|每月|月度|年度|趋势|统计/g, '').trim();
        if (cleanName && !existingNames.has(cleanName)) {
          const tables = [...new Set((Array.isArray(metricDefs) ? metricDefs : []).flatMap(d => d.tables || []))];
          const fieldMatch = (parsed.sql || '').match(/SUM\s*\(\s*(\w+)\s*\)/i);
          derivedMetricDef = {
            name: cleanName,
            definition: `${description || cleanName}（派生计算指标）`,
            tables: tables,
            aggregation: '自定义',
            measureField: fieldMatch ? fieldMatch[1] : '',
          };
        }
      }
    }

    return res.json({
      sql: lastSql,
      chartType: ['number', 'bar', 'line', 'pie', 'table'].includes(lastChartType) ? lastChartType : 'table',
      explanation: lastExplanation + (lastError ? `\n\n⚠️ SQL 验证失败（已尝试 ${MAX_RETRIES} 次自动修正）：${lastError}` : ''),
      derivedMetricDef,
    });
  } catch (e) {
    console.error('[/api/metric/generate]', e.message);
    return res.status(500).json({ error: e.message || '生成失败' });
  }
});

// ────────── /api/metric/query — 执行指标 SQL 并返回数据 ──────────
app.post('/api/metric/query', async (req, res) => {
  const { sql, connectionString } = req.body;
  if (!sql || !connectionString) {
    return res.status(400).json({ error: 'Missing sql or connectionString' });
  }

  const forbidden = /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|CREATE|ALTER)\b/i;
  if (forbidden.test(sql)) {
    return res.status(400).json({ error: '指标查询仅允许 SELECT 语句' });
  }

  try {
    const result = await runDatabaseOperation(connectionString, 'executeSQL', { sql });
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    return res.json({ rows: result.data.rows || [], rowCount: result.data.executionSummary?.rowCount || 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message || '查询失败' });
  }
});

// ────────── /api/lineage — 解析 SQL 返回数据血缘 ──────────
app.post('/api/lineage', async (req, res) => {
  if (!LLM_API_KEY) return res.status(503).json({ error: 'LLM_API_KEY not configured' });

  const { sql, connectionString, targetTable } = req.body;
  if (!sql) return res.status(400).json({ error: 'Missing sql' });

  // 获取涉及表的结构
  let schemaInfo = '';
  if (connectionString) {
    const tableRefs = extractTableRefsFromSql(sql);
    for (const ref of tableRefs) {
      const result = await runDatabaseOperation(connectionString, 'describeTable', { database: ref.database, table: ref.table });
      if (result.ok) {
        const cols = result.data.columns || [];
        const fullName = ref.database ? `${ref.database}.${ref.table}` : ref.table;
        const colList = cols.map(c => `  ${c.Field} ${c.Type}${c.Comment ? ` -- ${c.Comment}` : ''}`).join('\n');
        schemaInfo += `\n表 ${fullName}:\n${colList}\n`;
      }
    }
  }

  const systemPrompt = `你是一个 SQL 血缘分析专家。分析以下 INSERT INTO ... SELECT SQL，提取完整的数据血缘关系。

**SQL**:
\`\`\`sql
${sql}
\`\`\`

**涉及表的结构**:
${schemaInfo || '（未提供）'}

**目标表**: ${targetTable || '从 SQL 中提取'}

请分析并返回 JSON（不要 markdown 代码块），格式如下：
{
  "targetTable": "库名.表名",
  "sourceTables": [
    {
      "name": "库名.表名",
      "alias": "SQL中的别名（如有）",
      "role": "基表|维表|关联表",
      "joinType": "LEFT JOIN|INNER JOIN|无（主表）",
      "joinCondition": "ON 条件（如有）"
    }
  ],
  "fieldMappings": [
    {
      "targetField": "目标字段名",
      "sourceTable": "来源表全名（库名.表名）",
      "sourceField": "来源字段名",
      "transform": "加工逻辑描述，如：直接映射、SUM聚合、COUNT计数、CASE WHEN条件转换、LEFT JOIN关联取值、COALESCE空值处理 等",
      "expression": "原始SQL表达式片段"
    }
  ],
  "joinRelations": [
    {
      "leftTable": "库名.表名",
      "rightTable": "库名.表名",
      "joinType": "LEFT JOIN|INNER JOIN",
      "condition": "ON 条件"
    }
  ],
  "groupBy": "GROUP BY 字段列表（如有）",
  "filters": "WHERE 条件（如有）"
}

**要求**：
- 每个目标字段都必须追溯到具体的来源表和来源字段
- 如果一个目标字段涉及多个来源表/字段（如 JOIN 后取值），列出主要来源
- transform 要用中文描述清楚加工逻辑
- 维表（通过 JOIN 关联的查找表）的 role 标记为"维表"
- 主要数据来源表的 role 标记为"基表"
- sourceTables 必须包含 SQL 中 FROM 和所有 JOIN 涉及的表`;

  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请分析这条 SQL 的数据血缘关系。' },
        ],
        stream: false, temperature: 0.1, max_tokens: 4096,
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      let errMsg = bodyText || response.statusText;
      try { const j = JSON.parse(bodyText); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(bodyText); } catch (e) { return res.status(500).json({ error: 'LLM 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: '模型未返回有效 JSON' });
    const parsed = JSON.parse(jsonMatch[0]);
    return res.json(parsed);
  } catch (e) {
    console.error('[/api/lineage]', e.message);
    return res.status(500).json({ error: e.message || '血缘分析失败' });
  }
});

// ────────── /api/metric-lineage — 指标全链路血缘 ──────────
app.post('/api/metric-lineage', async (req, res) => {
  if (!LLM_API_KEY) return res.status(503).json({ error: 'LLM_API_KEY not configured' });

  const { metricDef, processedTables, connectionString } = req.body;
  if (!metricDef) return res.status(400).json({ error: 'Missing metricDef' });

  // 收集所有相关的加工 SQL
  const relevantTables = (metricDef.tables || []);
  const allProcessed = (processedTables || []);
  // 直接匹配指标涉及的表
  const directMatch = allProcessed.filter(pt =>
    relevantTables.some(t => t === `${pt.database}.${pt.table}`)
  );
  // 如果直接匹配为空，使用所有传入的加工表（前端已按 dashboard 过滤）
  const relevantProcessed = directMatch.length > 0 ? directMatch : allProcessed;

  // 获取表结构
  let schemaInfo = '';
  if (connectionString) {
    const allTbls = new Set(relevantTables);
    for (const pt of relevantProcessed) {
      (pt.sourceTables || []).forEach(s => allTbls.add(s));
    }
    for (const tbl of allTbls) {
      const parts = tbl.split('.');
      if (parts.length === 2) {
        const result = await runDatabaseOperation(connectionString, 'describeTable', { database: parts[0], table: parts[1] });
        if (result.ok) {
          const cols = (result.data.columns || []).map(c => `  ${c.Field} ${c.Type}${c.Comment ? ` -- ${c.Comment}` : ''}`).join('\n');
          schemaInfo += `\n表 ${tbl}:\n${cols}\n`;
        }
      }
    }
  }

  // 收集加工 SQL 和字段映射信息
  const etlInfo = relevantProcessed.map(pt => {
    const mappingInfo = Array.isArray(pt.fieldMappings) && pt.fieldMappings.length > 0
      ? `  字段映射:\n${pt.fieldMappings.map(fm =>
          `    ${fm.targetField} ← ${fm.sourceTable}.${fm.sourceExpr} (${fm.transform})`
        ).join('\n')}`
      : '';
    return `加工表 ${pt.database}.${pt.table}:\n  来源表: ${(pt.sourceTables || []).join(', ')}${mappingInfo ? '\n' + mappingInfo : ''}\n  加工SQL: ${pt.insertSql || '无'}`;
  }).join('\n\n');

  const systemPrompt = `你是一个数据血缘分析专家。请分析指标的全链路血缘，从最底层的基表/维表到加工后的业务表，再到指标本身。

**指标信息**：
- 名称：${metricDef.name}
- 定义：${metricDef.definition}
- 聚合方式：${metricDef.aggregation}
- 度量字段：${metricDef.measureField}
- 涉及表：${relevantTables.join(', ')}

**ETL 加工信息（这是真实的加工记录，必须严格依据此信息确定基表和维表）**：
${etlInfo || '（无加工信息）'}

**重要规则**：
- source 层的基表/维表**必须**来自上方 ETL 加工信息中的「来源表」和「字段映射」，不得自行编造。
- 如果 ETL 加工信息中有字段映射，基表是提供主要数据的来源表，维表是通过 JOIN 关联的查找表。
- 如果 ETL 加工信息中有加工 SQL（INSERT INTO ... SELECT ... FROM ... JOIN ...），从 SQL 中的 FROM 确定基表，从 JOIN 确定维表。
- 如果没有 ETL 加工信息，则指标涉及的表本身就是基表，不要编造不存在的表。

**表结构**：
${schemaInfo || '（未提供）'}

请分析并返回该指标的全链路血缘，**只包含与该指标相关的字段**。

返回 JSON（不要 markdown 代码块）：
{
  "layers": [
    {
      "level": "source",
      "label": "基表/维表",
      "tables": [
        {
          "name": "db.table",
          "role": "基表|维表",
          "fields": ["只列出与指标相关的字段"]
        }
      ]
    },
    {
      "level": "processed",
      "label": "加工业务表",
      "tables": [
        {
          "name": "db.table",
          "role": "业务表",
          "fields": ["只列出与指标相关的字段"]
        }
      ]
    },
    {
      "level": "metric",
      "label": "指标",
      "tables": [
        {
          "name": "${metricDef.name}",
          "role": "指标",
          "fields": ["${metricDef.aggregation}(${metricDef.measureField})"]
        }
      ]
    }
  ],
  "edges": [
    {
      "from": {"table": "源表名", "field": "源字段"},
      "to": {"table": "目标表名", "field": "目标字段"},
      "transform": "加工逻辑（如直接映射、SUM、JOIN等）"
    }
  ],
  "summary": "一句话总结该指标的数据流转路径"
}`;

  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请分析指标「${metricDef.name}」的全链路血缘` },
        ],
        stream: false, temperature: 0.1, max_tokens: 4096,
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      let errMsg = bodyText || response.statusText;
      try { const j = JSON.parse(bodyText); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(bodyText); } catch (e) { return res.status(500).json({ error: 'LLM 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: '模型未返回有效 JSON' });
    const parsed = JSON.parse(jsonMatch[0]);
    return res.json(parsed);
  } catch (e) {
    console.error('[/api/metric-lineage]', e.message);
    return res.status(500).json({ error: e.message || '指标血缘分析失败' });
  }
});

// ────────── /api/metric-chat — 指标定义对话 ──────────
app.post('/api/metric-chat', async (req, res) => {
  if (!LLM_API_KEY) return res.status(503).json({ error: 'LLM_API_KEY not configured' });

  const { conversation, connectionString, selectedTables } = req.body;
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return res.status(400).json({ error: 'Missing conversation' });
  }
  const selected = Array.isArray(selectedTables) ? selectedTables : [];

  // ── 数据库操作（与 ETL chat 完全一致的能力） ──
  let dbOperationNote = '';
  if (connectionString) {
    const dbIntent = await extractDbIntentFromModel(conversation, LLM_API_KEY, LLM_CHAT_URL);

    if (dbIntent.intent) {
      const esc = (n) => { const s = safeIdentifier(n); return s ? '`' + s + '`' : ''; };
      const db = safeIdentifier(dbIntent.params.database) || null;
      const tbl = safeIdentifier(dbIntent.params.table) || null;
      const fullTbl = tbl ? (db ? `${esc(db)}.${esc(tbl)}` : esc(tbl)) : '';

      if (dbIntent.intent === 'describeTable') {
        const schemaResult = await runDatabaseOperation(connectionString, 'describeTable', dbIntent.params);
        const previewResult = await runDatabaseOperation(connectionString, 'previewData', { ...dbIntent.params, limit: 10 });
        const parts = [];
        const returnCodes = [];
        if (schemaResult.ok) {
          const cols = schemaResult.data.columns || [];
          const tableSchema = rowsToMarkdownTable(cols, ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra']);
          returnCodes.push(`DESCRIBE 执行成功，返回列数: ${cols.length}`);
          parts.push(`**表结构**：\n${tableSchema}`);
        } else {
          returnCodes.push(`DESCRIBE 执行失败: ${schemaResult.error}`);
          parts.push(`**表结构查询失败**：${schemaResult.error}`);
        }
        if (previewResult.ok) {
          const rows = previewResult.data.rows || [];
          const tablePreview = rowsToMarkdownTable(rows);
          returnCodes.push(`SELECT 执行成功，返回行数: ${rows.length}`);
          parts.push(`**前10条数据**：\n${tablePreview}`);
        }
        parts.push(`**SQL 返回码**：${returnCodes.join('；')}`);
        dbOperationNote = `\n\n**【数据库操作结果】** 已查询表结构和数据预览。你必须在回复中以 markdown 表格展示，不得编造数据。\n${parts.join('\n\n')}`;
      } else {
        const opResult = await runDatabaseOperation(connectionString, dbIntent.intent, dbIntent.params);
        if (opResult.ok) {
          const d = opResult.data;
          let sqlAndTable = '';
          if (dbIntent.intent === 'listDatabases') {
            let databases = d.databases || [];
            // 如果有选中的表，过滤
            if (selected.length > 0) {
              const selectedDbs = new Set(selected.map(s => s.split('.')[0]));
              databases = databases.filter(item => selectedDbs.has(item.database));
            }
            const table = rowsToMarkdownTable(databases, ['database', 'tableCount']);
            sqlAndTable = `**实际返回**：\n${table}\n返回数据库数: ${databases.length}`;
          } else if (dbIntent.intent === 'listTables') {
            let tables = d.tables || [];
            if (selected.length > 0 && db) {
              const allowedTables = new Set(selected.filter(s => s.startsWith(db + '.')).map(s => s.split('.')[1]));
              if (allowedTables.size > 0) tables = tables.filter(t => allowedTables.has(t));
            }
            const rows = tables.map((t) => ({ '表名': t }));
            const table = rowsToMarkdownTable(rows, ['表名']);
            sqlAndTable = `**实际返回**：\n${table}\n返回表数量: ${tables.length}`;
          } else if (dbIntent.intent === 'previewData') {
            const table = rowsToMarkdownTable(d.rows || []);
            sqlAndTable = `**实际返回**：\n${table}\n返回行数: ${d.rowCount ?? (d.rows || []).length}`;
          } else if (dbIntent.intent === 'analyzeNulls') {
            const table = rowsToMarkdownTable(d.columns || [], ['column', 'nullCount', 'nullRate']);
            sqlAndTable = `**实际返回（空值统计）**：\n${table}\n总行数: ${d.totalRows ?? '-'}`;
          } else if (dbIntent.intent === 'executeSQL' && d.rows != null && d.rows.length > 0) {
            const sql = String(dbIntent.params.sql || '').trim();
            const table = rowsToMarkdownTable(d.rows);
            const code = d.executionSummary?.message || `执行成功，返回行数: ${d.rows.length}`;
            sqlAndTable = `**执行的 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回**：\n${table}\n**SQL 返回码**：${code}`;
          } else if (dbIntent.intent === 'executeSQL') {
            const sql = String(dbIntent.params.sql || '').trim();
            const code = d.executionSummary?.message || '执行完成。';
            sqlAndTable = `**执行的 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**SQL 返回码**：${code}`;
          } else if (dbIntent.intent === 'createTable') {
            sqlAndTable = `**结果**：${d.message || '表已创建'}`;
          } else if (dbIntent.intent === 'createDatabase') {
            sqlAndTable = `**结果**：${d.message || '数据库已创建'}`;
          } else {
            sqlAndTable = `\n\`\`\`json\n${JSON.stringify(d, null, 2)}\n\`\`\``;
          }
          dbOperationNote = `\n\n**【数据库操作结果】** 执行「${dbIntent.intent}」**成功**。你必须在回复中展示结果，表格内容必须与下方一致，不得编造。\n${sqlAndTable}`;
        } else {
          const errMsg = opResult.error || '';
          // 如果是列名错误，自动查表结构帮助纠正
          let schemaBlock = '';
          const isColumnError = /column\s+['\`]?\w+['\`]?\s+does not exist|Unknown column|doesn't have column/i.test(errMsg);
          if (dbIntent.intent === 'executeSQL' && isColumnError && dbIntent.params.sql) {
            const tableRefs = extractTableRefsFromSql(dbIntent.params.sql);
            const schemaParts = [];
            for (const ref of tableRefs) {
              const desc = await runDatabaseOperation(connectionString, 'describeTable', { database: ref.database, table: ref.table });
              if (desc.ok && desc.data && desc.data.columns) {
                const fullName = ref.database ? `${ref.database}.${ref.table}` : ref.table;
                const tableSchema = rowsToMarkdownTable(desc.data.columns, ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra']);
                schemaParts.push(`**表 ${fullName} 的真实结构**：\n${tableSchema}`);
              }
            }
            if (schemaParts.length > 0) {
              schemaBlock = `\n\n**【自我纠正】** 已自动查询涉及表的结构。请根据真实列名给出修正后的 SQL。\n\n${schemaParts.join('\n\n')}`;
            }
          }
          dbOperationNote = `\n\n**【数据库操作结果】** 执行「${dbIntent.intent}」**失败**。\n**失败原因**：${errMsg}\n请如实告知用户失败原因并给出修改建议。${schemaBlock}`;
        }
      }
    }
  }

  // 获取可用表结构信息（优先只查选中的表，否则全量扫描）
  let schemaContext = '';
  if (connectionString && selected.length > 0) {
    const schemaLines = [];
    for (const tbl of selected) {
      const parts = tbl.split('.');
      if (parts.length === 2) {
        const descResult = await runDatabaseOperation(connectionString, 'describeTable', { database: parts[0], table: parts[1] });
        if (descResult.ok && descResult.data.columns) {
          const cols = descResult.data.columns.map(c =>
            `    ${c.Field} ${c.Type}${c.Comment ? ` -- ${c.Comment}` : ''}`
          ).join('\n');
          schemaLines.push(`  ${tbl}:\n${cols}`);
        }
      }
    }
    if (schemaLines.length > 0) {
      schemaContext = `\n\n**可用表结构（仅限用户选中的 ${selected.length} 张表，严禁使用其他表）**：\n${schemaLines.join('\n\n')}`;
    }
  } else if (connectionString) {
    try {
      const dbResult = await runDatabaseOperation(connectionString, 'listDatabases', {});
      if (dbResult.ok) {
        const systemDbs = new Set(['information_schema', 'mysql', 'performance_schema', 'sys', 'mo_catalog', 'system', 'system_metrics']);
        const databases = (dbResult.data.databases || [])
          .filter(d => !systemDbs.has(d.database.toLowerCase()))
          .map(d => d.database);

        const schemaLines = [];
        for (const db of databases.slice(0, 10)) {
          const tblResult = await runDatabaseOperation(connectionString, 'listTables', { database: db });
          if (tblResult.ok && tblResult.data.tables) {
            for (const tbl of tblResult.data.tables.slice(0, 20)) {
              const descResult = await runDatabaseOperation(connectionString, 'describeTable', { database: db, table: tbl });
              if (descResult.ok && descResult.data.columns) {
                const cols = descResult.data.columns.map(c =>
                  `    ${c.Field} ${c.Type}${c.Comment ? ` -- ${c.Comment}` : ''}`
                ).join('\n');
                schemaLines.push(`  ${db}.${tbl}:\n${cols}`);
              }
            }
          }
        }
        if (schemaLines.length > 0) {
          schemaContext = `\n\n**可用表结构**：\n${schemaLines.join('\n\n')}`;
        }
      }
    } catch (e) {
      // ignore schema fetch errors
    }
  }

  const selectedTablesRestriction = selected.length > 0
    ? `\n**【严格限制】用户已在界面上选中了 ${selected.length} 张表（${selected.join(', ')}）。你必须且只能使用上方列出的表进行分析和建议。绝对不要提及、推测或建议任何未列出的表。**\n`
    : '';

  const systemPrompt = `你是一个智能数据助手，同时具备**数据加工（ETL）**和**指标定义**两种能力。
${selectedTablesRestriction}

## 能力一：数据加工（ETL）
你可以帮助用户完成完整的数据库操作，包括：
- 查看数据库列表、表列表、表结构、数据预览
- 创建数据库、创建表（需用户确认后执行）
- 执行 SQL 查询（SELECT 直接执行，INSERT/CREATE 等写操作需用户确认）
- 分析数据质量（空值率、异常值）
- 字段映射与数据加工（INSERT INTO ... SELECT）

**数据库操作规则**：
- 所有会修改库表或数据的操作（DDL、DML）必须先展示完整 SQL 并获用户确认后才能执行
- 只读操作（SELECT、DESCRIBE、SHOW）可直接执行
- 所有 SQL 必须严格符合 MySQL 语法
- 展示数据时必须用 markdown 表格，禁止 JSON
- 若有【数据库操作结果】，必须如实展示，不得编造

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

## 如何判断用户意图
- 用户说「看看有哪些库」「查看表结构」「建表」「执行SQL」「加工数据」等 → 数据加工能力
- 用户说「定义指标」「我想看收入」「统计订单量」「添加指标」等 → 指标定义能力
- 两种能力可以混合使用，比如用户可能先查看表结构再定义指标

${schemaContext}
${dbOperationNote}

**回复规则**：
- 用中文回复，简洁友好
- 若有【数据库操作结果】且为失败，必须如实输出失败原因
- 若有【数据库操作结果】且为成功，必须以 markdown 表格展示数据
- 若本轮没有【数据库操作结果】，不得声称已执行任何数据库操作
- 所有写操作（CREATE TABLE、INSERT 等）必须先展示 SQL 并提示用户确认

**输出格式**：只返回一个 JSON 对象，不要 markdown 代码块：

当还在讨论或执行数据库操作时：
{"reply":"你的回复（可含 markdown）"}

当用户确认指标后（用户明确说确认/可以/没问题）：
{"reply":"指标已创建：xxx","metricDef":{"name":"指标名称","definition":"指标计算逻辑描述","tables":["db.table1"],"aggregation":"SUM","measureField":"amount"}}

**aggregation 可选值**：SUM、COUNT、AVG、COUNT_DISTINCT、MAX、MIN
**measureField**：被聚合的字段名

**重要**：只有用户明确确认后才返回 metricDef。讨论阶段不要返回 metricDef。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversation.map(t => ({ role: t.role, content: t.content })),
  ];

  try {
    const response = await fetch(LLM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, messages, stream: false, temperature: 0.3, max_tokens: 4096 }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      let errMsg = bodyText || response.statusText;
      try { const j = JSON.parse(bodyText); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(bodyText); } catch (e) { return res.status(500).json({ error: 'LLM 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    let out = { reply: content };
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.reply === 'string') out.reply = parsed.reply;
        if (parsed.metricDef) out.metricDef = parsed.metricDef;
      } catch (_) {}
    }
    return res.json(out);
  } catch (e) {
    console.error('[/api/metric-chat]', e.message);
    return res.status(500).json({ error: e.message || '指标对话失败' });
  }
});

// ────────── 应用数据持久化 API ──────────
const appDb = require('./appDb');

// 在 Serverless 环境中，启动时立即初始化数据库（返回 Promise 供中间件 await）
let _appDbInitPromise = null;
if (appDb.isEnabled()) {
  _appDbInitPromise = appDb.initTables().then(ok => {
    if (ok) console.log('[AppDB] 数据库就绪');
    else console.log('[AppDB] 数据库初始化失败');
    return ok;
  });
}

// 中间件：/api/app/* 请求需要数据库就绪（status 端点除外）
app.use('/api/app', async (req, res, next) => {
  if (req.path === '/status') return next();
  // 在 serverless 冷启动时等待数据库初始化完成
  if (_appDbInitPromise && !appDb.isReady()) {
    await _appDbInitPromise;
  }
  if (!appDb.isReady()) {
    return res.status(503).json({ error: '应用数据库未就绪，请检查数据库连接配置' });
  }
  next();
});

// Dashboard
app.get('/api/app/dashboards', async (req, res) => {
  try { res.json(await appDb.listDashboards()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/app/dashboards', async (req, res) => {
  try { res.json(await appDb.createDashboard(req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/app/dashboards/:id', async (req, res) => {
  try { await appDb.updateDashboard(req.params.id, req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/app/dashboards/:id', async (req, res) => {
  try { await appDb.deleteDashboard(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Metrics
app.get('/api/app/metrics', async (req, res) => {
  try { res.json(await appDb.listMetrics(req.query.dashboardId || null)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/app/metrics', async (req, res) => {
  try { await appDb.upsertMetric(req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/app/metrics/:id', async (req, res) => {
  try { await appDb.deleteMetric(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/app/metrics/by-dashboard/:dashboardId', async (req, res) => {
  try { await appDb.clearMetricsByDashboard(req.params.dashboardId); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// MetricDefs
app.get('/api/app/metric-defs', async (req, res) => {
  try { res.json(await appDb.listMetricDefs(req.query.dashboardId || null)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/app/metric-defs', async (req, res) => {
  try { await appDb.upsertMetricDef(req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/app/metric-defs/:id', async (req, res) => {
  try { await appDb.deleteMetricDef(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ProcessedTables
app.get('/api/app/processed-tables', async (req, res) => {
  try { res.json(await appDb.listProcessedTables(req.query.dashboardId || null)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/app/processed-tables', async (req, res) => {
  try { await appDb.upsertProcessedTable(req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/app/processed-tables/:id', async (req, res) => {
  try { await appDb.deleteProcessedTable(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/app/processed-tables/by-dashboard/:dashboardId', async (req, res) => {
  try { await appDb.clearProcessedTablesByDashboard(req.params.dashboardId); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Chat Messages
app.get('/api/app/chat/:dashboardId/:chatType', async (req, res) => {
  try { res.json(await appDb.getChatMessages(req.params.dashboardId, req.params.chatType) || null); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/app/chat/:dashboardId/:chatType', async (req, res) => {
  try { await appDb.saveChatMessages(req.params.dashboardId, req.params.chatType, req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/app/chat/:dashboardId/:chatType?', async (req, res) => {
  try { await appDb.deleteChatMessages(req.params.dashboardId, req.params.chatType || null); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Schema Selections
app.get('/api/app/schema-selection/:dashboardId', async (req, res) => {
  try { res.json(await appDb.getSchemaSelection(req.params.dashboardId)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/app/schema-selection/:dashboardId', async (req, res) => {
  try { await appDb.saveSchemaSelection(req.params.dashboardId, req.body.selectedTables || []); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// App DB status
app.get('/api/app/status', (req, res) => {
  res.json({ enabled: appDb.isReady() });
});

// 导出 Express app 供 Vercel Serverless 使用
module.exports = app;

// 仅在非 Vercel 环境下启动本地服务器
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`ETL API server http://localhost:${PORT}`);
    console.log(`  LLM_API_KEY: ${LLM_API_KEY ? '已设置' : '未设置'}`);
    console.log(`  APP_DB: ${appDb.isEnabled() ? '已配置，正在初始化...' : '未配置（使用 localStorage）'}`);
  });
}
