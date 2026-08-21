// src/lib/plugin-manager.js
// 插件管理数据层唯一实现：profile 插件清单/bundle 与纯前端挂载状态（cordis.patch.yml 读写）、
// 禁用/启用、安装/卸载（pnpm.cjs 直连无 shell）、reconcile 对齐（bundles 层 + insert 挂载块）。
// 依赖注入（profileDir/coreDeps/validateArg/findPnpmBin/getNodeExe），便于裸 node 单测。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { withBuildLock } = require('./build-lock.js');

function createPluginManager(options) {
  const profileDir = options.profileDir;
  const coreDeps = options.coreDeps || new Set();
  const validateArg = options.validateArg || (() => null);
  const findPnpmBin = options.findPnpmBin || (() => null);
  const getNodeExe = options.getNodeExe || (() => null);
  const logger = options.logger || console.log;

  /** 获取已安装的插件列表（过滤核心依赖，仅展示可管理的第三方插件） */
  function getInstalledPlugins(dir = profileDir) {
    try {
      const pkgJsonPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) return [];
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const deps = pkg.dependencies || {};
      return Object.entries(deps)
        .filter(([name]) => !coreDeps.has(name))
        .map(([name, version]) => ({ name, version, disabled: isPluginDisabled(name, dir) }));
    } catch (e) {
      return [];
    }
  }

  /**
   * 解析插件在 dsh 行（row）系统中的注册 id。
   * - 声明 dsh.bundle.patch 的插件（如皮肤包）：从 patch 文件的 insert 条目取行 id
   *   （皮肤是 ui-skin-maid-atelier，而非包名）
   * - 普通插件：行 id = 包名
   */
  function getPluginRowIds(packageName, dir = profileDir) {
    try {
      const base = path.join(dir, 'node_modules', packageName);
      const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf-8'));
      const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
      if (patchRel) {
        const patchPath = path.join(base, patchRel);
        if (fs.existsSync(patchPath)) {
          const text = fs.readFileSync(patchPath, 'utf-8');
          const ids = [];
          for (const m of text.matchAll(/^\s*- id:\s*['"]?([^'"\s]+)['"]?\s*$/gm)) ids.push(m[1]);
          if (ids.length) return ids;
        }
      }
    } catch (e) {}
    return [packageName];
  }

  /**
   * 读取 profile 的 cordis.patch.yml。返回 { header, items }：
   * - header：首个顶层列表项之前的注释/空行/占位 []
   * - items：顶层列表项块（每项从 "- " 起，含缩进续行；覆盖 "- id:" 覆盖行与 "- insert:" 挂载块）
   */
  function readProfilePatch(dir = profileDir) {
    const file = path.join(dir, 'cordis.patch.yml');
    if (!fs.existsSync(file)) return { header: [], items: [] };
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    const header = [];
    const items = [];
    let i = 0;
    while (i < lines.length && !lines[i].trim().startsWith('- ')) { header.push(lines[i]); i++; }
    while (i < lines.length) {
      const block = [lines[i]];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith(' ') || lines[j].startsWith('\t'))) { block.push(lines[j]); j++; }
      items.push(block);
      i = j;
    }
    return { header, items };
  }

  /** 写回 profile 补丁：header（去占位 [] 与多余空行）+ 各顶层块；无块时回退 [] */
  function writeProfilePatch(dir, header, items) {
    const file = path.join(dir, 'cordis.patch.yml');
    const headerPart = header.filter((l) => l.trim() !== '[]').reduce((acc, l) => {
      if (l.trim() === '') { if (acc.length && acc[acc.length - 1].trim() !== '') acc.push(l); }
      else acc.push(l);
      return acc;
    }, []);
    const body = items.length ? [...headerPart, ...items.flatMap((b) => b)] : [...headerPart, '[]'];
    fs.writeFileSync(file, body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
  }

  /** 块是否为 "- id: <id>" 覆盖行；是则返回 id，否则 null */
  function itemId(item) {
    const t = (item[0] || '').trim();
    if (!t.startsWith('- id:')) return null;
    return t.slice('- id:'.length).trim().replace(/^['"]/, '').replace(/['"]$/, '');
  }

  /** 块是否为挂载块；是则返回其 name 值，否则 null */
  function itemMountedName(item) {
    const t0 = (item[0] || '').trim();
    if (!t0.startsWith('- insert:')) return null;
    for (const l of item) {
      const t = l.trim();
      if (t.startsWith('name:')) return t.slice('name:'.length).trim().replace(/^['"]/, '').replace(/['"]$/, '');
    }
    return null;
  }

  /** 块是否为挂载 <packageName> 的 insert 块 */
  function itemMountsPackage(item, packageName) {
    return itemMountedName(item) === packageName;
  }

  /** 设置某行 id 的禁用状态（bundle 插件）：写入/移除 profile 补丁中的 disabled: true 覆盖行 */
  function setRowDisabled(rowId, disabled, dir = profileDir) {
    const { header, items } = readProfilePatch(dir);
    const next = items.filter((b) => itemId(b) !== rowId);
    if (disabled) next.push(["- id: '" + rowId + "'", '  disabled: true']);
    writeProfilePatch(dir, header, next);
  }

  /** 设置纯前端插件的挂载状态（非 bundle 插件）：写入/移除 insert 挂载块 */
  function setInsertRow(packageName, mounted, dir = profileDir) {
    const { header, items } = readProfilePatch(dir);
    const next = items.filter((b) => !itemMountsPackage(b, packageName));
    if (mounted) next.push(['- insert:', "    - id: '" + packageName + "'", "      name: '" + packageName + "'"]);
    writeProfilePatch(dir, header, next);
  }

  /** 依赖是否有浏览器端入口（dsh.client 声明 + exports["./client"]）——非 bundle 的纯前端插件 */
  function hasClientEntry(packageName, dir = profileDir) {
    try {
      const base = path.join(dir, 'node_modules', packageName);
      const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf-8'));
      if (!pkg.dsh || !pkg.dsh.client) return false;
      const exp = pkg.exports && pkg.exports['./client'];
      return typeof exp === 'string' || (exp && typeof exp.default === 'string');
    } catch (e) { return false; }
  }

  /** 某依赖是否声明 dsh.bundle（作为 profile 层参与启动组合） */
  function exportsBundlePatch(packageName, dir = profileDir) {
    try {
      const base = path.join(dir, 'node_modules', packageName);
      const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf-8'));
      const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
      if (!patchRel) return false;
      return fs.existsSync(path.join(base, patchRel));
    } catch (e) { return false; }
  }

  /** 插件当前是否被禁用 */
  function isPluginDisabled(packageName, dir = profileDir) {
    const { items } = readProfilePatch(dir);
    if (exportsBundlePatch(packageName, dir)) {
      // bundle 插件：profile 补丁中是否存在 disabled: true 覆盖行
      const rows = getPluginRowIds(packageName, dir);
      const disabledIds = new Set(
        items.filter((b) => b.join('\n').includes('disabled: true')).map((b) => itemId(b)).filter(Boolean)
      );
      return rows.some((id) => disabledIds.has(id));
    }
    if (hasClientEntry(packageName, dir)) {
      // 纯前端插件：挂载块缺失即视为禁用
      return !items.some((b) => itemMountsPackage(b, packageName));
    }
    return false;
  }

  /** 启用/禁用插件（写 profile 补丁；重启 dsh 后生效） */
  async function setPluginEnabled(packageName, enabled, dir = profileDir) {
    if (typeof enabled !== 'boolean') return { success: false, error: '参数错误', name: packageName };
    const verr = validateArg(packageName, 'pkg');
    if (verr) return { success: false, error: verr, name: packageName };
    if (coreDeps.has(packageName)) return { success: false, error: '核心依赖不允许禁用', name: packageName };
    if (!getInstalledPlugins(dir).some((p) => p.name === packageName)) {
      return { success: false, error: '插件未安装', name: packageName };
    }
    try {
      if (exportsBundlePatch(packageName, dir)) {
        const rows = getPluginRowIds(packageName, dir);
        for (const rowId of rows) setRowDisabled(rowId, !enabled, dir);
      } else if (hasClientEntry(packageName, dir)) {
        setInsertRow(packageName, enabled, dir);
      } else {
        return { success: false, error: '该插件无前端入口，卸载即可移除，无需禁用', name: packageName };
      }
      return { success: true, name: packageName, enabled };
    } catch (e) {
      return { success: false, error: e.message || String(e), name: packageName };
    }
  }

  /**
   * 对齐 profile 与已安装依赖（复刻上游 dsh plugin 的 reconcile 逻辑，并补纯前端插件挂载）：
   * - bundle 插件（声明 dsh.bundle）：加入 dsh.profile.bundles 层（其 cordis.patch.yml 才会被应用）
   * - 纯前端插件（dsh.client 但无 dsh.bundle）：在 profile 补丁追加 insert 挂载块
   * - 卸载/失去声明的分别移出；核心 bundle（dsh-base/dsh-web-app，不在 dependencies 中）不受影响
   */
  function reconcilePlugins(dir = profileDir) {
    try {
      const pkgJsonPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) return;
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const deps = Object.keys(pkg.dependencies || {});
      const depSet = new Set(deps);

      // 1) bundles 层对齐
      const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? [...pkg.dsh.profile.bundles] : [];
      let changed = false;
      for (const name of deps) {
        if (exportsBundlePatch(name, dir) && !bundles.includes(name)) { bundles.push(name); changed = true; }
      }
      const kept = bundles.filter((name) => depSet.has(name) ? exportsBundlePatch(name, dir) : coreDeps.has(name));
      if (kept.length !== bundles.length) { bundles.length = 0; bundles.push(...kept); changed = true; }
      if (changed) {
        pkg.dsh = { ...pkg.dsh, profile: { ...(pkg.dsh.profile || {}), bundles } };
        fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
      }

      // 2) 纯前端插件挂载块对齐
      const { header, items } = readProfilePatch(dir);
      // 移除挂载了"已不在依赖中"插件的 insert 块
      const nextItems = items.filter((b) => {
        const mounted = itemMountedName(b);
        if (mounted === null) return true; // 非 insert 块（用户行/禁用行）保留
        return depSet.has(mounted);         // 挂载的包仍在依赖中则保留，否则移除
      });
      // 补充缺失的纯前端插件挂载块
      let added = false;
      for (const name of deps) {
        if (exportsBundlePatch(name, dir)) continue; // bundle 插件走 bundles 层
        if (!hasClientEntry(name, dir)) continue;     // 无前端入口，无需挂载
        if (!nextItems.some((b) => itemMountsPackage(b, name))) {
          nextItems.push(['- insert:', "    - id: '" + name + "'", "      name: '" + name + "'"]);
          added = true;
        }
      }
      if (added || nextItems.length !== items.length) writeProfilePatch(dir, header, nextItems);
    } catch (e) {
      logger(`[DSH Desktop] reconcilePlugins failed: ${e.message || e}`);
    }
  }

  /**
   * 用 pnpm 原生命令管理插件（绕过 dsh plugin 上游命令注入漏洞）。
   * @deepseek-ai/dsh@0.1.0-rc.6 的 plugin-9h8shc4d.js 在 Windows 用
   * spawnSync("pnpm", args, { shell: true }) 执行，参数被拼进 cmd /c 字符串，
   * 存在命令注入（| whoami、& calc 可执行）。改用 spawn(node, [pnpm.cjs, ...args])
   * 参数数组直达 pnpm，无 shell 解析，注入面为零。
   */
  function pnpmCmd(action, target, cwd) {
    // 只接受固定操作：add / remove；target 为包名或 file: 路径
    if (action !== 'add' && action !== 'remove') throw new Error('不支持的插件操作: ' + action);
    if (!target || typeof target !== 'string') throw new Error('插件名不能为空');

    // 校验用户输入的包名/路径（防上游 shell 注入）
    // file: 前缀大小写不敏感（File:/FILE: 也识别）；本地路径统一去掉前缀后校验
    const isLocal = /^file:/i.test(target);
    const localPath = isLocal ? target.replace(/^file:/i, '') : target;
    const verr = validateArg(localPath, isLocal ? 'path' : 'pkg');
    if (verr) throw new Error(verr);

    // 本地路径规范化：去尾部反斜杠/斜杠（防 pnpm 解析 file:D:\plugins\ 异常）
    const finalTarget = isLocal
      ? 'file:' + localPath.replace(/[\\/]+$/, '')
      : target;

    const pnpmBin = findPnpmBin();
    if (!pnpmBin) throw new Error('未找到 pnpm.cjs，请先安装 pnpm（npm install -g pnpm）');

    // 固定参数由代码内部生成（无注入面）；用户参数只透传一个 finalTarget
    const args = [action, finalTarget, '--dir', profileDir];
    const dsh = getNodeExe();
    if (!dsh || !dsh.node) throw new Error('未找到 node 运行时，请确认 Node.js 安装正常');
    const nodeExe = dsh.node;
    // 构建互斥锁：pnpm add/remove 会瞬间改写 profile node_modules，与外部 agent
    // 的并发构建/安装竞争时运行中的 dsh 前端会读到 404。持锁串行执行（排队等待，
    // 不是失败）；锁协议见 lib/build-lock.js。
    return withBuildLock(`desktop: pnpm ${action} ${finalTarget}`, () => new Promise((resolve, reject) => {
      const child = spawn(nodeExe, [pnpmBin, ...args], {
        cwd: cwd || os.homedir(),
        windowsHide: true,
        shell: false,
      });
      let stdout = '', stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // 超时：Windows 上 child.kill() 只杀父进程，pnpm 派生的子进程可能残留
          // （占住 pnpm store 锁），用 taskkill /T /F 整树强杀（幂等，与 execNode 一致）
          if (process.platform === 'win32') {
            try {
              require('child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 });
            } catch (e) {}
          }
          try { child.kill(); } catch (e) {}
          reject(new Error(`命令超时: ${action} ${target}`));
        }
      }, 60000);
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => {
        if (settled) return; settled = true; clearTimeout(timer);
        reject(new Error(`命令执行失败: ${err.message}`));
      });
      child.on('close', (code) => {
        if (settled) return; settled = true; clearTimeout(timer);
        const out = stdout.trim();
        if (code === 0) resolve(out);
        else reject(new Error(out || stderr.trim() || `exit code ${code}`));
      });
    }));
  }

  /** 解析 pnpm 常见错误，转成用户可读的中文提示 */
  function friendlyPnpmError(raw) {
    const msg = String(raw || '');
    if (/ERR_PNPM_IGNORED_BUILDS/.test(msg)) {
      return '安装成功，但部分依赖的原生模块未编译（node-pty 等），终端类功能可能不可用。可运行 pnpm approve-builds 后重新构建。';
    }
    if (/ERR_PNPM_UNEXPECTED_STORE/.test(msg)) {
      return 'pnpm store 位置异常，请先运行 pnpm install 重新链接依赖。';
    }
    if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|network/.test(msg)) {
      return '网络错误：无法连接 npm 仓库，请检查网络后重试。';
    }
    if (/EACCES|EPERM|EINVAL|EROFS/.test(msg)) {
      return '权限不足或文件被占用，请关闭占用程序后重试。';
    }
    if (/not found|No matching version|404|NO_MATCHING_VERSION/.test(msg)) {
      return '未找到该插件包，请检查包名是否正确（npm 包名小写，scoped 包为 @scope/name）。';
    }
    if (/already exists|already installed/.test(msg)) {
      return '该插件已安装。';
    }
    if (/ERESOLVE|peer dep|peerDependencies/.test(msg)) {
      return '存在依赖冲突（peer dependencies），插件可能无法正常加载，请检查兼容性。';
    }
    // 截断过长的原始输出（防 pnpm 刷屏）
    const firstLine = msg.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || msg;
    return firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
  }

  /** 安装插件（远程包名） */
  async function installPlugin(pluginName) {
    if (!pluginName) return { success: false, error: '插件名不能为空' };

    // 确认 profile 目录存在
    if (!fs.existsSync(profileDir)) {
      return { success: false, error: `DSH profile 目录不存在: ${profileDir}` };
    }

    try {
      // 包名白名单校验（npm 包名字符，防上游 shell 注入）
      const verr = validateArg(pluginName, 'pkg');
      if (verr) return { success: false, error: verr, name: pluginName };

      // pnpm add <pkg> --dir <profile>（node 直接执行 pnpm.cjs，无 shell）
      const output = await pnpmCmd('add', pluginName, profileDir);
      // 同步 bundles 层：声明 dsh.bundle 的插件（皮肤等）自动加入 dsh.profile.bundles
      // （与 pnpmCmd 同一把 build-lock，避免与外部 agent 的构建/安装竞争改写 profile）
      await withBuildLock('desktop: reconcile (install)', () => { reconcilePlugins(); });
      return { success: true, output, name: pluginName };
    } catch (e) {
      const errMsg = friendlyPnpmError(e.message || e);
      // 部分情况实际安装成功（如 IGNORED_BUILDS 只是警告，pnpm 仍返回非 0）
      // 此时包已写入 profile，列表刷新后可见；标记为 success 以便 UI 引导重启
      if (/IGNORED_BUILDS/.test(String(e.message || ''))) {
        return { success: true, warning: errMsg, name: pluginName };
      }
      return { success: false, error: errMsg, name: pluginName };
    }
  }

  /** 卸载插件 */
  async function uninstallPlugin(pluginName) {
    try {
      const verr = validateArg(pluginName, 'pkg');
      if (verr) return { success: false, error: verr, name: pluginName };

      // 硬保护：核心依赖禁止卸载（防御 UI 层被绕过/误操作）
      if (coreDeps.has(pluginName)) {
        return { success: false, error: `${pluginName} 是 DSH 核心依赖，不允许卸载`, name: pluginName };
      }

      const output = await pnpmCmd('remove', pluginName, profileDir);
      // 从 bundles 层移除（若该插件声明过 dsh.bundle）；与 pnpmCmd 同一把 build-lock
      await withBuildLock('desktop: reconcile (uninstall)', () => { reconcilePlugins(); });
      return { success: true, output, name: pluginName };
    } catch (e) {
      return { success: false, error: friendlyPnpmError(e.message || e), name: pluginName };
    }
  }

  /** 安装本地插件（从文件夹路径） */
  async function installLocalPlugin(pluginPath) {
    if (!pluginPath || !fs.existsSync(pluginPath)) {
      return { success: false, error: '插件路径不存在' };
    }

    try {
      // 路径白名单校验（shell 元字符拒绝）
      const verr = validateArg(pluginPath, 'path');
      if (verr) return { success: false, error: verr, name: pluginPath };

      // 读取本地插件的 package.json 获取名称
      const localPkgPath = path.join(pluginPath, 'package.json');
      let pluginName = path.basename(pluginPath);
      if (fs.existsSync(localPkgPath)) {
        const localPkg = JSON.parse(fs.readFileSync(localPkgPath, 'utf-8'));
        pluginName = localPkg.name || pluginName;
      }

      // 使用 file: 协议安装（pnpm 原生，无 shell）
      const output = await pnpmCmd('add', `file:${pluginPath}`, profileDir);
      // 同步 bundles 层；与 pnpmCmd 同一把 build-lock
      await withBuildLock('desktop: reconcile (installLocal)', () => { reconcilePlugins(); });
      return { success: true, output, name: pluginName };
    } catch (e) {
      return { success: false, error: e.message || String(e), name: pluginPath };
    }
  }

  return {
    getInstalledPlugins,
    getPluginRowIds,
    readProfilePatch,
    writeProfilePatch,
    isPluginDisabled,
    setPluginEnabled,
    hasClientEntry,
    exportsBundlePatch,
    reconcilePlugins,
    installPlugin,
    uninstallPlugin,
    installLocalPlugin,
  };
}

module.exports = { createPluginManager };
