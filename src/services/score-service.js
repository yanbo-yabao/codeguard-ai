'use strict';

/**
 * 评分卡服务
 * ---------------------------------------------------------------------------
 * 评分模型（可完全复现，便于复核与答辩质询）：
 *
 *   1. 单项扣分权重 w 由严重级别决定：
 *        blocker 15 · critical 10 · major 5 · minor 2 · info 0.5
 *
 *   2. 来源可信度系数 c 体现「确定性检测」与「概率性推断」的差异：
 *        静态规则命中 c = 1.00（可复现的确定性结论）
 *        大模型命中   c = 0.80 × confidence（语义推断，按置信度折算）
 *
 *   3. 规模归一化系数 σ 抑制「大文件因问题条目多而被系统性低估」的偏差：
 *        σ = 1 / (1 + ln(max(N, 30) / 30) / 3)      N = 有效代码行数
 *        N ≤ 30 → σ = 1.00（小片段按最严格口径计分）
 *        N = 100 → σ ≈ 0.71
 *        N = 500 → σ ≈ 0.52
 *        N = 1200 → σ ≈ 0.45
 *
 *   4. 综合得分 = clamp(100 − σ × Σ(wᵢ·cᵢ), 0, 100)
 *      维度得分 = clamp(100 − σ × Σ(wᵢ·cᵢ·d)， 0, 100)，d 为维度敏感度：
 *        security 1.20 · bug 1.00 · performance 0.90 · readability 0.80 · maintainability 0.80
 *      安全问题的敏感度最高，因其后果不可逆且修复成本随发布时间指数上升。
 *
 *   5. 结构风险修正：圈复杂度与嵌套深度超出阈值时施加附加扣分，
 *      因为「复杂但暂时正确」的代码是未来缺陷的温床，单纯按问题条目计分无法体现。
 */

const { SEVERITIES, DIMENSIONS } = require('../core/taxonomy');
const { clamp, round } = require('../core/utils');

/** 维度敏感度系数 */
const DIMENSION_SENSITIVITY = {
  security: 1.2,
  bug: 1.0,
  performance: 0.9,
  readability: 0.8,
  maintainability: 0.8,
};

/** 大模型结论的可信度基准系数 */
const LLM_SOURCE_FACTOR = 0.8;

/** 等级划分阈值（降序匹配） */
const GRADE_THRESHOLDS = [
  { grade: 'S', min: 92, label: '优秀', advice: '代码质量优秀，可直接合入主干。' },
  { grade: 'A', min: 82, label: '良好', advice: '存在个别待改进项，建议在合入前顺手处理。' },
  { grade: 'B', min: 70, label: '合格', advice: '功能可用，但需安排专门时间清理已列出的问题。' },
  { grade: 'C', min: 60, label: '需改进', advice: '存在影响稳定性或安全性的问题，建议本轮迭代内修复。' },
  { grade: 'D', min: 0, label: '不合格', advice: '存在阻断级问题，必须修复后才能合入。' },
];

/**
 * 计算规模归一化系数 σ
 * @param {number} totalLines 有效代码行数
 * @returns {number} σ ∈ (0, 1]
 */
function sizeNormalization(totalLines) {
  const n = Math.max(Number(totalLines) || 0, 30);
  return round(1 / (1 + Math.log(n / 30) / 3), 4);
}

/**
 * 计算单个问题在该次评分中实际生效的扣分
 * @param {object} issue 问题对象
 * @returns {number} 扣分值
 */
function issuePenalty(issue) {
  const weight = SEVERITIES[issue.severity]?.weight ?? 0;
  const sourceFactor = issue.source === 'llm' ? LLM_SOURCE_FACTOR * (Number(issue.confidence) || 0.7) : 1;
  return weight * sourceFactor;
}

/**
 * 判定等级
 * @param {number} score 综合得分
 * @returns {{grade:string,label:string,advice:string}} 等级信息
 */
function resolveGrade(score) {
  return GRADE_THRESHOLDS.find((item) => score >= item.min) || GRADE_THRESHOLDS[GRADE_THRESHOLDS.length - 1];
}

