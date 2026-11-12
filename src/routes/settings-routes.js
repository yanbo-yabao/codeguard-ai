'use strict';

/**
 * 运行时设置 API
 * ---------------------------------------------------------------------------
 *   GET    /api/settings        读取当前大模型设置（密钥脱敏）+ 可选供应商清单
 *   POST   /api/settings        保存设置并**立即生效**（无需重启服务）
 *   POST   /api/settings/test   用给定设置做一次真实连通性测试
 *   DELETE /api/settings        清除页面保存的设置，回到 .env 默认值
 *
 * 安全说明：
 *   密钥只写入本地 data/settings.json（data/ 已被 .gitignore 排除，不会进版本库），
 *   任何响应都只回传掩码，**绝不回传明文密钥**。
 */

const config = require('../config');
const settingsStore = require('../core/settings-store');
const { LlmClient } = require('../agents/llm-client');
const { ValidationError } = require('../core/errors');

/** 可选供应商（供前端下拉框渲染；均兼容 OpenAI 协议，选中即自动填好接口地址） */
const PROVIDERS = [
  {
    key: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrlHint: 'https://api.deepseek.com',
    modelHint: 'deepseek-flash',
    needsKey: true,
    note: '便宜好用，新用户有免费额度',
  },
  {
    key: 'kimi',
    label: 'Kimi（月之暗面）',
    baseUrlHint: 'https://api.moonshot.cn/v1',
    modelHint: 'kimi-k3',
    needsKey: true,
    note: '编程模型另有 kimi-k2.7-code 可选',
  },
  {
    key: 'zhipu',
    label: '智谱 AI（GLM）',
    baseUrlHint: 'https://open.bigmodel.cn/api/paas/v4',
    modelHint: 'glm-4-flash',
    needsKey: true,
    note: 'glm-4-flash 系列长期免费',
  },
  {
    key: 'dashscope',
    label: '阿里云百炼（通义千问）',
    baseUrlHint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelHint: 'qwen-plus',
    needsKey: true,
    note: '也可选 qwen-max / qwen-turbo 等',
  },
  {
    key: 'volcark',
    label: '火山方舟（豆包）',
    baseUrlHint: 'https://ark.cn-beijing.volces.com/api/v3',
    modelHint: '',
    modelPlaceholder: '填推理接入点 ID 或模型名（火山方舟控制台查看）',
    needsKey: true,
    note: '需先在控制台开通模型',
  },
  {
    key: 'tencent',
    label: '腾讯混元',
    baseUrlHint: 'https://api.hunyuan.cloud.tencent.com/v1',
    modelHint: '',
    modelPlaceholder: '填模型名（腾讯云控制台查看，如 hunyuan-turbos-latest）',
    needsKey: true,
  },
  {
    key: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrlHint: 'https://api.siliconflow.cn/v1',
    modelHint: '',
    modelPlaceholder: '填模型名（控制台查看，如 deepseek-ai/DeepSeek-V3）',
    needsKey: true,
    note: '聚合多家开源模型',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    baseUrlHint: 'https://openrouter.ai/api/v1',
    modelHint: '',
    modelPlaceholder: '填模型名（官网查看，如 deepseek/deepseek-chat）',
    needsKey: true,
    note: '海外聚合平台，可调 GPT / Claude 等',
  },
  {
    key: 'ollama',
    label: '本地 Ollama（完全免费）',
    baseUrlHint: 'http://127.0.0.1:11434/v1',
    modelHint: '',
    modelPlaceholder: '填本地模型名（ollama list 查看，如 qwen2.5-coder:7b）',
    needsKey: false,
    note: '需本机安装 Ollama，零费用',
  },
  {
    key: 'vllm',
    label: '本地 vLLM（完全免费）',
    baseUrlHint: 'http://127.0.0.1:8000/v1',
    modelHint: '',
    modelPlaceholder: '填部署时的模型名',
    needsKey: false,
  },
  {
    key: 'openai-compatible',
    label: '其他 OpenAI 兼容后端（手动填写）',
    baseUrlHint: '',
    modelHint: '',
    modelPlaceholder: '填写模型名',
    needsKey: true,
    note: '任何兼容 /chat/completions 的服务都可接入',
  },
  {
    key: 'mock',
    label: '离线模拟器（无需密钥，断网可用）',
    baseUrlHint: '',
    modelHint: 'codeguard-mock',
    needsKey: false,
    note: '演示流程用，不产生任何费用',
  },
];

