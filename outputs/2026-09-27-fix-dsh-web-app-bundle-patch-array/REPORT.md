# 0.1.7 启动报错修复 · `@deepseek-ai/dsh-web-app` 缺 `dsh.bundle` 声明

> 日期：2026-09-27 ｜ 类型：incident-fix
> 报错原文：`dsh-plugin-desktop: profile bundle "@deepseek-ai/dsh-web-app" declares no dsh.bundle in its package.json`
> 授权范围（用户拍板）：只改必改 3 处；热修编译产物 + 改源码

---

## 1. 现象

U6-0c 将 junction promote 到 `win-unpacked-build202609272329`（内核 0.1.7-rc.2）后，用户重启桌面壳即抛上述错误，应用无法进入 profile 装配。

## 2. 根因（实测）

0.1.7-rc.2 的 `@deepseek-ai/dsh-web-app` 把 `dsh.bundle.patch` 从**字符串**改成了**有序数组**：

```json
"dsh": { "bundle": { "patch": [
  "./cordis.patch.yml",
  "./presets/standard.patch.yml",
  "./presets/ptc.patch.yml",
  "./presets/minimal.patch.yml",
  "./presets/cordis.patch.yml"
]}}
```

对照：

| 包 | 0.1.1-rc.2（build 2104） | 0.1.7-rc.2（build 2329） |
|---|---|---|
| `@deepseek-ai/dsh-base` | `"./cordis.patch.yml"`（string） | `"./cordis.patch.yml"`（string，未变） |
| `@deepseek-ai/dsh-web-app` | `"./cordis.patch.yml"`（string） | **5 路径数组** |

官方 `@deepseek-ai/dsh-app-boot@0.1.7-rc.2` **已兼容**两种形态：

```js
// lib/index.js:495-508
function bundlePatchFiles(bundle) {
  const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string"))
    throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
  return declared;
}
```

但桌面壳自写的 `loadRecoveryFilteredProfile`（`src/profile.ts`）仍按字符串强校验：

```ts
if (typeof declared !== 'string' || declared.length === 0) {
  throw new Error(`${BIN_NAME}: profile bundle ... declares no dsh.bundle in its package.json`)
}
```

数组命中 `typeof !== 'string'` → 误报「未声明 dsh.bundle」→ 启动中断。

**历史对照**：2026-08-30 tool-visibility 是「真没声明」；本次是「声明了但形态升级，校验器没跟上」。同一句错误文案，两类根因。

## 3. 为何启动前没拦住

`scripts/startup-verify.mjs` **V10** 正是为防这类事故加的护栏，但 V10 同样只认 string。U6-0c 验收跑的是 `verify-dist-exports` / `check-dist-integrity` / `verify-patches` / SMOKE，**未跑 startup-verify** ⇒ 护栏未参与。

## 4. 改动（3 处）

### 4.1 源码 · `vendor/.../src/profile.ts`

- import 增加 `bundlePatchPaths`（官方 helper，string | string[] 通吃）
- 校验改为：`dsh.bundle` 缺失才抛原错误；patch 形态交 `bundlePatchPaths`
- `patchPaths` 从单元素数组改为官方解析结果；`patches` 改为 `flatMap(loadOverlayPatches)`

### 4.2 热修 · 编译产物 `profile-BiAXVV97.js` ×2

- 路径：
  - `.../app.asar.unpacked/lib/profile-BiAXVV97.js`
  - `.../app.asar.tmp.unpacked/lib/profile-BiAXVV97.js`
- 同目录 tmp + rename 原子写；改后回读断言（含 `bundlePatchPaths`、不含旧 `typeof declared !== "string"`）
- `node --check` 两份均通过

> 源码已同步改好；下次 rebuild 自然带上，热修不会丢。

### 4.3 护栏 · `scripts/startup-verify.mjs` V10

- 新增 `bundlePatchFiles()`：接受 string | string[]，空/非字符串列表判坏
- 每个 patch 文件单独 `existsSync` 核对
- 与源码语义对齐

## 5. 验证

| 项 | 结果 |
|---|---|
| `node --check` ×3（两份热修 + startup-verify） | PASS |
| 归一化 helper 单元断言（string / array / undefined / [] / number / mixed） | 6/6 PASS |
| `node scripts/startup-verify.mjs` **V10** | **PASS**（`bundles=51 all declared + patch present`） |
| V1/V2/V4/V5/V6/V7/V9 | PASS（51 bundle 可解析 / 模板==运行态 / 无孤儿 / junction 健康 / 核心文件在位 / 无锁 / 42 插件语法 OK） |
| V3 | FAIL（既有：`stale disabled: selftest-r2probe`） |
| V8 | FAIL（既有：`modlens=lowered0 workspace=MISSING`） |

V3/V8 **非本次引入**，按「相似问题不静默顺手改」未动。

## 6. 相似模式扫描（按用户授权未改）

| # | 位置 | 现象 | 处置 |
|---|---|---|---|
| A | `patches/reference/plugin-manager.js:44-46,148-150` | `path.join(base, patchRel)` 把 patch 当单路径 | **登记不改**（用户选「只改必改 3 处」） |
| B | 官方 `dsh-plugin-manager` | 含同类错误文案 | **登记不改**（多半官方已兼容；需时再查） |

## 7. 回滚

| 产物 | 回滚方式 |
|---|---|
| `src/profile.ts` | vendor git checkout 还原 |
| 两份 `profile-BiAXVV97.js` | 从 `_backups/dist-archive/20260927233701/` 或源 build 重拷；或 rebuild 覆盖 |
| `startup-verify.mjs` | git checkout 还原 |

## 8. 下一步

1. **用户重启**桌面壳进 0.1.7（本次修复未自动重启）
2. 重启后跑合并验收 T-1..T-13 + U6-0b
3. 可选：startup-verify 纳入 0.1.7 验收必跑项（防再次漏拦）

## 9. 边界

- 【实测】错误文案、两版 package.json 对照、官方 `bundlePatchFiles` 实现、V10 转绿
- 【推断】Electron 运行时读的是 `app.asar.unpacked` 自身（热修路径），非 vendor 源码树
- 【未验证】重启后 `/health` 10/10 与 T-1..T-13
