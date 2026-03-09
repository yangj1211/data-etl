/**
 * Vercel Serverless Function — 将 Express app 作为 serverless handler 导出
 * Vercel 会将所有 /api/* 请求路由到这里
 */
const app = require('../server/server');

module.exports = app;
