'use strict';

/**
 * 知识库检索器（RAG 的「检索」侧）
 * ---------------------------------------------------------------------------
 * 零依赖确定性检索：查询文本与条目做关键词/词元相关性打分，返回 Top-K。
 *
 * 检索策略（可解释、可复现）：
 *   1. 分词：英文/数字按词切分；中文按二元组（bigram）切分——零依赖下
 *      对短查询的召回足够稳定，且结果确定可复现；
 *   2. 打分：关键词整词命中 +4（最高权重），关键词词元与查询词元重合 +1/词元
 *      （封顶 3），标题词元重合 +2/词元（封顶 4），正文词元重合 +1/词元（封顶 3）；
 *   3. 召回：按分数降序取 Top-K，低于 minScore 的丢弃——宁缺毋滥，
 *      不给生成阶段塞无关上下文（阈值经实验取 5：单一关键词命中为 4 分，
 *      未获得多信号印证的弱匹配不召回）。
 */

const { KNOWLEDGE } = require('./knowledge-base');

/**
 * 分词：英文/数字整词 + 中文二元组
 * @param {string} text 文本
 * @returns {Set<string>} 词元集合
 */
function tokenize(text) {
  const source = String(text || '').toLowerCase();
  const tokens = new Set();

  for (const match of source.matchAll(/[a-z0-9_+#.]+/g)) {
    tokens.add(match[0]);
  }

  for (const chunk of source.split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (!/[\u4e00-\u9fa5]/.test(chunk)) continue;
    if (chunk.length === 1) {
      tokens.add(chunk);
      continue;
    }
    for (let i = 0; i + 1 < chunk.length; i += 1) {
      tokens.add(chunk.slice(i, i + 2));
    }
  }

  return tokens;
}

/**
 * 计算单个条目与查询的相关性得分
 * @param {object} entry 知识库条目
 * @param {string} lowerQuery 小写查询文本
 * @param {Set<string>} queryTokens 查询词元
 * @returns {number} 得分（0 表示不相关）
 */
function scoreEntry(entry, lowerQuery, queryTokens) {
  let score = 0;

  // 1) 关键词整词命中
  for (const keyword of entry.keywords) {
    if (lowerQuery.includes(keyword.toLowerCase())) score += 4;
  }

  // 2) 关键词词元重合（封顶 3）
  let keywordOverlap = 0;
  for (const keyword of entry.keywords) {
    for (const token of tokenize(keyword)) {
      if (queryTokens.has(token)) keywordOverlap += 1;
    }
  }
  score += Math.min(keywordOverlap, 3);

  // 3) 标题词元重合（封顶 4）
  const titleOverlap = [...tokenize(entry.title)].filter((token) => queryTokens.has(token)).length;
  score += Math.min(titleOverlap * 2, 4);

  // 4) 正文词元重合（封顶 3）
  const contentOverlap = [...tokenize(entry.content)].filter((token) => queryTokens.has(token)).length;
  score += Math.min(contentOverlap, 3);

  return score;
}

/**
 * 检索最相关的知识条目
 * @param {string} query 查询文本（提示词 / 问题描述 / 报错信息均可）
 * @param {object} [options] 选项
 * @param {number} [options.limit=3] 返回条数上限
 * @param {number} [options.minScore=4] 最低相关性分数（低于此值不召回）
 * @returns {Array<object>} 条目（附 score 与 snippet），按分数降序
 */
function retrieve(query, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 3;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 5;

  const lowerQuery = String(query || '').toLowerCase().trim();
  if (!lowerQuery) return [];
  const queryTokens = tokenize(lowerQuery);

  return KNOWLEDGE
    .map((entry) => ({ entry, score: scoreEntry(entry, lowerQuery, queryTokens) }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map((item) => ({
      id: item.entry.id,
      title: item.entry.title,
      category: item.entry.category,
      content: item.entry.content,
      score: item.score,
      snippet: item.entry.content.slice(0, 60),
    }));
}

module.exports = { tokenize, retrieve };
