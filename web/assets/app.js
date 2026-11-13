'use strict';

/**
 * CodeGuard AI · AI 编程学习助手 前端交互
 * ---------------------------------------------------------------------------
 * 三个工作模式互相独立（结果不串台）：
 *   complete  AI 解题与补全（文本 + 图片提问）→ 解题讲解 + 完整代码 → 可出题测试
 *   practice  代码测试（自由编码）→ 真实运行看输出
 *   fix       错误检查与修复 → 逐条修改方法 + 修复后的代码
 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const MODES = ['complete', 'practice', 'fix'];
const INPUT_TITLES = { complete: 'AI 解题与补全', practice: '代码测试', fix: '错误检查与修复' };
const EMPTY_STATES = {
  complete: ['还没有开始', '左边输入问题（可配图片），点「开始解题 / 补全」'],
  practice: ['还没有运行记录', '在左边粘贴要运行的代码，点「运行」看输出；也可以先在「AI 解题与补全」里出题来测'],
  fix: ['还没有开始', '左边贴上有错误的代码，点「开始检查与修复」'],
};

const SOURCE_LABELS = {
  llm: '真实 AI',
  template: '内置模板库',
  mock: '离线演示',
  none: '未生成',
};

const state = {
  mode: 'complete',
  modeResults: { complete: null, practice: null, fix: null },
  practiceRendered: false,
  image: null,          // { dataUrl, name }
  quiz: null,           // 最近一次生成的变式题
  providers: [],
};

/* ==================== 基础工具 ==================== */

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 2800);
}

function setBusy(buttonId, spinnerId, busy) {
  const button = $(buttonId);
  const spinner = spinnerId ? $(spinnerId) : null;
  if (button) button.disabled = busy;
  if (spinner) spinner.classList.toggle('hidden', !busy);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} 毫秒`;
  return `${(ms / 1000).toFixed(2)} 秒`;
}

/**
 * 每位访客自己的大模型配置（仅存于本人浏览器 localStorage，不上传服务器）
 * @returns {{provider?:string, apiKey?:string, model?:string, baseUrl?:string}|null}
 */
function loadLocalLlm() {
  try {
    const raw = localStorage.getItem('cgai-llm');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** 保存访客自己的大模型配置（只影响本人浏览器） */
function saveLocalLlm(cfg) {
  try { localStorage.setItem('cgai-llm', JSON.stringify(cfg)); } catch { /* 隐私模式忽略 */ }
}

/** 清除访客本浏览器的大模型配置 */
function clearLocalLlm() {
  try { localStorage.removeItem('cgai-llm'); } catch { /* 隐私模式忽略 */ }
}

/** 把本地 Key 掩码为 sk-…abcd 形式（绝不完整展示） */
function maskKey(key) {
  if (!key) return '';
  return key.length <= 8 ? `${key.slice(0, 2)}…` : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

async function api(path, options = {}) {
  // 涉及大模型的请求自动带上访客自己的配置（仅本次请求生效）
  const localLlm = path === '/api/completions' ? loadLocalLlm() : null;
  const llmHeaders = {};
  if (localLlm) {
    if (localLlm.provider) llmHeaders['x-llm-provider'] = String(localLlm.provider);
    if (localLlm.apiKey) llmHeaders['x-llm-key'] = String(localLlm.apiKey);
    if (localLlm.model) llmHeaders['x-llm-model'] = String(localLlm.model);
    if (localLlm.baseUrl) llmHeaders['x-llm-base-url'] = String(localLlm.baseUrl);
  }
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...llmHeaders, ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const message = data?.error?.message || data?.message || `请求失败（HTTP ${res.status}）`;
    throw new Error(message);
  }
  return data;
}

// fetch 层错误转成人话（连不上本机服务是新手最常见的情况）
if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
  window.fetch = ((original) => (...args) => original(...args).catch((error) => {
    if (error && /Failed to fetch|Load failed|NetworkError|fetch failed/i.test(error.message || '')) {
      throw new Error('连不上本机服务：请确认 start.bat 的黑色窗口还开着（关了就再双击它）');
    }
    throw error;
  }))(window.fetch.bind(window));
}

/* ==================== 使用记录（每用户只存自己的浏览器） ==================== */

const HISTORY_KEY = 'cgai-history';
const HISTORY_MAX = 30;

/** 存储后端：优先浏览器 localStorage；不可用时回退内存（隐私模式 / 测试） */
function historyBackend() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cgai-probe', '1');
      localStorage.removeItem('cgai-probe');
      return localStorage;
    }
  } catch { /* 隐私模式回退内存 */ }
  if (!historyBackend._mem) {
    const mem = new Map();
    historyBackend._mem = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
  return historyBackend._mem;
}

/** 读取使用记录（新 → 旧） */
function loadHistory() {
  try { return JSON.parse(historyBackend().getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

/** 追加一条使用记录（超出上限时丢弃最旧的） */
function addHistoryRecord(record) {
  const list = loadHistory();
  list.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, time: new Date().toISOString(), ...record });
  const trimmed = list.slice(0, HISTORY_MAX);
  try { historyBackend().setItem(HISTORY_KEY, JSON.stringify(trimmed)); } catch { /* 配额满静默 */ }
  return trimmed;
}

/** 删除一条记录 */
function removeHistoryRecord(id) {
  const list = loadHistory().filter((item) => item.id !== id);
  try { historyBackend().setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* 静默 */ }
  return list;
}

/** 清空使用记录 */
function clearHistory() {
  try { historyBackend().removeItem(HISTORY_KEY); } catch { /* 静默 */ }
}

/** 从一次 AI 调用结果构造记录（超长文本截断，省空间） */
function recordFromResult(featureLabel, question, result) {
  const clip = (text, max) => (typeof text === 'string' ? text.slice(0, max) : '');
  return {
    feature: featureLabel,
    question: clip(question, 300) || '(无文字描述)',
    language: result.language || '',
    source: result.completionSource || 'none',
    durationMs: result.stats?.durationMs || 0,
    issueCount: Array.isArray(result.issues) ? result.issues.length : 0,
    answer: clip(result.answer || result.summary?.text || '', 4000),
    code: clip(result.fixedCode || result.completedCode || '', 4000),
  };
}

/** 时间显示为 MM-DD HH:mm */
function formatHistoryTime(iso) {
  try {
    const d = new Date(iso);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return String(iso || ''); }
}

/** 渲染使用记录列表 */
function renderHistory() {
  const list = loadHistory();
  const count = $('#history-count');
  if (count) count.textContent = `共 ${list.length} 条`;
  $('#history-list').innerHTML = list.length
    ? list.map((item) => `
      <li class="issue">
        <details>
          <summary>
            <span class="issue-title">[${esc(item.feature)}] ${esc(item.question.slice(0, 40))}${item.question.length > 40 ? '…' : ''}</span>
            <span class="issue-line">${esc(formatHistoryTime(item.time))}</span>
            <span class="tag">${esc(SOURCE_LABELS[item.source] || item.source || '-')}</span>
          </summary>
          <p class="issue-msg"><b>问：</b>${esc(item.question)}</p>
          <p class="issue-msg">${esc(item.language || '语言未指定')}${item.durationMs ? ` · 耗时 ${esc(formatDuration(item.durationMs))}` : ''}${item.issueCount ? ` · 发现问题 ${item.issueCount} 处` : ''}</p>
          ${item.answer ? `<p class="issue-suggestion">答：${esc(item.answer)}</p>` : ''}
          ${item.code ? `<pre class="code-output">${esc(item.code)}</pre>` : ''}
          <button class="btn btn-ghost btn-sm" type="button" data-del="${esc(item.id)}">删除这条</button>
        </details>
      </li>`).join('')
    : '<li class="issue"><p class="issue-msg">还没有使用记录——去「AI 解题与补全」问个问题试试。</p></li>';
}

/** 打开使用记录面板 */
function openHistory() {
  $('#history-mask').classList.remove('hidden');
  renderHistory();
}

function updateStats(textarea, label) {
  const value = textarea.value;
  label.textContent = `${value ? value.split('\n').length : 0} 行 · ${value.length} 字符`;
  refreshGutter(textarea);
}

/* ==================== 代码编辑器行号栏 ==================== */

/**
 * 刷新行号栏（内容变化 / 程序化赋值后调用）
 * @param {HTMLTextAreaElement} textarea 代码输入框
 */
function refreshGutter(textarea) {
  if (!textarea || typeof textarea.closest !== 'function') return;
  const editor = textarea.closest('.editor');
  const gutter = editor ? editor.querySelector('.editor-gutter') : null;
  if (!gutter) return;
  const count = (textarea.value || '').split('\n').length;
  if (gutter.childElementCount !== count) {
    gutter.innerHTML = Array.from({ length: count }, (_, index) => `<span>${index + 1}</span>`).join('');
  }
  gutter.scrollTop = textarea.scrollTop;
}

/**
 * 为代码输入框挂接行号栏（输入时刷新、滚动时同步）
 * @param {HTMLTextAreaElement} textarea 代码输入框
 */
function attachGutter(textarea) {
  if (!textarea || typeof textarea.addEventListener !== 'function') return;
  textarea.addEventListener('input', () => refreshGutter(textarea));
  textarea.addEventListener('scroll', () => {
    if (typeof textarea.closest !== 'function') return;
    const gutter = textarea.closest('.editor')?.querySelector('.editor-gutter');
    if (gutter) gutter.scrollTop = textarea.scrollTop;
  });
  refreshGutter(textarea);
}

/* ==================== 代码自动格式化 ==================== */

/**
 * 重排一个语句段的续行：同一组括号跨行时保持同一列
 * ---------------------------------------------------------------------------
 *   - 闭括号独占一行 → 与开括号**同一列**
 *   - 其余续行 → 对齐到最内层开括号的后一列（参数列表标准对齐）
 *   - 无未闭合括号的续行 → 与首行同列（保持语句并列关系）
 * @param {string} body 语句段（可多行，已去首尾空白）
 * @param {number} baseCol 首行缩进列
 * @returns {string} 对齐后的文本
 */
function alignSegment(body, baseCol) {
  const lines = body.split('\n');
  const outLines = [];
  const stack = []; // 未闭合开括号所在列
  let state = 'code'; // code | line | block | sq | dq | tpl

  for (let li = 0; li < lines.length; li += 1) {
    const content = lines[li].trim();
    if (!content) { outLines.push(''); continue; }

    let prefixCol;
    if (li === 0) prefixCol = baseCol;
    else if (/^[)\]]/.test(content) && stack.length > 0) prefixCol = stack[stack.length - 1];
    else if (stack.length > 0) prefixCol = stack[stack.length - 1] + 1;
    else prefixCol = baseCol;

    const text = ' '.repeat(Math.max(0, prefixCol)) + content;
    outLines.push(text);

    // 扫描本行（按输出列）更新括号栈
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1];
      if (state === 'line') { if (ch === '\n') state = 'code'; continue; }
      if (state === 'block') { if (ch === '*' && next === '/') { i += 1; state = 'code'; } continue; }
      if (state !== 'code') {
        if (ch === '\\') { i += 1; continue; }
        if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) {
          state = 'code';
        }
        continue;
      }
      if (ch === '/' && next === '/') { state = 'line'; i += 1; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 1; continue; }
      if (ch === "'") { state = 'sq'; continue; }
      if (ch === '"') { state = 'dq'; continue; }
      if (ch === '`') { state = 'tpl'; continue; }
      if (ch === '(' || ch === '[') stack.push(i);
      else if (ch === ')' || ch === ']') stack.pop();
    }
  }
  return outLines.join('\n');
}

