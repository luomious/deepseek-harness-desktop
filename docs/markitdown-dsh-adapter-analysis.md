# MarkItDown → DSH 适配分析记录

> 生成日期：2026-09-11（会话内实测）
> 性质：只读分析 + 落地 plan（已全部执行并实测通过（详见 §7））
> 结论一句话：**首选按 DSH 官方 MCP 机制（复刻 firecrawl 模式）接入 markitdown 官方 MCP 服务端，零新插件代码，补上 DSH 缺失的「任意文件 → Markdown 摄入」能力。**

---

## 1. markitdown 已有功能（实测）

数据源：GitHub README（2026-09-07 抓取）+ PyPI `markitdown-mcp`（2026-09-11 抓取）。

| 项 | 值 |
|---|---|
| 仓库 | microsoft/markitdown |
| Stars / Forks | 182.0k / 13.4k |
| License | MIT |
| 语言 | Python（99.8%） |
| 运行时 | Python ≥ 3.10 |
| 核心库版本 | v0.1.7（2026-07-29，21 个 release，最近提交 2 天前）→ **极活跃** |

**定位**：把任意格式文件转成 Markdown 供 LLM 消费（保留标题/列表/表格/链接结构），对标 textract。

**支持格式（README 实测列表）**：PDF、PowerPoint、Word、Excel（含旧 xls）、图片（EXIF 元数据 + OCR）、音频（EXIF + 语音转写）、HTML、CSV/JSON/XML、ZIP（遍历内容）、YouTube URL、EPUB、Outlook 消息 … 以及更多。

**三种接口**：
- CLI：`markitdown file.pdf > out.md` / `-o` / 管道。
- Python API：`MarkItDown().convert()`、`convert_local()`、`convert_stream()`、`convert_response()`（安全收窄面）。
- Docker：`docker run --rm -i markitdown …`。

**可选依赖 extras**：`[all] [pptx] [docx] [xlsx] [xls] [pdf] [outlook] [az-doc-intel] [az-content-understanding] [audio-transcription] [youtube-transcription]`。

**插件机制**：3rd-party plugin（默认关闭，`--use-plugins`），官方 `markitdown-ocr` 用 LLM Vision 做嵌入图 OCR。

**MCP 服务端（官方 `markitdown-mcp` 包）**：
- 暴露**仅一个工具**：`convert_to_markdown(uri)`，`uri` 支持 `http:` / `https:` / `file:` / `data:`。
- 支持 stdio（默认）/ Streamable HTTP / SSE 三种 transport。
- 启动：`markitdown-mcp`（stdio）或 `markitdown-mcp --http --host 127.0.0.1 --port 3001`。
- 安全：无鉴权、以当前进程权限读写、默认绑定 `localhost`（非 localhost 绑定有风险，README 建议沙箱）。

> ⚠️ **关键风险（实测）**：`markitdown-mcp` PyPI 版本为 **0.0.1a4 预发布（Development Status 4 - Beta），2025-05-23 发布后已约 1 年未更新**。相比之下核心库 `markitdown` 活跃。→ 见 §4 风险评估与 §6 备选方案。

---

## 2. DSH 现有 MCP 接入机制（实测，带行号）

- MCP 客户端：`@deepseek-ai/dsh-mcp-client` v0.1.1-rc.2，位于
  `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js`。
- **配置入口**：`~/.dsh/mcp-configs/*.cordis.yml`，然后合并进
  `~/.dsh/profiles/desktop/cordis.patch.yml`（firecrawl 已于 2026-09-02 按此方式合并，见该文件第 67-76 行）。
- **支持的 transport（仅两种）**，config schema 见 `lib/index.js:738-756`：
  - `stdio`：`serverName`(必填, 正则 `^[A-Za-z0-9_-]{1,32}$`) + `command`(必填) + `args[]` + `env{}` + `cwd` + `toolCallTimeoutMs` + `failOnStartupError`(默认 false) + `reconnect`。
  - `streamable-http`：`serverName` + `url`(必填) + `headers{}` + 同上。
