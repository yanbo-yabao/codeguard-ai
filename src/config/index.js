'use strict';

/**
 * 全局配置中心
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 在模块加载阶段读取项目根目录下的 .env 文件（不覆盖已存在的系统环境变量）；
 *   2. 将散落的 process.env 规整为带默认值与类型转换的结构化配置对象；
 *   3. 对外提供 describe()，输出**已脱敏**的配置快照，供 /api/meta/config 与 doctor 命令使用。
 *
 * 设计说明：
 *   为满足「运行时零第三方依赖」的目标，这里自行实现了一个极简 dotenv 解析器，
 *   支持 `KEY=VALUE`、`#` 注释、单/双引号包裹、\n 转义以及 `export ` 前缀。
 */

const fs = require('fs');
const path = require('path');

/** 项目根目录（src/config/index.js → 上溯两级） */
const ROOT_DIR = path.resolve(__dirname, '..', '..');

/**
 * 解析 .env 文本为键值对
 * @param {string} text .env 文件内容
 * @returns {Record<string,string>} 解析结果
 */
function parseDotEnv(text) {
  const result = {};
  const lines = String(text).split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // 跳过空行与注释行
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    let key = line.slice(0, eqIndex).trim().replace(/^export\s+/, '');
    let value = line.slice(eqIndex + 1).trim();
    if (!key) continue;

    // 去除包裹引号，并还原常见的转义字符
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    } else {
      // 未加引号时，行尾的内联注释需要剔除（仅当注释前有空白分隔）
      const hashIndex = value.search(/\s#/);
      if (hashIndex >= 0) value = value.slice(0, hashIndex).trim();
    }

    result[key] = value;
  }
  return result;
}

/**
 * 加载 .env 到 process.env（已存在的变量优先，不被覆盖）
 * @param {string} [file] .env 路径，默认项目根目录
 * @returns {string[]} 实际注入的键名列表
 */
function loadEnvFile(file = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(file)) return [];
  const parsed = parseDotEnv(fs.readFileSync(file, 'utf8'));
  const injected = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      injected.push(key);
    }
  }
  return injected;
}

/** 在导出配置对象之前，尽早完成 .env 注入 */
loadEnvFile();

/** 读取字符串环境变量 */
function str(key, fallback = '') {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim();
}

/** 读取整数环境变量，非法值回退默认值 */
function int(key, fallback) {
  const value = Number.parseInt(str(key, ''), 10);
  return Number.isFinite(value) ? value : fallback;
}

/** 读取浮点环境变量，非法值回退默认值 */
function float(key, fallback) {
  const value = Number.parseFloat(str(key, ''));
  return Number.isFinite(value) ? value : fallback;
}

/** 读取布尔环境变量，接受 1/true/yes/on 为真 */
function bool(key, fallback) {
  const value = str(key, '').toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on', 'y'].includes(value);
}

/** 读取 package.json 的版本号，避免重复维护 */
function readPackageMeta() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return { name: pkg.name, version: pkg.version, description: pkg.description };
  } catch {
    return { name: 'codeguard-ai', version: '0.0.0', description: '' };
  }
}

const pkgMeta = readPackageMeta();

/** 大模型供应商解析表：统一映射为 OpenAI 兼容的三元组 */
const PROVIDER_PRESETS = {
  deepseek: {
    label: 'DeepSeek 官方',
    baseUrlKey: 'DEEPSEEK_BASE_URL',
    baseUrlDefault: 'https://api.deepseek.com',
    apiKeyKey: 'DEEPSEEK_API_KEY',
    modelKey: 'DEEPSEEK_MODEL',
    modelDefault: 'deepseek-flash',
    requiresKey: true,
  },
  'openai-compatible': {
    label: 'OpenAI 兼容后端',
    baseUrlKey: 'OPENAI_COMPATIBLE_BASE_URL',
    baseUrlDefault: '',
    apiKeyKey: 'OPENAI_COMPATIBLE_API_KEY',
    modelKey: 'OPENAI_COMPATIBLE_MODEL',
    modelDefault: '',
    requiresKey: true,
  },
  mock: {
    label: '离线模拟器',
    baseUrlKey: '',
    baseUrlDefault: '',
    apiKeyKey: '',
    modelKey: '',
    modelDefault: 'codeguard-mock',
    requiresKey: false,
  },
};

