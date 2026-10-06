/* ===========================================================================
 * CodeGuard AI · 评审台交互逻辑
 * ---------------------------------------------------------------------------
 * 组织方式：单一状态对象 + 纯渲染函数。所有网络访问集中在 api 对象中，
 * 便于后续替换为其他后端实现（例如接入 CI 机器人）。
 * =========================================================================== */

(function initApp() {
  'use strict';

  /* ------------------------------ 全局状态 ------------------------------ */
  const state = {
    meta: { severities: [], dimensions: [], rules: [], languages: [] },
    config: null,
    record: null,
    history: [],
    filters: { severity: 'all', source: 'all', keyword: '' },
    busy: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  /** HTML 转义，防止问题内容破坏页面结构 */
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 毫秒格式化 */
  function formatDuration(ms) {
    const value = Number(ms) || 0;
    if (value < 1000) return `${Math.round(value)} ms`;
    return `${(value / 1000).toFixed(2)} s`;
  }

  /** 轻提示 */
  let toastTimer = null;
  function toast(message, isError) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.toggle('error', Boolean(isError));
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 4200);
  }

  /* ------------------------------ 接口封装 ------------------------------ */
  const api = {
    /** 发起请求并解析 JSON，失败时抛出带后端错误码的异常 */
    async request(path, options) {
      const response = await fetch(path, options);
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!response.ok) {
        const error = new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
        error.code = data?.error?.code;
        error.status = response.status;
        error.details = data?.error?.details;
        throw error;
      }
      return data;
    },
    meta: (path) => api.request(`/api/meta/${path}`),
    review: (payload) => api.request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    list: (query) => api.request(`/api/reviews?${new URLSearchParams(query || {})}`),
    get: (id) => api.request(`/api/reviews/${id}`),
    remove: (id) => api.request(`/api/reviews/${id}`, { method: 'DELETE' }),
    reportUrl: (id, format) => `/api/reviews/${id}/report?format=${format}`,
  };

  /* ------------------------------ 初始化 ------------------------------ */
  async function bootstrap() {
    try {
      const [version, rules, health, overview] = await Promise.all([
        api.meta('config'),
        api.meta('rules'),
        api.meta('health'),
        api.meta('overview'),
      ]);

      state.config = version;
      state.meta.severities = rules.severities || [];
      state.meta.dimensions = rules.dimensions || [];
      state.meta.rules = rules.rules || [];
      state.history = overview.recent || [];

      renderEnvBadges(version, rules, health);
      renderSamples();
      renderSeverityFilters();
      renderSourceFilters();
      renderHistory(state.history);
      renderFooter(version);
    } catch (error) {
      toast(`初始化失败：${error.message}`, true);
      $('#badge-version').textContent = '后端未就绪';
      $('#badge-version').className = 'badge badge-danger';
    }
  }

  /** 顶栏状态徽标 */
  function renderEnvBadges(config, rules, health) {
    $('#badge-version').textContent = `${config.app.name} v${config.app.version}`;
    $('#badge-version').className = 'badge badge-muted';

    const llmBadge = $('#badge-llm');
    if (config.llm.available) {
      llmBadge.textContent = `大模型：${config.llm.providerLabel} / ${config.llm.model}`;
      llmBadge.className = 'badge badge-ok';
    } else {
      llmBadge.textContent = '大模型未配置 · 仅规则引擎';
      llmBadge.className = 'badge badge-warn';
    }

    const ruleBadge = $('#badge-rules');
    ruleBadge.textContent = `规则引擎 ${rules.total} 条`;
    ruleBadge.className = health.status === 'ok' ? 'badge badge-ok' : 'badge badge-warn';
    ruleBadge.title = `运行环境：${health.checks.map((c) => `${c.name}=${c.ok ? '正常' : '异常'}`).join('，')}`;
  }

  function renderFooter(config) {
    $('#footer-model').textContent = config.llm.available
      ? `当前模型：${config.llm.model}`
      : '当前为离线模式（未配置大模型密钥）';
  }

  /* ------------------------------ 组件渲染 ------------------------------ */
  function renderSamples() {
    const grid = $('#sample-grid');
    grid.innerHTML = '';
    for (const sample of window.CodeGuardSamples || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sample-card';
      button.innerHTML = `<b>${escapeHtml(sample.name)}</b><span>${escapeHtml(sample.description)}</span>`;
      button.addEventListener('click', () => {
        $('#input-code').value = sample.code;
        $('#input-filename').value = sample.fileName;
        updateCodeStats();
        toast(`已载入示例：${sample.name}`);
      });
      grid.appendChild(button);
    }
  }

  function renderSeverityFilters() {
    const container = $('#filter-severity');
    const colorOf = (key) => state.meta.severities.find((item) => item.key === key)?.color || '#8b98a5';
    const options = [{ key: 'all', label: '全部级别' }, ...state.meta.severities];
    container.innerHTML = '';
    for (const option of options) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${option.key === 'all' ? ' active' : ''}`;
      chip.dataset.severity = option.key;
      const dot = option.key === 'all' ? '' : `<span class="chip-dot" style="background:${colorOf(option.key)}"></span>`;
      chip.innerHTML = `${dot}${escapeHtml(option.label)}`;
      chip.addEventListener('click', () => {
        state.filters.severity = option.key;
        $$('#filter-severity .chip').forEach((node) => node.classList.toggle('active', node === chip));
        renderIssues();
      });
      container.appendChild(chip);
    }
  }

  function renderSourceFilters() {
    const container = $('#filter-source');
    const options = [
      { key: 'all', label: '全部来源' },
      { key: 'static', label: '规则引擎' },
      { key: 'llm', label: '大模型' },
    ];
    container.innerHTML = '';
    for (const option of options) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${option.key === 'all' ? ' active' : ''}`;
      chip.textContent = option.label;
      chip.addEventListener('click', () => {
        state.filters.source = option.key;
        $$('#filter-source .chip').forEach((node) => node.classList.toggle('active', node === chip));
        renderIssues();
      });
      container.appendChild(chip);
    }
  }

  /* ------------------------------ 输入区交互 ------------------------------ */
  function updateCodeStats() {
    const code = $('#input-code').value;
    const lines = code ? code.split('\n').length : 0;
    $('#code-stats').textContent = `${lines} 行 · ${code.length} 字符`;
  }

  function setupSourceTabs() {
    $$('.tabs-sm .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.tabs-sm .tab').forEach((node) => node.classList.toggle('active', node === tab));
        for (const name of ['paste', 'upload', 'sample']) {
          $(`#panel-${name}`).classList.toggle('hidden', name !== tab.dataset.source);
        }
      });
    });
  }

  function setupViewTabs() {
    $$('.card-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.card-tabs .tab').forEach((node) => node.classList.toggle('active', node === tab));
        for (const name of ['issues', 'fixes', 'metrics', 'history']) {
          $(`#view-${name}`).classList.toggle('active', name === tab.dataset.view);
        }
      });
    });
  }

  function setupUpload() {
    const dropzone = $('#dropzone');
    const input = $('#input-file');
    const list = $('#file-list');

    /** 读取文件列表到编辑区（多文件时拼接为多个 "// ==== 文件 ====" 分段） */
    const ingest = async (files) => {
      const accepted = [];
      for (const file of files) {
        if (file.size > 800 * 1024) {
          toast(`文件 ${file.name} 超过 800 KB，已跳过`, true);
          continue;
        }
        accepted.push({ name: file.name, size: file.size, text: await file.text() });
      }
      if (accepted.length === 0) return;

      list.innerHTML = accepted
        .map((item) => `<li><span>${escapeHtml(item.name)}</span><span class="file-size">${(item.size / 1024).toFixed(1)} KB</span></li>`)
        .join('');

      if (accepted.length === 1) {
        $('#input-code').value = accepted[0].text;
        $('#input-filename').value = accepted[0].name;
      } else {
        $('#input-code').value = accepted
          .map((item) => `// ==================== 文件：${item.name} ====================\n${item.text}`)
          .join('\n\n');
        $('#input-filename').value = accepted[0].name;
        toast(`已载入 ${accepted.length} 个文件，将合并为一次审查`);
      }
      updateCodeStats();
    };

    dropzone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { ingest(Array.from(input.files)); input.value = ''; });
    ['dragenter', 'dragover'].forEach((type) =>
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add('dragover');
      }));
    ['dragleave', 'drop'].forEach((type) =>
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.remove('dragover');
      }));
    dropzone.addEventListener('drop', (event) => {
      if (event.dataTransfer?.files?.length) ingest(Array.from(event.dataTransfer.files));
    });
  }

  function collectPayload() {
    const code = $('#input-code').value;
    if (!code.trim()) {
      toast('请先粘贴或上传待审查的代码', true);
      return null;
    }
    const roles = $$('#role-checkboxes input:checked').map((node) => node.value);
    return {
      code,
      fileName: $('#input-filename').value.trim() || null,
      language: $('#select-language').value || null,
      minSeverity: $('#select-min-severity').value || null,
      roles,
      useLlm: $('#opt-llm').checked,
      includeFixes: $('#opt-fixes').checked,
      includeSummary: $('#opt-summary').checked,
      fixLimit: 5,
    };
  }

  /* ------------------------------ 提交审查 ------------------------------ */
  async function runReview() {
    if (state.busy) return;
    const payload = collectPayload();
    if (!payload) return;

    state.busy = true;
    $('#btn-review').disabled = true;
    $('#review-spinner').classList.remove('hidden');
    $('#review-label').textContent = payload.useLlm ? '审查中（规则引擎 + 大模型）…' : '审查中（规则引擎）…';
    $('#review-note').textContent = payload.useLlm
      ? '正在并行调用多角色评审，通常需要 10~60 秒'
      : '离线规则引擎，通常 1 秒内完成';

    try {
      const result = await api.review(payload);
      const detail = await api.get(result.id);
      state.record = detail;
      renderResult(detail);
      toast(`审查完成：${detail.stats.issueCount} 个问题，综合得分 ${detail.score.overall}`);
      await refreshHistory();
    } catch (error) {
      toast(`审查失败：${error.message}`, true);
    } finally {
      state.busy = false;
      $('#btn-review').disabled = false;
      $('#review-spinner').classList.add('hidden');
      $('#review-label').textContent = '开始智能审查';
      $('#review-note').textContent = '';
    }
  }

  /* ------------------------------ 结果渲染 ------------------------------ */
  function renderResult(record) {
    $('#empty-state').classList.add('hidden');
    $('#result-body').classList.remove('hidden');

    const { score, metrics, stats, source } = record;
    const charts = window.CodeGuardCharts;

    charts.renderGauge($('#chart-gauge'), score.overall, score.grade, score.gradeLabel);
    charts.renderRadar($('#chart-radar'), score.dimensions);
    charts.renderSeverityBars($('#chart-severity'), stats.severityCounts, state.meta.severities);
    charts.renderDimensionBars($('#chart-dimension'), score.dimensions);

    const gradeBadge = $('#badge-grade');
    gradeBadge.textContent = `${score.grade} · ${score.gradeLabel}`;
    gradeBadge.style.cssText = `color:${charts.scoreColor(score.overall)};border-color:${charts.scoreColor(score.overall)}66`;

    $('#score-advice').textContent = score.advice;
    $('#meta-language').textContent = `${source.language}（${source.languageDetectedBy}）`;
    $('#meta-size').textContent = `${metrics.totalLines} 行 / ${metrics.functionCount} 函数`;
    $('#meta-issues').textContent = `${stats.issueCount} 个（阻断级 ${stats.severityCounts.blocker}）`;
    $('#meta-duration').textContent = formatDuration(stats.durationMs);

    // 结论摘要
    const summary = record.summary;
    $('#card-summary').classList.remove('hidden');
    $('#summary-source').textContent = summary?.offline
      ? '确定性兜底结论（未调用大模型）'
      : `大模型生成 · ${record.llm.model || ''}`;
    $('#summary-overview').textContent = summary?.overview || '（无）';
    $('#summary-blockers').innerHTML = (summary?.blockers?.length
      ? summary.blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
      : '<li style="color:var(--fg-dim)">无</li>');
    $('#summary-actions').innerHTML = (summary?.actions?.length
      ? summary.actions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
      : '<li style="color:var(--fg-dim)">无</li>');

    const roles = Object.entries(record.llm?.roleSummaries || {});
    $('#summary-roles').innerHTML = roles.length
      ? `<div class="role-summaries">${roles
          .map(([role, text]) => `<div><b>${escapeHtml(role)}</b>：${escapeHtml(text)}</div>`)
          .join('')}</div>`
      : '';

    const warningBox = $('#warning-box');
    if (record.warnings?.length) {
      warningBox.classList.remove('hidden');
      warningBox.innerHTML = `<b>审查提示</b><ul>${record.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    } else {
      warningBox.classList.add('hidden');
    }

    $('#count-issues').textContent = String(stats.issueCount);
    $('#count-fixes').textContent = String(record.fixes?.length || 0);

    renderIssues();
    renderFixes();
    renderMetrics(record);
    renderHistory(state.history);
  }

  /** 当前筛选条件下的问题列表 */
  function filteredIssues() {
    if (!state.record) return [];
    const keyword = state.filters.keyword.trim().toLowerCase();
    return state.record.issues.filter((issue) => {
      if (state.filters.severity !== 'all' && issue.severity !== state.filters.severity) return false;
      if (state.filters.source !== 'all' && issue.source !== state.filters.source) return false;
      if (keyword) {
        const haystack = `${issue.title} ${issue.ruleId} ${issue.message} ${issue.suggestion || ''}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }

  function renderIssues() {
    const container = $('#issue-list');
    if (!state.record) { container.innerHTML = ''; return; }

    const issues = filteredIssues();
    if (issues.length === 0) {
      container.innerHTML = '<li style="color:var(--fg-muted);font-size:13px;padding:18px 0;text-align:center">当前筛选条件下没有问题。</li>';
      return;
    }

    const severityOf = (key) => state.meta.severities.find((item) => item.key === key)
      || { label: key, color: '#8b98a5' };
    const fixMap = new Map((state.record.fixes || []).map((fix) => [fix.issueId, fix]));

    container.innerHTML = issues.map((issue) => {
      const definition = severityOf(issue.severity);
      const hasFix = fixMap.has(issue.id);
      return `<li class="issue" style="border-left-color:${definition.color}">
      <div class="issue-head">
        <span class="tag" style="background:${definition.color}22;color:${definition.color};border-color:${definition.color}55">${escapeHtml(definition.label)}</span>
        <span class="issue-title">${escapeHtml(issue.title)}</span>
        <span class="issue-line">第 ${issue.line} 行${issue.column > 1 ? `:${issue.column}` : ''}</span>
        <span class="tag" style="background:transparent;color:var(--fg-muted);border-color:var(--border)">${escapeHtml(issue.dimensionLabel)}</span>
        ${issue.confirmedBy ? '<span class="tag confirmed" style="background:#2da44e14;border-color:#2da44e55">双引擎印证</span>' : ''}
      </div>
      <p class="issue-msg">${escapeHtml(issue.message)}</p>
      ${issue.snippet ? `<pre class="issue-snippet">${escapeHtml(issue.snippet)}</pre>` : ''}
      ${issue.suggestion ? `<p class="issue-suggestion">建议：${escapeHtml(issue.suggestion)}</p>` : ''}
      <div class="issue-meta">
        <span>规则 <code>${escapeHtml(issue.ruleId)}</code></span>
        <span>来源 ${issue.source === 'llm' ? `大模型（${escapeHtml(issue.roleLabel || '')}）` : '规则引擎'}</span>
        <span>置信度 ${issue.confidence}</span>
        ${issue.reference ? `<span>${escapeHtml(issue.reference)}</span>` : ''}
      </div>
      ${hasFix ? '<div class="issue-actions"><button class="btn btn-ghost btn-sm" type="button" data-goto-fix="1">查看修复建议</button></div>' : ''}
    </li>`;
    }).join('');

    container.querySelectorAll('[data-goto-fix]').forEach((button) => {
      button.addEventListener('click', () => {
        $$('.card-tabs .tab').find((tab) => tab.dataset.view === 'fixes').click();
      });
    });
  }

  function renderFixes() {
    const container = $('#fix-list');
    const fixes = state.record?.fixes || [];
    if (fixes.length === 0) {
      container.innerHTML = '<p style="color:var(--fg-muted);font-size:13px">本次未生成修复建议。</p>';
      return;
    }

    container.innerHTML = fixes.map((fix, index) => {
      const diffHtml = (fix.diff || '')
        .split('\n')
        .map((line) => {
          if (line.startsWith('+')) return `<span class="add">${escapeHtml(line)}</span>`;
          if (line.startsWith('-')) return `<span class="del">${escapeHtml(line)}</span>`;
          if (line.startsWith('@@')) return `<span class="hunk">${escapeHtml(line)}</span>`;
          return escapeHtml(line);
        })
        .join('\n');

      return `<div class="fix">
      <h4>${index + 1}. 第 ${fix.line} 行 · ${escapeHtml(fix.title)} <code>${escapeHtml(fix.ruleId)}</code></h4>
      <p class="rationale">${escapeHtml(fix.rationale || '')}</p>
      <p class="meta">风险等级 ${escapeHtml(fix.risk || 'medium')} · 来源 ${fix.source === 'llm' ? '大模型生成' : '内置修复模板'}${fix.fallbackReason ? ` · 降级原因：${escapeHtml(fix.fallbackReason)}` : ''}</p>
      ${fix.before || fix.after ? `<div class="codes">
        ${fix.before ? `<div><h5>修复前</h5><pre class="diff">${escapeHtml(fix.before)}</pre></div>` : ''}
        ${fix.after ? `<div><h5>修复后</h5><pre class="diff">${escapeHtml(fix.after)}</pre></div>` : ''}
      </div>` : ''}
      ${diffHtml ? `<pre class="diff">${diffHtml}</pre>` : ''}
      ${fix.tests?.length ? `<ul class="tests">${fix.tests.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
    </div>`;
    }).join('');
  }

  function renderMetrics(record) {
    const metrics = record.metrics;
    const tiles = [
      { label: '总行数', value: metrics.totalLines, unit: '行' },
      { label: '有效代码行', value: metrics.codeLines, unit: '行' },
      { label: '注释行 / 注释率', value: metrics.commentLines, unit: `行 · ${(metrics.commentRatio * 100).toFixed(1)}%` },
      { label: '函数数量', value: metrics.functionCount, unit: '个' },
      { label: '最长函数', value: metrics.maxFunctionLength, unit: '行' },
      { label: '最大圈复杂度', value: metrics.maxComplexity, unit: '' },
      { label: '平均圈复杂度', value: metrics.avgComplexity, unit: '' },
      { label: '最大嵌套深度', value: metrics.maxNesting, unit: '层' },
      { label: '超长行（>120）', value: metrics.longLineCount, unit: '行' },
      { label: '可维护性指数', value: metrics.maintainabilityIndex, unit: '/100' },
    ];

    const functionRows = [...(metrics.functions || [])]
      .sort((a, b) => b.complexity - a.complexity)
      .slice(0, 25)
      .map((fn) => `<tr>
        <td>${escapeHtml(fn.name)}</td>
        <td class="num">${fn.startLine}–${fn.endLine}</td>
        <td class="num">${fn.lines}</td>
        <td class="num">${fn.complexity}</td>
        <td class="num">${fn.nesting}</td>
        <td class="num">${fn.params}</td>
      </tr>`).join('');

    const ruleRows = Object.entries(record.stats.ruleHits || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([ruleId, count]) => {
        const rule = state.meta.rules.find((item) => item.id === ruleId);
        return `<tr><td><code>${escapeHtml(ruleId)}</code></td><td>${escapeHtml(rule ? rule.title : '-')}</td><td class="num">${count}</td></tr>`;
      }).join('');

    $('#metrics-body').innerHTML = `
      <div class="metric-grid">
        ${tiles.map((tile) => `<div class="metric-tile"><div class="label">${tile.label}</div>
          <div class="value">${tile.value}<span class="unit">${tile.unit}</span></div></div>`).join('')}
      </div>
      ${functionRows ? `<h4 style="font-size:13px;margin:0 0 10px">函数明细（按圈复杂度降序，最多 25 条）</h4>
      <table><thead><tr><th>函数</th><th class="num">行区间</th><th class="num">行数</th><th class="num">复杂度</th><th class="num">嵌套</th><th class="num">参数</th></tr></thead>
      <tbody>${functionRows}</tbody></table>` : '<p style="color:var(--fg-muted);font-size:13px">未识别到函数定义。</p>'}
      <div class="divider"></div>
      <h4 style="font-size:13px;margin:0 0 10px">规则命中排行</h4>
      <table><thead><tr><th>规则</th><th>名称</th><th class="num">命中</th></tr></thead><tbody>${ruleRows || '<tr><td colspan="3" style="color:var(--fg-muted)">无</td></tr>'}</tbody></table>
      <div class="divider"></div>
      <h4 style="font-size:13px;margin:0 0 10px">扣分构成</h4>
      <table><thead><tr><th>规则</th><th>问题</th><th class="num">级别</th><th class="num">生效扣分</th></tr></thead>
      <tbody>${(record.score.deductions || []).slice(0, 15).map((item) => `<tr>
        <td><code>${escapeHtml(item.ruleId)}</code></td><td>${escapeHtml(item.title)}</td>
        <td class="num">${escapeHtml(item.severity)}</td><td class="num">${item.applied}</td></tr>`).join('')}</tbody></table>
    `;
  }

  function renderHistory(items) {
    const container = $('#history-body');
    const list = items || [];
    if (list.length === 0) {
      container.innerHTML = '<p style="color:var(--fg-muted);font-size:13px">暂无历史评审记录。</p>';
      return;
    }

    const colorOf = (score) => (window.CodeGuardCharts ? window.CodeGuardCharts.scoreColor(score) : '#8b98a5');

    container.innerHTML = `
      <div style="margin-bottom:16px">${'<div id="chart-history"></div>'}</div>
      <table>
        <thead><tr><th>时间</th><th>标题</th><th>语言</th><th class="num">规模</th><th class="num">得分</th><th class="num">问题</th><th>操作</th></tr></thead>
        <tbody>
          ${list.map((item) => `<tr class="history-row" data-id="${escapeHtml(item.id)}">
            <td class="num">${escapeHtml(String(item.createdAt).replace('T', ' ').slice(0, 16))}</td>
            <td>${escapeHtml(item.title)}</td>
            <td>${escapeHtml(item.language || '-')}</td>
            <td class="num">${item.lines || 0}</td>
            <td class="num"><span class="score-pill" style="color:${colorOf(item.score)};border-color:${colorOf(item.score)}66">${item.score ?? '-'}</span></td>
            <td class="num">${item.issueCount ?? 0}</td>
            <td><button class="btn btn-ghost btn-sm" data-load="${escapeHtml(item.id)}" type="button">查看</button>
                <button class="btn btn-ghost btn-sm" data-delete="${escapeHtml(item.id)}" type="button">删除</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    if (window.CodeGuardCharts) {
      window.CodeGuardCharts.renderSparkline($('#chart-history'), list);
    }

    container.querySelectorAll('[data-load]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const record = await api.get(button.dataset.load);
          state.record = record;
          renderResult(record);
          $$('.card-tabs .tab').find((tab) => tab.dataset.view === 'issues').click();
          toast(`已载入历史记录 ${record.id}`);
        } catch (error) {
          toast(`载入失败：${error.message}`, true);
        }
      });
    });

    container.querySelectorAll('[data-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await api.remove(button.dataset.delete);
          toast('已删除该条记录');
          await refreshHistory();
        } catch (error) {
          toast(`删除失败：${error.message}`, true);
        }
      });
    });
  }

  async function refreshHistory() {
    try {
      const overview = await api.meta('overview');
      state.history = overview.recent || [];
      renderHistory(state.history);
    } catch (error) {
      /* 历史刷新失败不影响主流程 */
    }
  }

  /* ------------------------------ 事件绑定 ------------------------------ */
  function bindEvents() {
    $('#input-code').addEventListener('input', updateCodeStats);
    $('#btn-review').addEventListener('click', runReview);
    $('#btn-clear').addEventListener('click', () => {
      $('#input-code').value = '';
      $('#input-filename').value = 'demo.js';
      $('#file-list').innerHTML = '';
      updateCodeStats();
      toast('已清空输入');
    });
    $('#btn-collapse').addEventListener('click', () => {
      const card = $('#card-input');
      card.classList.toggle('collapsed');
      $('#btn-collapse').textContent = card.classList.contains('collapsed') ? '展开' : '收起';
      const panel = $('#panel-paste');
      panel.style.display = card.classList.contains('collapsed') ? 'none' : '';
    });
    $('#filter-keyword').addEventListener('input', (event) => {
      state.filters.keyword = event.target.value;
      renderIssues();
    });

    $$('[data-export]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!state.record) { toast('请先完成一次审查', true); return; }
        window.open(api.reportUrl(state.record.id, button.dataset.export), '_blank');
      });
    });

    // Ctrl/Cmd + Enter 快捷提交
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        runReview();
      }
    });
  }

  /* ------------------------------ 启动 ------------------------------ */
  document.addEventListener('DOMContentLoaded', () => {
    setupSourceTabs();
    setupViewTabs();
    setupUpload();
    bindEvents();
    updateCodeStats();
    bootstrap();
  });
})();