/**
 * 代码格式化：自动换行 + 缩进规范（括号类语言）
 * ---------------------------------------------------------------------------
 * 规则（启发式、保守）：
 *   1. 行首 Tab 换算为 4 空格、去掉行尾空白
 *   2. 括号类语言（C/C++/Java/JS）：在顶层的 ; { } 后自动断行（括号内的分号如
 *      for(...;...;...) 不断）；} 后跟 else/catch/finally/while 保持同行
 *   3. 按大括号深度重排 4 空格缩进；字符串与注释内的符号原样保留，不动语义
 *   4. Python：仅做空白规范化（Tab→空格、去行尾空白），不改缩进结构
 * @param {string} raw 原始代码
 * @param {string} [language] 语言键（缺省按内容推断）
 * @returns {string} 格式化后的代码
 */
function formatCode(raw, language = '') {
  const text0 = String(raw ?? '').replace(/\r\n?/g, '\n');
  const isPython = /python/i.test(language)
    || (!language && !/[{}]/.test(text0) && /^\s*\w+.*:$/m.test(text0));

  // —— 公共：行首 Tab→4 空格、去行尾空白 ——
  const normalized = text0.split('\n').map((line) => {
    const lead = /^[\t ]*/.exec(line)[0];
    const body = line.slice(lead.length).replace(/\s+$/, '');
    const width = [...lead].reduce((sum, ch) => sum + (ch === '\t' ? 4 : 1), 0);
    return body ? `${' '.repeat(width)}${body}` : '';
  }).join('\n');

  if (isPython) return normalized;

  // —— 顶层断行扫描（自带字符串/注释状态机，绝不切开语义） ——
  const segments = [];
  let buf = '';
  let parenDepth = 0;
  let state = 'code'; // code | line | block | sq | dq | tpl
  const chars = [...normalized];

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const next = chars[i + 1];
    buf += ch;

    if (state === 'line') { if (ch === '\n') state = 'code'; continue; }
    if (state === 'block') {
      if (ch === '*' && next === '/') { buf += '/'; i += 1; state = 'code'; }
      continue;
    }
    if (state !== 'code') {
      // 字符串内：转义与结束引号
      if (ch === '\\') { buf += next ?? ''; i += 1; continue; }
      if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) {
        state = 'code';
      }
      continue;
    }

    if (ch === '/' && next === '/') { buf += next; i += 1; state = 'line'; continue; }
    if (ch === '/' && next === '*') { buf += next; i += 1; state = 'block'; continue; }
    if (ch === "'") { state = 'sq'; continue; }
    if (ch === '"') { state = 'dq'; continue; }
    if (ch === '`') { state = 'tpl'; continue; }
    if (ch === '(' || ch === '[') { parenDepth += 1; continue; }
    if (ch === ')' || ch === ']') { parenDepth = Math.max(0, parenDepth - 1); continue; }

    if (parenDepth === 0 && (ch === ';' || ch === '{' || ch === '}')) {
      // } 后紧跟 else / catch / finally / while（do-while）时保持同行
      const rest = chars.slice(i + 1).join('');
      const nextWord = /^\s*([A-Za-z_$][\w$]*)/.exec(rest)?.[1] || '';
      const keepSameLine = ch === '}' && /^(?:else|catch|finally|while)\b/.test(nextWord);
      if (keepSameLine) continue;

      if (ch === '}') {
        // } 单独成段：与对应 { 保持同一列（Allman 风格）
        if (buf.slice(0, -1).trim()) segments.push(buf.slice(0, -1));
        segments.push('}');
        buf = '';
      } else if (ch === '{') {
        const before = buf.slice(0, -1);
        const linePrefix = before.slice(before.lastIndexOf('\n') + 1);
        if (/^\s*$/.test(linePrefix)) {
          // { 独占一行：单独成段，与对应 } 同列
          if (before.trim()) segments.push(before);
          segments.push('{');
        } else {
          // K&R 风格：{ 紧跟语句行尾，随语句成段
          segments.push(buf);
        }
        buf = '';
      } else {
        segments.push(buf); // ; 语句结束
        buf = '';
      }
    }
  }
  if (buf.trim()) segments.push(buf);

  // —— 按大括号深度重排缩进；续行按括号列对齐 ——
  let depth = 0;
  const out = [];
  for (const seg of segments) {
    const body = seg.trim();
    if (!body) continue;
    // 保留语句之间的空行（最多一行）
    if ((seg.match(/^\n+/) || [''])[0].length >= 2 && out.length > 0) out.push('');
    // 统计该段顶层大括号增减（跳过字符串/注释）
    let delta = 0;
    let innerState = 'code';
    let innerParen = 0;
    const segChars = [...body];
    for (let i = 0; i < segChars.length; i += 1) {
      const ch = segChars[i];
      const next = segChars[i + 1];
      if (innerState === 'line') { if (ch === '\n') innerState = 'code'; continue; }
      if (innerState === 'block') { if (ch === '*' && next === '/') { i += 1; innerState = 'code'; } continue; }
      if (innerState !== 'code') {
        if (ch === '\\') { i += 1; continue; }
        if ((innerState === 'sq' && ch === "'") || (innerState === 'dq' && ch === '"') || (innerState === 'tpl' && ch === '`')) innerState = 'code';
        continue;
      }
      if (ch === '/' && next === '/') { innerState = 'line'; i += 1; continue; }
      if (ch === '/' && next === '*') { innerState = 'block'; i += 1; continue; }
      if (ch === "'") { innerState = 'sq'; continue; }
      if (ch === '"') { innerState = 'dq'; continue; }
      if (ch === '`') { innerState = 'tpl'; continue; }
      if (ch === '(' || ch === '[') innerParen += 1;
      else if (ch === ')' || ch === ']') innerParen = Math.max(0, innerParen - 1);
      else if (innerParen === 0 && ch === '{') delta += 1;
      else if (innerParen === 0 && ch === '}') delta -= 1;
    }

    const startsCloser = /^[}\])]/.test(body);
    const indentLevel = Math.max(0, depth + (startsCloser ? -1 : 0));
    out.push(alignSegment(body, indentLevel * 4));
    depth = Math.max(0, depth + delta);
  }

  return out.join('\n');
}

