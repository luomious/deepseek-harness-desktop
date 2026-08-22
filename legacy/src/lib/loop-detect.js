// src/lib/loop-detect.js
// 回环检测器：识别「同一问题反复处理失败」的循环模式。
// 语义：对同一错误指纹（fingerprint）累计失败次数，达到阈值即判定为「环」。
// 判环后由调用方（brain.js）强制升级破坏等级，避免低等级动作无限重试。

class LoopDetector {
  /**
   * @param {number} threshold 连续失败次数阈值，>= 该值判定为环（默认 2）
   */
  constructor(threshold = 2) {
    this.threshold = threshold;
    // fp -> { lastAction, count }
    this.state = {};
  }

  /**
   * 记录一次失败（同一指纹累计；换动作不重置——换动作说明上一级策略失败）
   * @param {string} fp 错误指纹
   * @param {string} action 本次失败的动作名
   */
  record(fp, action) {
    const s = this.state[fp];
    if (s) {
      s.lastAction = action;
      s.count += 1;
    } else {
      this.state[fp] = { lastAction: action, count: 1 };
    }
  }

  /** 成功反馈：清零该指纹的失败计数（问题解决，重新开始） */
  reset(fp) {
    delete this.state[fp];
  }

  /** 是否已判环 */
  looped(fp) {
    const s = this.state[fp];
    return !!(s && s.count >= this.threshold);
  }

  /** 当前失败次数 */
  count(fp) {
    const s = this.state[fp];
    return s ? s.count : 0;
  }

  /** 最近一次失败的动作（判环升级时据此跳过当前等级） */
  lastAction(fp) {
    const s = this.state[fp];
    return s ? s.lastAction : null;
  }
}

module.exports = { LoopDetector };