/**
 * 解析大模型配置
 * @param {object} [overrides] 运行时覆盖项（来自 data/settings.json，优先级高于 .env）
 * @param {string} [overrides.provider] 供应商
 * @param {string} [overrides.apiKey] 密钥
 * @param {string} [overrides.model] 模型名
 * @param {string} [overrides.baseUrl] 接口根地址
 * @returns {object} 结构化的大模型配置
 */
function resolveLlm(overrides = {}) {
  const provider = String(overrides.provider || str('LLM_PROVIDER', 'deepseek')).toLowerCase();
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.deepseek;

  const apiKey = overrides.apiKey || (preset.apiKeyKey ? str(preset.apiKeyKey, '') : '');
  const baseUrl = overrides.baseUrl || (preset.baseUrlKey ? str(preset.baseUrlKey, preset.baseUrlDefault) : '');
  const model =
    overrides.model || (preset.modelKey ? str(preset.modelKey, preset.modelDefault) : preset.modelDefault);

  // 密钥仍是模板占位符时视为未配置，避免误报「已就绪」
  const isPlaceholder = /^sk-x{6,}$/i.test(apiKey);
  const available = preset.requiresKey ? Boolean(apiKey) && !isPlaceholder : true;

  return {
    provider,
    providerLabel: preset.label,
    apiKey,
    baseUrl,
    model,
    available,
    requiresKey: preset.requiresKey,
    reason: available ? 'ready' : '缺少 API Key（可在网页「设置」中填写，或写入 .env）',
  };
}

const llm = resolveLlm();

/** 结构化配置对象 */
const config = {
  rootDir: ROOT_DIR,
  pkg: pkgMeta,
  env: str('NODE_ENV', 'development'),
  server: {
    port: int('PORT', 8848),
    host: str('HOST', '127.0.0.1'),
    maxBodyBytes: int('MAX_BODY_BYTES', 5 * 1024 * 1024),
  },
  log: {
    level: str('LOG_LEVEL', 'info').toLowerCase(),
    format: str('LOG_FORMAT', 'pretty').toLowerCase(),
  },
  llm,
  review: {
    enableLlm: bool('REVIEW_ENABLE_LLM', true) && llm.available,
    temperature: float('REVIEW_TEMPERATURE', 0.2),
    maxTokens: int('REVIEW_MAX_TOKENS', 16000),
    concurrency: Math.max(1, int('REVIEW_CONCURRENCY', 2)),
    timeoutMs: int('REVIEW_TIMEOUT_MS', 120000),
    maxRetries: Math.max(0, int('REVIEW_MAX_RETRIES', 2)),
    maxLines: int('REVIEW_MAX_LINES', 1200),
    chunkLines: int('REVIEW_CHUNK_LINES', 400),
  },
  storage: {
    dataDir: path.resolve(ROOT_DIR, str('DATA_DIR', 'data')),
    keepReportFiles: bool('KEEP_REPORT_FILES', true),
  },
  gitee: {
    token: str('GITEE_ACCESS_TOKEN', ''),
    apiBase: str('GITEE_API_BASE', 'https://gitee.com/api/v5'),
  },
  webDir: path.join(ROOT_DIR, 'web'),
};

// 派生目录
config.storage.reviewsDir = path.join(config.storage.dataDir, 'reviews');
config.storage.reportsDir = path.join(config.storage.dataDir, 'reports');

