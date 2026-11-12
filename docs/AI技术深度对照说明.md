# AI 技术深度对照说明（35%）

本文对照赛题《评审标准》中「AI 技术深度」维度的六个考察点，逐项说明本作品的
**具体实现、代码位置与验证方式**，并如实标注尚未覆盖的部分。

---

## 1. 大模型集成质量（8%）

| 项 | 实现 | 位置 |
| --- | --- | --- |
| 合理选择并高质量集成 LLM | OpenAI 兼容协议统一封装，一套客户端适配 DeepSeek / Kimi / 智谱 / 通义 / 火山方舟 / 腾讯混元 / 硅基流动 / OpenRouter / Ollama / vLLM 等 **12 家预设**（网页一键切换，接口地址与推荐模型自动填好） | `src/agents/llm-client.js`、`src/routes/settings-routes.js` |
| Prompt 设计精巧 | 任务化专家提示词（语法诊断专家 + 解题补全专家 + 变式出题专家），每个角色有独立职责边界与判定口径；**输出契约**（严格 JSON 结构）保证可解析；思维链模型的截断问题有精确诊断提示 | `src/agents/prompt-templates.js` |
| 输出稳定可控 | 温度按任务区分（诊断 0.1 / 补全 0.2 / 出题 0.4）；非标准 JSON 三级容错解析；指数退避重试（仅超时/5xx）；输出经行号校正与结构归一化 | `src/agents/llm-client.js`、`src/agents/completion-agent.js` |
| 可复现验证 | 离线模拟器保证同输入同输出；141 项 Agent/服务层测试无需网络 | `test/llm-client.test.js` 等 |

## 2. Agent / 工作流设计（8%）

| 项 | 实现 | 位置 |
| --- | --- | --- |
| AI Agent / 复杂工作流 | 四角色**并行评审编排**（分段切块 → 并发调度 → 结果归一化 → 行号校正）；补全/修复为**双专家流水线**（诊断 → 修复/补全 → 产物自检 → 安全复检） | `src/agents/review-agent.js`、`src/services/completion-service.js` |
| 规划能力 | 流水线按输入规模自动分段送审；静态检查结论与 RAG 检索结果作为上下文**注入**后续阶段，形成「先检索规划、再生成」的工作流 | `src/services/review-service.js`、`completion-service.js` |
| 工具调用 | Agent 将确定性工具（规则引擎、语法检查器、知识库检索、安全规则）作为流水线步骤调用；并通过 **MCP 协议**将本系统开放为外部 AI 的工具（见第 6 点） | `src/mcp/server.js` |
| 自主决策 | 双引擎**交叉印证**决策（同位置结论合并为高可信问题）；三级降级决策（未配置 / 单阶段失败 / 全部失败均有不同兜底路径）；修复不可安全执行时 Agent 输出 `applicable:false` 并说明原因 | `src/services/*`、`src/agents/fix-agent.js` |

## 3. RAG 技术应用（6%）

| 项 | 实现 | 位置 |
| --- | --- | --- |
| RAG 架构 | 完整「知识库 → 检索 → 增强生成」链路：内置 16 条领域知识（CWE/OWASP 对齐的修复模式与最佳实践） | `src/rag/knowledge-base.js` |
| 检索策略 | 中文二元组 + 英文词元的确定性打分检索：关键词命中（+4）/ 关键词词元 / 标题 / 正文四路信号加权，阈值 5 分宁缺毋滥，Top-3 召回，结果确定可复现 | `src/rag/retriever.js` |
| 生成质量提升 | 检索命中以「参考资料」注入诊断与补全提示词，**约束修复方案遵循知识库中的修复模式**（如 SQL 注入必须参数化、密钥必须走环境变量）；命中结果随响应返回（`rag.hits`），前端可见、可解释 | `src/agents/prompt-templates.js`、`src/services/completion-service.js` |
| 验证 | 检索相关性测试（SQL 注入/密钥主题精准召回、无关查询零召回、确定性）；产出安全复检测试验证注入的修复模式被遵循 | `test/rag-retriever.test.js` |

