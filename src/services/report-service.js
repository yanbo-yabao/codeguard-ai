'use strict';

/**
 * 报告导出服务
 * ---------------------------------------------------------------------------
 * 支持四种交付形态，覆盖不同使用场景：
 *   json   机器可读，供二次处理与归档
 *   markdown  可直接粘贴进 Git 平台评论或周报
 *   html   自包含单文件（样式与图表全部内联），可离线打开、可直接截图答辩
 *   sarif  SARIF 2.1.0 标准格式，可被 Gitee/GitHub 代码扫描与 IDE 插件消费
 */

const { SEVERITIES, DIMENSIONS } = require('../core/taxonomy');
const { escapeHtml, formatDuration } = require('../core/utils');

/** 严重级别 → SARIF level */
const SARIF_LEVEL = {
  blocker: 'error',
  critical: 'error',
  major: 'warning',
  minor: 'note',
  info: 'note',
};

/**
 * 按严重级别分组
 * @param {object[]} issues 问题列表
 * @returns {Record<string, object[]>} 分组结果
 */
function groupBySeverity(issues) {
  const groups = {};
  for (const key of Object.keys(SEVERITIES)) groups[key] = [];
  for (const issue of issues) {
    (groups[issue.severity] || groups.minor).push(issue);
  }
  return groups;
}

/**
 * 生成 Markdown 报告
 * @param {object} record 评审记录
 * @returns {string} Markdown 文本
 */
