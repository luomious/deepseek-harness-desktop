#!/usr/bin/env node
/**
 * apply-session-decode-streaming.mjs — PERF-5（薄封装, 2026-09-07 重构）
 *
 * 原本: writeFileSync 直写 dist 运行路径文件, 无原子替换、无 node --check（2026-08-29 事故模式）。
 * 现在: 复用 scripts/patch-apply.mjs 统一引擎（备份→锚点校验→node --check→原子替换→回读校验→回滚）。
 * 补丁登记: scripts/patch-registry.mjs → id 'perf5-session-decode-streaming'
 *
 * 效果: 打开对话（全量载入 readRaw）的多帧 zstd 解码改为单一流式解码器连续消费,
 *       12MB/4 万帧会话实测 2976ms → 876ms（3.4x）, 输出逐字节一致; 流式错误自动回退逐帧路径。
 *
 * 前置条件: 建议先关闭 DSH Desktop（部署到 app.asar.unpacked 运行时文件）; 完成后需手动重启生效。
 *
 * 用法: node scripts/apply-session-decode-streaming.mjs        # 仅应用 PERF-5
 */
import { main } from './patch-apply.mjs'

main(['apply', '--id', 'perf5-session-decode-streaming'])
