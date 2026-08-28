# dsh-file-explorer

右侧文件浏览器（details 面板，双 tab：文件 / 详情）。文件树 + 代码高亮 + **文档/图片预览** + **大文本分段预览**。

## 架构

```
lib/
  index.js     host：/file-explorer/api 路由（list-dir / read-file / open-external / session-cwd / resolve-home）
               + 文本分段预览：readTextWindow（UTF-8 边界对齐窗口读）/ alignUtf8Offset（纯函数）
  extract.js   文档文本提取引擎（纯函数、零依赖、只读内存）
  client.js    浏览器 UI（details slot 注入；按 host 返回的 mode 渲染预览）
test/
  extract.test.mjs  提取引擎单测（内存生成合法 ZIP 夹具，`node --test` 或直接 `node` 运行）
  window.test.mjs   分段预览单测（UTF-8 边界 + 翻页无损拼接；fixtures/ 夹具文件）
```

host 经 `dsh-host-services.registerLocalApi` 注册，仅回环 + Origin 同源校验（`trusted()`），
路径一律过 `isPathAllowed`（默认仅用户主目录；`DSH_FILE_EXPLORER_ROOTS` 附加白名单 /
`DSH_FILE_EXPLORER_UNRESTRICTED=1` 全盘）。

## read-file 返回的预览模式（mode）

| mode | 含义 | client 渲染 |
|---|---|---|
| `text` | 文本文件（含未知扩展名）；>2MB 分段窗口，`offset` 翻页 | `<pre>` + 简易语法高亮 + 分页条 |
| `extracted` | office/pdf 提取的纯文本（`content` + `note`） | `<pre>` + 提示条 |
| `image` | dataURL 图片（`dataUrl`） | `<img>` |
| `binary` | 无法内联预览（`note`） | 提示 + 「用系统程序打开」按钮 |

旧客户端不感知新字段，向后兼容（无 mode 时按 text 渲染）。

## 文本分段预览（大文件）

- 触发：`size > MAX_READ_BYTES（2MB）` 时不再拒绝，`read-file` 返回首段（128KB）+ `hasMore: true`；
  client 底部出现「← 上一页 / 第 x/y 页 / 下一页 →」，翻页 = 再调 `read-file { offset }`。
- 窗口常量 `TEXT_WINDOW_BYTES = 128KB`：小于高亮上限 200KB → 窗口内语法高亮始终可用；
  100MB 日志也只占一个窗口内存（host 按需 fd 读取，不整读）。
- UTF-8 安全：`alignUtf8Offset`（纯函数）把窗口起点回退到字符边界；窗口尾部半个字符剥离
  （绝不显示 �）；首段剥离 BOM。翻页拼接无损（单测 + 3.3MB 真实文件抽检验证）。
- 二进制探测仅首段执行（前 1KB 含 \0 且扩展名非常见文本 → `binary`）。

## 提取引擎（lib/extract.js）——可迭代性设计

```js
export const EXTRACTORS = {
  '.docx': extractDocx,   // ZIP + word/document.xml（+页眉页脚）
  '.xlsx': extractXlsx,   // ZIP + sharedStrings + 各工作表
  '.pptx': extractPptx,   // ZIP + slides/slide*.xml
  '.pdf':  extractPdf,    // FlateDecode 流 + Tj/T*/TJ 文本（best-effort + 乱码启发式）
}
```

**加新格式**：写一个 `(buf) => string` 函数 + 在 `EXTRACTORS` 加一行即可。
旧版二进制格式（`.doc/.xls/.ppt/.rtf`，OLE）零依赖无法解析 → 只走「打开」兜底。

### 长期运行专项

- **零子进程**（提取全在进程内；打开文件用 `explorer.exe`，实测 `cmd /c start` 会挂起）；
- **零新增监听/定时器**，解析全同步有界；
- **防 zip 炸弹**：`LIMITS` 集中在 extract.js 顶部——读文件 ≤32MB、单条目解压 ≤8MB
  （`maxOutputLength`）、条目 ≤500、提取文本 ≤512KB；超限/损坏一律走「提取失败」提示，
  单文件不影响面板；
- 只按条目名读内存、**从不写盘** → 无路径穿越；正则抽文本、不用 XML 解析器 → 无 XXE；
- PDF 乱码启发式（`isGarbageText`）：CID 字体/扫描 PDF 解出大量控制符/高字节乱码时
  宁可提示「用系统程序打开」，不展示乱码。

### 验证

- 单测：`node plugins/dsh-file-explorer/test/extract.test.mjs`（9 例：四格式提取、
  实体/表格/域代码、分类、zip 炸弹/坏 ZIP 容错、注册表完整性）；
  `node plugins/dsh-file-explorer/test/window.test.mjs`（5 例：UTF-8 边界、17 字节窗口
  翻页拼接无损、越界 offset）；
  注意：`node --test` 在本环境因沙箱 spawn EPERM 不可用，直接 `node` 运行测试文件。
- 真实文件抽检（2026-08-28）：中文 docx（论文/教学计划）、xlsx 账单表格、
  pptx 幻灯片均正常；CNKI/知网/学位论文 PDF 因 CID 字体正确走兜底提示；
  3.3MB 混合中英文文本 27 页翻页拼接字节一致、0 个坏窗口。

## API 约定

- `read-file` `{ path, offset?, limit? }` → `{ ok, data: { path, size, mtime, mode, content?, dataUrl?, note?, offset?, total?, hasMore?, chunk?, chunks?, windowBytes? } }`
  （`offset`/`limit` 仅文本分段翻页用；小文件不带参整读，返回 `hasMore:false`）
- `open-external` `{ path }` → 仅用户点击触发；`explorer.exe` 打开（成功时 exit code 亦为 1，只判 spawn 错误）
- `list-dir` / `session-cwd` / `resolve-home` 语义不变