/**
 * 代码框智能编辑：回车自动缩进、粘贴「挤成一行」的代码自动换行规范
 * @param {HTMLTextAreaElement} textarea 代码输入框
 * @param {string} langSelectId 对应的语言下拉框 id（可为空）
 */
function attachSmartEditing(textarea, langSelectId) {
  if (!textarea || typeof textarea.addEventListener !== 'function') return;
  const currentLang = () => {
    const select = langSelectId ? document.querySelector(`#${langSelectId}`) : null;
    return select ? select.value : '';
  };

  // 回车：实时对齐——括号内续行对齐开括号后一列；其余沿用缩进，{ / : 后加深一级
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      // Tab 插入 4 空格（不移焦）
      event.preventDefault();
      textarea.setRangeText('    ', textarea.selectionStart, textarea.selectionEnd, 'end');
      textarea.dispatchEvent(new Event('input'));
      return;
    }

    if (['}', ')', ']'].includes(event.key)) {
      // 输入闭括号：若位于行首（前只有空白），实时把该行对齐到配对括号的列
      const { value, selectionStart, selectionEnd } = textarea;
      if (selectionStart === selectionEnd) {
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const beforeOnLine = value.slice(lineStart, selectionStart);
        if (beforeOnLine.trim() === '') {
          const col = closeAlignCol(value.slice(0, selectionStart), event.key);
          if (col !== null) {
            event.preventDefault();
            textarea.setRangeText(
              `${' '.repeat(Math.max(0, col))}${event.key}`,
              lineStart,
              selectionEnd,
              'end',
            );
            textarea.dispatchEvent(new Event('input'));
            return;
          }
        }
      }
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const { value, selectionStart, selectionEnd } = textarea;
    const col = enterIndentCol(value.slice(0, selectionStart));
    textarea.setRangeText(`\n${' '.repeat(Math.max(0, col))}`, selectionStart, selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input'));
  });

  // 粘贴：整段只有一行但含语句分隔符（典型是格式被压扁的代码）时自动换行缩进
  textarea.addEventListener('paste', (event) => {
    const clipboard = event.clipboardData || window.clipboardData;
    const text = clipboard ? clipboard.getData('text') : '';
    if (!text || text.includes('\n') || !/[;{}]/.test(text)) return;
    event.preventDefault();
    const formatted = formatCode(text, currentLang());
    textarea.setRangeText(formatted, textarea.selectionStart, textarea.selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input'));
    toast('粘贴的代码已自动换行缩进');
  });
}

/* ==================== 写码时实时括号对齐 ==================== */

/**
 * 扫描括号栈：返回未闭合的开括号信息（跳过字符串与注释）
 * @param {string} text 光标之前的文本
 * @returns {Array<{char:string, col:number, indent:number}>} 栈内元素
 *   col = 开括号所在列；indent = 开括号所在行的行首缩进列
 */
function scanBracketStack(text) {
  const stack = [];
  const pairOf = { ')': '(', ']': '[', '}': '{' };
  let state = 'code'; // code | line | block | sq | dq | tpl
  let col = 0;
  let indent = 0;
  let seenContent = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\n') {
      if (state === 'line') state = 'code';
      col = 0;
      indent = 0;
      seenContent = false;
      continue;
    }
    if (!seenContent && (ch === ' ' || ch === '\t')) { col += 1; continue; }
    if (!seenContent) { seenContent = true; indent = col; }

    if (state === 'line') { col += 1; continue; }
    if (state === 'block') {
      col += 1;
      if (ch === '*' && next === '/') { i += 1; col += 1; state = 'code'; }
      continue;
    }
    if (state !== 'code') {
      if (ch === '\\') { i += 1; col += 2; continue; }
      col += 1;
      if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'tpl' && ch === '`')) {
        state = 'code';
      }
      continue;
    }

    col += 1;
    if (ch === '/' && next === '/') { i += 1; col += 1; state = 'line'; continue; }
    if (ch === '/' && next === '*') { i += 1; col += 1; state = 'block'; continue; }
    if (ch === "'") { state = 'sq'; continue; }
    if (ch === '"') { state = 'dq'; continue; }
    if (ch === '`') { state = 'tpl'; continue; }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ char: ch, col: col - 1, indent });
    } else if (pairOf[ch]) {
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s].char === pairOf[ch]) { stack.length = s; break; }
      }
    }
  }
  return stack;
}

