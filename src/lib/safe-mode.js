// src/lib/safe-mode.js
// 熔断/安全模式：连续启动失败达到阈值 → 备份并移出第三方 bundle（仅核心功能启动）。
// 成功启动 → 会话退出时恢复配置；异常退出（强杀）→ 下次启动自动恢复备份。
// 独立模块：不依赖 electron，可单元测试；由 main.js 在启动流程中接入。

const fs = require('fs');
const path = require('path');

const DEFAULT_THRESHOLD = 3;   // 窗口内失败次数阈值
const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 判定窗口 1 小时

class SafeMode {
  /**
   * @param {object} options
   * @param {string} options.profileDir web profile 目录（含 package.json）
   * @param {Set<string>} options.coreDeps 核心依赖包名（安全模式保留）
   * @param {string} [options.backupName] 备份文件名（测试可隔离）
   */
  constructor({ profileDir, coreDeps, backupName = '.dsh-safe-mode-backup.json' }) {
    this.profileDir = profileDir;
    this.coreDeps = coreDeps || new Set();
    this.backupFile = path.join(profileDir, backupName);
  }

  /**
   * 是否应进入安全模式：brain.throttle 中指定错误码前缀的失败次数
   * 在窗口内累计 >= threshold。
   * @param {object} throttle brain.throttle（{ 'fp|action': [ts...] }）
   * @param {string[]} codePrefixes 错误码前缀（如 ['BOOT-004|']）
   * @param {number} [threshold]
   * @param {number} [windowMs]
   */
  shouldEnter(throttle, codePrefixes, threshold = DEFAULT_THRESHOLD, windowMs = DEFAULT_WINDOW_MS) {
    const now = Date.now();
    let fails = 0;
    for (const key of Object.keys(throttle || {})) {
      if (!codePrefixes.some((p) => key.startsWith(p))) continue;
      fails += (throttle[key] || []).filter((t) => now - t < windowMs).length;
    }
    return fails >= threshold;
  }

  /**
   * 应用安全模式：备份当前配置并移除第三方 bundle。
   * @returns {{removed:string[]}|null} 移除的第三方 bundle；无第三方或失败返回 null
   */
  apply() {
    try {
      const pkgJsonPath = path.join(this.profileDir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) return null;
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const bundles = (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles))
        ? [...pkg.dsh.profile.bundles]
        : [];
      const thirdParty = bundles.filter((b) => !this.coreDeps.has(b));
      if (thirdParty.length === 0) return null; // 无第三方插件可隔离

      fs.writeFileSync(this.backupFile, JSON.stringify({ pkg }, null, 2));
      pkg.dsh = { ...pkg.dsh, profile: { ...(pkg.dsh.profile || {}), bundles: bundles.filter((b) => this.coreDeps.has(b)) } };
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
      return { removed: thirdParty };
    } catch (e) {
      return null;
    }
  }

  /** 恢复备份配置（安全模式会话退出/异常退出后调用），幂等 */
  restore() {
    try {
      if (!this.hasBackup()) return false;
      const backup = JSON.parse(fs.readFileSync(this.backupFile, 'utf-8'));
      if (backup && backup.pkg) {
        fs.writeFileSync(path.join(this.profileDir, 'package.json'), JSON.stringify(backup.pkg, null, 2) + '\n');
      }
      fs.unlinkSync(this.backupFile);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 是否存在未恢复的备份（上次会话异常退出） */
  hasBackup() {
    return fs.existsSync(this.backupFile);
  }
}

module.exports = { SafeMode, DEFAULT_THRESHOLD, DEFAULT_WINDOW_MS };