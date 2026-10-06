# 贡献指南

感谢对本项目的关注。本文说明参与开发时需要遵守的约定，
目的是让审查者能够快速理解每一处改动的动机与影响范围。

---

## 一、开发环境准备

```bash
git clone <仓库地址>
cd codeguard-ai

# 运行时零第三方依赖，此命令不下载任何包
npm install

# 配置大模型（可选；跳过则仅运行规则引擎）
cp .env.example .env      # Windows: Copy-Item .env.example .env

# 环境自检
npm run doctor

# 运行测试
npm test
```

**硬性约束**：请勿引入运行时第三方依赖。这不只是偏好问题——
「零依赖」是本项目可一键复现、可离线运行的基础，破坏它会连带破坏
`npm install` 必定成功这一交付承诺。若确有必要的功能，
请先用 Node 内置模块实现，并在 Pull Request 中说明为何内置模块无法满足。

---

## 二、代码规范

### 2.1 格式

| 项 | 标准 |
| --- | --- |
| 缩进 | 2 空格 |
| 换行符 | LF |
| 文件末尾 | 保留一个换行 |
| 行尾空白 | 不得存在 |
| 编码 | UTF-8 |
| 单行长度 | 不超过 120 字符 |
| 严格模式 | 每个源码文件首行 `'use strict';` |

以上由 `.editorconfig` 约束，绝大多数编辑器会自动应用。
提交前也可以用本项目自身的引擎自查：

```bash
node bin/codeguard.js review src/ --no-llm --min-severity major
```

### 2.2 注释

**核心原则：解释「为什么」，而不是复述「是什么」。**

```js
// ✗ 无价值：复述代码
// 把 a 和 b 相加
const sum = a + b;

// ✓ 有价值：解释设计动机与边界
// 金额按「分」为单位做整数运算：浮点累加会在千级条目后产生可见误差，
// 而金融场景不允许出现 0.01 级别的漂移。
const sumInCents = items.reduce((acc, item) => acc + item.priceInCents, 0);
```

导出的函数必须有 JSDoc，标注参数与返回值：

```js
/**
 * 计算规模归一化系数 σ
 * @param {number} totalLines 有效代码行数
 * @returns {number} σ ∈ (0, 1]
 */
```

遇到「看起来可以优化但实际不能改」的代码，**务必写下原因**。
例如本项目 `src/analyzers/metrics.js` 中关于三元运算符优先级的括号说明——
那条注释的价值在于阻止后人在「清理冗余括号」时重新引入已修复的缺陷。

### 2.3 命名

| 对象 | 约定 | 示例 |
| --- | --- | --- |
| 变量 / 函数 | 小驼峰，语义完整 | `computeMetrics`、`normalizedSeverity` |
| 类 / 构造函数 | 大驼峰 | `ReviewService`、`LlmClient` |
| 常量 | 全大写下划线 | `MAX_BODY_BYTES`、`SEVERITY_ORDER` |
| 布尔值 | `is` / `has` / `should` 前缀 | `isMock`、`hasBlocking` |
| 私有辅助 | 文件内不导出即可，不额外加下划线前缀 | 保持风格统一 |

避免无意义的缩写（`usr`、`cfg`、`tmp2`），也避免单字母命名（循环下标除外）。

---

## 三、新增一条审查规则

规则是**声明式数据**，新增时无需修改引擎。以在 `src/analyzers/rules/bug-rules.js` 中
追加一条规则为例：

```js
{
  id: 'BUG011',                       // 唯一编号，前缀表维度
  title: '简短标题（不超过 16 字）',
  dimension: 'bug',                   // security | bug | performance | readability | maintainability
  severity: 'major',                  // blocker | critical | major | minor | info
  languages: ['*'],                   // '*' 表示全部语言，也可列出具体语言键
  description: '说明触发条件与可能的后果。',
  suggestion: '给出可直接落地的修改方式。',
  reference: '判据来源（OWASP / CWE / 风格指南）',
  scan: {
    type: 'syntaxLine',               // line | syntaxLine | rawLine | comment | custom
    pattern: /your-regex-here/,
    filter: (match, lineText, ctx) => true,   // 可选：上下文相关的排除逻辑
    maxPerFile: 5,                            // 可选：单文件最多报几条，避免刷满报告
  },
  message: '问题描述，可用 {match} / {1} / {length} 占位符',
}
```

### 3.1 选择扫描通道

