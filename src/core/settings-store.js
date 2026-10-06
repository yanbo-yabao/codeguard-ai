'use strict';

/**
 * 运行时可编辑设置
 * ---------------------------------------------------------------------------
 * 让使用者**无需修改 .env** 即可在网页里选择大模型供应商、填写自己的 API Key。
 *
 * 设计约束：
 *   1. 设置保存在 data/settings.json —— data/ 已在 .gitignore 中，
 *      因此永远不会被提交到版本库，个人密钥不会外泄；
 *   2. 只覆盖显式提供的字段，未提供的继续沿用 .env / 内置默认值；
 *   3. 密钥仅在服务端读取，任何接口返回一律脱敏。
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('./logger');

const log = logger.child('settings');

/** 允许持久化的 llm 字段白名单 */
const LLM_FIELDS = ['provider', 'apiKey', 'model', 'baseUrl'];

/** 设置文件路径（位于 data/ 下，不入版本库） */
function filePath() {
  return path.join(config.storage.dataDir, 'settings.json');
}

/** 内存缓存，避免每次请求都读盘 */
let cache = null;

/**
 * 清洗入参：只保留白名单字段；空串表示"取消该项覆盖"
 * @param {object} [input] 形如 { llm: {...} } 或直接 {...}
 * @returns {{llm:object}} 规整后的设置对象
 */
function sanitize(input) {
  const source = (input && input.llm) || input || {};
  const llm = {};
  for (const key of LLM_FIELDS) {
    const value = String(source[key] ?? '').trim();
    if (value) llm[key] = value;
  }
  return { llm };
}

/**
 * 读取设置（带缓存）
 * @returns {{llm:object}} 设置对象
 */
function load() {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(filePath(), 'utf8')));
  } catch {
    cache = { llm: {} };
  }
  return cache;
}

/**
 * 写入设置（整体替换 llm 段）
 * @param {object} input llm 设置
 * @returns {{llm:object}} 写入后的设置
 */
function save(input) {
  const next = sanitize(input);
  fs.mkdirSync(config.storage.dataDir, { recursive: true });
  fs.writeFileSync(filePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cache = next;
  log.info('运行时设置已保存', { file: filePath(), provider: next.llm.provider || '(沿用 .env)' });
  return next;
}

/**
 * 清除设置文件，回到 .env 默认值
 * @returns {{llm:object}} 清空后的设置
 */
function clear() {
  try {
    fs.unlinkSync(filePath());
  } catch {
    /* 文件不存在时忽略 */
  }
  cache = { llm: {} };
  log.info('运行时设置已清除，回到 .env 默认值');
  return cache;
}

/**
 * 取当前 llm 覆盖项
 * @returns {object} 覆盖项（可能为空对象）
 */
function getLlm() {
  return { ...load().llm };
}

/**
 * 把已保存的设置应用到运行时配置
 * @returns {object} 本次应用的覆盖项
 */
function apply() {
  const overrides = getLlm();
  config.refreshLlm(overrides);
  return overrides;
}

module.exports = { load, save, clear, getLlm, apply, sanitize, filePath };
