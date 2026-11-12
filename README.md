<p align="center">
  <img src="web/favicon.svg" width="72" alt="CodeGuard AI">
</p>

<h1 align="center">CodeGuard AI · 智码审</h1>

<p align="center">
  <b>AI 编程学习助手</b>——提问 / 拍题得讲解与代码，变式练习在线判题，逐行调试定位问题<br>
  纯 Node.js 零第三方依赖 · 服务端真实运行 C / C++ / Java / JS / Python · 支持 12 家大模型供应商 · 内置 RAG 与 MCP
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D18.17-2da44e">
  <img src="https://img.shields.io/badge/npm%20依赖-0-blue">
  <img src="https://img.shields.io/badge/%E5%8D%95%E5%85%83%E6%B5%8B%E8%AF%95-148%20%E9%80%9A%E8%BF%87-2da44e">
  <img src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E8%AF%AD%E8%A8%80-C%20%C2%B7%20C%2B%2B%20%C2%B7%20Java%20%C2%B7%20JS%20%C2%B7%20Python-7c3aed">
  <img src="https://img.shields.io/badge/license-MIT-yellow">
</p>

---

## 一、它能干什么

> 学习编程的三个痛点：**没人讲题、没人出题练、代码跑不通不知道为什么**。
> CodeGuard AI 把这三件事做成一个闭环：

```text
 ① 问问题 / 拍题目          ② 出变式题考你            ③ 真实运行 · 判题 · 调试
 文字或截图 → 解题讲解 + 代码 → AI 按原题微改变式题 → 写代码 → 自动判题 → 跑不通就逐行调试
```

| 功能 | 说明 |
|---|---|
| 🧠 **AI 解题与补全（多模态）** | 文字提问或**上传题目截图/报错截图/手写笔记**，AI 返回面向学习者的解题讲解（思路 + 每步原因 + 知识点）与可直接运行的完整代码 |
| 📝 **变式练习 + 自动判题** | 解答完点「出题测试我」，AI 在原题基础上**微改**出变式题（附测试用例、起始骨架、提示、参考答案）——**直接在解题页里作答**，一键判题逐组给出通过/不通过与期望-实际对照 |
| 🧪 **代码测试（独立功能）** | 不问问题也能跑：粘贴任意代码 → 一键运行看输出（判题 / 调试在「出题测试我」流程里） |
| 🐛 **逐行调试** | 服务端真实执行并逐行记录：每行**执行了几次**（循环可视化）、每次的**变量快照**（JS/Python）、报错**定位到行**；C/C++/Java 按行记录执行轨迹 |
| 🩹 **错误检查与修复** | 贴上有错误的代码 → 逐条错误的修改方法 + 修复后的完整代码；**离线即用真编译器诊断**（gcc/g++/javac/Python 解析器，报错定位到行）+ 启发式检查 + AI 诊断多引擎印证 |
| 📚 **RAG 检索增强** | 内置 CWE/OWASP 修复模式知识库，确定性检索命中注入提示词约束生成质量 |
| 🔌 **MCP 工具集成** | 内置 MCP 服务器，Claude / Cherry Studio 等外部 AI 可直接调用解题/修复/出题/运行能力 |
| 🛡️ **AI 安全与可控** | 产出代码自动安全复检、语法自检、全链路降级兜底、离线演示诚实标注来源 |
| 🌐 **12 家供应商一键接入** | DeepSeek / Kimi / 智谱 / 通义 / 火山方舟 / 腾讯混元 / 硅基流动 / OpenRouter / Ollama / vLLM / 任意 OpenAI 兼容 / 离线模拟 |

**代码在哪运行？** 判题/调试在**本机独立子进程**真实执行（超时熔断、输出截断）；
只有开启大模型时，代码才会发送给你自己配置的 AI 服务。不填密钥时，运行/判题/调试与静态检查**照常可用**。

## 二、快速开始

### 1. 一条命令启动

```bash
node src/server.js
# 浏览器打开 http://127.0.0.1:8848/ ，首次进入自带新手引导
```

### 2. 三步用起来