/**
 * 输入闭括号时该行应缩进到的列（同一组括号保持同一列）
 * ---------------------------------------------------------------------------
 *   } → 与配对 { 所在行的行首缩进同列（Allman：即 { 的列）
 *   ) / ] → 与配对 ( / [ 的列相同
 * @param {string} textBefore 光标之前的文本
 * @param {string} closer 闭括号字符
 * @returns {number|null} 目标列；无配对开括号时返回 null（不干预）
 */
function closeAlignCol(textBefore, closer) {
  const pair = { ')': '(', ']': '[', '}': '{' }[closer];
  const stack = scanBracketStack(textBefore);
  for (let s = stack.length - 1; s >= 0; s -= 1) {
    if (stack[s].char === pair) {
      return closer === '}' ? stack[s].indent : stack[s].col;
    }
  }
  return null;
}

/**
 * 回车后新行应缩进到的列
 * ---------------------------------------------------------------------------
 *   括号内 → 对齐到最内层开括号后一列（参数续行标准对齐）
 *   其余   → 沿用当前行缩进；行尾是 { 或 : 时加深一级
 * @param {string} textBefore 光标之前的文本
 * @returns {number} 缩进列
 */
function enterIndentCol(textBefore) {
  const stack = scanBracketStack(textBefore);
  const top = stack[stack.length - 1];
  if (top && (top.char === '(' || top.char === '[')) return top.col + 1;
  const lineStart = textBefore.lastIndexOf('\n') + 1;
  const currentLine = textBefore.slice(lineStart);
  const indentWidth = /^[\t ]*/.exec(currentLine)[0].replace(/\t/g, '    ').length;
  const opensBlock = /\{\s*$|:\s*$/.test(currentLine.replace(/\s+$/, ''));
  return indentWidth + (opensBlock ? 4 : 0);
}

/* ==================== 模式切换（结果互相独立） ==================== */

function switchMode(mode) {
  state.mode = mode;
  $$('#mode-tabs .tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  for (const item of MODES) {
    $(`#mode-${item}-body`).classList.toggle('hidden', item !== mode);
  }
  $('#input-card-title').textContent = INPUT_TITLES[mode];
  showResultByMode(mode);
}

function showResultByMode(mode) {
  const empty = $('#empty-state');
  const comp = $('#completion-body');
  const prac = $('#practice-body');
  if (mode === 'practice') {
    comp.classList.add('hidden');
    prac.classList.toggle('hidden', !state.practiceRendered);
    empty.classList.toggle('hidden', state.practiceRendered);
  } else {
    prac.classList.add('hidden');
    const raw = state.modeResults[mode];
    if (raw) {
      renderCompletionResult(raw);
      comp.classList.remove('hidden');
      empty.classList.add('hidden');
    } else {
      comp.classList.add('hidden');
      empty.classList.remove('hidden');
    }
  }
  const [title, hint] = EMPTY_STATES[mode];
  $('#empty-title').textContent = title;
  $('#empty-hint').textContent = hint;
}

/* ==================== 结果渲染 ==================== */

function renderIssueList(items, container) {
  container.innerHTML = items.length
    ? items.map((issue) => `
      <li class="issue">
        <div class="issue-head">
          <span class="issue-title">${esc(issue.title)}</span>
          <span class="issue-line">第 ${esc(issue.line)} 行</span>
          ${issue.ruleId ? `<span class="tag">${esc(issue.ruleId)}</span>` : ''}
          ${issue.confirmedBy ? '<span class="tag confirmed">双引擎印证</span>' : ''}
        </div>
        <p class="issue-msg">${esc(issue.message)}</p>
        ${issue.suggestion ? `<p class="issue-suggestion">✔ ${esc(issue.suggestion)}</p>` : ''}
      </li>`).join('')
    : '<li class="issue"><p class="issue-msg">未发现问题。</p></li>';
}

function renderWarnings(items, box) {
  if (!items || items.length === 0) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `<p class="field-label">提示与降级说明</p><ul>${items.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
}

function kvRows(pairs) {
  return pairs.filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('');
}

function renderCompletionResult(result) {
  const isFix = result.feature === 'fix';
  const answer = result.answer || '';

  // 解题讲解卡片（仅解题补全）
  $('#answer-card').classList.toggle('hidden', isFix || !answer);
  $('#answer-text').textContent = answer;
  $('#btn-quiz').classList.toggle('hidden', isFix);

  $('#complete-badge-title').textContent = isFix ? '检查与修复结论' : '解题与补全结论';
  $('#complete-badge').textContent = SOURCE_LABELS[result.completionSource] || result.completionSource;
  $('#complete-badge').className = `badge ${result.completionSource === 'llm' ? 'badge-ok' : result.completionSource === 'none' ? 'badge-danger' : 'badge-warn'}`;
  $('#complete-summary').textContent = result.summary?.text || '';

  $('#complete-kv').innerHTML = kvRows([
    ['语言', result.language],
    ['模式', isFix ? '错误检查与修复' : result.mode === 'generate' ? '从零生成' : '补全代码'],
    ['执行来源', SOURCE_LABELS[result.completionSource] || '-'],
    ['图片输入', result.prompt !== undefined && state.image && result.feature === 'complete' ? '是（多模态）' : ''],
    ['问题数', result.stats?.issueCount],
    ['耗时', formatDuration(result.stats?.durationMs || 0)],
  ]);

  $('#complete-engines').innerHTML = kvRows([
    ['静态语法引擎', result.engines?.static ? '已执行' : '未启用'],
    ['大模型', result.engines?.llm ? '已调用' : '未调用'],
    ['模型', result.llm?.model || '-'],
    ['双引擎印证', result.engines?.confirmed ? `${result.engines.confirmed} 处` : ''],
    ['RAG 检索', result.rag?.hits?.length ? `命中 ${result.rag.hits.length} 条` : '未命中'],
  ]);

  renderWarnings(result.warnings, $('#complete-warnings'));

  $('#complete-issues-title').textContent = isFix ? '问题与修改建议' : '补全结果自检';
  $('#complete-issue-count').textContent = String(result.issues?.length || 0);
  renderIssueList(result.issues || [], $('#complete-issue-list'));

  const codeCard = $('#complete-code-card');
  const code = isFix ? result.fixedCode : result.completedCode;
  codeCard.classList.toggle('hidden', !code);
  $('#complete-code-title').textContent = isFix ? '修复后的完整代码' : '完整代码';
  $('#complete-code').textContent = code || '';
  $('#complete-notes').innerHTML = (result.notes || []).map((note) => `<li class="issue-msg">· ${esc(note)}</li>`).join('');
}

/** 运行/判题/调试结果元素组（双场景：practice=代码测试，quiz=解题流程内嵌测试） */
function runEls(ctx = 'practice') {
  const p = ctx === 'quiz' ? 'quiz-' : '';
  return {
    runCard: $(`#${p}run-card`),
    runBadge: $(`#${p}run-badge`),
    runKv: $(`#${p}run-kv`),
    runStdout: $(`#${p}run-stdout`),
    runStderr: $(`#${p}run-stderr`),
    judgeCard: $(`#${p}judge-card`),
    judgeBadge: $(`#${p}judge-badge`),
    judgeSummary: $(`#${p}judge-summary`),
    judgeTable: $(`#${p}judge-table`),
    debugCard: $(`#${p}debug-card`),
    debugBadge: $(`#${p}debug-badge`),
    debugSummary: $(`#${p}debug-summary`),
    debugTable: $(`#${p}debug-table`),
    errorBanner: $(`#${p}run-error-banner`),
    sourceEditor: $(ctx === 'quiz' ? '#quiz-code' : '#practice-code'),
  };
}