/**
 * 计算完整评分卡
 * @param {object} input 输入
 * @param {object[]} input.issues 合并后的问题列表
 * @param {object} input.metrics 度量结果
 * @param {object} [input.options] 选项
 * @param {boolean} [input.options.enableStructuralPenalty] 是否启用结构风险修正
 * @returns {object} 评分卡
 */
function computeScore({ issues, metrics, options = {} }) {
  const totalLines = metrics?.nonBlankLines || metrics?.totalLines || 0;
  const sigma = sizeNormalization(totalLines);
  const enableStructural = options.enableStructuralPenalty !== false;

  const dimensionRaw = {};
  const dimensionCounts = {};
  for (const key of Object.keys(DIMENSIONS)) {
    dimensionRaw[key] = 0;
    dimensionCounts[key] = 0;
  }

  const deductions = [];
  let rawPenalty = 0;

  for (const issue of issues) {
    const penalty = issuePenalty(issue);
    if (penalty <= 0) continue;
    rawPenalty += penalty;
    const dimension = DIMENSIONS[issue.dimension] ? issue.dimension : 'maintainability';
    dimensionRaw[dimension] += penalty;
    dimensionCounts[dimension] += 1;
    deductions.push({
      issueId: issue.id,
      ruleId: issue.ruleId,
      title: issue.title,
      severity: issue.severity,
      source: issue.source,
      weight: SEVERITIES[issue.severity]?.weight ?? 0,
      applied: round(penalty, 2),
    });
  }

  // 结构风险附加扣分：复杂度与嵌套深度
  const structural = { complexityPenalty: 0, nestingPenalty: 0, maintainabilityFactor: 0 };
  if (enableStructural && metrics) {
    const complexityOver = Math.max(0, (metrics.maxComplexity || 0) - 15);
    if (complexityOver > 0) {
      structural.complexityPenalty = round(Math.min(complexityOver * 0.8, 12), 2);
    }
    const nestingOver = Math.max(0, (metrics.maxNesting || 0) - 4);
    if (nestingOver > 0) {
      structural.nestingPenalty = round(Math.min(nestingOver * 1.5, 9), 2);
    }
    structural.maintainabilityFactor = round(structural.complexityPenalty + structural.nestingPenalty, 2);
    dimensionRaw.maintainability += structural.maintainabilityFactor;
    rawPenalty += structural.maintainabilityFactor;
  }

  const overallPenalty = round(rawPenalty * sigma, 2);
  const overall = round(clamp(100 - overallPenalty, 0, 100), 1);

  const dimensions = {};
  for (const [key, definition] of Object.entries(DIMENSIONS)) {
    const sensitivity = DIMENSION_SENSITIVITY[key] ?? 1;
    const penalty = round(dimensionRaw[key] * sigma * sensitivity, 2);
    dimensions[key] = {
      key,
      label: definition.label,
      color: definition.color,
      score: round(clamp(100 - penalty, 0, 100), 1),
      penalty,
      issueCount: dimensionCounts[key],
    };
  }

  const gradeInfo = resolveGrade(overall);

  return {
    overall,
    grade: gradeInfo.grade,
    gradeLabel: gradeInfo.label,
    advice: gradeInfo.advice,
    dimensions,
    penalty: {
      raw: round(rawPenalty, 2),
      normalized: overallPenalty,
      sigma,
      structural: structural.maintainabilityFactor,
      bySeverity: Object.keys(SEVERITIES).reduce((acc, key) => {
        acc[key] = round(
          issues.filter((issue) => issue.severity === key).reduce((sum, issue) => sum + issuePenalty(issue), 0),
          2,
        );
        return acc;
      }, {}),
    },
    structural,
    /** 扣分明细：按生效扣分降序，用于报告中的「得分构成」表格 */
    deductions: deductions.sort((a, b) => b.applied - a.applied).slice(0, 50),
    model: {
      name: 'CodeGuard 加权扣分模型 v1',
      description:
        '综合得分 = 100 − σ × Σ(严重级别权重 × 来源可信度)；维度得分在此基础上叠加维度敏感度系数与结构风险修正。',
      sigma,
      formula: 'overall = clamp(100 - sigma * sum(weight_i * confidence_i), 0, 100)',
    },
  };
}

module.exports = {
  computeScore,
  sizeNormalization,
  issuePenalty,
  resolveGrade,
  DIMENSION_SENSITIVITY,
  GRADE_THRESHOLDS,
};
