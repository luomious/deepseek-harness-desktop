# D:\Deepseek-Harness 文件级分类与整理（2026-09-29）

> 用户疑问：「感觉文件还是很多」。本文按**文件数**（而非体积）彻底盘点，并给出可执行的压缩方案。

---

## 一、真相：301,838 个文件，99.3% 挤在 5 个目录

| 目录 | 文件数 | 体积 | 占比 | 性质 |
|---|---|---|---|---|
| `vendor/` | **133,850** | 3,516 MB | 44.3% | 壳源码 + node_modules + dist |
| `_backups/` | **102,760** | 3,909 MB | 34.0% | 操作备份 + 归档构建 |
| `备份/` | **45,958** | 2,598 MB | 15.2% | 冷备（散文件形式） |
| `tools/` | 9,762 | 309 MB | 3.2% | markitdown venv |
| `hy3-gateway/` | 5,955 | 31 MB | 2.0% | 网关服务 + node_modules |
| `plugins/` | 1,438 | 108 MB | 0.5% | **你的插件** |
| `.git/` | 870 | 23 MB | 0.3% | 版本库 |
| 其余 20 个目录 | ~1,245 | ~206 MB | 0.4% | docs/scripts/outputs/tests 等 |
| **合计** | **301,838** | **10,700 MB** | 100% | |

⇒ **「文件多」不是杂乱，是 5 个大目录各自的内部结构**。逐个拆解：

### 1.1 vendor/（133,850 files）拆解

| 子路径 | 文件数 | 体积 | 必要性 |
|---|---|---|---|
| `dsh-plugin-desktop/node_modules` | 57,703 | 1,061 MB | ✅ 构建必需 |
| `dsh-plugin-desktop/dist/win-unpacked` | (junction) | — | ✅ 活动入口（软链，不占实体文件） |
| `dsh-plugin-desktop/dist/win-unpacked-build202609272329` | 40,150 | 1,623 MB | ✅ **当前活动构建** |
| `dsh-plugin-desktop/dist/win-unpacked-build202608272104` | **22,843** | **567 MB** | ❌ **旧 0.1.1 构建，已过时** |
| 其余（src/docs/scripts/tests…） | ~13,000 | ~265 MB | ✅ 源码与文档 |

### 1.2 _backups/（102,760 files）拆解

| 子路径 | 文件数 | 体积 | 必要性 |
|---|---|---|---|
| `dist-archive/20260927233701` | **102,256** | **3,881 MB** | ⚠️ 归档构建（与活动构建同源，可压缩保存） |
| 108 个操作备份目录 | ~504 | ~28 MB | ✅ 近 3 天回滚点（已压缩过旧的一批） |

### 1.3 备份/（45,958 files）拆解

| 子路径 | 文件数 | 体积 | 说明 |
|---|---|---|---|
| `2026-09-29-full/profile-desktop` | 43,665 | 830 MB | 冷备的 profile（**junction 已展开成散文件**） |
| `2026-09-29-full/appdata` | 1,036 | 505 MB | 应用数据 |
| `2026-09-29-full/sessions` | 292 | 412 MB | 会话 |
| `2026-09-29-full/storages` | 278 | 121 MB | 存储 |
| `2026-09-29-cleanup/repo-archived` | 604 | 712 MB | 升级快照 |
| 其余 | ~83 | ~18 MB | config/meta/manifest |

⇒ **冷备用散文件形式存，是文件数虚高的重要原因**——打成 zip 后可见文件数从 45,958 降到 ~40。

---

## 二、整理方案（按「降文件数」效率排序）

| # | 动作 | 减文件数 | 省空间 | 风险 | 数据安全 |
|---|---|---|---|---|---|
| **1** | 删除旧 0.1.1 构建 `dist/win-unpacked-build202608272104` | **−22,843** | −567 MB | 低 | 已过时版本，无用途 |
| **2** | 打包 `_backups/dist-archive/20260927233701` → zip | **−102,256** | −2.5 GB | 低 | **内容保留在 zip 内** |
| **3** | 打包 `备份/2026-09-29-full/` 各子目录 → zip | **−45,000** | ~−1 GB | 低 | **内容保留在 zip 内** |
| **4** | 打包 `备份/2026-09-29-cleanup/repo-archived` → zip | −604 | −0.5 GB | 低 | 内容保留 |
| | **合计** | **−170,703** | **−4.6 GB** | | |

**结果：301,838 → ~131,135 文件（−57%）**

### 剩下的 ~131,000 是什么？

| 项 | 文件数 | 能否再降 |
|---|---|---|
| `vendor/.../node_modules` | 57,703 | ❌ 构建工具链依赖 |
| `vendor/.../dist/win-unpacked-build202609272329` | 40,150 | ❌ 运行中的构建 |
| `tools/markitdown`（venv） | 9,536 | ⚠️ 取决于 markitdown MCP 去留 |
| `hy3-gateway/node_modules` | 5,948 | ⚠️ 取决于网关去留 |
| `plugins/` | 1,438 | ❌ 你的插件 |
| 其余 | ~16,000 | ❌ 源码/文档/.git |

