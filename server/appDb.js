/**
 * 应用数据持久化层 — 使用 MatrixOne/MySQL 存储应用数据
 * dashboards、metrics、metric_defs、processed_tables、chat_messages 等
 */
const mysql2 = require('mysql2/promise');

let pool = null;
let _ready = false; // 数据库是否就绪.

function getAppDbConfig() {
  const host = process.env.APP_DB_HOST;
  const port = Number(process.env.APP_DB_PORT) || 3306;
  const user = process.env.APP_DB_USER;
  const password = process.env.APP_DB_PASSWORD;
  const database = process.env.APP_DB_NAME || 'data_etl_app';
  if (!host || !user) return null;
  return { host, port, user, password, database };
}

/** 带超时的 Promise */
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg || `超时(${ms}ms)`)), ms)),
  ]);
}

async function getPool() {
  if (pool) {
    // 在 serverless 环境中验证连接是否仍然有效
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (_) {
      // 连接已断开，重新创建
      try { pool.end(); } catch (_) {}
      pool = null;
    }
  }
  const cfg = getAppDbConfig();
  if (!cfg) throw new Error('APP_DB 未配置');
  // 先确保数据库存在
  const tmpConn = await withTimeout(
    mysql2.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
      connectTimeout: 8000,
    }),
    10000, '数据库连接超时'
  );
  await tmpConn.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\``);
  tmpConn.destroy();
  pool = mysql2.createPool({ ...cfg, waitForConnections: true, connectionLimit: 3, connectTimeout: 8000 });
  return pool;
}

/** 初始化所有应用表（带超时保护，失败不阻塞启动） */
async function initTables() {
  const cfg = getAppDbConfig();
  if (!cfg) { console.log('[AppDB] APP_DB 未配置，跳过初始化'); return false; }
  try {
    const p = await withTimeout(getPool(), 15000, '数据库连接超时，跳过初始化');
    await p.query(`CREATE TABLE IF NOT EXISTS dashboards (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`);
    await p.query(`CREATE TABLE IF NOT EXISTS metrics (
      id VARCHAR(64) PRIMARY KEY,
      dashboard_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      definition TEXT,
      tables_json TEXT,
      sql_text TEXT,
      chart_type VARCHAR(32) DEFAULT 'table',
      data_json LONGTEXT,
      created_at BIGINT NOT NULL,
      sort_order INT DEFAULT 0,
      INDEX idx_dashboard (dashboard_id)
    )`);
    await p.query(`CREATE TABLE IF NOT EXISTS metric_defs (
      id VARCHAR(64) PRIMARY KEY,
      dashboard_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      definition TEXT,
      tables_json TEXT,
      aggregation VARCHAR(64) DEFAULT 'SUM',
      measure_field VARCHAR(255) DEFAULT '',
      created_at BIGINT NOT NULL,
      INDEX idx_dashboard (dashboard_id)
    )`);
    await p.query(`CREATE TABLE IF NOT EXISTS processed_tables (
      id VARCHAR(255) PRIMARY KEY,
      dashboard_id VARCHAR(64) NOT NULL,
      db_name VARCHAR(128) NOT NULL,
      table_name VARCHAR(128) NOT NULL,
      source_tables_json TEXT,
      field_mappings_json TEXT,
      insert_sql TEXT,
      processed_at BIGINT NOT NULL,
      INDEX idx_dashboard (dashboard_id)
    )`);
    await p.query(`CREATE TABLE IF NOT EXISTS chat_messages (
      dashboard_id VARCHAR(64) NOT NULL,
      chat_type VARCHAR(16) NOT NULL DEFAULT 'etl',
      step INT DEFAULT 1,
      connection_string TEXT,
      messages_json LONGTEXT,
      PRIMARY KEY (dashboard_id, chat_type)
    )`);
    await p.query(`CREATE TABLE IF NOT EXISTS schema_selections (
      dashboard_id VARCHAR(64) PRIMARY KEY,
      selected_tables_json TEXT
    )`);
    _ready = true;
    console.log('[AppDB] 应用表初始化完成');
    return true;
  } catch (e) {
    _ready = false;
    console.error('[AppDB] 初始化失败（将使用 localStorage 降级）:', e.message);
    return false;
  }
}

function isEnabled() {
  return !!getAppDbConfig();
}

