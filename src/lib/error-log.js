// src/lib/error-log.js
// 错误日志（诊断中心核心）：行式 JSON 追加，每条记录错误码 + 标题 + 解决指引 + 上下文。
// 超出上限截半（复用启动日志思路），损坏/写入失败不阻断主流程。
// 独立模块：不依赖 electron，可单元测试；由 main.js 在关键错误点调用。

const fs = require('fs');
const path = require('path');
const { getErrorCode } = require('./error-codes');

const DEFAULT_MAX_BYTES = 1024 * 1024; // 单日志文件上限 1MB

class ErrorLog {
  /**
   * @param {object} options
   * @param {string} [options.file] 日志文件路径（不传 = 内存模式，测试用）
   * @param {number} [options.maxBytes] 单文件上限（默认 1MB，超出截半）
   */
  constructor(options = {}) {
    this.file = options.file || null;
    this.maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
    this.entries = [];
  }

  /**
   * 记录一条错误（结构化 JSON 行）。
   * @param {string} code 错误码（见 error-codes.js）
   * @param {object} [info] { module, msg, ctx }
   * @returns {object} 错误码定义（title/hint，未知码返回兜底）
   */
  log(code, info = {}) {
    const def = getErrorCode(code);
    const entry = {
      ts: new Date().toISOString(),
      level: 'error',
      code,
      module: info.module || 'main',
      title: def.title,
      hint: def.hint,
      msg: info.msg ? String(info.msg) : '',
      ctx: info.ctx || {},
    };
    this.entries.push(entry);
    if (this.file) this._append(entry);
    return def;
  }

  /** 读取最近 N 条记录（按写入顺序） */
  readRecent(maxLines = 50) {
    return this.entries.slice(-maxLines);
  }

  _append(entry) {
    try {
      this._truncateIfNeeded();
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch (e) { /* 写入失败不阻断主流程 */ }
  }

  _truncateIfNeeded() {
    try {
      const st = fs.statSync(this.file);
      if (st.size > this.maxBytes) {
        const buf = Buffer.from(fs.readFileSync(this.file, 'utf8'));
        // 全部按字节计算（文件含中文时字符数 ≠ 字节数）
        if (buf.length > this.maxBytes) {
          // 保留后半段（更新鲜），压到上限一半以下（字节），避免追加一行后立即再次超限
          const keepBytes = Math.max(1, Math.min(buf.length / 2, this.maxBytes / 2));
          let startByte = Math.max(0, buf.length - Math.floor(keepBytes));
          // 对齐到行首：避免切断多字节字符、破坏 JSON 行结构
          const nl = buf.indexOf(0x0a, startByte);
          if (nl !== -1 && nl < buf.length - 1) startByte = nl + 1;
          fs.writeFileSync(this.file, buf.slice(startByte).toString('utf8'));
        }
      }
    } catch (e) { /* 文件不存在等：忽略 */ }
  }
}

module.exports = { ErrorLog, DEFAULT_MAX_BYTES };