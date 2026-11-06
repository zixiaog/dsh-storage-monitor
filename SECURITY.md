# 安全策略

## 支持版本

| 版本 | 支持 |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## 报告安全问题

请不要用公开 issue 报告安全漏洞。优先使用 GitHub 的
[Private vulnerability reporting](https://github.com/zixiaog/dsh-storage-monitor/security/advisories/new)；
如果不可用，请通过仓库维护者主页上的联系方式私下联系。

报告中请包含：

- 受影响版本与 DSH 版本；
- 复现步骤（尽量最小化，不要附带真实会话/附件数据）；
- 影响面（例如：越权删除、路径逃逸、CSRF、迁移失败导致数据不可用）；
- 你建议的修复方式（可选）。

## 威胁模型

本插件是**本地单用户工具**，默认假设：

- DSH Web UI 只监听本机回环地址，不暴露给不可信网络；
- 使用插件的人就是这台机器的所有者；
- 插件进程与 DSH 宿主同权限运行，能访问 `DSH_HOME` 下的全部数据。

插件明确处理的边界：

- HTTP API 只挂在 `/storage-monitor` 前缀；POST 请求校验同源 `Origin`、要求
  `x-dsh-storage-monitor: 1` 自定义头、`Content-Type: application/json`，并限制请求体大小；
- 所有删除/移动路径先做 `assertInside`，拒绝 `..` 与逃逸出 `sessions`/`attachments`/
  `storage-monitor` 根目录的路径；
- 运行中的会话拒绝删除；批量删除有上限；默认进回收站；
- 迁移脚本只在 DSH 退出后运行，Junction 创建失败会自动恢复原目录名；
- 迁移操作不注册为 agent 工具，只能由页面用户发起。

不在防护范围内：

- 已经取得你本机账号的攻击者（同权限下可以直接读写 `DSH_HOME`）；
- 用户手动执行篡改后的迁移脚本；
- DSH 自身的鉴权/网络暴露配置问题（请向 DSH 报告）。

## 使用建议

- 不要把 DSH Web UI 暴露到公网；
- 迁移前先备份或勾选「保留旧目录备份」；
- 不要在对话/任务执行中启动一键迁移；
- 定期检查回收站并清空确认不再需要的内容；
- 只从本仓库或可信来源安装插件。