> **结论：~131,000 是一个 Electron 项目 + Python venv 的物理下限。**
> 再降只有两条路：放弃构建能力（删 node_modules，需要时重装）、或放弃 markitdown/网关。
> 两者都不是「整理」，而是「砍功能」。

---

## 三、分类总表（27 个根级目录 → 六类）

| 类别 | 目录 | 处置 |
|---|---|---|
| **① 源码与工具** | `vendor/` `plugins/` `scripts/` `patches/` `tests/` `profile/` `assets/` | 保留原位 |
| **② 文档与产出** | `docs/` `outputs/` `README.md` `CHANGELOG.md` `PROJECT_README.md` `AGENTS.md` `LICENSE` `package.json` | 保留原位 |
| **③ 版本控制** | `.git/` `.github/` `.githooks/` `.gitignore` `.gitattributes` | 保留原位 |
| **④ 备份与归档** | `备份/`（full/cleanup/reorg）`_backups/` | **本次压缩瘦身** |
| **⑤ 缓存（可重建）** | `.corepack/` `.electron-cache/` `.electron-builder-cache/` `_tmp/`(空) `node_modules/`(空壳) | 按需清理 |
| **⑥ 本地运行时** | `hy3-gateway/` `tools/` `agent-presets/` `.workbuddy/` `diagrams/` | 按需 |

### 待处理：3 个插件仍在根目录（阶段 2，风险最高，放最后）

`dsh-context-lifecycle/` `dsh-stuck-loop-guard/` `dsh-vision-rotator/` → 应移入 `plugins/`，
需同步改 7 处引用（详见 `outputs/2026-09-29-reorg/README.md`）。

---

## 四、执行顺序

1. **本次执行**：方案第 1–4 项（压缩归档）→ 文件数腰斩
2. **然后执行**：阶段 3 源码重建壳（收益最大）
3. **最后执行**：阶段 2 插件归位（风险最高，收益最低）

---

## 五、记录

- 逐文件清单：`备份/2026-09-29-reorg/file-slim-manifest.json/.csv`（含 SHA256）
- 变更日志：`CHANGELOG.md`
- 本报告：`outputs/2026-09-29-reorg/README.md`（追加执行记录）

---

## ����ʵ��ִ�м�¼��2026-09-29��

| # | ���� | ���ļ��� | ʡ�ռ� |
|---|---|---|---|
| 1 | ɾ���� 0.1.1 ���� `dist/win-unpacked-build202608272104` | **?22,843** | ?567 MB |
| 2 | `_backups/dist-archive/20260927233701` �� `tar.gz`��3,881 �� 1,321 MB�� | **?102,256** | ?2,560 MB |
| 3 | `����/full/profile-desktop`��43,665 �� tar.gz 195 MB�� | **?43,665** | ?635 MB |
| 4 | `����/full/appdata`��1,036 �� tar.gz 198 MB�� | **?1,036** | ?307 MB |
| 5 | `����/cleanup/repo-archived` ѹ����**�������**��712��874 MB���� **�ѻ�ԭ** | 0 | 0 |

### �����޸�

- **`scripts/apply-sweep-transform-fixes.mjs` Ӳ����ɹ���·��**��`win-unpacked-build202608272104`����
  �����һֱ patch һ���������� ���� ����Ŀ������ `startup-verify.mjs` 2026-09-06 �޹�����ͬ�෴ģʽ��
  �Ѹ�Ϊ `resolveCurrentBuild()` ��̬������`--check` ��ָ֤��ǰ������exit 0��

### ��Ч

| ָ�� | ����ǰ | ���� | �仯 |
|---|---|---|---|
| ���ļ��� | 301,838 | **132,043** | **?169,795��?56%��** |
| ����� | 10,700 MB | **6,631 MB** | **?4,069 MB** |
| `_backups` | 3,909 MB / 102,760 files | **27.9 MB / 504 files** | ?99.5% �ļ��� |
| `����` | 2,598 MB / 45,958 files | 2,976 MB / 1,260 files | ?97% �ļ���* |

\* �������������ѹ����鵵 + ԭ repo-archived ��ԭ������**�ɼ��ļ������� 97%**��

### ��֤

- `verify-patches` **ALL PASS (99)**
- `patch-manifest --verify` **ALL PASS**��46 entries��digest �����µǼǣ�
- `apply-sweep-transform-fixes.mjs --check` **exit 0**

### ʣ�� ~132,000 �ļ��Ĺ��ɣ���Ϊ���裩

| �� | �ļ��� | ˵�� |
|---|---|---|
| `vendor/.../node_modules` | 57,703 | �������������� |
| `vendor/.../dist/win-unpacked-build202609272329` | 40,150 | ��ǰ���й��� |
| `tools/markitdown` | 9,536 | MCP venv��ȡ���� MCP ȥ���� |
| `hy3-gateway` | 5,955 | ���أ�ȡ��������ȥ���� |
| `plugins/` | 1,438 | **��Ĳ��** |
| ���� | ~17,000 | Դ��/�ĵ�/.git/���� |