function toMarkdown(record) {
  const { score, metrics, source } = record;
  const lines = [];

  lines.push(`# 代码审查报告 · ${source.title}`);
  lines.push('');
  lines.push(
    `> 生成时间：\`${record.createdAt}\`　|　审查引擎：${record.engines?.llm ? '静态规则引擎 + 大模型语义评审' : '静态规则引擎'}　|　语言：${source.language}`,
  );
  lines.push(`> 代码规模：${metrics.totalLines} 行（有效 ${metrics.nonBlankLines} 行）　|　问题总数：${record.issues.length}　|　耗时：${formatDuration(record.stats.durationMs)}`);
  lines.push(`> 代码指纹（SHA-256）：\`${source.codeHash}\``);
  lines.push('');

  lines.push('## 一、结论摘要');
  lines.push('');
  lines.push(`**综合得分：${score.overall} / 100（等级 ${score.grade} · ${score.gradeLabel}）**`);
  lines.push('');
  lines.push(`> ${score.advice}`);
  lines.push('');
  if (record.summary?.overview) {
    lines.push(record.summary.overview);
    lines.push('');
  }
  if (record.llm?.roleSummaries && Object.keys(record.llm.roleSummaries).length > 0) {
    lines.push('各专家角色结论：');
    lines.push('');
    for (const [role, text] of Object.entries(record.llm.roleSummaries)) {
      lines.push(`- **${role}**：${text}`);
    }
    lines.push('');
  }

  lines.push('## 二、评分卡');
  lines.push('');
  lines.push('| 维度 | 得分 | 问题数 | 生效扣分 |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const dimension of Object.values(score.dimensions)) {
    lines.push(`| ${dimension.label} | ${dimension.score} | ${dimension.issueCount} | ${dimension.penalty} |`);
  }
  lines.push('');
  lines.push('严重级别分布：');
  lines.push('');
  lines.push('| 级别 | 数量 | 单项扣分 |');
  lines.push('| --- | ---: | ---: |');
  for (const [key, definition] of Object.entries(SEVERITIES)) {
    lines.push(`| ${definition.label}（${key}） | ${record.stats.severityCounts[key] || 0} | ${definition.weight} |`);
  }
  lines.push('');
  lines.push(
    `> 计分模型：${score.model.description} 规模归一化系数 σ = ${score.model.sigma}；原始扣分 ${score.penalty.raw}，归一化后 ${score.penalty.normalized}。`,
  );
  lines.push('');

  lines.push('## 三、问题清单');
  lines.push('');
  if (record.issues.length === 0) {
    lines.push('本次审查未发现问题。');
    lines.push('');
  } else {
    const groups = groupBySeverity(record.issues);
    for (const [key, definition] of Object.entries(SEVERITIES)) {
      const items = groups[key];
      if (!items || items.length === 0) continue;
      lines.push(`### ${definition.label}（${key}） · ${items.length} 项`);
      lines.push('');
      lines.push('| 行号 | 规则 | 问题 | 来源 | 说明 |');
      lines.push('| ---: | --- | --- | --- | --- |');
      for (const issue of items) {
        const message = String(issue.message).replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(
          `| ${issue.line} | \`${issue.ruleId}\` | ${String(issue.title).replace(/\|/g, '\\|')} | ${issue.source === 'llm' ? '大模型' : '规则引擎'} | ${message} |`,
        );
      }
      lines.push('');
    }
  }

  if (record.fixes && record.fixes.length > 0) {
    lines.push('## 四、修复建议');
    lines.push('');
    record.fixes.forEach((fix, index) => {
      lines.push(`### ${index + 1}. 第 ${fix.line} 行 · ${fix.title}（\`${fix.ruleId}\`）`);
      lines.push('');
      lines.push(`**修复思路**：${fix.rationale || '见下方补丁'}`);
      lines.push('');
      lines.push(`**风险评估**：${fix.risk || 'medium'}　|　**来源**：${fix.source === 'llm' ? '大模型生成' : '内置模板'}`);
      lines.push('');
      if (fix.diff) {
        lines.push('```diff');
        lines.push(fix.diff);
        lines.push('```');
        lines.push('');
      }
      if (fix.tests && fix.tests.length > 0) {
        lines.push('建议补充的测试：');
        lines.push('');
        for (const test of fix.tests) lines.push(`- ${test}`);
        lines.push('');
      }
    });
  }

  lines.push('## 五、代码度量');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | ---: |');
  lines.push(`| 总行数 | ${metrics.totalLines} |`);
  lines.push(`| 有效代码行 | ${metrics.codeLines} |`);
  lines.push(`| 注释行 / 注释率 | ${metrics.commentLines} / ${(metrics.commentRatio * 100).toFixed(1)}% |`);
  lines.push(`| 函数数量 | ${metrics.functionCount} |`);
  lines.push(`| 最长函数 | ${metrics.maxFunctionLength} 行 |`);
  lines.push(`| 最大圈复杂度 | ${metrics.maxComplexity} |`);
  lines.push(`| 平均圈复杂度 | ${metrics.avgComplexity} |`);
  lines.push(`| 最大嵌套深度 | ${metrics.maxNesting} |`);
  lines.push(`| 超长行（>120 字符） | ${metrics.longLineCount} |`);
  lines.push(`| 简化可维护性指数 | ${metrics.maintainabilityIndex} / 100 |`);
  lines.push('');
  if (metrics.functions.length > 0) {
    lines.push('函数明细（按复杂度降序，最多 15 条）：');
    lines.push('');
    lines.push('| 函数 | 起止行 | 行数 | 圈复杂度 | 嵌套 | 参数 |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
    [...metrics.functions]
      .sort((a, b) => b.complexity - a.complexity)
      .slice(0, 15)
      .forEach((fn) => {
        lines.push(`| ${fn.name} | ${fn.startLine}–${fn.endLine} | ${fn.lines} | ${fn.complexity} | ${fn.nesting} | ${fn.params} |`);
      });
    lines.push('');
  }

  lines.push('## 附录：可复现性信息');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 记录 ID | \`${record.id}\` |`);
  lines.push(`| 代码指纹 | \`${source.codeHash}\` |`);
  lines.push(`| 规则版本 | \`${record.meta?.ruleVersion || 'v1'}\`（共 ${record.stats.appliedRuleCount || '-'} 条规则生效） |`);
  lines.push(`| 大模型 | ${record.llm?.model || '未启用'} |`);
  lines.push(`| 规则命中 | ${record.stats.staticIssueCount} 条 |`);
  lines.push(`| 大模型命中 | ${record.stats.llmIssueCount} 条（其中 ${record.stats.confirmedCount} 条与规则引擎结论互相印证） |`);
  lines.push(`| 审查耗时 | ${formatDuration(record.stats.durationMs)} |`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('本报告由 CodeGuard AI 自动生成，结论可依据代码指纹与上述参数完整复现。');

  return lines.join('\n');
}

/**
 * 生成自包含 HTML 报告
 * @param {object} record 评审记录
 * @returns {string} HTML 文本
 */
function toHtml(record) {
  const { score, metrics, source } = record;

  const severityRows = Object.entries(SEVERITIES)
    .map(([key, definition]) => {
      const count = record.stats.severityCounts[key] || 0;
      const percent = record.issues.length ? (count / record.issues.length) * 100 : 0;
      return `<tr>
        <td><span class="dot" style="background:${definition.color}"></span>${definition.label}<code>${key}</code></td>
        <td class="num">${count}</td>
        <td>${definition.weight}</td>
        <td><div class="bar"><span style="width:${percent.toFixed(1)}%;background:${definition.color}"></span></div></td>
      </tr>`;
    })
    .join('');

  const dimensionCards = Object.values(score.dimensions)
    .map(
      (dimension) => `<div class="dim">
        <div class="dim-head"><span>${dimension.label}</span><b style="color:${dimension.color}">${dimension.score}</b></div>
        <div class="bar"><span style="width:${dimension.score}%;background:${dimension.color}"></span></div>
        <div class="dim-foot">问题 ${dimension.issueCount} 项 · 扣分 ${dimension.penalty}</div>
      </div>`,
    )
    .join('');

  const issueRows = record.issues
    .map(
      (issue) => `<tr>
      <td class="num">${issue.line}</td>
      <td><span class="tag" style="background:${SEVERITIES[issue.severity].color}22;color:${SEVERITIES[issue.severity].color};border-color:${SEVERITIES[issue.severity].color}55">${issue.severityLabel}</span></td>
      <td><code>${escapeHtml(issue.ruleId)}</code></td>
      <td><b>${escapeHtml(issue.title)}</b><div class="msg">${escapeHtml(issue.message)}</div>
        ${issue.snippet ? `<pre class="snippet">${escapeHtml(issue.snippet)}</pre>` : ''}
        ${issue.suggestion ? `<div class="tip">建议：${escapeHtml(issue.suggestion)}</div>` : ''}
      </td>
      <td class="src">${issue.source === 'llm' ? `大模型<br><small>${escapeHtml(issue.roleLabel || '')}</small>` : '规则引擎'}</td>
    </tr>`,
    )
    .join('');

  const fixBlocks = (record.fixes || [])
    .map(
      (fix, index) => `<div class="fix">
      <h4>${index + 1}. 第 ${fix.line} 行 · ${escapeHtml(fix.title)} <code>${escapeHtml(fix.ruleId)}</code></h4>
      <p class="rationale">${escapeHtml(fix.rationale || '')}</p>
      <p class="meta">风险：${fix.risk || 'medium'} · 来源：${fix.source === 'llm' ? '大模型生成' : '内置模板'}</p>
      ${fix.diff ? `<pre class="diff">${escapeHtml(fix.diff)}</pre>` : ''}
      ${fix.tests && fix.tests.length ? `<ul class="tests">${fix.tests.map((test) => `<li>${escapeHtml(test)}</li>`).join('')}</ul>` : ''}
    </div>`,
    )
    .join('');

  const functionRows = [...metrics.functions]
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 15)
    .map(
      (fn) => `<tr><td>${escapeHtml(fn.name)}</td><td class="num">${fn.startLine}–${fn.endLine}</td>
      <td class="num">${fn.lines}</td><td class="num">${fn.complexity}</td>
      <td class="num">${fn.nesting}</td><td class="num">${fn.params}</td></tr>`,
    )
    .join('');

  const circumference = 2 * Math.PI * 54;
  const dash = (score.overall / 100) * circumference;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>代码审查报告 · ${escapeHtml(source.title)}</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--fg:#e6edf3;--muted:#8b949e;--accent:#2f81f7}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:32px 20px 80px}
header{display:flex;flex-wrap:wrap;gap:24px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:24px;margin-bottom:28px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:17px;margin:36px 0 14px;padding-left:10px;border-left:3px solid var(--accent)}
h3{font-size:15px;margin:24px 0 10px;color:var(--muted)}
h4{font-size:14px;margin:0 0 8px}
.sub{color:var(--muted);font-size:12px;line-height:1.9}
code{background:#21262d;padding:1px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
pre{background:#0b0f14;border:1px solid var(--border);border-radius:6px;padding:10px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin:8px 0}
.gauge{position:relative;width:150px;height:150px;flex:0 0 auto}
.gauge svg{transform:rotate(-90deg)}
.gauge .val{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.gauge .val b{font-size:36px;line-height:1}
.gauge .val span{font-size:12px;color:var(--muted);margin-top:4px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.dim-head{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px}
.dim-head b{font-size:18px}
.dim-foot{color:var(--muted);font-size:11px;margin-top:6px}
.bar{background:#21262d;border-radius:4px;height:8px;overflow:hidden}
.bar>span{display:block;height:100%;border-radius:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid;font-size:11px;white-space:nowrap}
.msg{color:var(--muted);font-size:12px;margin-top:3px}
.tip{color:#7ee787;font-size:12px;margin-top:6px}
.src{color:var(--muted);font-size:12px;white-space:nowrap}
.snippet{margin:6px 0 0;max-height:80px}
.diff{white-space:pre;font-size:12px}
.fix{border-left:3px solid var(--accent);padding-left:14px;margin:18px 0}
.rationale{color:var(--muted);font-size:13px;margin:4px 0}
.meta{color:var(--muted);font-size:11px;margin:4px 0}
.tests{margin:6px 0 0 18px;padding:0;font-size:12px;color:var(--muted)}
.foot{color:var(--muted);font-size:11px;text-align:center;margin-top:40px;border-top:1px solid var(--border);padding-top:16px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>代码审查报告 · ${escapeHtml(source.title)}</h1>
      <div class="sub">
        生成时间 ${escapeHtml(record.createdAt)}<br>
        审查引擎 ${record.engines?.llm ? '静态规则引擎 + 大模型语义评审' : '静态规则引擎'} · 语言 ${escapeHtml(source.language)}<br>
        代码规模 ${metrics.totalLines} 行（有效 ${metrics.nonBlankLines} 行） · 问题 ${record.issues.length} 项 · 耗时 ${formatDuration(record.stats.durationMs)}<br>
        代码指纹 <code>${escapeHtml(source.codeHash).slice(0, 32)}…</code>
      </div>
    </div>
    <div class="gauge">
      <svg width="150" height="150">
        <circle cx="75" cy="75" r="54" fill="none" stroke="#21262d" stroke-width="12"></circle>
        <circle cx="75" cy="75" r="54" fill="none" stroke="${score.overall >= 82 ? '#2da44e' : score.overall >= 70 ? '#d29922' : '#e5484d'}"
          stroke-width="12" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${circumference.toFixed(1)}"></circle>
      </svg>
      <div class="val"><b>${score.overall}</b><span>等级 ${score.grade} · ${escapeHtml(score.gradeLabel)}</span></div>
    </div>
  </header>

  <h2>一、结论摘要</h2>
  <div class="card">
    <p>${escapeHtml(score.advice)}</p>
    ${record.summary?.overview ? `<p>${escapeHtml(record.summary.overview)}</p>` : ''}
    ${
      record.summary?.blockers?.length
        ? `<h4>必须在合入前解决</h4><ul>${record.summary.blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : ''
    }
    ${
      record.summary?.actions?.length
        ? `<h4>建议后续动作</h4><ul>${record.summary.actions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : ''
    }
  </div>

  <h2>二、评分卡</h2>
  <div class="grid">${dimensionCards}</div>
  <div class="card">
    <table>
      <thead><tr><th>严重级别</th><th class="num">数量</th><th class="num">单项扣分</th><th>占比</th></tr></thead>
      <tbody>${severityRows}</tbody>
    </table>
    <p class="meta">${escapeHtml(score.model.description)} 规模归一化系数 σ = ${score.model.sigma}，原始扣分 ${score.penalty.raw}，归一化后 ${score.penalty.normalized}。</p>
  </div>

  <h2>三、问题清单</h2>
  <div class="card">
    ${
      record.issues.length
        ? `<table>
      <thead><tr><th class="num">行号</th><th>级别</th><th>规则</th><th>问题详情</th><th>来源</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table>`
        : '<p>本次审查未发现问题。</p>'
    }
  </div>

  ${fixBlocks ? `<h2>四、修复建议</h2><div class="card">${fixBlocks}</div>` : ''}

  <h2>五、代码度量</h2>
  <div class="card">
    <div class="grid">
      <div class="dim"><div class="dim-head"><span>总行数</span><b>${metrics.totalLines}</b></div></div>
      <div class="dim"><div class="dim-head"><span>有效代码行</span><b>${metrics.codeLines}</b></div></div>
      <div class="dim"><div class="dim-head"><span>注释率</span><b>${(metrics.commentRatio * 100).toFixed(1)}%</b></div></div>
      <div class="dim"><div class="dim-head"><span>函数数量</span><b>${metrics.functionCount}</b></div></div>
      <div class="dim"><div class="dim-head"><span>最长函数</span><b>${metrics.maxFunctionLength}</b></div></div>
      <div class="dim"><div class="dim-head"><span>最大圈复杂度</span><b>${metrics.maxComplexity}</b></div></div>
      <div class="dim"><div class="dim-head"><span>最大嵌套深度</span><b>${metrics.maxNesting}</b></div></div>
      <div class="dim"><div class="dim-head"><span>可维护性指数</span><b>${metrics.maintainabilityIndex}</b></div></div>
    </div>
    ${functionRows ? `<h3>函数明细（按复杂度降序）</h3>
    <table><thead><tr><th>函数</th><th class="num">行区间</th><th class="num">行数</th><th class="num">复杂度</th><th class="num">嵌套</th><th class="num">参数</th></tr></thead>
    <tbody>${functionRows}</tbody></table>` : ''}
  </div>

  <h2>附录：可复现性信息</h2>
  <div class="card">
    <table>
      <tbody>
        <tr><td>记录 ID</td><td><code>${escapeHtml(record.id)}</code></td></tr>
        <tr><td>代码指纹（SHA-256）</td><td><code>${escapeHtml(source.codeHash)}</code></td></tr>
        <tr><td>生效规则数</td><td>${record.stats.appliedRuleCount || '-'}</td></tr>
        <tr><td>大模型</td><td>${escapeHtml(record.llm?.model || '未启用')}</td></tr>
        <tr><td>规则引擎命中</td><td>${record.stats.staticIssueCount} 条</td></tr>
        <tr><td>大模型命中</td><td>${record.stats.llmIssueCount} 条（${record.stats.confirmedCount} 条与规则引擎互相印证）</td></tr>
      </tbody>
    </table>
    <p class="foot">本报告由 CodeGuard AI 自动生成。结论可依据代码指纹与上述参数完整复现。</p>
  </div>
</div>
</body>
</html>`;
}

/**
 * 生成 SARIF 2.1.0 报告
 * @param {object} record 评审记录
 * @returns {object} SARIF 对象
 */
function toSarif(record) {
  /** 收集规则元数据 */
  const ruleIndex = new Map();
  const rules = [];
  for (const issue of record.issues) {
    if (ruleIndex.has(issue.ruleId)) continue;
    ruleIndex.set(issue.ruleId, rules.length);
    rules.push({
      id: issue.ruleId,
      name: issue.ruleId,
      shortDescription: { text: issue.title },
      fullDescription: { text: issue.suggestion || issue.title },
      defaultConfiguration: { level: SARIF_LEVEL[issue.severity] || 'warning' },
      properties: {
        dimension: issue.dimension,
        severity: issue.severity,
        source: issue.source,
      },
    });
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'CodeGuard AI',
            informationUri: 'https://gitee.com/',
            version: record.meta?.version || '1.0.0',
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            startTimeUtc: record.createdAt,
            properties: {
              score: record.score.overall,
              grade: record.score.grade,
              codeHash: record.source.codeHash,
            },
          },
        ],
        results: record.issues.map((issue) => ({
          ruleId: issue.ruleId,
          ruleIndex: ruleIndex.get(issue.ruleId),
          level: SARIF_LEVEL[issue.severity] || 'warning',
          message: { text: `${issue.title}：${issue.message}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: record.source.fileName || 'snippet.txt' },
                region: { startLine: issue.line, startColumn: Math.max(1, issue.column || 1) },
              },
            },
          ],
          properties: {
            dimension: issue.dimension,
            severity: issue.severity,
            source: issue.source,
            confidence: issue.confidence,
          },
        })),
      },
    ],
  };
}

/**
 * 按格式导出报告
 * @param {object} record 评审记录
 * @param {string} format 目标格式：json | markdown | md | html | sarif
 * @returns {{content:string, contentType:string, fileName:string}}
 */
function exportReport(record, format) {
  const normalized = String(format || 'json').toLowerCase();
  const baseName = `codeguard-${record.id}`;

  switch (normalized) {
    case 'markdown':
    case 'md':
      return {
        content: toMarkdown(record),
        contentType: 'text/markdown; charset=utf-8',
        fileName: `${baseName}.md`,
      };
    case 'html':
      return {
        content: toHtml(record),
        contentType: 'text/html; charset=utf-8',
        fileName: `${baseName}.html`,
      };
    case 'sarif':
      return {
        content: JSON.stringify(toSarif(record), null, 2),
        contentType: 'application/json; charset=utf-8',
        fileName: `${baseName}.sarif.json`,
      };
    case 'json':
    default:
      return {
        content: JSON.stringify(record, null, 2),
        contentType: 'application/json; charset=utf-8',
        fileName: `${baseName}.json`,
      };
  }
}

module.exports = {
  toMarkdown,
  toHtml,
  toSarif,
  exportReport,
  groupBySeverity,
};