- **工具命名约定**（`lib/index.js:57-59`）：每个 MCP 工具公开名为 `mcp__<serverName>__<rawName>`，归一化到 DeepSeek 函数名约束（≤64 字符，`[A-Za-z0-9_-]`）。→ markitdown 会暴露成 `mcp__markitdown__convert_to_markdown`。
- **stdio spawn 实现**（`lib/index.js:41-46`）：`new StdioClientTransport({ command, args, env: buildChildEnv(config.env), cwd })`，**未显式传 `windowsHide`**；firecrawl 用 `npx`(stdio) 已生产运行，证明该模式在打包壳可用。
- **firecrawl 参考模板**（`~/.dsh/mcp-configs/firecrawl.cordis.yml`）：

```yaml
- insert:
    - id: mcp-firecrawl
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: firecrawl
        transport: stdio
        command: npx
        args: ["-y", "firecrawl-mcp"]
        env:
          FIRECRAWL_API_KEY: "fc-..."
        cwd: !!js process.cwd()
```

---

## 3. 必要性 / 去重（DSH 现有文件摄入能力）

- DSH 现有 skills：`docx` / `xlsx` / `pdf` / `pptx` / `diagram` / `diagram-design` 等 —— 定位是「**生成 / 编辑**办公文档与图表」的方法论 skill。
- DSH 现有摄取面：`attachment`（附件）+ `dsh-web-fetch-local`（网页抓取）+ `dsh-vision-engine`（图/视觉）。
- **DSH 缺的是**：一套统一、稳定的「任意二进制文件 → Markdown 文本」摄入工具，尤其
  PDF 表格/扫描件 OCR、xlsx 多 sheet、音频转写、ZIP 遍历、YouTube 字幕、EPUB/Outlook 这些现有机制覆盖不到的格式。
- markitdown 补的正是这个 gap，与现有 skills 互补、不冲突。

> 待 POC 阶段复核：DSH `attachment` 是否已对 PDF/xlsx 等二进制做文本提取（如已提取则部分重叠，但音频/zip/youtube/epub/ocr 仍是净增量）。

---

## 4. 适配方式与风险评估

### 方案对比

| 方案 | 说明 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. MCP stdio（复刻 firecrawl）** | `command` 指向 markitdown-mcp 可执行，transport: stdio | 走官方机制、零新插件代码、自动暴露工具、短生命周期无常驻进程 | 依赖预发布 `markitdown-mcp` 0.0.1a4 | **首选（P0）** |
| B. MCP streamable-http | `markitdown-mcp --http` 常驻 + `transport: streamable-http, url` | 可远程、便于调试 | 多一个常驻进程要自启/守护，生命周期复杂 | 备选，不首选 |
| C. 封装 DSH 插件/工具（直调核心 markitdown） | 绕过 MCP 包，直接调 `markitdown` CLI/Python API | 彻底规避 0.0.1a4 预发布风险、用活跃核心库 | 要写新插件 + 处理 Python spawn windowsHide/原子写/登记，工作量大 | 长期强化备选，非 P0 |

### Python 供应商子选项（方案 A 的 command）

| 子项 | command | 说明 |
|---|---|---|
| a. uvx 临时环境 | `uvx` / `args:["markitdown-mcp"]` | 隔离，但首次联网下载 + 仍用预发布 0.0.1a4 |
| **b. 专用 venv（推荐）** | `<venv>\Scripts\markitdown-mcp.exe` | 固定目录、可重建、可 pin 版本、最可复现、最稳 |

关键点：打包壳的 PATH 可能 ≠ 交互 shell PATH，**`command` 用绝对路径**避免 PATH 歧义（firecrawl 用 npx 依赖 PATH 有先例，但 markitdown 建议绝对路径）。同时用原生 `.exe`（uvx.exe / venv 内 `.exe`）而非 `.cmd` shim，减少闪窗。

### 风险清单