function renderRunResult(result, { asDebug = false, ctx = 'practice' } = {}) {
  const els = runEls(ctx);
  els.runCard.classList.remove('hidden');
  if (ctx === 'practice') state.practiceRendered = true;

  const ok = result.ok;
  els.runBadge.textContent = result.timedOut ? '超时' : ok ? '运行成功' : '运行失败';
  els.runBadge.className = `badge ${result.timedOut ? 'badge-warn' : ok ? 'badge-ok' : 'badge-danger'}`;
  els.runKv.innerHTML = kvRows([
    ['语言', result.language],
    ['耗时', formatDuration(result.durationMs || 0)],
    ['退出码', result.exitCode === null ? '-' : result.exitCode],
    ['报错行', result.error?.line ? `第 ${result.error.line} 行` : ''],
  ]);
  els.runStdout.textContent = result.stdout || '（无输出）';
  els.runStderr.textContent = result.error
    ? `${result.error.message}${result.error.line ? `（第 ${result.error.line} 行）` : ''}${result.stderr && result.stderr !== result.error.message ? `\n${result.stderr}` : ''}`
    : (result.stderr || '（无错误）');

  // 错误信息醒目化：失败时显示红色警示横幅 + 高亮错误输出框
  if (result.error) {
    els.errorBanner.classList.remove('hidden');
    els.errorBanner.innerHTML = `❌ 运行失败${result.error.line ? ` · 第 <b>${result.error.line}</b> 行` : ''}：${esc(result.error.message)}`;
    els.runStderr.classList.add('error-output');
  } else {
    els.errorBanner.classList.add('hidden');
    els.runStderr.classList.remove('error-output');
  }

  if (asDebug) renderDebugTrace(result, ctx);
}

function renderJudgeResult(result, ctx = 'practice') {
  const els = runEls(ctx);
  els.judgeCard.classList.remove('hidden');
  if (ctx === 'practice') state.practiceRendered = true;

  els.judgeBadge.textContent = `通过 ${result.passed} / ${result.total}`;
  els.judgeBadge.className = `badge ${result.allPassed ? 'badge-ok' : 'badge-danger'}`;
  els.judgeSummary.textContent = result.total === 0
    ? '没有测试用例：先点「出题测试我」，或在「测试用例」里手动填写。'
    : result.allPassed
      ? '全部测试用例通过，这道题你掌握了！'
      : `有 ${result.total - result.passed} 组用例未通过，对照「期望输出」和「实际输出」找找差别，可用「调试运行」逐行排查。`;

  const rows = result.cases.map((item) => `
    <tr class="${item.ok ? '' : 'row-fail'}">
      <td>${item.index}</td>
      <td><pre>${esc(item.input || '（空）')}</pre></td>
      <td><pre>${esc(item.expected)}</pre></td>
      <td><pre>${esc(item.actual || item.stderr || '（无输出）')}</pre></td>
      <td>${item.timedOut ? '<span class="badge badge-warn">超时</span>' : item.ok ? '<span class="badge badge-ok">通过</span>' : '<span class="badge badge-danger">不通过</span>'}</td>
    </tr>`).join('');

  els.judgeTable.innerHTML = `
    <thead><tr><th>用例</th><th>输入</th><th>期望输出</th><th>实际输出</th><th>结果</th></tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderDebugTrace(result, ctx = 'practice') {
  const els = runEls(ctx);
  els.debugCard.classList.remove('hidden');
  if (ctx === 'practice') state.practiceRendered = true;

  const trace = result.trace || [];
  els.debugBadge.textContent = trace.length ? `${trace.length} 步` : '无轨迹';
  els.debugBadge.className = `badge ${trace.length ? 'badge-ok' : 'badge-warn'}`;

  if (!trace.length) {
    els.debugSummary.textContent = '本次没有产生逐行轨迹（代码可能太短、语法不支持插桩，或运行前就失败了）。';
    els.debugTable.innerHTML = '';
    return;
  }

  // 按行聚合：执行次数 + 最后一次的变量快照
  const byLine = new Map();
  for (const step of trace) {
    const item = byLine.get(step.line) || { line: step.line, count: 0, vars: {} };
    item.count += 1;
    item.vars = step.vars || {};
    byLine.set(step.line, item);
  }
  const sourceLines = (els.sourceEditor.value || '').split('\n');
  const rows = [...byLine.values()].map((item) => `
    <tr>
      <td>${item.line}</td>
      <td><pre>${esc((sourceLines[item.line - 1] || '').trim() || '（空行）')}</pre></td>
      <td>${item.count} 次</td>
      <td><pre>${esc(Object.entries(item.vars).map(([k, v]) => `${k} = ${v}`).join('\n') || '（无变量）')}</pre></td>
    </tr>`).join('');

  els.debugSummary.textContent =
    `按执行顺序记录了 ${trace.length} 步；下表按代码行聚合，「执行次数」大于 1 说明该行在循环里执行了多次。`;
  els.debugTable.innerHTML = `
    <thead><tr><th>行号</th><th>代码</th><th>执行次数</th><th>变量快照（最后一次）</th></tr></thead>
    <tbody>${rows}</tbody>`;
}

function renderQuizResult(quiz, languageKey) {
  state.quiz = { quiz, languageKey };

  // 变式题测试区（解题流程内嵌）
  $('#quiz-section').classList.remove('hidden');
  $('#quiz-title').textContent = `变式题测试：${quiz.title}`;
  $('#quiz-desc').textContent = quiz.description;
  $('#quiz-hints').classList.add('hidden');
  $('#quiz-answer-box').classList.add('hidden');
  $('#quiz-answer-code').textContent = quiz.referenceSolution || '（无参考答案）';

  // 自动填充解答区（已有内容不覆盖）
  const editor = $('#quiz-code');
  if (!(editor.value || '').trim()) editor.value = quiz.starterCode || '';
  updateStats(editor, $('#quiz-stats'));

  const runnable = ['javascript', 'python', 'c', 'cpp', 'java'];
  if (runnable.includes(languageKey)) $('#quiz-language').value = languageKey;

  // 清掉上一题的测试结果
  $('#quiz-run-card').classList.add('hidden');
  $('#quiz-judge-card').classList.add('hidden');
  $('#quiz-debug-card').classList.add('hidden');
  $('#quiz-note').textContent = '按题目自带的测试用例自动判题，逐组给出通过 / 不通过';

  if ($('#quiz-section').scrollIntoView) $('#quiz-section').scrollIntoView({ behavior: 'smooth' });
}

/* ==================== 各功能提交 ==================== */

async function submitComplete() {
  const prompt = $('#input-prompt').value.trim();
  const code = $('#input-complete-code').value;
  if (!prompt && !state.image) {
    toast('先写下你的问题，或者上传一张题目图片');
    return;
  }

  setBusy('#btn-complete', '#complete-spinner', true);
  $('#complete-note').textContent = '正在解题…';
  try {
    const result = await api('/api/completions', {
      method: 'POST',
      body: JSON.stringify({
        feature: 'complete',
        prompt,
        code,
        language: $('#select-complete-language').value || undefined,
        fileName: $('#input-complete-filename').value || undefined,
        useLlm: $('#opt-complete-llm').checked,
        image: state.image ? state.image.dataUrl : undefined,
      }),
    });
    state.modeResults.complete = result;
    state.lastPrompt = prompt || '（图片提问）';
    showResultByMode('complete');
    addHistoryRecord(recordFromResult('解题与补全', prompt || '（图片提问）', result));
    $('#complete-note').textContent = `完成，耗时 ${formatDuration(result.stats?.durationMs || 0)}`;
    toast('解题完成，结果已显示在下方');
  } catch (error) {
    $('#complete-note').textContent = '';
    toast(`解题失败：${error.message}`);
  } finally {
    setBusy('#btn-complete', '#complete-spinner', false);
  }
}

async function submitQuiz() {
  setBusy('#btn-quiz', null, true);
  try {
    const result = await api('/api/completions', {
      method: 'POST',
      body: JSON.stringify({
        feature: 'quiz',
        prompt: state.lastPrompt || $('#input-prompt').value.trim(),
        language: $('#select-complete-language').value || undefined,
      }),
    });
    state.modeResults.practice = result;
    if (!result.quiz) {
      toast(result.warnings?.[0] || '没有生成变式题（需要配置大模型）');
      return;
    }
    renderQuizResult(result.quiz, result.languageKey);
    addHistoryRecord(recordFromResult('变式出题', state.lastPrompt || '(图片提问)', {
      ...result,
      answer: result.quiz ? `${result.quiz.title}｜提示：${(result.quiz.hints || []).join('；')}` : '',
    }));
    toast('变式题已生成，在下方作答后点「自动判题」');
  } catch (error) {
    toast(`出题失败：${error.message}`);
  } finally {
    setBusy('#btn-quiz', null, false);
  }
}

/**
 * 运行 / 判题 / 调试（双场景：practice=代码测试页·只运行，quiz=解题流程内的变式题测试）
 * @param {string} mode run / judge / debug
 * @param {string} ctx practice / quiz
 */
async function submitRun(mode, ctx = 'practice') {
  const isQuiz = ctx === 'quiz';
  const code = $(isQuiz ? '#quiz-code' : '#practice-code').value;
  if (!code.trim()) {
    toast('先写点代码');
    return;
  }
  const language = $(isQuiz ? '#quiz-language' : '#select-practice-language').value;
  const buttonIds = [`#btn-${ctx}-${mode}`, `#${ctx}-${mode}-spinner`];

  let testCases;
  if (mode === 'judge') {
    // 判题只在解题流程的「出题测试我」中使用（用例由题目自带）
    testCases = state.quiz?.quiz?.testCases || [];
    if (!testCases.length) {
      toast('这道题还没有测试用例');
      return;
    }
  }

  setBusy(buttonIds[0], buttonIds[1], true);
  $(`#${ctx}-note`).textContent = '正在真实执行代码…';
  try {
    const body = {
      mode,
      language,
      code,
      stdin: $(isQuiz ? '#quiz-stdin' : '#practice-stdin').value,
    };
    if (mode === 'judge') body.testCases = testCases;
    const result = await api('/api/run', { method: 'POST', body: JSON.stringify(body) });
    if (!isQuiz) state.modeResults.practice = result;
    if (mode === 'judge') renderJudgeResult(result, ctx);
    else renderRunResult(result, { asDebug: mode === 'debug', ctx });
    $(`#${ctx}-note`).textContent = `完成，耗时 ${formatDuration(result.durationMs || result.cases?.reduce((sum, item) => sum + (item.durationMs || 0), 0) || 0)}`;
    toast(mode === 'judge' ? `判题完成：通过 ${result.passed}/${result.total}` : '执行完成');
  } catch (error) {
    $(`#${ctx}-note`).textContent = '';
    toast(`执行失败：${error.message}`);
  } finally {
    setBusy(buttonIds[0], buttonIds[1], false);
  }
}

