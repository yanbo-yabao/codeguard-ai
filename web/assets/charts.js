/* ===========================================================================
 * CodeGuard AI · 图表渲染（纯 SVG，零依赖）
 * ---------------------------------------------------------------------------
 * 提供四个渲染函数，全部直接操作 DOM 生成 SVG 节点：
 *   renderGauge        综合得分圆环仪表盘
 *   renderRadar        五维评分雷达图
 *   renderSeverityBars 严重级别分布条
 *   renderDimensionBars 维度问题数分布条
 *   renderSparkline    历史得分走势（可空）
 * 之所以不引入图表库：本项目承诺「零运行时第三方依赖」，且离线环境必须可用。
 * =========================================================================== */

(function initCharts(global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** 创建 SVG 元素并设置属性 */
  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, String(value));
    }
    return node;
  }

  /** 清空容器 */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** 得分 → 语义色 */
  function scoreColor(score) {
    if (score >= 82) return '#2da44e';
    if (score >= 70) return '#d29922';
    if (score >= 60) return '#f76808';
    return '#e5484d';
  }

  /**
   * 渲染综合得分圆环
   * @param {HTMLElement} container 容器
   * @param {number} score 综合得分
   * @param {string} grade 等级
   * @param {string} gradeLabel 等级文案
   */
  function renderGauge(container, score, grade, gradeLabel) {
    clear(container);
    const size = 168;
    const stroke = 13;
    const radius = (size - stroke) / 2 - 6;
    const circumference = 2 * Math.PI * radius;
    const ratio = Math.max(0, Math.min(100, Number(score) || 0)) / 100;
    const color = scoreColor(score);

    const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img' });
    svg.appendChild(svgEl('title', {})).textContent = `综合得分 ${score}，等级 ${grade}`;

    // 背景环
    svg.appendChild(svgEl('circle', {
      cx: size / 2, cy: size / 2, r: radius,
      fill: 'none', stroke: '#21262d', 'stroke-width': stroke,
    }));

    // 进度环：以 12 点钟方向为起点顺时针绘制
    const progress = svgEl('circle', {
      cx: size / 2, cy: size / 2, r: radius,
      fill: 'none', stroke: color, 'stroke-width': stroke, 'stroke-linecap': 'round',
      'stroke-dasharray': `${(circumference * ratio).toFixed(2)} ${circumference.toFixed(2)}`,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    });
    svg.appendChild(progress);

    container.appendChild(svg);

    // 中心文字（用 HTML 叠加，避免 SVG 文本换行差异）
    const center = document.createElement('div');
    center.className = 'gauge-center';
    center.style.cssText = `position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none`;
    center.innerHTML =
      `<b style="font-size:40px;line-height:1;font-family:var(--mono);color:${color}">${Math.round(Number(score) || 0)}</b>` +
      `<span style="font-size:11.5px;color:var(--fg-muted);margin-top:6px">等级 ${grade} · ${gradeLabel}</span>`;

    container.style.position = 'relative';
    container.appendChild(center);
  }

  /**
   * 渲染五维雷达图
   * @param {HTMLElement} container 容器
   * @param {object} dimensions 维度字典
   */
  function renderRadar(container, dimensions) {
    clear(container);
    const entries = Object.values(dimensions || {});
    if (entries.length === 0) {
      container.innerHTML = '<p style="color:var(--fg-muted);font-size:12.5px">暂无维度数据</p>';
      return;
    }

    // 画布宽高比为非对称（宽 > 高）：轴标签沿水平方向外扩，若画布与图形等宽，
    // 左右两侧标签的 getBBox() 会超出 viewBox 被裁掉。此处为标签预留横向余量。
    const width = 340;
    const height = 260;
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = 84;
    const labelRadiusRatio = 1.22;
    const axisCount = entries.length;

    // SVG 表现属性不支持 CSS 变量，必须给出具体字体族，否则标签会回退到默认字体
    const LABEL_FONT = "-apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";

    const svg = svgEl('svg', {
      width: '100%', height, viewBox: `0 0 ${width} ${height}`, role: 'img',
    });
    svg.appendChild(svgEl('title', {})).textContent = '五维评分雷达图';

    /** 极坐标 → 直角坐标 */
    const pointAt = (index, radiusRatio) => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / axisCount;
      return {
        x: centerX + maxRadius * radiusRatio * Math.cos(angle),
        y: centerY + maxRadius * radiusRatio * Math.sin(angle),
      };
    };

    // 网格环（25% / 50% / 75% / 100%）
    for (const level of [0.25, 0.5, 0.75, 1]) {
      const points = entries.map((_, index) => {
        const p = pointAt(index, level);
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      }).join(' ');
      svg.appendChild(svgEl('polygon', {
        points, fill: level === 1 ? '#ffffff06' : 'none',
        stroke: '#232c37', 'stroke-width': 1,
      }));
    }

    // 轴线
    entries.forEach((_, index) => {
      const p = pointAt(index, 1);
      svg.appendChild(svgEl('line', {
        x1: centerX, y1: centerY, x2: p.x.toFixed(1), y2: p.y.toFixed(1),
        stroke: '#232c37', 'stroke-width': 1,
      }));
    });

    // 数据多边形
    const dataPoints = entries.map((item, index) => {
      const p = pointAt(index, Math.max(0, Math.min(100, item.score)) / 100);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }).join(' ');

    svg.appendChild(svgEl('polygon', {
      points: dataPoints,
      fill: '#2f81f733', stroke: '#2f81f7', 'stroke-width': 2, 'stroke-linejoin': 'round',
    }));

    // 顶点
    entries.forEach((item, index) => {
      const p = pointAt(index, Math.max(0, Math.min(100, item.score)) / 100);
      svg.appendChild(svgEl('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3.4, fill: item.color || '#2f81f7' }));
    });

    // 轴标签（名称 + 得分）
    entries.forEach((item, index) => {
      const p = pointAt(index, labelRadiusRatio);
      const anchor = p.x > centerX + 6 ? 'start' : p.x < centerX - 6 ? 'end' : 'middle';
      const label = svgEl('text', {
        x: p.x.toFixed(1), y: (p.y + 4).toFixed(1),
        fill: '#8b98a5', 'font-size': 11, 'text-anchor': anchor,
        'font-family': LABEL_FONT,
      });
      label.textContent = `${item.label} ${Math.round(item.score)}`;
      svg.appendChild(label);
    });

    container.appendChild(svg);
  }

  /**
   * 渲染严重级别分布（横向条形）
   * @param {HTMLElement} container 容器
   * @param {object} counts 级别 → 数量
   * @param {object[]} severities 级别定义数组（含 label/color/weight）
   */
  function renderSeverityBars(container, counts, severities) {
    clear(container);
    const total = Object.values(counts || {}).reduce((sum, value) => sum + value, 0);
    const max = Math.max(1, ...Object.values(counts || { 0: 1 }));

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;gap:9px';

    for (const definition of severities) {
      const count = counts?.[definition.key] || 0;
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:78px 34px 1fr 40px;align-items:center;gap:8px;font-size:12px';
      row.innerHTML =
        `<span style="color:${definition.color}">${definition.label}</span>` +
        `<span class="num" style="text-align:right;font-family:var(--mono)">${count}</span>` +
        `<span style="background:#21262d;height:7px;border-radius:4px;overflow:hidden;display:block">` +
        `<span style="display:block;height:100%;width:${((count / max) * 100).toFixed(1)}%;background:${definition.color};border-radius:4px"></span></span>` +
        `<span style="color:var(--fg-dim);font-family:var(--mono);text-align:right">${total ? ((count / total) * 100).toFixed(0) : 0}%</span>`;
      wrap.appendChild(row);
    }
    container.appendChild(wrap);
  }

  /**
   * 渲染维度问题数分布
   * @param {HTMLElement} container 容器
   * @param {object} dimensions 维度字典
   */
  function renderDimensionBars(container, dimensions) {
    clear(container);
    const entries = Object.values(dimensions || {}).filter((item) => item.issueCount > 0);
    if (entries.length === 0) {
      container.innerHTML = '<p style="color:var(--fg-muted);font-size:12px">暂无问题分布数据</p>';
      return;
    }
    const max = Math.max(...entries.map((item) => item.issueCount));

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;gap:9px';
    for (const item of entries) {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:78px 34px 1fr;align-items:center;gap:8px;font-size:12px';
      row.innerHTML =
        `<span>${item.label}</span>` +
        `<span class="num" style="text-align:right;font-family:var(--mono)">${item.issueCount}</span>` +
        `<span style="background:#21262d;height:7px;border-radius:4px;overflow:hidden;display:block">` +
        `<span style="display:block;height:100%;width:${((item.issueCount / max) * 100).toFixed(1)}%;background:${item.color};border-radius:4px"></span></span>`;
      wrap.appendChild(row);
    }
    container.appendChild(wrap);
  }

  /**
   * 渲染历史得分走势
   * @param {HTMLElement} container 容器
   * @param {Array<{createdAt:string, score:number|null}>} items 记录列表
   */
  function renderSparkline(container, items) {
    clear(container);
    const points = (items || [])
      .filter((item) => typeof item.score === 'number')
      .slice(0, 20)
      .reverse();

    if (points.length < 2) {
      container.innerHTML = '<p style="color:var(--fg-muted);font-size:12.5px">累计两次以上评审后展示得分走势。</p>';
      return;
    }

    const width = 520;
    const height = 120;
    const pad = { top: 14, right: 14, bottom: 20, left: 34 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const svg = svgEl('svg', { width: '100%', height, viewBox: `0 0 ${width} ${height}`, role: 'img', preserveAspectRatio: 'none' });
    svg.appendChild(svgEl('title', {})).textContent = '历史评审得分走势';

    // 水平参考线（0 / 50 / 100）
    for (const value of [0, 50, 100]) {
      const y = pad.top + innerH * (1 - value / 100);
      svg.appendChild(svgEl('line', { x1: pad.left, y1: y, x2: width - pad.right, y2: y, stroke: '#232c37', 'stroke-width': 1 }));
      const text = svgEl('text', { x: pad.left - 6, y: y + 3.5, fill: '#6b7681', 'font-size': 9.5, 'text-anchor': 'end' });
      text.textContent = String(value);
      svg.appendChild(text);
    }

    const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
    const coords = points.map((item, index) => ({
      x: pad.left + stepX * index,
      y: pad.top + innerH * (1 - Math.max(0, Math.min(100, item.score)) / 100),
      item,
    }));

    // 面积
    const areaPath = `M ${coords[0].x},${pad.top + innerH} ` +
      coords.map((p) => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
      ` L ${coords[coords.length - 1].x},${pad.top + innerH} Z`;
    svg.appendChild(svgEl('path', { d: areaPath, fill: '#2f81f71f', stroke: 'none' }));

    // 折线
    svg.appendChild(svgEl('polyline', {
      points: coords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      fill: 'none', stroke: '#2f81f7', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    // 数据点
    for (const point of coords) {
      svg.appendChild(svgEl('circle', { cx: point.x.toFixed(1), cy: point.y.toFixed(1), r: 3, fill: scoreColor(point.item.score) }));
    }

    container.appendChild(svg);
  }

  global.CodeGuardCharts = {
    renderGauge,
    renderRadar,
    renderSeverityBars,
    renderDimensionBars,
    renderSparkline,
    scoreColor,
  };
})(window);
