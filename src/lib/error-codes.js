// src/lib/error-codes.js
// 错误码定义：错误码 → 标题 + 解决指引（日志即手册，报错可直接按 hint 处理）
// 编码规则：BOOT-0xx 启动类 / RENDER-0xx 渲染类 / PLG-0xx 插件类 / NPM-0xx 依赖类

const ERROR_CODES = {
  'BOOT-001': { title: 'DSH 服务启动失败', hint: '执行 npm install -g @deepseek-ai/dsh 后重试' },
  'BOOT-002': { title: 'DSH 服务进程异常退出', hint: '查看 %TEMP%\\dsh-service.log 尾部定位原因' },
  'BOOT-003': { title: '端口 3080 被非 DSH 进程占用', hint: '手动关闭占用程序后重启应用' },
  'BOOT-004': { title: 'DSH 服务 30 秒未就绪', hint: '检查网络/配置；查看 %TEMP%\\dsh-service.log' },
  'BOOT-005': { title: '连续启动失败，已进入安全模式', hint: '已跳过第三方插件，请逐插件启用排查' },
  'RENDER-001': { title: '渲染进程崩溃', hint: '已自动恢复（限次）；复发请导出诊断报告' },
  'RENDER-002': { title: '渲染进程无响应', hint: '已记录；复发请导出诊断报告' },
  'PLG-001': { title: '插件加载失败（slot key 缺失）', hint: '按插件开发规范为 keyed slot 补 key' },
  'PLG-002': { title: '插件注册了未声明 slot', hint: '检查核心包 children 表声明' },
  'PLG-003': { title: '插件被安全模式跳过', hint: '逐插件启用定位问题插件' },
  'NPM-001': { title: 'pnpm 安装失败（网络问题）', hint: '检查网络后重试' },
  'NPM-002': { title: 'pnpm 安装失败（权限/占用）', hint: '关闭占用程序后重试' },
  'NPM-003': { title: 'npm 查询挂起已强制终止', hint: '已自动降级静态路径' },
  'PATCH-001': { title: '补丁自愈失败', hint: '导出诊断报告反馈开发者（升级后补丁规则失配）' },
};

/** 未知错误码兜底 */
const UNKNOWN = { title: '未知错误', hint: '导出诊断报告后联系开发者' };

/** 查错误码定义（未知码返回兜底） */
function getErrorCode(code) {
  return ERROR_CODES[code] || UNKNOWN;
}

module.exports = { ERROR_CODES, UNKNOWN, getErrorCode };