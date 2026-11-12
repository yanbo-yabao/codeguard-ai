# CodeGuard AI API 文档

> 基础地址：`http://127.0.0.1:8848`。除特别说明外，请求体与响应体均为 JSON（`Content-Type: application/json`）。
> 错误响应统一为 `{"error": {"code", "message", "details?"}, "requestId"}`，参数错误返回 `400`，未知接口返回 `404`。

## 1. 解题补全三合一

### `POST /api/completions`

按 `feature` 分三种任务，共用一个接口。

**公共字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `feature` | string | `complete` 解题与补全 / `fix` 错误检查与修复 / `quiz` 变式出题；缺省时按输入推断 |
| `prompt` | string | 问题 / 需求 / 期望行为 / 刚学的题目 |
| `code` | string | 现有代码（可空） |
| `language` | string | 语言键（javascript / python / java …），缺省自动识别 |
| `fileName` | string | 文件名（辅助语言识别） |
| `useLlm` | boolean | 默认 true；false 表示不调用大模型（静态检查 / 离线模板照常） |

**feature = complete（解题与补全，支持图片）**

额外字段：`image`（data URL，`data:image/png;base64,...`，约 6MB 以内，仅 complete 可用）。

```json
{ "feature": "complete", "prompt": "这道题怎么做？求数组中两数之和等于目标值的下标",
  "image": "data:image/png;base64,iVBORw0KGgo...", "language": "javascript" }
```

响应（201）关键字段：

```json
{
  "feature": "complete", "mode": "generate",
  "answer": "解题讲解（思路 + 每步原因 + 知识点）",
  "completedCode": "完整代码",
  "completionSource": "llm | template | mock | none",
  "notes": ["补全要点"], "issues": [], "syntaxOk": true,
  "summary": { "text": "结论", "offline": false },
  "engines": { "static": false, "llm": true, "confirmed": 0 },
  "selfCheck": { "target": "completedCode", "issueCount": 0 },
  "safetyCheck": { "issueCount": 0 },
  "rag": { "query": "…", "hits": [] },
  "warnings": ["降级/来源说明"], "stats": { "durationMs": 260 }
}
```

**feature = fix（错误检查与修复）**

响应中 `issues` 为逐条问题（含 `line / title / message / suggestion / confirmedBy`），
`fixedCode` 为修复后的完整代码；`completedCode` 与 `answer` 为 null。

**feature = quiz（变式出题）**

```json
{ "feature": "quiz", "prompt": "两数之和", "language": "python" }
```

响应中 `quiz` 结构：

```json
{
  "title": "变式题：三数之和最小下标",
  "description": "完整题面（含输入/输出格式）",
  "starterCode": "起始代码骨架（含 TODO）",
  "testCases": [ { "input": "1 2\n", "expected": "3\n" } ],
  "referenceSolution": "参考实现（可直接拿去判题验证）",
  "hints": ["提示 1", "提示 2"]
}
```

## 2. 代码执行（真实运行）

### `GET /api/run/env`

返回运行环境探测（供前端下拉框自动探测）：
`{ "languages": { "javascript": {"available": true, "detail": "Node v24"}, "c": {"available": true, "detail": "D:\\w64devkit\\bin\\gcc.exe"}, … }, "runnable": ["javascript","python","c","cpp","java"], "timeoutMs": 5000 }`。
工具链探测顺序：环境变量（PYTHON_BIN / CC / CXX / JAVAC / JAVA_HOME）→ PATH → 已知安装位置。
编译型语言（c / cpp / java）判题时**只编译一次**、多用例复用产物；编译失败返回错误信息与行号。

### `POST /api/run`

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | string | `run` 运行（默认）/ `judge` 判题 / `debug` 逐行调试 |
| `language` | string | `javascript` / `python` / `c` / `cpp` / `java`（另接受别名 js / c++ / py） |
| `code` | string | 要执行的代码（从标准输入读入、向标准输出写出） |
| `stdin` | string | 标准输入内容（run / debug） |
| `testCases` | array | `[{input, expected}]`（judge 必填，最多 20 组） |
| `timeoutMs` | number | 超时毫秒（默认 5000，上限 30000） |

**run / debug 响应**

```json
{
  "ok": true, "language": "javascript",
  "stdout": "3\n", "stderr": "", "exitCode": 0, "timedOut": false,
  "durationMs": 42,
  "error": null,
  "trace": [ { "line": 2, "vars": { "sum": "0", "i": "1" } } ]
}
```

- `error`：失败时为 `{ "message", "line" }`（`line` 自动从报错栈解析）
- `trace`：`debug` 模式返回逐行执行记录（每步：行号 + 变量快照）；`run` 模式为空数组

**judge 响应**

```json
{
  "language": "javascript", "passed": 2, "total": 3, "allPassed": false,
  "cases": [
    { "index": 1, "input": "1 2\n", "expected": "3\n", "actual": "3\n", "ok": true, "stderr": "", "timedOut": false, "durationMs": 40 }
  ]
}
```

判题为确定性输出比对（统一换行符、忽略行尾空白），不经过大模型。

## 3. 大模型设置

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/settings` | GET | 返回 `{ llm: {provider, model, available, apiKeyMasked, …}, overrides: {…}, providers: [...], storageFile }`（**不含明文密钥**） |
| `/api/settings` | POST | 保存：`{ provider, baseUrl, model, apiKey }`。`apiKey` 留空=沿用已存值，`null`=清除 |
| `/api/settings/test` | POST | 测试连接：`{ provider, baseUrl, model, apiKey? }` |
| `/api/settings` | DELETE | 清除保存的设置，回到 `.env` 配置 |

`providers` 为 12 家预设（DeepSeek / Kimi / 智谱 / 通义 / 火山方舟 / 腾讯混元 / 硅基流动 /
OpenRouter / Ollama / vLLM / openai-compatible / mock），每项含 `baseUrlHint / modelHint / note`。

## 4. 元信息

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/meta/health` | GET | 健康检查（200/503，含自检明细） |
| `/api/meta/config` | GET | 脱敏运行配置 |
| `/api/meta/rules` | GET | 规则清单与分类字典 |
| `/api/meta/routes` | GET | 路由清单 |
| `/api/meta/languages` | GET | 支持语言清单 |
| `/api/version` | GET | 名称 / 版本 / Node 版本 |

## 5. 错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 参数缺失 / 格式非法 / 超限 |
| 404 | `NOT_FOUND` | 未知接口 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不匹配 |
| 500 | `INTERNAL_ERROR` | 服务端异常（含 requestId） |
| 503 | — | `/api/meta/health` 自检未全部通过 |