/**
 * 代码测试 · 离线静态检查（不调大模型）：随「运行」自动执行，
 * 复用错误检查与修复的找错能力（启发式 + 真编译器诊断），逐条给出修改建议。
 */
async function runPracticeCheck() {
  const code = $('#practice-code').value;
  if (!code.trim()) return;
  try {
    const result = await api('/api/completions', {
      method: 'POST',
      body: JSON.stringify({
        feature: 'fix',
        code,
        language: $('#select-practice-language').value,
        useLlm: false,
      }),
    });
    state.practiceRendered = true;
    showResultByMode('practice');

    $('#check-card').classList.remove('hidden');
    const count = result.issues?.length || 0;
    $('#check-badge').textContent = count ? `${count} 处问题` : '未发现问题';
    $('#check-badge').className = `badge ${count ? 'badge-danger' : 'badge-ok'}`;
    $('#check-summary').textContent = result.summary?.text || '';
    renderIssueList(result.issues || [], $('#check-issue-list'));
  } catch { /* 检查失败不影响运行结果 */ }
}

async function submitFix() {
  const code = $('#input-fix-code').value;
  if (!code.trim()) {
    toast('先贴上要检查的代码');
    return;
  }
  setBusy('#btn-fix', '#fix-spinner', true);
  $('#fix-note').textContent = '正在检查…';
  try {
    const result = await api('/api/completions', {
      method: 'POST',
      body: JSON.stringify({
        feature: 'fix',
        code,
        prompt: $('#input-fix-intent').value.trim(),
        language: $('#select-fix-language').value || undefined,
        fileName: $('#input-fix-filename').value || undefined,
        useLlm: $('#opt-fix-llm').checked,
      }),
    });
    state.modeResults.fix = result;
    showResultByMode('fix');
    $('#fix-note').textContent = `完成，耗时 ${formatDuration(result.stats?.durationMs || 0)}`;
    addHistoryRecord(recordFromResult('检查与修复', $('#input-fix-intent').value.trim() || '(仅代码检查)', result));
    toast('检查完成，结果已显示在下方');
  } catch (error) {
    $('#fix-note').textContent = '';
    toast(`检查失败：${error.message}`);
  } finally {
    setBusy('#btn-fix', '#fix-spinner', false);
  }
}

/* ==================== 图片提问 ==================== */

function setImage(file) {
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) {
    toast('图片太大了（约 6MB 上限），请压缩后再上传');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.image = { dataUrl: reader.result, name: file.name };
    $('#image-preview-img').src = reader.result;
    $('#image-preview-name').textContent = `${file.name}（已就绪，将随问题一起发给 AI）`;
    $('#image-preview').classList.remove('hidden');
    $('#image-dropzone').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  state.image = null;
  $('#input-image').value = '';
  $('#image-preview').classList.add('hidden');
  $('#image-dropzone').classList.remove('hidden');
}

/* ==================== 大模型设置 ==================== */

function providerNote(provider) {
  if (!provider) return '';
  return `${provider.note ? `${provider.note}；` : ''}免费额度与价格以官网为准`;
}

function applyProviderDefaults() {
  const key = $('#settings-provider').value;
  const provider = state.providers.find((item) => item.key === key);
  if (!provider) return;
  if (provider.baseUrlHint) $('#settings-baseurl').value = provider.baseUrlHint;
  if (provider.modelHint) $('#settings-model').value = provider.modelHint;
  $('#settings-model').placeholder = provider.modelPlaceholder || '模型名';
  $('#settings-provider-note').textContent = providerNote(provider);
}