/** 数据库是否真正就绪可用 */
function isReady() {
  return _ready;
}

// ─── Dashboard CRUD ───
async function listDashboards() {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM dashboards ORDER BY created_at DESC');
  return rows.map(r => ({ id: r.id, name: r.name, description: r.description, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }));
}

async function createDashboard(dashboard) {
  const p = await getPool();
  await p.query('INSERT INTO dashboards (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [dashboard.id, dashboard.name, dashboard.description || '', dashboard.createdAt, dashboard.updatedAt]);
  return dashboard;
}

async function updateDashboard(id, updates) {
  const p = await getPool();
  const sets = [];
  const vals = [];
  if (updates.name !== undefined) { sets.push('name = ?'); vals.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); vals.push(updates.description); }
  sets.push('updated_at = ?'); vals.push(Date.now());
  vals.push(id);
  if (sets.length > 1) await p.query(`UPDATE dashboards SET ${sets.join(', ')} WHERE id = ?`, vals);
}

async function deleteDashboard(id) {
  const p = await getPool();
  await p.query('DELETE FROM dashboards WHERE id = ?', [id]);
  await p.query('DELETE FROM metrics WHERE dashboard_id = ?', [id]);
  await p.query('DELETE FROM metric_defs WHERE dashboard_id = ?', [id]);
  await p.query('DELETE FROM processed_tables WHERE dashboard_id = ?', [id]);
  await p.query('DELETE FROM chat_messages WHERE dashboard_id = ?', [id]);
  await p.query('DELETE FROM schema_selections WHERE dashboard_id = ?', [id]);
}

// ─── Metrics CRUD ───
async function listMetrics(dashboardId) {
  const p = await getPool();
  const where = dashboardId ? 'WHERE dashboard_id = ?' : '';
  const params = dashboardId ? [dashboardId] : [];
  const [rows] = await p.query(`SELECT * FROM metrics ${where} ORDER BY sort_order ASC, created_at DESC`, params);
  return rows.map(r => ({
    id: r.id, dashboardId: r.dashboard_id, name: r.name, definition: r.definition,
    tables: safeJsonParse(r.tables_json, []), sql: r.sql_text, chartType: r.chart_type,
    data: safeJsonParse(r.data_json, null), createdAt: Number(r.created_at),
  }));
}

async function upsertMetric(m) {
  const p = await getPool();
  await p.query(`INSERT INTO metrics (id, dashboard_id, name, definition, tables_json, sql_text, chart_type, data_json, created_at, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE name=VALUES(name), definition=VALUES(definition), tables_json=VALUES(tables_json),
    sql_text=VALUES(sql_text), chart_type=VALUES(chart_type), data_json=VALUES(data_json), sort_order=VALUES(sort_order)`,
    [m.id, m.dashboardId, m.name, m.definition || '', JSON.stringify(m.tables || []),
     m.sql || '', m.chartType || 'table', JSON.stringify(m.data), m.createdAt || Date.now(), m.sortOrder || 0]);
}

async function deleteMetric(id) {
  const p = await getPool();
  await p.query('DELETE FROM metrics WHERE id = ?', [id]);
}

async function clearMetricsByDashboard(dashboardId) {
  const p = await getPool();
  await p.query('DELETE FROM metrics WHERE dashboard_id = ?', [dashboardId]);
}

// ─── MetricDefs CRUD ───
async function listMetricDefs(dashboardId) {
  const p = await getPool();
  const where = dashboardId ? 'WHERE dashboard_id = ?' : '';
  const params = dashboardId ? [dashboardId] : [];
  const [rows] = await p.query(`SELECT * FROM metric_defs ${where} ORDER BY created_at DESC`, params);
  return rows.map(r => ({
    id: r.id, dashboardId: r.dashboard_id, name: r.name, definition: r.definition,
    tables: safeJsonParse(r.tables_json, []), aggregation: r.aggregation, measureField: r.measure_field,
    createdAt: Number(r.created_at),
  }));
}

async function upsertMetricDef(d) {
  const p = await getPool();
  await p.query(`INSERT INTO metric_defs (id, dashboard_id, name, definition, tables_json, aggregation, measure_field, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE name=VALUES(name), definition=VALUES(definition), tables_json=VALUES(tables_json),
    aggregation=VALUES(aggregation), measure_field=VALUES(measure_field)`,
    [d.id, d.dashboardId, d.name, d.definition || '', JSON.stringify(d.tables || []),
     d.aggregation || 'SUM', d.measureField || '', d.createdAt || Date.now()]);
}

