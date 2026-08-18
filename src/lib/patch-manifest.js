// src/lib/patch-manifest.js
// 补丁自愈清单：登记所有 node_modules 补丁点（dsh / 插件升级会覆盖手动补丁，
// 启动时自动校验并重打），解决「升级后问题复发」。
// 每项补丁：check（内容是否已补）+ apply（替换规则），失败记录不损坏文件。
// 独立模块：不依赖 electron，可单元测试。

const fs = require('fs');
const path = require('path');

// ── modlens：settings namespace 回调必须传 scope.settings ──
// 根因：rc.7 起 settings surfaces 按 Host 提供的 namespace 分发卡片，
// 不传 scope.settings 则设置卡片不渲染（卡片消失）。
function patchModlensIndex(content) {
  if (content.includes('registerSettingsNamespace(scope.settings)')) return { status: 'ok' };
  const fixed = content.replace(/registerSettingsNamespace\(\s*\)/, 'registerSettingsNamespace(scope.settings)');
  if (fixed === content) return { status: 'failed', error: '未找到 registerSettingsNamespace() 调用点' };
  return { status: 'applied', fixed };
}

// ── modlens：settings 卡片 keyed slot 必须带 key ──
// 根因：keyed slot 缺 key 时注册失败（卡片不显示）。
function patchModlensKey(content) {
  if (content.includes("id: 'modlens', key: 'modlens'")) return { status: 'ok' };
  const fixed = content.replace(/id:\s*'modlens',/, "id: 'modlens', key: 'modlens',");
  if (fixed === content) return { status: 'failed', error: "未找到 id: 'modlens' 注册点" };
  return { status: 'applied', fixed };
}

// ── dsh-safe-delete：同上，keyed slot 必须带 key ──
function patchSafeDeleteKey(content) {
  if (content.includes("key: 'safe-delete'")) return { status: 'ok' };
  const fixed = content.replace(/id:\s*'safe-delete',/, "id: 'safe-delete', key: 'safe-delete',");
  if (fixed === content) return { status: 'failed', error: "未找到 id: 'safe-delete' 注册点" };
  return { status: 'applied', fixed };
}

/** 对单个文件执行补丁：不存在 → skipped；已补 → ok；应用 → applied；失败 → failed */
function applyFilePatch(file, patchFn) {
  try {
    if (!fs.existsSync(file)) return { status: 'skipped', reason: 'missing' };
    const content = fs.readFileSync(file, 'utf8');
    const r = patchFn(content);
    if (r.status === 'applied') fs.writeFileSync(file, r.fixed, 'utf8');
    return r;
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

/** 构建补丁清单（profile 目录可配，测试隔离） */
function buildManifest(profileDir) {
  return [
    {
      id: 'modlens-settings-namespace',
      file: path.join(profileDir, 'node_modules', '@liustack', 'modlens', 'dsh', 'index.js'),
      patch: patchModlensIndex,
    },
    {
      id: 'modlens-slot-key',
      file: path.join(profileDir, 'node_modules', '@liustack', 'modlens', 'dsh', 'client.js'),
      patch: patchModlensKey,
    },
    {
      id: 'safe-delete-slot-key',
      file: path.join(profileDir, 'node_modules', 'dsh-safe-delete', 'lib', 'client.js'),
      patch: patchSafeDeleteKey,
    },
  ];
}

/** 执行全部补丁，返回结果列表（幂等：已补的跳过） */
function reconcilePatches({ profileDir }) {
  return buildManifest(profileDir).map((p) => ({
    id: p.id,
    file: p.file,
    ...applyFilePatch(p.file, p.patch),
  }));
}

module.exports = {
  reconcilePatches,
  buildManifest,
  applyFilePatch,
  patchModlensIndex,
  patchModlensKey,
  patchSafeDeleteKey,
};