async function openSettings() {
  $('#settings-mask').classList.remove('hidden');
  $('#settings-status').textContent = '读取中…';
  try {
    const snapshot = await api('/api/settings');
    state.providers = snapshot.providers || [];
    const select = $('#settings-provider');
    select.innerHTML = state.providers
      .map((item) => `<option value="${esc(item.key)}">${esc(item.label)}</option>`).join('');
    const local = loadLocalLlm() || {};
    select.value = local.provider || snapshot.overrides?.provider || snapshot.llm?.provider || 'deepseek';
    if (!select.value) select.value = state.providers[0]?.key || '';
    $('#settings-baseurl').value = local.baseUrl || snapshot.overrides?.baseUrl || snapshot.llm?.baseUrl || '';
    $('#settings-model').value = local.model || snapshot.overrides?.model || snapshot.llm?.model || '';
    $('#settings-key-hint').textContent = local.apiKey
      ? `已保存在本浏览器（${maskKey(local.apiKey)}），留空不修改`
      : '未设置（填你自己的 Key；留空则用服务器公共配置，若有）';
    $('#settings-status').textContent = local.apiKey
      ? `当前生效：你本浏览器的配置${local.model ? ` / ${local.model}` : ''}`
      : (snapshot.llm?.available
        ? `当前生效：服务器公共配置 ${snapshot.llm.providerLabel} / ${snapshot.llm.model}`
        : `当前未启用（${snapshot.llm?.reason || '未配置'}）`);
    applyProviderDefaults();
    $('#settings-baseurl').value = local.baseUrl || snapshot.overrides?.baseUrl || snapshot.llm?.baseUrl || $('#settings-baseurl').value;
    $('#settings-model').value = local.model || snapshot.overrides?.model || snapshot.llm?.model || $('#settings-model').value;
    $('#settings-note').textContent = '密钥只保存在你自己的浏览器（localStorage），不上传服务器、不与他人共享；每位访客用自己的 Key。';
  } catch (error) {
    $('#settings-status').textContent = `读取失败：${error.message}`;
  }
}

async function saveSettings() {
  setBusy('#btn-settings-save', null, true);
  try {
    // 保存到本人浏览器 localStorage（每位访客用自己的 Key，不上传、不共享）
    const previous = loadLocalLlm() || {};
    const apiKeyInput = $('#settings-apikey').value.trim();
    const cfg = {
      provider: $('#settings-provider').value,
      baseUrl: $('#settings-baseurl').value.trim(),
      model: $('#settings-model').value.trim(),
      apiKey: apiKeyInput || previous.apiKey || '',
    };
    saveLocalLlm(cfg);
    $('#settings-note').textContent = '已保存在你自己的浏览器（只对你生效，不会上传服务器）';
    $('#settings-key-hint').textContent = cfg.apiKey
      ? `已保存在本浏览器（${maskKey(cfg.apiKey)}），留空不修改`
      : '未设置（不填 Key 则使用服务器公共配置，若有）';
    $('#settings-apikey').value = '';
    refreshBadges();
    toast('已保存到你的浏览器，只对你生效');
  } catch (error) {
    $('#settings-note').textContent = `保存失败：${error.message}`;
  } finally {
    setBusy('#btn-settings-save', null, false);
  }
}

async function testSettings() {
  setBusy('#btn-settings-test', null, true);
  $('#settings-note').textContent = '正在测试…';
  try {
    const result = await api('/api/settings/test', {
      method: 'POST',
      body: JSON.stringify({
        provider: $('#settings-provider').value,
        baseUrl: $('#settings-baseurl').value.trim(),
        model: $('#settings-model').value.trim(),
        apiKey: $('#settings-apikey').value.trim() || loadLocalLlm()?.apiKey || undefined,
      }),
    });
    $('#settings-note').textContent = result.ok === false
      ? `连接失败：${result.message || '未知原因'}`
      : `连接成功${result.latencyMs ? `（${formatDuration(result.latencyMs)}）` : ''}`;
  } catch (error) {
    $('#settings-note').textContent = `连接失败：${error.message}`;
  } finally {
    setBusy('#btn-settings-test', null, false);
  }
}

async function resetSettings() {
  setBusy('#btn-settings-reset', null, true);
  try {
    clearLocalLlm();
    $('#settings-note').textContent = '已清除本浏览器保存的配置';
    refreshBadges();
    openSettings();
    toast('已清除你的浏览器配置');
  } catch (error) {
    $('#settings-note').textContent = `清除失败：${error.message}`;
  } finally {
    setBusy('#btn-settings-reset', null, false);
  }
}

/* ==================== 顶部状态徽标 ==================== */

async function refreshBadges() {
  try {
    const version = await api('/api/version');
    $('#badge-version').textContent = `v${version.version}`;
  } catch { /* 静默 */ }

  try {
    const snapshot = await api('/api/settings');
    const llm = snapshot.llm || {};
    const local = loadLocalLlm();
    $('#footer-model').textContent = local?.apiKey
      ? `${local.provider || llm.providerLabel || '大模型'} / ${local.model || llm.model || ''}（本浏览器配置）`
      : llm.available ? `${llm.providerLabel} / ${llm.model}` : '未配置大模型（运行/判题/调试不受影响）';
  } catch { /* 静默 */ }

  try {
    const env = await api('/api/run/env');
    const labels = { javascript: 'JavaScript', python: 'Python', c: 'C', cpp: 'C++', java: 'Java' };
    const available = Object.entries(env.languages || {}).filter(([, item]) => item.available);

    // 语言下拉框：只列本机真能跑的语言（自动探测）
    const select = $('#select-practice-language');
    const current = select.value;
    select.innerHTML = available
      .map(([key]) => `<option value="${esc(key)}">${esc(labels[key] || key)}</option>`)
      .join('');
    if (available.some(([key]) => key === current)) select.value = current;
  } catch { /* 静默 */ }
}

/* ==================== 主题（浅色 / 深色） ==================== */

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  if (document.documentElement) document.documentElement.dataset.theme = next;
  const button = $('#btn-theme');
  if (button) button.textContent = next === 'light' ? '深色模式' : '浅色模式';
  try { localStorage.setItem('cgai-theme', next); } catch { /* 隐私模式忽略 */ }
}

function initTheme() {
  let theme = 'light';
  try {
    const param = new URLSearchParams(location.search).get('theme');
    theme = param || localStorage.getItem('cgai-theme') || 'light';
  } catch { /* 无 location/localStorage 时用默认 */ }
  applyTheme(theme);
}

/* ==================== 事件装配 ==================== */