| 第 1 步 | 第 2 步 | 第 3 步 |
|---|---|---|
| 在「AI 解题与补全」里输入问题（或上传题目截图），点「开始解题 / 补全」 | 看讲解和代码，点「**出题测试我**」——变式题直接出现在下方 | 就在同一页写解答 → 点「自动判题」；跑不通点「调试运行」看逐行轨迹。想单独测代码？切到「**代码测试**」标签 |

### 3. 命令行（可选）

```bash
node bin/codeguard.js complete sort.js --prompt "补充参数校验"
node bin/codeguard.js quiz --prompt "两数之和" --language python
node bin/codeguard.js run main.py --stdin "3 4"
node bin/codeguard.js fix broken.js --prompt "该函数应返回数组长度"
node bin/codeguard.js doctor
```

### 4. 配置大模型（解题/出题需要；运行判题调试不需要）

右上角「⚙ 设置大模型」→ 选供应商（自动填接口地址）→ 粘贴你的 API Key → 测试连接 → 保存即生效。
密钥仅保存在**访客自己浏览器**（localStorage），请求时随 `x-llm-*` 头携带、仅对当次请求生效——每位访客用自己的 Key 与额度，互不影响；服务器端 `data/settings.json` / `.env` 仅作兜底（CLI / MCP 用），不入库、不上传。

## 三、能力边界（诚实声明）

| 能力 | 无 API Key（默认） | 配置大模型后 |
|---|---|---|
| 运行 / 自动判题 / 逐行调试 | ✅ 真实执行 | ✅ 真实执行 |
| 错误检查（静态语法引擎） | ✅ 真实有效 | ✅ 双引擎印证 |
| 解题讲解 / 补全代码 | ⚠️ 常见功能走内置模板库，其余为演示占位（明确标注） | ✅ 真实 AI |
| 变式出题 | ⚠️ 固定示例题（明确标注） | ✅ 按原题微改的真实变式题 |
| 图片提问 | ⚠️ 无法理解图片（明确提示） | ✅ 需支持视觉的模型（Kimi K3、GLM-4V 等） |

> **运行语言**：JavaScript / Python / C / C++ / Java 五种（下拉框自动探测本机装了哪些工具链，
> 只列真能跑的）。C/C++ 需要 gcc/g++（如 w64devkit），Java 需要 JDK——本机已装于 `D:\w64devkit` 与 `D:\jdk-21`。

## 四、API 一览（共 13 个接口）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/completions` | POST | 三合一：feature = complete（解题补全，可带 image）/ fix（错误修复）/ quiz（变式出题） |
| `/api/run` | POST | 代码执行：mode = run（运行）/ judge（判题）/ debug（逐行调试）；语言 JS / Python / C / C++ / Java |
| `/api/run/env` | GET | 运行环境探测（各语言工具链可用性，供下拉框自动探测） |
| `/api/settings` | GET / POST / DELETE | 大模型设置（读取快照 / 保存 / 清除） |
| `/api/settings/test` | POST | 测试大模型连接 |
| `/api/meta/health` `/api/meta/config` `/api/meta/rules` `/api/meta/routes` `/api/meta/languages` `/api/version` | GET | 元信息（健康检查、脱敏配置、规则清单、接口清单、语言清单、版本） |

完整参数见 [docs/API文档.md](docs/API文档.md)。

## 五、MCP 接入（让外部 AI 调用本系统）

```bash
node bin/codeguard.js mcp    # 以 MCP 服务器模式运行（stdio 传输）
```

暴露 5 个工具：`complete_code`（解题补全）、`fix_code`（错误修复）、`quiz_code`（变式出题）、
`run_code`（运行/判题/调试）、`list_rules`（规则清单）。接入步骤见 [docs/MCP接入说明.md](docs/MCP接入说明.md)。

## 六、测试与工程

```bash
npm install && npm test        # 148 用例全绿（含五语言真实编译执行、HTTP 集成、MCP 协议、前端交互）
npm run doctor                 # 环境自检
```

- **零第三方依赖**：生产代码仅用 Node 内置模块，`npm install` 一步到位
- **确定性降级**：任一环节失败都有 warnings 说明，绝不整体失败
- **测试即证据**：运行器（含超时熔断）、判题、调试轨迹、多模态消息组装、模式隔离均有回归用例

## 七、模块结构