| `scan.type` | 使用的文本 | 适用场景 |
| --- | --- | --- |
| `line` | 已剥离注释、**保留字符串** | 需要看到字面量内容的规则（硬编码凭据、SQL 拼接） |
| `syntaxLine` | 已剥离注释**与字符串** | 只关心运算符与关键字结构（松散相等、浮点比较） |
| `rawLine` | 原始行 | 需要感知注释本身的行级问题（行尾空白） |
| `comment` | **仅注释** | 待办标记、技术债识别 |
| `custom` | 完整上下文 | 需要跨行分析或访问度量结果的规则 |

选错通道是误报的主要来源：在 `line` 通道上匹配运算符，
会把 `const label = "a == b"` 判为松散相等。

### 3.2 强制要求：配套测试

**每新增一条规则，必须在 `test/static-analyzer.test.js` 中补充两类用例：**

1. **正例**：构造应被检出的代码片段，断言规则命中；
2. **反例**：构造**不应**被检出的相近代码，断言规则未命中。

反例比正例更重要。代码审查工具的误报会直接摧毁使用者对工具的信任——
一次错误的高危告警，代价远大于漏掉十个风格提示。

`npm test` 中的「干净代码零告警」用例是全局兜底：
如果新规则对 `examples/clean-sample.js` 产生误报，该用例会失败。

---

## 四、提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/) 风格的提交信息：

```text
<类型>(<范围>): <简短描述>

<可选正文：说明动机与影响>
```

| 类型 | 用途 |
| --- | --- |
| `feat` | 新增功能 |
| `fix` | 修复缺陷 |
| `docs` | 文档变更 |
| `test` | 测试相关 |
| `refactor` | 重构（不改变外部行为） |
| `perf` | 性能优化 |
| `chore` | 构建、配置、依赖等杂项 |

示例：

```text
fix(analyzer): 除零规则只检查当前行导致误判

原实现只检查除法所在行是否有守卫语句，导致函数内存在无关分支
（如 if (a == b)）时漏报，且改为窗口回溯后又过度放行。

现要求出现与 0 的比较、取反判断或 Math.max 兜底才视为已校验，
并补充正反两类测试用例。
```

**一次提交只做一件事**。把「修复缺陷」和「调整格式」混在一个提交里，
会让审查者难以判断哪部分改动是必要的。

---

## 五、修改现有行为时

### 5.1 修改规则判据

如果放宽或收紧某条规则的判据，请在提交信息中说明：

- 触发的误报/漏报场景（最好附上最小复现代码片段）；
- 对已有测试的影响；
- 是否需要在 `CHANGELOG.md` 的「已知限制」中更新说明。

### 5.2 修改评分模型

评分模型是公开且可复算的（见 README 第七章）。任何改动都意味着：

- 历史记录的得分将不可与新版直接比较；
- 需要同步更新 `docs/测试与验证报告.md` 中的相关数字；
- 需要在 `CHANGELOG.md` 中记录，并说明为何新模型更合理。

请谨慎对待，并在 Pull Request 中提供改动前后的对照数据。

### 5.3 修改提示词

`src/agents/prompt-templates.js` 中的提示词会直接影响结论质量与稳定性。
调整后请用 `examples/vulnerable-sample.js` 做一次真实调用，
对比改动前后的漏报情况与输出 JSON 的合规率。

---

## 六、Pull Request 检查清单

提交前请逐项确认：

- [ ] `npm test` 全部通过（97 个用例）
- [ ] 未引入运行时第三方依赖（`package.json` 的 `dependencies` 仍为空）
- [ ] 新增/修改的功能有对应测试，且包含反例
- [ ] 导出的函数有 JSDoc（含 `@param` / `@returns`）
- [ ] 注释解释的是「为什么」而非「是什么」
- [ ] 未提交 `.env` 或任何真实密钥
- [ ] 涉及行为变更时已更新相关文档
- [ ] 提交信息符合 Conventional Commits 规范
- [ ] 使用自身引擎自查无新增的阻断级问题：
      `node bin/codeguard.js review src/ --no-llm --min-severity critical`

---

## 七、报告问题

提交 Issue 时请包含：

1. **运行环境**：Node 版本、操作系统、`npm run doctor` 的输出；
2. **复现步骤**：最小可复现的代码片段（可直接粘贴到 Web 评审台的输入框）；
3. **期望行为**与实际行为；
4. 若是误报，请说明该代码为什么是安全的——这是判断规则是否需要调整的关键依据。

安全问题请勿公开提交 Issue，请通过仓库所有者邮箱私下联系。