function bindEvents() {
  // 主题切换
  $('#btn-theme').addEventListener('click', () => {
    applyTheme(document.documentElement && document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });

  // 模式切换
  $$('#mode-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  });

  // 解题补全
  $('#btn-complete').addEventListener('click', submitComplete);
  $('#btn-complete-clear').addEventListener('click', () => {
    $('#input-prompt').value = '';
    $('#input-complete-code').value = '';
    $('#input-complete-filename').value = '';
    clearImage();
    updateStats($('#input-complete-code'), $('#complete-stats'));
    toast('已清空');
  });
  $('#btn-quiz').addEventListener('click', submitQuiz);
  $('#btn-copy-code').addEventListener('click', async () => {
    const code = $('#complete-code').textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast('代码已复制');
    } catch {
      toast('复制失败，请手动选中复制');
    }
  });

  // 图片提问
  const dropzone = $('#image-dropzone');
  dropzone.addEventListener('click', () => $('#input-image').click());
  $('#input-image').addEventListener('change', (event) => setImage(event.target.files[0]));
  $('#btn-image-remove').addEventListener('click', clearImage);
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    setImage(event.dataTransfer.files[0]);
  });

  // 代码测试（独立测试代码）：点「运行」= 真实执行 + 自动离线找错
  $('#btn-practice-run').addEventListener('click', () => {
    Promise.allSettled([submitRun('run', 'practice'), runPracticeCheck()]);
  });
  $('#btn-practice-clear').addEventListener('click', () => {
    $('#practice-code').value = '';
    $('#practice-stdin').value = '';
    $('#run-card').classList.add('hidden');
    $('#check-card').classList.add('hidden');
    updateStats($('#practice-code'), $('#practice-stats'));
    toast('已清空');
  });

  // 变式题测试（解题流程内嵌）
  $('#btn-quiz-run').addEventListener('click', () => submitRun('run', 'quiz'));
  $('#btn-quiz-judge').addEventListener('click', () => submitRun('judge', 'quiz'));
  $('#btn-quiz-debug').addEventListener('click', () => submitRun('debug', 'quiz'));
  $('#btn-quiz-hint').addEventListener('click', () => {
    const hints = state.quiz?.quiz?.hints || [];
    const box = $('#quiz-hints');
    if (!hints.length) {
      toast('这道题没有提示');
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = `<p class="field-label">提示</p><ul>${hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`;
  });
  $('#btn-quiz-answer').addEventListener('click', () => {
    $('#quiz-answer-box').classList.remove('hidden');
  });

  // 错误修复
  $('#btn-fix').addEventListener('click', submitFix);
  $('#btn-fix-clear').addEventListener('click', () => {
    $('#input-fix-code').value = '';
    $('#input-fix-intent').value = '';
    updateStats($('#input-fix-code'), $('#fix-stats'));
    toast('已清空');
  });

  // 统计 + 代码框行号栏 + 智能编辑（回车缩进 / 粘贴自动换行）
  const EDITORS = [
    ['#input-complete-code', 'select-complete-language'],
    ['#input-fix-code', 'select-fix-language'],
    ['#practice-code', 'select-practice-language'],
    ['#quiz-code', 'quiz-language'],
  ];
  for (const [id, langId] of EDITORS) {
    attachGutter($(id));
    attachSmartEditing($(id), langId);
  }

  // 「格式化」按钮：一键规范换行与缩进（可 Ctrl+Z 撤销）
  $$('.btn-format').forEach((button) => {
    button.addEventListener('click', () => {
      const textarea = $(`#${button.dataset.format}`);
      const select = button.dataset.lang ? $(`#${button.dataset.lang}`) : null;
      if (!textarea) return;
      textarea.value = formatCode(textarea.value, select ? select.value : '');
      textarea.dispatchEvent(new Event('input'));
      toast('已格式化：换行与缩进已规范（可 Ctrl+Z 撤销）');
    });
  });

  updateStats($('#input-complete-code'), $('#complete-stats'));
  $('#input-complete-code').addEventListener('input', () => updateStats($('#input-complete-code'), $('#complete-stats')));
  updateStats($('#practice-code'), $('#practice-stats'));
  $('#practice-code').addEventListener('input', () => updateStats($('#practice-code'), $('#practice-stats')));
  updateStats($('#quiz-code'), $('#quiz-stats'));
  $('#quiz-code').addEventListener('input', () => updateStats($('#quiz-code'), $('#quiz-stats')));
  updateStats($('#input-fix-code'), $('#fix-stats'));
  $('#input-fix-code').addEventListener('input', () => updateStats($('#input-fix-code'), $('#fix-stats')));

  // 收起输入卡
  $('#btn-collapse').addEventListener('click', () => {
    const card = $('#card-input');
    card.classList.toggle('collapsed');
    $('#btn-collapse').textContent = card.classList.contains('collapsed') ? '展开' : '收起';
  });

  // 设置面板
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-history').addEventListener('click', openHistory);
  $('#btn-history-close').addEventListener('click', () => $('#history-mask').classList.add('hidden'));
  $('#btn-history-clear').addEventListener('click', () => {
    clearHistory();
    renderHistory();
    toast('已清空使用记录');
  });
  $('#history-list').addEventListener('click', (event) => {
    const id = event.target && event.target.dataset ? event.target.dataset.del : '';
    if (id) {
      renderHistory(removeHistoryRecord(id));
      toast('已删除该条记录');
    }
  });
  $('#btn-settings-close').addEventListener('click', () => $('#settings-mask').classList.add('hidden'));
  $('#settings-provider').addEventListener('change', applyProviderDefaults);
  $('#btn-settings-save').addEventListener('click', saveSettings);
  $('#btn-settings-test').addEventListener('click', testSettings);
  $('#btn-settings-reset').addEventListener('click', resetSettings);

  // 帮助
  const openHelp = () => $('#help-mask').classList.remove('hidden');
  $('#btn-help').addEventListener('click', openHelp);
  $('#btn-help-empty').addEventListener('click', openHelp);
  $('#btn-help-close').addEventListener('click', () => $('#help-mask').classList.add('hidden'));
  $('#btn-help-ok').addEventListener('click', () => {
    $('#help-mask').classList.add('hidden');
    try { localStorage.setItem('cgai-help-seen', '1'); } catch { /* 隐私模式忽略 */ }
  });

  // 快捷键与弹层关闭
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('#help-mask').classList.add('hidden');
      $('#settings-mask').classList.add('hidden');
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (state.mode === 'complete') $('#btn-complete').click();
      else if (state.mode === 'practice') $('#btn-practice-run').click();
      else $('#btn-fix').click();
    }
  });
}

/* ==================== 启动 ==================== */

function init() {
  initTheme();
  bindEvents();
  // ?tab=complete|practice|fix 直达指定工作模式（也便于分享与截图）
  const startMode = (() => {
    try {
      const tab = new URLSearchParams(location.search).get('tab');
      return ['complete', 'practice', 'fix'].includes(tab) ? tab : 'complete';
    } catch {
      return 'complete';
    }
  })();
  switchMode(startMode);
  refreshBadges();
  try {
    // ?nofirsthelp 跳过首次引导（供截图/自动化测试使用）
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nofirsthelp')) {
      localStorage.setItem('cgai-help-seen', '1');
    }
    if (!localStorage.getItem('cgai-help-seen')) $('#help-mask').classList.remove('hidden');
  } catch { /* 隐私模式忽略 */ }
}

if (typeof document !== 'undefined' && document.querySelector) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    esc,
    kvRows,
    SOURCE_LABELS,
    MODES,
    state,
    formatDuration,
    renderIssueList,
    refreshGutter,
    formatCode,
    scanBracketStack,
    closeAlignCol,
    enterIndentCol,
    loadHistory,
    addHistoryRecord,
    removeHistoryRecord,
    clearHistory,
    recordFromResult,
    switchMode,
    showResultByMode,
    renderCompletionResult,
    renderQuizResult,
    renderRunResult,
    renderJudgeResult,
    renderDebugTrace,
  };
}