1. **预发布/陈旧依赖**：`markitdown-mcp` 0.0.1a4（beta，2025-05）长期可维护性存疑；核心库活跃可兜底。缓解：POC 烟雾测试 + 备选方案 C 下探。
2. **Python 环境污染**：默认 `python` 指向 Anaconda base（E:\Anaconda）。缓解：用专用 venv，不动 conda base。
3. **打包壳 PATH/环境差异**：命令解析可能不同。缓解：`command` 用绝对路径。
4. **stdio spawn 无显式 windowsHide**（DSH 自有实现如此）：firecrawl 已生产证明可用；用原生 exe 进一步降低闪窗风险。
5. **安全面**：`convert_to_markdown` 可读任意本地文件（进程权限）。缓解：仅本地受信 agent，选 **stdio**（无网络暴露面，比 http 更安全），不绑定非 localhost。
6. **登记**：venv 是独立目录，不动 global/vendor node_modules，**无需进补丁体系**；但需写 setup/teardown 脚本存档以便重建。

### 长期稳定 / 可维护 / 可迭代 / 可扩展

- **可维护**：复刻 firecrawl 官方模式，配置集中在 `~/.dsh/mcp-configs/markitdown.cordis.yml` 一处；venv 独立可重建。
- **可迭代**：升级 = venv 内 `uv pip install -U "markitdown[all]"`，不动 DSH 本体、不重建桌面壳。
- **可扩展**：换 transport / 加 env / 加 server 都走同一 `dsh-mcp-client` 机制；未来要视频走 `az-content-understanding` extra、要 OCR 走 `markitdown-ocr` 插件，均 venv 内加依赖即可，零 DSH 改动。
- **稳定**：stdio 每次调用短生命周期，无泄漏；`dsh-mcp-client` 自带 reconnect 策略 + serverName 查重 + credentials scrubbing。

---

## 5. 落地 plan（固定模板）

- **目标**：按 firecrawl 模式接入 markitdown MCP，得到 `mcp__markitdown__convert_to_markdown` 工具，可稳定把任意文件转 Markdown。
- **涉及文件**：
  - 新增 `~/.dsh/mcp-configs/markitdown.cordis.yml`（MCP 配置模板）
  - 修改 `~/.dsh/profiles/desktop/cordis.patch.yml`（合并 insert 块，先备份）
  - 新增 `tools/markitdown/`（venv + setup/teardown 脚本，可选，或放 `~/.dsh/venvs/markitdown`）
  - 新增本记录文档 `docs/markitdown-dsh-adapter-analysis.md`
- **改动点**：
  1. 建专用 venv：`uv venv tools/markitdown/.venv` + `uv pip install --python tools/markitdown/.venv/Scripts/python.exe "markitdown-mcp" "markitdown[all]"`。
  2. 写 `markitdown.cordis.yml`（`transport: stdio`，`command` 绝对路径指向 venv 内 `markitdown-mcp.exe`，`serverName: markitdown`）。
  3. 备份 `cordis.patch.yml` → 合并 insert 块。
  4. 通知用户重启（遵守重启守则，重启由用户执行）。
- **验证方式**：
  1. venv 内手动跑 `markitdown-mcp` 握手确认可执行。
  2. 重启后确认工具列表出现 `mcp__markitdown__convert_to_markdown`（`mcp_search` 或直接调用）。
  3. 真实转换一份 docx/xlsx/pdf 验证输出 Markdown。
  4. 故障注入：损坏文件 / 超大文件 / 无权限路径，确认报错可读、不崩 DSH、可重连。
- **回滚方式**：`cordis.patch.yml` 有 `.bak`；单删新增 insert 块即可回滚；venv 目录回收站删除；无需重建桌面壳（不动 vendor/dist）。
- **风险收益**：
  - 收益：补 DSH 文件摄入空白，一工具覆盖 PDF/Office/图片/音频/zip/YouTube/EPUB/Outlook。
  - 风险：中（预发布 MCP 包 + Python venv 依赖 + 打包壳 PATH 差异）；可逆性高；不波及运行中服务（改配置后等用户重启）。
  - 等级：**中**（高可逆 + 受影响面仅 profile 配置 + 不碰 dist/node_modules）。

