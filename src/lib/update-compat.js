// src/lib/update-compat.js
// 更新前兼容性评估 / 更新后自检 / 回滚（防止「更新完无法正常使用」再次发生）。
// 背景：0.1.0-rc.6 → 0.1.1-rc.2 升级后 modlens 补丁被覆盖 + 自愈被端口占用跳过，
// 导致粘贴显示路径等问题复发。本模块在更新前评估风险、更新后自检、异常可一键回滚。
// 设计：纯函数（assessUpdate / parseVersion / satisfiesNode / freeBytesOf / fetchPackageMeta）
// + 工厂（createUpdateCompat，全依赖注入），裸 node 可单测；任何检查失败一律 fail-open。

const fs = require('fs');
const os = require('os');
const https = require('https');
const { probeManifest } = require('./patch-manifest');

const DSH_PKG = '@deepseek-ai/dsh';

/** 解析版本号（支持 0.1.1-rc.2 等 pre-release）；无法解析返回 null */
function parseVersion(v) {
  const s = String(v || '').trim();
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null, raw: s };
}

function isPre(v) { return !!(v && v.pre); }

/**
 * 极简 semver 满足判断（Node engines 用）：
 * 支持 >= > <= < = ^ ~ 及空格分隔的 AND、|| 分隔的 OR；无法解析的段视为放行。
 * 覆盖 Node engines 常见写法（">=18" / ">=18.0.0 <25" / "^18.0.0" / "18 || >=20"）。
 */
function satisfiesNode(version, range) {
  try {
    const v = parseVersion(version);
    if (!v) return true;
    return String(range)
      .split('||')
      .some((alt) =>
        alt
          .trim()
          .split(/\s+/)
          .every((part) => {
            if (!part) return true;
            const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(part);
            if (!m) return true; // 无法解析的单段 → 放行
            const op = m[1] || '=';
            const tv = { major: Number(m[2]), minor: Number(m[3] || 0), patch: Number(m[4] || 0) };
            const cmp = v.major - tv.major || v.minor - tv.minor || v.patch - tv.patch;
            switch (op) {
              case '>=': return cmp >= 0;
              case '<=': return cmp <= 0;
              case '>': return cmp > 0;
              case '<': return cmp < 0;
              case '^': return v.major === tv.major && cmp >= 0;
              case '~': return v.major === tv.major && v.minor === tv.minor && cmp >= 0;
              default: return cmp === 0;
            }
          })
      );
  } catch (e) {
    return true;
  }
}

/** 目录所在磁盘可用字节（statfs）；失败返回 null */
function freeBytesOf(dir) {
  try {
    const s = fs.statfsSync(dir || os.homedir());
    return s.bavail * s.bsize;
  } catch (e) {
    return null;
  }
}

/** 拉取 npm 最新包元数据（含 engines），15s 超时；失败返回 null（fail-open） */
function fetchPackageMeta(pkgName = DSH_PKG, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const req = https.get(`https://registry.npmjs.org/${pkgName}/latest`, (res) => {
      if (res.statusCode !== 200) { res.resume(); done(null); return; }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { done(JSON.parse(data)); } catch (e) { done(null); } });
    });
    req.on('error', () => done(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); done(null); });
  });
}

/**
 * 纯评估函数：综合版本跨度 / 补丁健康度 / Node 引擎 / 磁盘空间，产出风险清单与结论。
 * input: { local, remote, profileDir, nodeVersion, freeBytes, remoteEngines, patchProbe }
 * 返回 { verdict: 'ok'|'warn'|'block', summary, risks:[{level,text}], checks:[...], recommendations:[...] }
 */