async function deleteMetricDef(id) {
  const p = await getPool();
  await p.query('DELETE FROM metric_defs WHERE id = ?', [id]);
}

// ─── ProcessedTables CRUD ───
async function listProcessedTables(dashboardId) {
  const p = await getPool();
  const where = dashboardId ? 'WHERE dashboard_id = ?' : '';
  const params = dashboardId ? [dashboardId] : [];
  const [rows] = await p.query(`SELECT * FROM processed_tables ${where} ORDER BY processed_at DESC`, params);
  return rows.map(r => ({
    id: r.id, dashboardId: r.dashboard_id, database: r.db_name, table: r.table_name,
    sourceTables: safeJsonParse(r.source_tables_json, []),
    fieldMappings: safeJsonParse(r.field_mappings_json, []),
    insertSql: r.insert_sql, processedAt: Number(r.processed_at),
  }));
}

async function upsertProcessedTable(t) {
  const p = await getPool();
  const id = t.id || `${t.database}.${t.table}`;
  await p.query(`INSERT INTO processed_tables (id, dashboard_id, db_name, table_name, source_tables_json, field_mappings_json, insert_sql, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE source_tables_json=VALUES(source_tables_json), field_mappings_json=VALUES(field_mappings_json),
    insert_sql=VALUES(insert_sql), processed_at=VALUES(processed_at)`,
    [id, t.dashboardId, t.database, t.table, JSON.stringify(t.sourceTables || []),
     JSON.stringify(t.fieldMappings || []), t.insertSql || '', t.processedAt || Date.now()]);
}

async function deleteProcessedTable(id) {
  const p = await getPool();
  await p.query('DELETE FROM processed_tables WHERE id = ?', [id]);
}

async function clearProcessedTablesByDashboard(dashboardId) {
  const p = await getPool();
  await p.query('DELETE FROM processed_tables WHERE dashboard_id = ?', [dashboardId]);
}

// ─── Chat Messages ───
async function getChatMessages(dashboardId, chatType) {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM chat_messages WHERE dashboard_id = ? AND chat_type = ?', [dashboardId, chatType]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    step: r.step,
    connectionString: r.connection_string,
    messages: safeJsonParse(r.messages_json, []),
  };
}

async function saveChatMessages(dashboardId, chatType, data) {
  const p = await getPool();
  await p.query(`INSERT INTO chat_messages (dashboard_id, chat_type, step, connection_string, messages_json)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE step=VALUES(step), connection_string=VALUES(connection_string), messages_json=VALUES(messages_json)`,
    [dashboardId, chatType, data.step || 1, data.connectionString || null, JSON.stringify(data.messages || [])]);
}

async function deleteChatMessages(dashboardId, chatType) {
  const p = await getPool();
  if (chatType) {
    await p.query('DELETE FROM chat_messages WHERE dashboard_id = ? AND chat_type = ?', [dashboardId, chatType]);
  } else {
    await p.query('DELETE FROM chat_messages WHERE dashboard_id = ?', [dashboardId]);
  }
}

// ─── Schema Selections ───
async function getSchemaSelection(dashboardId) {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM schema_selections WHERE dashboard_id = ?', [dashboardId]);
  if (rows.length === 0) return null;
  return safeJsonParse(rows[0].selected_tables_json, []);
}

async function saveSchemaSelection(dashboardId, selectedTables) {
  const p = await getPool();
  await p.query(`INSERT INTO schema_selections (dashboard_id, selected_tables_json)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE selected_tables_json=VALUES(selected_tables_json)`,
    [dashboardId, JSON.stringify(selectedTables)]);
}

// ─── Helpers ───
function safeJsonParse(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}

module.exports = {
  initTables, isEnabled, isReady,
  listDashboards, createDashboard, updateDashboard, deleteDashboard,
  listMetrics, upsertMetric, deleteMetric, clearMetricsByDashboard,
  listMetricDefs, upsertMetricDef, deleteMetricDef,
  listProcessedTables, upsertProcessedTable, deleteProcessedTable, clearProcessedTablesByDashboard,
  getChatMessages, saveChatMessages, deleteChatMessages,
  getSchemaSelection, saveSchemaSelection,
};
