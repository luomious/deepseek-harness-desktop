# dsh-skills-manager

DSH 设置页 **Skills 管理器**（宿主级 bundle 插件）：系统/用户技能分类展示，用户技能支持启用开关、编辑、删除、新建。随 DSH 启动自动加载，不依赖会话，重启不失效。

## 功能

- 设置页左侧导航新增 **Skills** 入口（自定义火花星图标）
- **系统 Skills**：只读展示（bundled/runtime/custom 来源），无开关/删除
- **用户 Skills**（`~/.dsh/skills`）：启用开关、编辑、新建、删除
- 底部诊断行显示扫描层范围

## 安装

```bash
# 安装 v0.1.2
dsh plugin --profile web add github:xiaoxianyu-office/dsh-skills-manager#v0.1.2
```

安装后**重启 DSH** 生效。

## 升级

重复 `add` 并指定新 tag，**不要使用 update 选择 Git 引用**：

```bash
dsh plugin --profile web add github:xiaoxianyu-office/dsh-skills-manager#v0.1.2
```

## 卸载

```bash
dsh plugin --profile web remove dsh-skills-manager
```

卸载后重启 DSH：设置页入口、client bundle 路由全部移除，无残留。

## 结构

```
dsh-skills-manager/
├── package.json      # dsh.bundle（组合补丁）+ dsh.client（浏览器双面）声明
├── cordis.patch.yml  # 组合补丁：insert skills-manager 插件行
└── lib/
    ├── index.js      # host 端：Skills 管理 API，注册 /skmg 路由
    └── client.js     # client 端：设置页 UI（成品 bundle，无需构建）
```

## 说明

- host 端依赖宿主服务：`skills` / `fs` / `shell` / `sandboxPolicy` / `webServer`
- 写操作使用 `danger-full-access` 策略以管理 `~/.dsh/skills`，写后等待 300ms 让文件 watcher 完成注册表更新
- `/skmg` API 仅接受本机回环请求（源地址 + Host 头双重校验），不要将该端口暴露到局域网/公网
- client bundle 为手写 `__ModuleLoader__` 成品，无 prepare 脚本，不受 pnpm `allowBuilds` 限制
