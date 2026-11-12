# MCP 接入说明

CodeGuard AI 内置 **MCP 服务器**（Model Context Protocol，stdio 传输），
可以把本系统的代码审查 / 修复 / 补全能力作为「工具」开放给外部 AI
（Claude Desktop、Cherry Studio、Cline、Cursor 等），实现 AI 调用本系统完成开发任务。

## 一、启动方式

```bash
node bin/codeguard.js mcp
```

启动后进程从标准输入读取 JSON-RPC 请求（MCP 标准的换行分隔格式），
外部 AI 客户端会自动完成握手并发现工具。日志输出在 stderr，stdout 只走协议消息。

## 二、暴露的工具

| 工具名 | 功能 | 主要参数 |
| --- | --- | --- |
| `complete_code` | 解题与代码补全：解题讲解 + 完整代码 | `prompt`（必填）、`code`、`language`、`useLlm` |
| `fix_code` | 错误检查与修复：逐条错误的修改方法 + 修复后的完整代码 | `code`（必填）、`prompt`（期望行为）、`useLlm` |
| `quiz_code` | 变式出题：题面 + 测试用例 + 起始代码 + 参考答案 | `prompt`（必填）、`code`、`language` |
| `run_code` | 真实执行：run 运行 / judge 判题 / debug 逐行调试 | `code`、`language`（必填）、`mode`、`stdin`、`testCases` |
| `list_rules` | 列出全部内置规则 | 无 |

## 三、接入示例

### Cherry Studio / Claude Desktop（MCP 配置片段）

```json
{
  "mcpServers": {
    "codeguard-ai": {
      "command": "node",
      "args": ["D:/path/to/codeguard-ai-master/bin/codeguard.js", "mcp"],
      "env": {
        "LLM_PROVIDER": "deepseek",
        "DEEPSEEK_API_KEY": "你的密钥（可选，不填则仅规则引擎）"
      }
    }
  }
}
```

配置完成后，在对话里对 AI 说「用 codeguard 出一道变式题考我」或「用 codeguard 跑一下这段代码」，
AI 会通过 MCP 调用 `quiz_code` / `run_code` 并把结果整理给你。

### 手工验证协议（可作为答辩演示）

```bash
# 一行 JSON 就是一条协议消息
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node bin/codeguard.js mcp
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node bin/codeguard.js mcp
```

## 四、说明

- 零第三方依赖：MCP 服务器用 Node 内置模块实现 JSON-RPC 2.0 与 stdio 传输
- 工具参数 Schema 与 OpenAI Function Calling 格式兼容，可平移到模型侧 tool_calls 编排
- `useLlm:false` 时完全离线（规则引擎 + 语法检查 + 离线模板库），适合无密钥环境
