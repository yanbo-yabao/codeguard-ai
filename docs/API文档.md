# API 接口文档

> 运行时可通过 `GET /api/meta/routes` 获取实时接口清单。
> 所有接口默认携带 `Access-Control-Allow-Origin: *`，响应头包含 `X-Request-Id` 便于日志追踪。

## 目录

- [通用约定](#通用约定)
- [评审接口](#评审接口)
- [报告导出接口](#报告导出接口)
- [元信息接口](#元信息接口)
- [数据模型](#数据模型)

---

## 通用约定

| 项 | 说明 |
| --- | --- |
| Base URL | `http://<host>:<port>`（默认 `http://127.0.0.1:8848`） |
| 请求编码 | UTF-8 |
| 请求体格式 | `application/json` |
| 请求体上限 | 5 MB（可用 `MAX_BODY_BYTES` 调整），超限返回 `413` |
| 时间格式 | ISO 8601（UTC），例如 `2026-03-01T10:00:00.000Z` |

### 成功响应

成功响应直接返回业务数据对象，不额外包一层 `data` 字段。

### 错误响应

所有错误统一为以下结构：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "送审代码不能为空",
    "details": { "field": "code" }
  },
  "requestId": "req_lq3k9x_a1b2"
}
```

| HTTP 状态 | `code` | 含义 |
| ---: | --- | --- |
| 400 | `VALIDATION_ERROR` | 请求参数非法（缺字段、类型错误、格式不支持） |
| 404 | `ROUTE_NOT_FOUND` / `NOT_FOUND` | 接口不存在 / 资源不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 路径存在但方法不符，响应头 `Allow` 列出可用方法 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过上限 |
| 500 | `CONFIG_ERROR` / `INTERNAL_ERROR` | 服务端配置或内部错误 |
| 502 | `LLM_ERROR` | 大模型调用失败（含超时、截断、协议错误） |
| 503 | `-` | 健康检查发现环境异常时由 `/api/meta/health` 返回 |

> **注意**：大模型调用失败**不会**让评审接口失败。审查会降级为纯规则引擎结果并返回 `201`，
> 失败原因记录在响应体的 `warnings` 字段中。

---

## 评审接口

### POST /api/reviews

提交代码发起一次完整审查。

**请求体**

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | :---: | --- | --- |
| `code` | string | ✅ | - | 待审查源码，不能为空白；上限 800,000 字符 |
| `fileName` | string | | `null` | 文件名，用于语言自动识别（只取基名） |
| `title` | string | | 文件名 | 报告标题，上限 120 字符 |
| `language` | string | | 自动识别 | 强制指定语言键，如 `javascript`、`python` |
| `roles` | string[] | | 全部四个 | 启用的大模型角色：`security` / `bug` / `performance` / `readability` |
| `dimensions` | string[] | | 全部五个 | 仅报告这些维度的问题 |
| `minSeverity` | string | | 全部 | 最低报告级别：`blocker` / `critical` / `major` / `minor` / `info` |
| `ignoreRules` | string[] | | `[]` | 忽略的规则 ID，上限 100 个 |
| `useLlm` | boolean | | 配置值 | 是否启用大模型语义评审 |
| `includeFixes` | boolean | | `true` | 是否生成修复建议 |
| `fixLimit` | number | | `5` | 最多生成几条修复建议，范围 1~15 |
| `includeSummary` | boolean | | `true` | 是否生成结论摘要 |

**响应** `201 Created`

```json
{
  "id": "rv_lq3k9x_a1b2",
  "createdAt": "2026-03-01T10:00:00.000Z",
  "source": {
    "title": "user-service.js",
    "fileName": "user-service.js",
    "language": "JavaScript",
    "codeHash": "4f2a9c1e7b03…（64 位十六进制）",
    "totalLines": 88
  },
  "engines": { "static": true, "llm": true, "llmRoles": ["security", "bug", "performance", "readability"] },
  "score": {
    "overall": 21.3,
    "grade": "D",
    "gradeLabel": "不合格",
    "advice": "存在阻断级问题，必须修复后才能合入。",
    "dimensions": {
      "security": { "key": "security", "label": "安全性", "score": 37.5, "penalty": 62.5, "issueCount": 4 },
      "bug": { "label": "缺陷风险", "score": 88.8, "issueCount": 3 },
      "performance": { "label": "性能", "score": 93.3, "issueCount": 2 },
      "readability": { "label": "可读性", "score": 97.3, "issueCount": 1 },
      "maintainability": { "label": "可维护性", "score": 96.3, "issueCount": 0 }
    },
    "penalty": { "raw": 88, "normalized": 78.7, "sigma": 0.894, "structural": 0, "bySeverity": { "blocker": 45 } },
    "deductions": [{ "ruleId": "SEC001", "severity": "blocker", "weight": 15, "applied": 15 }],
    "model": { "name": "CodeGuard 加权扣分模型 v1", "sigma": 0.894 }
  },
  "metrics": { "totalLines": 88, "codeLines": 52, "commentRatio": 0.12, "functionCount": 6, "maxComplexity": 4 },
  "issues": [
    {
      "id": "SEC001:22:1",
      "ruleId": "SEC001",
      "title": "硬编码敏感凭据",
      "dimension": "security",
      "dimensionLabel": "安全性",
      "severity": "blocker",
      "severityLabel": "阻断",
      "message": "检测到硬编码凭据…",
      "line": 22,
      "column": 1,
      "snippet": "const DB_API_KEY = \"sk-live-…\";",
      "suggestion": "改用环境变量注入并轮换已泄露凭据。",
      "reference": "OWASP Top 10 2021 · A07",
      "source": "static",
      "confidence": 0.9,
      "confirmedBy": 1
    }
  ],
  "summary": {
    "overview": "本次改动未达到合入标准：综合得分 21.3/D…",
    "highlights": [],
    "blockers": ["第 22、23 行硬编码敏感凭据，必须移除并轮换…"],
    "actions": ["立即移除硬编码凭据并轮换所有相关密钥…"]
  },
  "llm": {
    "enabled": true,
    "model": "deepseek-flash",
    "roles": ["security", "bug", "performance", "readability"],
    "roleSummaries": { "security": "…", "bug": "…" },
    "usage": { "calls": 9, "promptTokens": 18342, "completionTokens": 9120, "totalTokens": 27462 },
    "errors": []
  },
  "stats": {
    "durationMs": 65603,
    "staticIssueCount": 12,
    "llmIssueCount": 7,
    "confirmedCount": 1,
    "issueCount": 18,
    "severityCounts": { "blocker": 3, "critical": 2, "major": 7, "minor": 5, "info": 1 },
    "ruleHits": { "SEC001": 2, "SEC003": 1 }
  },
  "warnings": [],
  "fixCount": 3
}
```

**字段说明**

| 字段 | 说明 |
| --- | --- |
| `issues[].source` | `static` = 规则引擎命中；`llm` = 大模型命中（此时额外有 `role` / `roleLabel`） |
| `issues[].confirmedBy` | 该问题被大模型独立印证的次数，仅规则引擎命中时可能出现 |
| `score.penalty.sigma` | 规模归一化系数，用于复算得分 |
| `stats.confirmedCount` | 被互相印证的大模型结论数量 |
| `llm.usage` | token 用量，含 `reasoningTokens`（思维链模型的推理消耗） |
| `warnings` | 降级与截断等提示，**建议前端始终展示** |

**示例**

```bash
curl -X POST http://127.0.0.1:8848/api/reviews \
  -H "Content-Type: application/json" \
  -d '{
    "code": "const API_KEY = \"sk-abcdef1234567890\";",
    "fileName": "demo.js",
    "useLlm": false
  }'
```

---

### GET /api/reviews

分页查询历史评审记录（按创建时间倒序）。

**查询参数**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `limit` | number | `20` | 每页条数，范围 1~200 |
| `offset` | number | `0` | 偏移量 |
| `keyword` | string | - | 按标题模糊过滤（不区分大小写） |

**响应** `200 OK`

```json
{
  "total": 12,
  "limit": 20,
  "offset": 0,
  "items": [
    {
      "id": "rv_lq3k9x_a1b2",
      "createdAt": "2026-03-01T10:00:00.000Z",
      "title": "user-service.js",
      "language": "JavaScript",
      "fileName": "user-service.js",
      "lines": 88,
      "codeHash": "4f2a9c1e…",
      "score": 21.3,
      "grade": "D",
      "issueCount": 18,
      "severityCounts": { "blocker": 3 },
      "durationMs": 65603,
      "engines": { "static": true, "llm": true }
    }
  ]
}
```

> 列表接口只下发摘要字段（不含 `issues` / `metrics` / `fixes`），以降低传输体积。

---

### GET /api/reviews/:id

读取单条完整记录。

**响应** `200 OK`：与 `POST /api/reviews` 的响应结构一致，但额外包含：

| 字段 | 说明 |
| --- | --- |
| `source.codePreview` | 送审代码前 4000 字符（便于回溯，`codeTruncated` 指示是否被截断） |
| `fixes` | 完整的修复建议列表 |
| `options` | 本次审查使用的选项快照 |
| `meta` | 版本、规则版本、评分模型名 |

**错误**：记录不存在返回 `404 NOT_FOUND`。

---

### DELETE /api/reviews/:id

删除一条评审记录。

**响应** `200 OK`

```json
{ "deleted": true, "id": "rv_lq3k9x_a1b2" }
```

**错误**：记录不存在返回 `404 NOT_FOUND`。

---

## 报告导出接口

### GET /api/reviews/:id/report

导出指定记录的报告。

**查询参数**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `format` | string | `json` | `json` / `markdown` / `html` / `sarif` |
| `download` | `0`\|`1` | `0` | `1` 时以附件形式下载（`Content-Disposition: attachment`） |

**响应** `200 OK`，`Content-Type` 随格式变化：

| `format` | `Content-Type` | 文件名后缀 |
| --- | --- | --- |
| `json` | `application/json; charset=utf-8` | `.json` |
| `markdown` | `text/markdown; charset=utf-8` | `.md` |
| `html` | `text/html; charset=utf-8` | `.html` |
| `sarif` | `application/json; charset=utf-8` | `.sarif.json` |

**各格式用途**

| 格式 | 适用场景 |
| --- | --- |
| Markdown | 直接粘贴到 Git 平台的 PR 评论、周报、Issue |
| HTML | 自包含单文件（样式与图表全部内联），可离线打开、可直接截图答辩 |
| SARIF | 标准格式，可被 Gitee/GitHub 代码扫描、IDE 插件（VS Code SARIF Viewer）消费 |
| JSON | 机器可读，供二次统计与归档 |

**示例**

```bash
curl "http://127.0.0.1:8848/api/reviews/rv_lq3k9x_a1b2/report?format=html" -o report.html
curl "http://127.0.0.1:8848/api/reviews/rv_lq3k9x_a1b2/report?format=sarif&download=1" -O
```

**错误**：`format` 不在支持列表时返回 `400 VALIDATION_ERROR`，`details.supported` 列出可用值。

---

### GET /api/reviews/:id/fixes

仅获取该次评审的修复建议列表（报告体积较大时使用）。

**响应** `200 OK`

```json
{
  "id": "rv_lq3k9x_a1b2",
  "total": 3,
  "fixes": [
    {
      "issueId": "SEC001:22:1",
      "ruleId": "SEC001",
      "title": "硬编码敏感凭据",
      "line": 22,
      "applicable": true,
      "source": "llm",
      "rationale": "把硬编码凭据改为从环境变量读取，并补充启动期校验。",
      "risk": "low",
      "before": "const DB_API_KEY = \"sk-live-…\";",
      "after": "const DB_API_KEY = process.env.DB_API_KEY;\nif (!DB_API_KEY) throw new Error(\"缺少环境变量 DB_API_KEY\");",
      "diff": "@@ -22,1 +22,2 @@\n-const DB_API_KEY = \"sk-live-…\";\n+const DB_API_KEY = process.env.DB_API_KEY;",
      "tests": ["缺失环境变量时应抛出明确错误", "配置环境变量后能正常完成鉴权调用"],
      "model": "deepseek-flash"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `source` | `llm` = 大模型生成的上下文感知补丁；`template` = 内置修复模板（离线兜底） |
| `fallbackReason` | 仅当由大模型降级到模板时出现，说明降级原因 |
| `applicable` | `false` 表示该问题无法在片段范围内安全修复 |

---

## 元信息接口

### GET /api/meta/health

健康检查，含逐项环境自检。

**响应** `200 OK`（全部检查通过）或 `503 Service Unavailable`（存在 error 级检查失败）

```json
{
  "status": "ok",
  "app": { "name": "codeguard-ai", "version": "1.0.0" },
  "uptimeSeconds": 132,
  "memoryMB": 28,
  "checks": [
    { "name": "Node.js 版本", "ok": true, "level": "info", "detail": "v20.11.0（要求 >= 18.17.0）" },
    { "name": ".env 配置文件", "ok": true, "level": "info", "detail": "/app/.env" },
    { "name": "大模型连接", "ok": true, "level": "info", "detail": "DeepSeek 官方 / deepseek-flash（https://api.deepseek.com）" },
    { "name": "全局 fetch 可用性", "ok": true, "level": "info", "detail": "内置 fetch 就绪（无需第三方 http 库）" },
    { "name": "数据目录可写", "ok": true, "level": "info", "detail": "/app/data" }
  ]
}
```

---

### GET /api/meta/config

返回**已脱敏**的运行配置（密钥只保留前后各 4 位），可安全用于演示与排查。

```json
{
  "app": { "name": "codeguard-ai", "version": "1.0.0" },
  "env": "development",
  "server": { "port": 8848, "host": "127.0.0.1", "maxBodyBytes": 5242880 },
  "log": { "level": "info", "format": "pretty" },
  "llm": {
    "provider": "deepseek",
    "providerLabel": "DeepSeek 官方",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "available": true,
    "apiKeyMasked": "sk-5****c1ad"
  },
  "review": { "enableLlm": true, "temperature": 0.2, "maxTokens": 16000, "concurrency": 2 },
  "storage": { "dataDir": "/app/data", "keepReportFiles": true },
  "gitee": { "enabled": false, "apiBase": "https://gitee.com/api/v5" },
  "runtime": { "node": "v20.11.0", "platform": "linux", "arch": "x64" }
}
```

> **安全约束**：响应中**绝不包含** `apiKey` 原始字段，仅提供 `apiKeyMasked`。

---

### GET /api/meta/rules

返回完整规则清单与分类字典。

```json
{
  "total": 41,
  "dimensions": [
    { "key": "security", "label": "安全性", "color": "#e5484d", "description": "密钥泄露、注入、不安全依赖等安全缺陷" }
  ],
  "severities": [
    { "key": "blocker", "label": "阻断", "order": 5, "weight": 15, "color": "#e5484d" }
  ],
  "rules": [
    {
      "id": "SEC001",
      "title": "硬编码敏感凭据",
      "dimension": "security",
      "severity": "blocker",
      "languages": ["*"],
      "description": "密钥、口令、令牌等凭据一经写入源码即视为永久泄露…",
      "suggestion": "改用环境变量或密钥管理服务注入…",
      "reference": "OWASP Top 10 2021 · A07 身份认证与授权失效",
      "scanType": "line"
    }
  ]
}
```

---

### GET /api/meta/routes

返回全部 API 端点清单，便于交付评审时核对接口覆盖情况。

```json
{
  "routes": [
    { "method": "POST", "path": "/api/reviews" },
    { "method": "GET", "path": "/api/reviews" },
    { "method": "GET", "path": "/api/reviews/:id" },
    { "method": "DELETE", "path": "/api/reviews/:id" },
    { "method": "GET", "path": "/api/reviews/:id/report" },
    { "method": "GET", "path": "/api/reviews/:id/fixes" },
    { "method": "GET", "path": "/api/meta/health" },
    { "method": "GET", "path": "/api/meta/config" },
    { "method": "GET", "path": "/api/meta/rules" },
    { "method": "GET", "path": "/api/meta/routes" },
    { "method": "GET", "path": "/api/meta/overview" },
    { "method": "GET", "path": "/api/meta/languages" },
    { "method": "GET", "path": "/api/meta/formats" },
    { "method": "GET", "path": "/api/version" }
  ]
}
```

---

### GET /api/meta/overview

评审历史概览统计，用于首页展示。

```json
{
  "totalReviews": 12,
  "averageScore": 74.6,
  "totalIssues": 118,
  "languageDistribution": { "JavaScript": 7, "Python": 4, "Java": 1 },
  "recent": [
    { "id": "rv_lq3k9x_a1b2", "createdAt": "2026-03-01T10:00:00.000Z", "title": "demo.js", "score": 21.3, "issueCount": 18 }
  ],
  "llm": { "provider": "deepseek", "model": "deepseek-flash", "available": true }
}
```

---

### GET /api/meta/languages

返回支持的语言清单。

```json
{
  "languages": [
    { "key": "javascript", "label": "JavaScript", "extensions": [".js", ".mjs", ".cjs", ".jsx"] },
    { "key": "python", "label": "Python", "extensions": [".py", ".pyw"] }
  ]
}
```

---

### GET /api/meta/formats

返回支持的报告导出格式。

```json
{ "formats": ["json", "markdown", "md", "html", "sarif"] }
```

---

### GET /api/version

返回应用与运行时版本。

```json
{
  "name": "codeguard-ai",
  "version": "1.0.0",
  "description": "CodeGuard AI（智码审）—— 面向开发者的 AI 代码审查 Agent…",
  "node": "v20.11.0"
}
```

---

## 数据模型

### 问题对象（Issue）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 问题唯一标识，格式 `<规则ID>:<行>:<列>`（大模型问题为 `LLM:<角色>:<随机>`） |
| `ruleId` | string | 规则编号，大模型问题为 `LLM-<角色缩写>` |
| `title` | string | 问题标题，不超过 60 字 |
| `dimension` | enum | `security` / `bug` / `performance` / `readability` / `maintainability` |
| `severity` | enum | `blocker` / `critical` / `major` / `minor` / `info` |
| `severityOrder` | number | 严重程度排序权重，5 = 最高 |
| `message` | string | 问题描述，含触发条件与后果 |
| `line` / `column` | number | 位置（1 基） |
| `snippet` | string | 命中的原始代码行，不超过 200 字符 |
| `suggestion` | string | 可执行的修改建议 |
| `reference` | string | 判据来源（OWASP / CWE / 风格指南） |
| `source` | enum | `static`（规则引擎）/ `llm`（大模型） |
| `role` / `roleLabel` | string | 仅大模型问题：产生该结论的专家角色 |
| `confidence` | number | 0~1，规则引擎固定 0.9，大模型自评 |
| `confirmedBy` | number | 仅规则引擎问题：被大模型独立印证的次数 |

### 严重级别与扣分权重

| `severity` | 中文 | 权重 | 说明 |
| --- | --- | ---: | --- |
| `blocker` | 阻断 | 15 | 必然导致凭据泄露、远程代码执行、数据损毁 |
| `critical` | 严重 | 10 | 常见输入下即触发安全漏洞或服务不可用 |
| `major` | 主要 | 5 | 偶发故障、明显性能劣化或行为不符预期 |
| `minor` | 次要 | 2 | 影响可读性、可维护性，功能正确 |
| `info` | 建议 | 0.5 | 风格建议与可选优化 |

### 等级划分

| 等级 | 分数区间 | 含义 |
| --- | --- | --- |
| S | ≥ 92 | 优秀，可直接合入主干 |
| A | ≥ 82 | 良好，合入前顺手处理个别项 |
| B | ≥ 70 | 合格，需安排专门时间清理 |
| C | ≥ 60 | 需改进，推荐本轮迭代内修复 |
| D | < 60 | 不合格，必须修复后才能合入 |

计分公式详见 [README 第七章](../README.md#七评分模型)。
