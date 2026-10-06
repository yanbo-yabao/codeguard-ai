'use strict';

/**
 * 示例：一个包含多处典型缺陷的 Node.js 服务模块
 * ---------------------------------------------------------------------------
 * 用途：用于演示与验收 CodeGuard AI 的检测能力。
 * 本文件**故意**包含安全问题与逻辑缺陷，请勿在生产环境模仿。
 *
 * 预期可被检出的问题：
 *   SEC001 硬编码凭据        SEC003 SQL 拼接
 *   SEC005 不安全随机数      SEC007 关闭证书校验
 *   BUG001 松散相等          BUG002 异常被静默吞掉
 *   BUG005 除零未保护        PERF001 循环内串行 await
 *   PERF002 同步阻塞 IO      STY002 调试输出残留
 */

const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

// 凭据直接写入源码 —— 一旦提交即视为泄露
const DB_PASSWORD = 'prod_mysql_2026!';
const DB_API_KEY = 'sk-live-9f8e7d6c5b4a3210';

// 关闭证书校验以便连接内网自签服务
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * 按用户名查询用户（存在 SQL 注入风险）
 */
function findUserByName(name) {
  const sql = "SELECT * FROM users WHERE name = '" + name + "'";
  return db.query(sql);
}

/**
 * 生成会话令牌（使用可预测的伪随机数）
 */
function createSession(user) {
  const sessionId = Math.random().toString(36).slice(2);
  try {
    db.save({ user, sessionId });
  } catch (e) {
    // 静默忽略写入失败
  }
  return sessionId;
}

/**
 * 计算平均分（未校验除数）
 */
function averageScore(total, count) {
  const score = total / count;
  if (score == 0) {
    return null;
  }
  return score;
}

/**
 * 同步读取配置（阻塞事件循环）
 */
function readConfig() {
  const raw = fs.readFileSync('./config.json', 'utf8');
  console.log('配置已加载：', raw.slice(0, 40));
  return JSON.parse(raw);
}

/**
 * 批量同步远端数据（循环内串行 await）
 */
async function syncAll(ids) {
  const results = [];
  for (const id of ids) {
    results.push(await fetchRemote(id));
  }
  return results;
}

/**
 * 使用弱哈希算法生成签名
 */
function signPayload(payload) {
  return crypto.createHash('md5').update(payload).digest('hex');
}

module.exports = {
  findUserByName,
  createSession,
  averageScore,
  readConfig,
  syncAll,
  signPayload,
  insecureAgent,
};