/**
 * 运行时重算大模型配置
 * ---------------------------------------------------------------------------
 * 网页「设置」面板保存后调用，使新供应商 / 新密钥 / 新模型**立即生效**，无需重启服务。
 * 注意：`llm` 与 `config.llm` 是同一个对象，原地合并即可让 describe()/selfCheck() 同步感知。
 * @param {object} [overrides] 覆盖项（来自 data/settings.json）
 * @returns {object} 重算后的 llm 配置
 */
config.refreshLlm = function refreshLlm(overrides = {}) {
  Object.assign(config.llm, resolveLlm(overrides));
  config.review.enableLlm = bool('REVIEW_ENABLE_LLM', true) && config.llm.available;
  return config.llm;
};

/**
 * 生成脱敏后的配置快照（密钥只保留前后各 4 位）
 * @returns {object} 可安全展示/记录的配置摘要
 */
config.describe = function describe() {
  /** 对密钥做掩码处理 */
  const mask = (value) => {
    if (!value) return '';
    if (value.length <= 8) return '****';
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
  };

  return {
    app: { name: pkgMeta.name, version: pkgMeta.version },
    env: config.env,
    server: { ...config.server },
    log: { ...config.log },
    llm: {
      provider: llm.provider,
      providerLabel: llm.providerLabel,
      baseUrl: llm.baseUrl,
      model: llm.model,
      available: llm.available,
      apiKeyMasked: mask(llm.apiKey),
    },
    review: { ...config.review },
    storage: { dataDir: config.storage.dataDir, keepReportFiles: config.storage.keepReportFiles },
    gitee: { enabled: Boolean(config.gitee.token), apiBase: config.gitee.apiBase },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
};

/**
 * 环境自检：返回逐项检查结果，供 `codeguard doctor` 与 /api/meta/health 使用
 * @returns {{ok:boolean, checks:Array<{name:string,ok:boolean,level:string,detail:string}>}}
 */
config.selfCheck = function selfCheck() {
  const checks = [];

  const nodeMajor = Number.parseInt(process.version.replace(/^v/, '').split('.')[0], 10);
  checks.push({
    name: 'Node.js 版本',
    ok: nodeMajor >= 18,
    level: nodeMajor >= 18 ? 'info' : 'error',
    detail: `${process.version}（要求 >= 18.17.0）`,
  });

  const envFile = path.join(ROOT_DIR, '.env');
  checks.push({
    name: '.env 配置文件',
    ok: fs.existsSync(envFile),
    level: fs.existsSync(envFile) ? 'info' : 'warn',
    detail: fs.existsSync(envFile) ? envFile : '未找到 .env，将使用 .env.example 的默认值',
  });

  checks.push({
    name: '大模型连接',
    ok: llm.available,
    level: llm.available ? 'info' : 'warn',
    detail: llm.available
      ? `${llm.providerLabel} / ${llm.model}（${llm.baseUrl || '本地'}）`
      : `${llm.reason}；此时仅运行本地规则引擎`,
  });

  checks.push({
    name: '全局 fetch 可用性',
    ok: typeof fetch === 'function',
    level: typeof fetch === 'function' ? 'info' : 'error',
    detail: typeof fetch === 'function' ? '内置 fetch 就绪（无需第三方 http 库）' : '当前 Node 缺少内置 fetch',
  });

  const dataWritable = (() => {
    try {
      fs.mkdirSync(config.storage.dataDir, { recursive: true });
      const probe = path.join(config.storage.dataDir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  })();
  checks.push({
    name: '数据目录可写',
    ok: dataWritable,
    level: dataWritable ? 'info' : 'error',
    detail: config.storage.dataDir,
  });

  return { ok: checks.every((item) => item.ok || item.level === 'warn'), checks };
};

module.exports = config;
module.exports.parseDotEnv = parseDotEnv;
module.exports.loadEnvFile = loadEnvFile;
module.exports.ROOT_DIR = ROOT_DIR;