/**
 * 密钥掩码
 * @param {string} value 明文密钥
 * @returns {string} 掩码后的展示值
 */
function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/**
 * 生成对外可见的设置快照（不含明文密钥）
 * @returns {object} 快照
 */
function snapshot() {
  const overrides = settingsStore.getLlm();
  return {
    llm: {
      provider: config.llm.provider,
      providerLabel: config.llm.providerLabel,
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
      available: config.llm.available,
      requiresKey: config.llm.requiresKey,
      reason: config.llm.reason,
      apiKeyMasked: mask(config.llm.apiKey),
      apiKeySource: overrides.apiKey ? 'settings' : config.llm.apiKey ? 'env' : 'none',
    },
    overrides: {
      provider: overrides.provider || '',
      model: overrides.model || '',
      baseUrl: overrides.baseUrl || '',
      hasApiKey: Boolean(overrides.apiKey),
    },
    providers: PROVIDERS,
    storageFile: settingsStore.filePath(),
  };
}

/**
 * 保存后统一应用的收尾动作
 * @param {object} service 评审服务
 * @returns {object} 快照
 */
function applyAndRebuild(service) {
  settingsStore.apply();
  if (service && typeof service.rebuildLlm === 'function') service.rebuildLlm();
  return snapshot();
}

/**
 * 注册设置路由
 * @param {import('../core/http/router').Router} router 路由器
 * @param {import('../services/review-service').ReviewService} service 评审服务
 */
function register(router, service) {
  router.get('/api/settings', (ctx) => {
    ctx.json(200, snapshot());
  });

  router.post('/api/settings', async (ctx) => {
    const body = (await ctx.parseBody()) || {};
    if (typeof body !== 'object') throw new ValidationError('请求体必须是 JSON 对象');

    const existing = settingsStore.getLlm();

    // apiKey 语义：
    //   非空字符串 → 使用新密钥
    //   null       → 显式清除（回落到 .env）
    //   空/缺省     → 沿用已保存的密钥（改模型时无需重复粘贴）
    let apiKey;
    if (body.apiKey === null) {
      apiKey = '';
    } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      apiKey = body.apiKey.trim();
    } else {
      apiKey = existing.apiKey || '';
    }

    settingsStore.save({
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey,
    });

    ctx.json(200, applyAndRebuild(service));
  });

  router.post('/api/settings/test', async (ctx) => {
    const body = (await ctx.parseBody()) || {};
    const existing = settingsStore.getLlm();

    const draft = {
      provider: body.provider || existing.provider || config.llm.provider,
      model: body.model || existing.model || config.llm.model,
      baseUrl: body.baseUrl || existing.baseUrl || config.llm.baseUrl,
      apiKey:
        typeof body.apiKey === 'string' && body.apiKey.trim()
          ? body.apiKey.trim()
          : existing.apiKey || config.llm.apiKey,
    };

    const client = new LlmClient({
      provider: draft.provider,
      apiKey: draft.apiKey,
      baseUrl: draft.baseUrl,
      model: draft.model,
      timeoutMs: Math.min(config.review.timeoutMs, 30000),
      maxRetries: 0,
    });

    if (!client.available) {
      ctx.json(200, { ok: false, message: '配置不完整：请填写密钥 / 接口地址 / 模型名' });
      return;
    }

    try {
      const result = await client.chat({
        messages: [
          { role: 'system', content: '你是连通性测试助手，只回复 OK 两个字。' },
          { role: 'user', content: '请只回复：OK' },
        ],
        temperature: 0,
        maxTokens: 64,
      });
      ctx.json(200, {
        ok: true,
        message: `连接成功：${draft.provider} / ${result.model}`,
        model: result.model,
        latencyMs: result.latencyMs,
        reply: String(result.content || '').slice(0, 60),
      });
    } catch (error) {
      ctx.json(200, { ok: false, message: String(error && error.message ? error.message : error) });
    }
  });

  router.delete('/api/settings', (ctx) => {
    settingsStore.clear();
    ctx.json(200, applyAndRebuild(service));
  });
}

module.exports = { register, PROVIDERS };
