'use strict';

/**
 * 业务错误体系
 * ---------------------------------------------------------------------------
 * 所有可预期的失败都通过 AppError 的子类向上抛出，HTTP 层统一捕获并转换为
 * 带有稳定错误码的 JSON 响应；未识别的异常一律按 500 处理，避免泄漏堆栈细节。
 */

/**
 * 应用级错误基类
 */
class AppError extends Error {
  /**
   * @param {string} message 面向用户的错误描述
   * @param {object} [options] 选项
   * @param {string} [options.code] 稳定错误码，供前端分支判断
   * @param {number} [options.status] HTTP 状态码
   * @param {object} [options.details] 附加信息
   */
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'APP_ERROR';
    this.status = options.status || 500;
    this.details = options.details || null;
    this.expose = options.expose !== false;
    Error.captureStackTrace?.(this, this.constructor);
  }

  /**
   * 转换为统一的 JSON 响应体
   * @returns {{error:{code:string,message:string,details:object|null}}}
   */
  toResponse() {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : '服务内部错误，请查看服务端日志',
        details: this.details,
      },
    };
  }
}

/** 请求参数校验失败（400） */
class ValidationError extends AppError {
  /**
   * @param {string} message 错误描述
   * @param {object} [details] 字段级明细
   */
  constructor(message, details) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, details });
  }
}

/** 资源不存在（404） */
class NotFoundError extends AppError {
  /**
   * @param {string} message 错误描述
   */
  constructor(message) {
    super(message, { code: 'NOT_FOUND', status: 404 });
  }
}

/** 请求体过大（413） */
class PayloadTooLargeError extends AppError {
  /**
   * @param {number} limit 限制字节数
   */
  constructor(limit) {
    super(`请求体超过上限 ${limit} 字节`, { code: 'PAYLOAD_TOO_LARGE', status: 413 });
  }
}

/** 大模型调用失败（502） */
class LlmError extends AppError {
  /**
   * @param {string} message 错误描述
   * @param {object} [details] 附加信息
   */
  constructor(message, details) {
    super(message, { code: 'LLM_ERROR', status: 502, details });
  }
}

/** 配置缺失或非法（500） */
class ConfigError extends AppError {
  /**
   * @param {string} message 错误描述
   */
  constructor(message) {
    super(message, { code: 'CONFIG_ERROR', status: 500 });
  }
}

/**
 * 将任意异常规整为 AppError
 * @param {unknown} error 原始异常
 * @returns {AppError} 规整后的错误
 */
function toAppError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError(error.message, { code: 'INTERNAL_ERROR', status: 500, expose: false });
  }
  return new AppError(String(error), { code: 'INTERNAL_ERROR', status: 500, expose: false });
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  PayloadTooLargeError,
  LlmError,
  ConfigError,
  toAppError,
};
