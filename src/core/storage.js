'use strict';

/**
 * 评审记录持久化（零依赖）
 * ---------------------------------------------------------------------------
 * 采用「一条记录一个 JSON 文件 + 内存索引」的轻量方案：
 *   - 写入使用「临时文件 → 原子重命名」，避免进程中断产生半截文件；
 *   - 启动时扫描目录重建索引，天然支持跨进程崩溃恢复；
 *   - 记录量级在万级以内时，性能与可读性均优于引入 SQLite。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');
const { NotFoundError, ValidationError } = require('./errors');

const log = logger.child('storage');

/** 评审记录存储 */
class ReviewStore {
  /**
   * @param {string} [dir] 记录目录，默认取配置中的 data/reviews
   */
  constructor(dir = config.storage.reviewsDir) {
    this.dir = dir;
    /** @type {Map<string, object>} id → 记录摘要索引 */
    this.index = new Map();
    this.ready = false;
  }

  /** 初始化目录并重建索引 */
  init() {
    if (this.ready) return this;
    fs.mkdirSync(this.dir, { recursive: true });
    this.rebuildIndex();
    this.ready = true;
    log.info(`评审记录存储就绪，已加载 ${this.index.size} 条历史记录`, { dir: this.dir });
    return this;
  }

  /** 扫描目录重建内存索引 */
  rebuildIndex() {
    this.index.clear();
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch (error) {
      log.warn('读取存储目录失败', { message: error.message });
      return;
    }

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf8');
        const record = JSON.parse(raw);
        if (record && record.id) this.index.set(record.id, this.toSummary(record));
      } catch (error) {
        // 单条坏数据不应影响整体可用性
        log.warn(`跳过损坏的记录文件 ${file}`, { message: error.message });
      }
    }
  }

  /**
   * 记录 → 列表摘要（列表接口不下发大字段，降低传输体积）
   * @param {object} record 完整记录
   * @returns {object} 摘要
   */
  toSummary(record) {
    return {
      id: record.id,
      createdAt: record.createdAt,
      title: record.source?.title || '未命名片段',
      language: record.source?.language || 'text',
      fileName: record.source?.fileName || null,
      lines: record.metrics?.totalLines || 0,
      codeHash: record.source?.codeHash || '',
      score: record.score?.overall ?? null,
      grade: record.score?.grade || null,
      issueCount: record.issues?.length || 0,
      severityCounts: record.stats?.severityCounts || {},
      durationMs: record.stats?.durationMs || 0,
      engines: record.engines || {},
    };
  }

  /**
   * 保存记录（原子写入）
   * @param {object} record 完整记录
   * @returns {object} 保存后的记录
   */
  save(record) {
    this.init();
    if (!record?.id) throw new ValidationError('评审记录缺少 id 字段');

    const target = path.join(this.dir, `${record.id}.json`);
    const temp = `${target}.${process.pid}.tmp`;

    // 先写临时文件再重命名，保证任何时刻磁盘上的文件都是完整 JSON
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(temp, target);

    this.index.set(record.id, this.toSummary(record));
    return record;
  }

  /**
   * 读取完整记录
   * @param {string} id 记录 ID
   * @returns {object} 完整记录
   * @throws {NotFoundError} 记录不存在
   */
  get(id) {
    this.init();
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) throw new NotFoundError(`评审记录不存在：${id}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /**
   * 分页列出记录摘要（按创建时间倒序）
   * @param {object} [options] 选项
   * @param {number} [options.limit] 每页条数
   * @param {number} [options.offset] 偏移量
   * @param {string} [options.keyword] 标题关键字过滤
   * @returns {{total:number, items:object[], limit:number, offset:number}}
   */
  list(options = {}) {
    this.init();
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const keyword = String(options.keyword || '').trim().toLowerCase();

    let items = [...this.index.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    if (keyword) {
      items = items.filter((item) => String(item.title).toLowerCase().includes(keyword));
    }

    return {
      total: items.length,
      limit,
      offset,
      items: items.slice(offset, offset + limit),
    };
  }

  /**
   * 删除记录
   * @param {string} id 记录 ID
   * @returns {boolean} 是否删除了文件
   */
  remove(id) {
    this.init();
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) throw new NotFoundError(`评审记录不存在：${id}`);
    fs.unlinkSync(file);
    this.index.delete(id);
    return true;
  }

  /** 按创建日期清理超出保留期的记录 */
  prune(keepDays = 30) {
    this.init();
    const deadline = Date.now() - keepDays * 24 * 3600 * 1000;
    let removed = 0;
    for (const [id, summary] of this.index.entries()) {
      if (new Date(summary.createdAt).getTime() < deadline) {
        this.remove(id);
        removed += 1;
      }
    }
    return removed;
  }
}

module.exports = { ReviewStore, store: new ReviewStore() };