function assessUpdate(input) {
  const { local, remote, nodeVersion, freeBytes, remoteEngines, patchProbe } = input || {};
  const risks = [];
  const checks = [];
  const recommendations = [];
  const lv = parseVersion(local);
  const rv = parseVersion(remote);

  // 1. 版本跨度
  if (!lv || !rv) {
    risks.push({ level: 'warn', text: `无法解析版本号（local=${local}, remote=${remote}），按未知风险处理。` });
  } else {
    checks.push({ name: '版本跨度', status: 'pass', detail: `${local} → ${remote}` });
    const majorJump = rv.major !== lv.major;
    const minorJump = !majorJump && rv.minor !== lv.minor;
    const rcToStable = isPre(lv) && !isPre(rv);
    const patchJump = !majorJump && !minorJump && rv.patch !== lv.patch;
    if (majorJump) {
      risks.push({ level: 'danger', text: `主版本升级（${lv.major}.x → ${rv.major}.x）：上游可能有大范围接口/配置变更，本项目的自愈补丁与插件可能需要重新适配。` });
    }
    if (minorJump) {
      risks.push({ level: 'warn', text: `次版本升级（${lv.major}.${lv.minor} → ${lv.major}.${rv.minor}）：上游 rc 迭代常伴随前端/核心重构（上次 0.1.1-rc.2 就改版了 Vite 前端与 settings-models），自愈补丁需重新验证。` });
    }
    if (rcToStable) {
      risks.push({ level: 'warn', text: `从预发布（${lv.raw}）升级到正式版（${rv.raw}）：行为可能收紧，建议升级后重点验证粘贴图片、模型管理、远程工作区、文件浏览器。` });
    }
    if (patchJump && !rcToStable) {
      checks.push({ name: '补丁级升级', status: 'pass', detail: '补丁级升级通常只修 bug，风险低。' });
    }
  }

  // 2. 补丁健康度（当前版本只读探测）——锚点已失配的补丁，升级后大概率仍失配
  const probe = Array.isArray(patchProbe) ? patchProbe : [];
  const failed = probe.filter((x) => x.status === 'failed');
  if (failed.length > 0) {
    const coreFailed = failed.filter((x) => /^dsh-core-/.test(x.id));
    risks.push({
      level: 'warn',
      text: `当前版本已有 ${failed.length} 项自愈补丁失效（${failed.map((x) => x.id).join('、')}）${coreFailed.length ? `，其中核心补丁 ${coreFailed.map((x) => x.id).join('、')}` : ''}。升级后这些补丁大概率同样失效（多为增强功能，不影响核心使用）；升级完成会自动重跑自愈并在诊断日志中提示 PATCH-001。`,
    });
  } else {
    checks.push({ name: '补丁自愈清单', status: 'pass', detail: '当前全部自愈补丁正常。' });
  }

  // 3. Node 引擎要求
  const engines = remoteEngines && remoteEngines.node;
  if (engines) {
    if (nodeVersion && !satisfiesNode(nodeVersion, engines)) {
      risks.push({ level: 'danger', text: `新版本要求 Node ${engines}，当前 ${nodeVersion} 不满足，升级后可能无法启动。` });
    } else {
      checks.push({ name: 'Node 版本', status: 'pass', detail: `当前 ${nodeVersion}，满足新版本要求（${engines}）` });
    }
  } else if (remoteEngines === undefined) {
    checks.push({ name: 'Node 版本', status: 'skip', detail: '未能获取新版本引擎要求（网络受限），跳过此项检查。' });
  }

  // 4. 磁盘空间
  if (freeBytes != null) {
    const gb = freeBytes / 1024 / 1024 / 1024;
    if (freeBytes < 200 * 1024 * 1024) {
      risks.push({ level: 'danger', text: `磁盘可用空间仅 ${gb.toFixed(1)} GB，npm 安装可能失败（建议 ≥1 GB）。` });
    } else if (freeBytes < 1024 * 1024 * 1024) {
      risks.push({ level: 'warn', text: `磁盘可用空间 ${gb.toFixed(1)} GB 偏少，安装大型依赖可能变慢或失败。` });
    } else {
      checks.push({ name: '磁盘空间', status: 'pass', detail: `可用 ${gb.toFixed(1)} GB` });
    }
  } else {
    checks.push({ name: '磁盘空间', status: 'skip', detail: '无法读取磁盘空间。' });
  }

  // 5. 本项目已知风险点（modlens 服务端补丁在 profile node_modules，升级可能被重装覆盖）
  risks.push({ level: 'info', text: '本项目自定义提示：升级可能覆盖 ~/.dsh/profiles/web 下 modlens 等服务端补丁；升级完成后应用会自动重跑补丁自愈（modlens-takeover-verdict 等），若提示 PATCH-001 表示需人工适配，可先回滚。' });

  // 6. 回滚保险
  recommendations.push(`已记录当前版本 ${local}：若升级后自检异常，可直接一键回滚到 ${local}。`);
  recommendations.push('升级完成后会先做自检（补丁健康 + 服务就绪），有问题会弹窗提示并可选回滚。');

  const danger = risks.filter((r) => r.level === 'danger').length;
  const warn = risks.filter((r) => r.level === 'warn').length;
  const verdict = danger > 0 ? 'block' : warn > 0 ? 'warn' : 'ok';
  const summary =
    verdict === 'block'
      ? '⚠️ 不建议更新：发现高风险项，可能升级后无法正常使用。'
      : verdict === 'warn'
        ? '⚠️ 建议谨慎更新：存在需注意项，升级后请留意自检结果。'
        : '✅ 检查通过：未发现明显风险，可安全更新。';
  return { verdict, summary, risks, checks, recommendations, local, remote };
}