**消融对比思路**：同一问题「SQL 字符串拼接怎么修」，无 RAG 时模型可能给出泛泛建议；
注入 `kb-sqli` 后修复方案被约束为「参数化查询 + 绑定参数 + 白名单」的标准模式。

## 4. 多模态能力（5%）

**已实现图像输入（文本 + 图片融合提问）：**
「AI 解题与补全」支持上传题目截图 / 报错截图 / 手写笔记（png/jpeg/gif/webp，data URL 随消息发送），
提示词以「文本 + image_url」两段内容组装，由支持视觉的大模型（如 Kimi K3、GLM-4V 系列）
理解图片后结合文字问题给出讲解与代码；服务端对图片做格式与体积校验（约 6MB 上限）。
不支持视觉的模型与离线模式会**明确提示**图片无法理解，绝不假装读过。

| 考察点 | 落点 | 代码位置 |
| --- | --- | --- |
| 多模态输入 | 图片上传（点击/拖拽/预览）→ data URL → OpenAI 兼容多模态消息 | `web/assets/app.js`、`src/agents/prompt-templates.js` |
| 融合自然 | 图文同题：文字描述与图片内容共同进入同一推理上下文，讲解中复述图片题意 | `src/agents/completion-agent.js` |
| 诚实降级 | 离线模拟器明确说明「无法真正理解图片」；非视觉模型报错提示换模型或文字描述 | `src/agents/llm-client.js`、`src/services/completion-service.js` |
| 回归测试 | 多模态消息组装、图片参数校验、离线诚实提示均有用例 | `test/quiz-image.test.js` |

语音 / 视频模态未覆盖，不宣称。

## 5. AI 安全与可控性（4%）

| 项 | 实现 | 位置 |
| --- | --- | --- |
| 输出安全性 | **产出安全复检**：所有交付代码（补全/修复/模板）回扫 11 条安全规则（硬编码凭据、注入、动态执行等），发现风险即警告；模板库内置代码本身零安全告警 | `src/services/completion-service.js` |
| 可解释性 | 每条结论带来源（规则/大模型/模板库）、置信度、修改方法；补全来源如实标注（真实 AI / 内置模板 / 占位模拟）；RAG 命中随结果展示 | 全链路 |
| 兜底机制 | 三级降级（未配置 → 仅静态；单阶段失败 → 其余照常；全部失败 → 绝不 5xx）；产物语法自检；模板库「无匹配不硬凑」 | `src/services/*` |
| 密钥与隐私 | 密钥仅存本机、接口一律脱敏；`data/` 不入版本库；代码仅在启用大模型时发往用户自选服务 | `src/core/settings-store.js` |

## 6. MCP / 工具集成（4%）

| 项 | 实现 | 位置 |
| --- | --- | --- |
| MCP 协议 | 标准 MCP stdio 传输（换行分隔 JSON-RPC 2.0），实现 `initialize` / `tools/list` / `tools/call` / `ping` 握手与调用 | `src/mcp/server.js` |
| 工具开放 | 暴露 5 个工具：`complete_code`（解题补全）、`fix_code`（诊断修复）、`quiz_code`（变式出题）、`run_code`（运行/判题/调试）、`list_rules`（规则清单），各带 JSON Schema | 同上 |
| 外部 AI 集成 | `node bin/codeguard.js mcp` 一条命令即可被 Claude Desktop / Cherry Studio / Cline / Cursor 等接入，AI 在对话中直接调用本系统解题、修复、出题、运行代码 | `docs/MCP接入说明.md` |
| Function Calling 同源能力 | 工具参数 Schema 与 OpenAI Function Calling 格式兼容，可平移到模型侧 tool_calls 编排 | `src/mcp/server.js` |
| 验证 | 7 项协议测试：握手、工具清单、三类工具调用、未知方法/工具错误处理 | `test/mcp-server.test.js` |