```text
codeguard-ai/
├── bin/codeguard.js            CLI（complete / fix / quiz / run / mcp / serve / doctor / rules）
├── src/
│   ├── server.js               HTTP 服务入口
│   ├── config/                 配置中心（含 12 家供应商预设）
│   ├── core/                   路由器 / HTTP / 校验 / 误报分类 / 日志 / 工具
│   ├── analyzers/              语法检查器（SYN001-005）· 41 条静态规则 · 语言档案
│   ├── agents/                 大模型客户端 · 提示词契约 · 解题补全智能体
│   ├── services/               解题补全服务（complete/fix/quiz 流水线）· 离线模板库
│   ├── runners/                代码运行服务（run / judge / debug，JS 行探针 + Python settrace）
│   ├── rag/                    知识库 + 确定性检索器
│   ├── mcp/                    MCP 服务器（stdio JSON-RPC）
│   └── routes/                 HTTP 路由（completions / run / settings / meta）
├── web/                        工作台（三工作模式 / 图片上传 / 判题表 / 调试轨迹表）
├── test/                       141 个单元与集成测试
├── docs/                       API 文档 / MCP 接入 / 评分标准对照
└── examples/                   示例代码
```

## 八、文档

| 文档 | 内容 |
|---|---|
| [docs/API文档.md](docs/API文档.md) | 全部接口的请求 / 响应格式与示例 |
| [docs/MCP接入说明.md](docs/MCP接入说明.md) | 在 Claude / Cherry Studio 中接入本系统 |
| [docs/评分标准对齐说明.md](docs/评分标准对齐说明.md) | 与赛事评分维度逐项对齐的证据索引 |
| [docs/AI技术深度对照说明.md](docs/AI技术深度对照说明.md) | 大模型集成 / Agent / RAG / 多模态 / 安全 / MCP 六项对照 |
| [CHANGELOG.md](CHANGELOG.md) | 版本演进（v2.0.0 产品定位调整说明） |

## 九、常见问题

- **运行别人的代码安全吗？** 每次执行都是独立子进程，超时 30 秒内强制终止，输出限量截断；不联网执行（除非代码本身发起网络请求）
- **出题 / 判题会不会作弊？** 判题是确定性输出比对（期望 vs 实际），不经过大模型，无法被"说服"
- **支持哪些语言？** 运行/判题/调试支持 **C / C++ / Java / JavaScript / Python** 五种（下拉框自动探测本机工具链）；解题/修复支持 12 种语言的文本
- **不联网能用吗？** 运行/判题/调试、静态检查、常见功能模板补全都可以

## 十、部署

### A. 当网站用（功能 100% 不缺，推荐）

所有计算都发生在**跑系统的那台电脑**上，访问者只是打开浏览器——所以功能一个不少：
运行/判题/调试在服务器上执行（5 种语言全可跑），AI 解题/出题走云端大模型，谁都一样。

1. 服务器上启动：`node src/server.js`
2. **允许别人访问**：在项目 `.env` 文件里写一行 `HOST=0.0.0.0`（默认 `127.0.0.1` 只有本机能打开），
   重启服务；同一局域网的其他人浏览器输入 `http://你的IP:8848` 即可（IP 用 `ipconfig` 查）
3. 注意事项（都是实话）：
   - **多人同时用会排队**：单机版设计，几十人以内没问题；人多了判题会变慢（每次执行独立进程 + 超时熔断，不会拖死服务器）
   - **别直接暴露公网**：判题功能 = 让访问者的代码在你电脑上运行，只在可信网络（局域网 / 加访问限制）开放

### B. 整套拷给别人自己跑

把项目文件夹拷给对方即可，两种情况：

- **带上工具链（推荐）**：把编译器文件夹放进项目的 `tools\` 目录（命名固定）：
  `tools\w64devkit\`（w64devkit 解压后的整个文件夹）、`tools\jdk\`（JDK 解压后改名 jdk）。
  系统启动时自动探测这些目录，**对方什么都不用装**，5 种语言全可跑
- **不带工具链**：对方只需装 Node.js，运行/判题/调试支持 JavaScript / Python；
  语言下拉框会诚实地只显示真能跑的，装了编译器（或放进 tools\）后自动出现 C/C++/Java

## 十一、许可

[MIT](LICENSE) © CodeGuard AI
