# 贡献指南

感谢你愿意改进 `dsh-storage-monitor`。这是一个面向 DeepSeek Harness（DSH）的本地插件，
涉及**删除用户数据**和**迁移 DSH 根目录**，所以对安全与可回滚性的要求高于普通前端项目。

## 环境

- DSH Desktop 0.2.x（Web UI 可用）
- Windows 10/11（路径迁移 / Junction 相关改动需要）
- Node.js >= 22.12（仅本地校验与脚本需要；插件运行时零依赖）

## 项目结构

```text
index.js              Host 入口：注册 HTTP 路由、预热报告、storage_inspect 工具
client.js             Client 页面：window.__ModuleLoader__ 动态模块，React 插槽
lib/api.js            HTTP 路由、同源/CSRF 防护、报告缓存
lib/report.js         分类统计、会话元数据、深度扫描、清理建议
lib/sessions.js       会话删除、回收站、恢复、缓存/孤儿清理
lib/attachments.js    附件引用扫描与对象路径
lib/migrate.js        路径迁移：扫描/校验/预拷贝/脚本生成/智能控制台
lib/util.js           目录测量、字节格式化、路径校验、有限并发
locale/*.json         插件管理页元数据
docs/DESIGN.md        完整设计说明与验证记录
```

没有构建步骤。Host 是普通 ESM；Client 是单个动态模块文件，React 由宿主模块表提供。

## 本地开发循环

1. 用 DSH 插件管理页或 `plugin_manager install_bundle` 安装本目录；
2. 修改 `client.js` 后刷新页面（Host 文件被修改时禁用/启用一次插件以重载）；
3. 修改 Host（`index.js`、`lib/*`）后，禁用/启用插件行，或重启 DSH；
4. 用 `npm test` 做语法、JSON 与清单一致性检查。

> 开发时请使用一份**可丢弃的 DSH profile / 测试会话**验证删除与迁移，不要在真实数据上
> 首次运行未审查的迁移脚本。

## 代码约定

- **零运行时依赖**：Host 只使用 Node 内置模块与 `ctx` 服务；不要 import
  `@deepseek-ai/*` 包（插件安装在 profile 中，无法可靠解析 DSH 安装目录内的包）。
- **Host 服务通过 `ctx`**：`webServer`、`sessionPersistence`、`workspaceRegistry`、
  `sessions`，不要猜测路径或直接碰数据库。
- **Client 只用主题 token**：颜色用 `--dsw-alias-*`，页面结构用 `stm-*` 类；不要读取其它
  插件的 DOM/样式，不要替换 app root。
- **Client 不用 JSX**：用 `React.createElement`（本文件里别名为 `h`），因为没有构建步骤。
- **破坏性操作必须在 Host 二次校验**：运行中会话拒绝删除、所有路径 `assertInside`、
  默认回收站、永久删除需显式参数、迁移脚本必须能在失败时回滚。
- **不要把迁移操作暴露成 agent 工具**：替换 DSH 根目录属于用户操作，必须由用户在页面上确认。
- 新增可配置项时优先通过 `Config` 暴露，不要硬编码用户目录。

## 测试清单

提交前至少完成：

```powershell
npm test
```

并手工检查：

- [ ] 概览、分类、会话、建议、迁移、回收站六个页签都能打开，无 console error；
- [ ] 深度扫描能完成（会话多时需要 10~20 秒）；
- [ ] 删除一个**空会话** → 出现在回收站 → 恢复 → 再永久删除；
- [ ] 迁移页：校验通过/失败、预拷贝取消、生成脚本、映射状态/空状态；
- [ ] 迁移脚本生成后用 PowerShell 解析器检查语法（不要在不清楚后果时实际执行）。

如果改动涉及 `lib/migrate.js`，请在 PR 描述里说明是否实际执行过迁移脚本、在什么环境下、
以及如何回滚。

## 提交与 PR

- 一个 PR 只做一件事；提交信息建议使用 Conventional Commits：
  `feat: ...`、`fix: ...`、`docs: ...`、`refactor: ...`、`chore: ...`；
- 描述里写清楚**用户可见行为变化**、测试方式、风险与回滚方式；
- 不要提交本机路径、凭据、日志、截图中的个人信息；
- 不要在 PR 中包含 `node_modules/`、迁移测试目录或 `.dsh` 数据。

## 安全问题

发现安全问题请不要开公开 issue，按 [SECURITY.md](SECURITY.md) 私下报告。