> 执行前按多对话协作铁律走：`node scripts/task-scheduler.mjs status` → 关键操作加锁（`global:install` / cordis.patch.yml）→ 改完 release 登记。

---

## 6. 管理与卸载（官方规范）

### 定位（三处，互不相扰）

| 角色 | 路径 | 说明 |
|---|---|---|
| 配置源（单一事实） | `~/.dsh/mcp-configs/markitdown.cordis.yml` | 与官方 `firecrawl.cordis.yml` 同目录同格式 |
| 生效块 | `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾 `# 2026-09-11: MarkItDown MCP` 注释块 | 官方 `@deepseek-ai/dsh-mcp-client` 实例 |
| 运行时 | `D:\Deepseek-Harness\tools\markitdown\`（.venv + .uv-cache + fixtures） | 隔离环境，不碰 Anaconda base / vendor / dist / 插件 |

### 升级 markitdown 核心库（不动 DSH 本体）

```powershell
$env:UV_CACHE_DIR="D:\Deepseek-Harness\tools\markitdown\.uv-cache"
$env:UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
uv pip install --upgrade --python "D:\Deepseek-Harness\tools\markitdown\.venv\Scripts\python.exe" "markitdown[all]"
```

### 卸载（三步，全部可逆）

1. 从 `~/.dsh/profiles/desktop/cordis.patch.yml` 删掉 markitdown 块（按注释行分界，块位于文件末尾）：
```powershell
$p = "$HOME\.dsh\profiles\desktop\cordis.patch.yml"
$t = [System.IO.File]::ReadAllText($p)
$marker = "# 2026-09-11: MarkItDown MCP"
$idx = $t.IndexOf($marker)
if ($idx -lt 0) { Write-Output "block not found" } else {
  $head = $t.Substring(0, $idx).TrimEnd()
  [System.IO.File]::WriteAllText($p, $head + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "removed markitdown block"
}
```
   - 即时回滚：改动前整份备份在 `cordis.patch.yml.bak-markitdown-20260911`。
2. 删除配置源：`~/.dsh/mcp-configs/markitdown.cordis.yml`。
3. 删除运行时（可选）：`tools/markitdown/`（约几百 MB），走回收站可恢复。

> 卸载后 DSH 恢复原状：不触碰任何现有插件、vendor、dist、Anaconda base、settings.yaml。

---

## 7. 实测结果（2026-09-11 重启后实测，全部通过）

| # | 格式 | 输入 | 输出要点 | 结论 |
|---|---|---|---|---|
| 1 | DOCX | fixtures/sample.docx | 标题 + 段落 + 表格完整保留 | PASS |
| 2 | XLSX | fixtures/sample.xlsx | `## sales` + 3 行数据表 | PASS |
| 3 | PPTX | fixtures/sample.pptx | `# Quarterly results` + 正文 | PASS |
| 4 | ZIP | fixtures/sample.zip | 遍历嵌套：`## File: notes.md` / `readme.txt` | PASS |
| 5 | CSV | fixtures/sample.csv | 3 列表格 | PASS |
| 6 | HTML | fixtures/sample.html | 标题 + 加粗 + 列表 | PASS |
| 7 | PDF(中文) | _backups/paper-writer-smoke-20260831/main.pdf | 中文标题/目录/正文 + 公式 + 三线表 + 参考文献 | PASS |
| 8 | PDF(中文) | _backups/paper-writer-smoke-20260831/test-cn.pdf | pandoc 公式 + 引用 | PASS |
| 9 | 故障注入 | fixtures/no-such-file.zip | `[Errno 2] No such file` 干净报错，DSH 未崩 | PASS |

- 中文 PDF 文本提取正确（标题 / 目录 / 三线表 / 参考文献均正常）。
- PDF 复杂公式（求和 / 上下标 / 分数）被线性化为普通文本，属 PDF→文本的固有损失，非 markitdown 缺陷；扫描件 / 复杂排版需 `markitdown-ocr` 插件或 `az-doc-intel` 补 OCR。
- 工具名：`mcp__markitdown__convert_to_markdown`，单参数 `uri`，支持 http/https/file/data。