/**
 * 工厂：注入 profileDir / execNode / findNpmCli / dshService / errorLog / logger。
 * 返回 { assessCompatibility, postUpdateSelfTest, rollback }。
 */
function createUpdateCompat(options = {}) {
  const { profileDir, execNode, findNpmCli, dshService, errorLog, logger } = options;

  return {
    /** 更新前评估：版本跨度 + 补丁只读探测 + Node 引擎（远程尽力而为）+ 磁盘；全部 fail-open */
    async assessCompatibility({ local, remote } = {}) {
      let patchProbe = [];
      try { patchProbe = probeManifest({ profileDir }); } catch (e) {}
      let remoteMeta = null;
      try { remoteMeta = await fetchPackageMeta(DSH_PKG); } catch (e) {}
      const freeBytes = freeBytesOf(profileDir || os.homedir());
      return assessUpdate({
        local,
        remote,
        profileDir,
        nodeVersion: process.versions.node,
        freeBytes,
        remoteEngines: remoteMeta ? remoteMeta.engines : undefined,
        patchProbe,
      });
    },

    /** 更新后自检：补丁只读探测 + 服务端口就绪；返回 { ok, issues }（不抛错） */
    async postUpdateSelfTest({ local } = {}) {
      const issues = [];
      try {
        const probe = probeManifest({ profileDir });
        const failed = probe.filter((x) => x.status === 'failed');
        if (failed.length > 0) {
          issues.push(`自愈补丁 ${failed.length} 项失效：${failed.map((x) => x.id).join('、')}（多为增强功能；可查看诊断日志 PATCH-001）`);
        }
      } catch (e) {
        issues.push('补丁探测异常：' + (e.message || e));
      }
      if (dshService && typeof dshService.isPortListening === 'function') {
        try {
          if (await dshService.isPortListening()) {
            const ok = await dshService.isDSHListening(3080);
            if (!ok) issues.push('服务端口 3080 未返回预期页面（__DSH_BOOT__）');
          }
        } catch (e) {
          issues.push('服务就绪检查异常：' + (e.message || e));
        }
      }
      return { ok: issues.length === 0, issues, version: local || null };
    },

    /** 回滚到指定版本：npm install -g @deepseek-ai/dsh@<version> */
    async rollback(version) {
      const npmCli = findNpmCli ? findNpmCli() : null;
      if (!npmCli) throw new Error('未找到 npm-cli.js，无法回滚');
      if (!execNode) throw new Error('未注入 execNode，无法回滚');
      if (errorLog) {
        errorLog.log('UPD-003', { module: 'update-compat', msg: `回滚到 ${version}`, ctx: { version } });
      }
      const out = await execNode(npmCli, ['install', '-g', `${DSH_PKG}@${version}`], null, 180000);
      if (logger) logger('[DSH Desktop] rollback output: ' + out);
      return version;
    },
  };
}

module.exports = {
  createUpdateCompat,
  assessUpdate,
  parseVersion,
  satisfiesNode,
  freeBytesOf,
  fetchPackageMeta,
  DSH_PKG,
};
