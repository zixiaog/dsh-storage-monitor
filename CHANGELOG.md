# Changelog

本项目的所有重要变更都会记录在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.11] - 2026-11-07

### Fixed

- **迁移后插件安装/卸载报 `ERR_PNPM_UNEXPECTED_STORE` / `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` 的三个根因**：
  1. **修复与重链现在先把 profile 解析为真实路径再执行**。之前用 Junction 逻辑路径
     （`C:\Users\<user>\.dsh\...`）跑 pnpm，pnpm 按 cwd 判定项目所在盘，会认为项目
     仍在旧盘并把 `storeDir` 写回 `C:\...\store`；而 DSH 插件管理器用真实路径
     （`D:\...\profiles\desktop`）跑 pnpm，两边永远不一致。控制台脚本改用 DSH 自带
     node 的 `fs.realpathSync` 解析真实路径，插内检测同样先 `realpath` 再判断盘符。
  2. **非系统盘 store 约定修正**：由 `<盘符>:\pnpm-store`（0.1.8 起的错误规则）改为
     pnpm 实际使用的 `<盘符>\.pnpm-store\v<major>`（插件管理器失败日志
     `Using the store at D:\.pnpm-store\v11 instead` 与 `pnpm store path` 实证）。
  3. **修复现在同时修正 `virtualStoreDir`**：指向真实路径下的 `node_modules\.pnpm`，
     并清理记录旧项目路径的 `.pnpm-workspace-state-v1.json` 缓存。之前只改
     `storeDir`，修完立刻撞上 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`。
- pnpm 依赖存储卡片现在同时显示 `storeDir` 与 `virtualStoreDir` 的当前/期望值，
  文案同时提及两种错误码。

## [0.1.10] - 2026-11-07

### Fixed

- **pnpm store 检测误报“一致”**：0.1.9 只用“盘符 + pnpm-store”规则推测期望值，可能和 DSH
  插件管理器实际使用的 store 不同。现在按优先级检测：
  1. 最近一次插件管理器失败日志里的 `Using the store at ...` / `pnpm now wants to use the store at ...`
     （DSH 自己 pnpm 实际选择，最可靠）；
  2. 用 DSH 自带 pnpm 执行 `store path`；
  3. 最后才回退到盘符规则。
  卡片和修复按钮都使用检测到的真实路径，不会再出现“显示一致但卸载仍报错”。

## [0.1.9] - 2026-11-07

### Added

- **插件内 pnpm store 修复入口**：迁移 → 映射状态页新增「pnpm 依赖存储」卡片。
  当 `node_modules/.modules.yaml` 的 `storeDir` 与当前盘不符时，直接点击
  「修复 pnpm store 记录」即可修正 metadata，不需要手动编辑文件，也不会重装依赖。
- 修复前自动备份 `.modules.yaml`；修复后卡片显示当前/期望 store 路径与修复结果。
- 新增 Host API `POST /storage-monitor/api/migrate/repair-pnpm`，只接受同源请求，
  仅修改当前 profile 的 pnpm metadata，不执行 pnpm install。

## [0.1.8] - 2026-11-07

### Fixed

- **迁移后插件安装/卸载仍报 `ERR_PNPM_UNEXPECTED_STORE`**：0.1.7 使用的是 `pnpm store path`
  返回的默认值（非系统盘可能是 `<drive>:\.pnpm-store\v11`），而 DSH 自己使用的是
  `<drive>:\pnpm-store\v11`，两者仍不一致。0.1.8 在非系统盘按 DSH 规则选择 store 路径，
  metadata 修正和完整重链都使用该路径；C 盘仍使用 pnpm 默认 store。
- 现在迁移到 D 盘后，pnpm store 是 `D:\pnpm-store\v11`，与 DSH 插件管理器一致，不再需要
  先回退才能卸载/安装插件。

## [0.1.7] - 2026-11-07

### Changed

- **迁移/回滚后自动执行完整 pnpm 重链**：metadata 修正成功后，脚本会在重启 DSH 之前
  自动执行 `pnpm install --force --store-dir <新盘 store>`，把 profile 依赖真正重新链接到
  新盘 store，而不只是改记录。这样后续插件安装/卸载处于完全一致的状态。
- 重链放在 DSH 关闭时执行，避免运行中的 DSH 占用 `node_modules`；脚本顺序为
  “修正 metadata → 完整重链 → 重启 DSH”，重启完成时重链已经结束。
- 重链失败不会阻塞迁移或重启；metadata 已修正，仍可先卸载/安装插件，并会打印手动命令。

## [0.1.6] - 2026-11-07

### Changed

- **pnpm store 修复改为只改 metadata，不重装依赖**：迁移/回滚切换数据目录后，先用 DSH
  自带的 pnpm 查出新盘实际 store 路径，然后只把 `node_modules/.modules.yaml` 里的
  `storeDir` 改为该路径并备份原文件。这样不会删除/重装 `node_modules`、不需要联网，
  也不会因为插件依赖来自 GitHub/本地而失败；改完后 pnpm 的卸载/安装操作即可正常工作。
- 只有 metadata 写入或校验失败时，才回退到原来的 `pnpm install --force` 兜底。

## [0.1.5] - 2026-11-07

### Fixed

- **迁移后 DSH 没有自动重启**：0.1.3/0.1.4 为了解析新端口，把 DSH 的 stdout/stderr
  重定向到文件；部分 DSH/Electron 版本在重定向 stdio 后无法拉起 GUI。现在恢复普通
  `Start-Process` 启动，不再重定向；改为检测 DSH 进程的主窗口和监听端口来确认启动成功。
- **按回车不关闭迁移控制台**：脚本结束后显式调用 `[Environment]::Exit(0)`，避免
  Windows Terminal / `cmd start` 环境里 PowerShell 已结束但标签页仍停留。
- **profile 显示“未映射”**：当只迁移 DSH 数据目录时，profile 位于该目录内部，随父目录
  Junction 一起映射，并不是漏掉。映射状态现在显示「随数据目录映射」并解释无需单独 Junction。

## [0.1.4] - 2026-11-07

### Fixed

- **迁移后卸载/安装插件报 `ERR_PNPM_UNEXPECTED_STORE`**：跨盘迁移 DSH_HOME 后，
  profile 的 `node_modules/.modules.yaml` 仍记录旧盘的 pnpm store，而 DSH 已按新盘选择
  store，导致所有插件安装/卸载失败。一键迁移和回滚现在会在切换数据目录后自动检查
  `storeDir` 与 profile 所在盘是否一致；不一致时用 DSH 自带的 node/pnpm 在 profile 里执行
  `pnpm install --force`，把依赖重新链接到新盘的 store，然后再重启 DSH。
- 自动修复失败不会回滚已完成的迁移，只在控制台日志里给出手动修复命令，避免数据目录状态
  被二次破坏。

## [0.1.3] - 2026-11-06

### Fixed

- **启动控制台等待动画**：点击「生成并启动迁移控制台」或「生成并启动回滚控制台」后，
  页面显示带旋转指示器的加载遮罩和说明，直到独立控制台确认启动或返回错误，不再出现
  “点完没反应”的空窗期。
- **重启 DSH 卡在 starting…**：迁移脚本重启 DSH 时不再等待旧端口（DSH 每次启动会分配新端口）。
  现在把新进程 stdout/stderr 重定向到文件，从输出里解析实际的 `http://127.0.0.1:<port>`，
  检测到就继续执行；如果 120 秒内解析不到，只打印警告，不再阻塞后续流程。

## [0.1.2] - 2026-11-06

### Fixed

- **浅色 brand 主题下按钮文字不可见**：部分皮肤把 `--dsw-alias-brand-primary` 设为接近白色，
  v0.1.1 的主按钮用该 token 做背景 + 白字，导致「重新扫描」「校验目标」「生成并启动迁移控制台」
  等按钮变成白块。现在主按钮、步骤序号、选中态、开关、进度条、聚焦边框统一使用插件自带的
  高对比强调色（`#3b5bdb`），不再依赖皮肤 brand token；标签/图标也同步修正。

## [0.1.1] - 2026-11-06

### Fixed

- **迁移/回滚控制台自动启动**：生成脚本后通过 `Start-Process` 打开独立控制台，并用脚本开头的
  `.started` 标记确认窗口真的启动；失败时回退到 `cmd start`，仍失败则返回明确错误和手动命令，
  不再出现“生成了脚本但没有任何窗口”的静默失败。
- **迁移后重启 DSH 的 Chromium 缓存报错**：关闭 DSH 时在优雅关闭超时后清理残留的 Electron /
  GPU / renderer 进程，并等待进程全部退出、端口释放后再重启，避免
  `Unable to move/create cache`、`GPU Cache Creation failed`。
- **回滚一键化**：映射状态页新增「生成并启动回滚控制台」，自动关闭 DSH、移除 Junction、
  把数据复制回原盘并自动重启 DSH；失败时自动恢复 Junction，保证 DSH 仍可启动。

## [0.1.0] - 2026-11-06

### Added

- 存储报告：会话日志、附件、缓存、存储索引、插件目录、已安装插件包、运行时、插件数据、
  日志与回收站共 10 个分类；工作区项目文件独立统计。
- 图表页面：分类环形图、Top 会话条形图、全宽占用构成堆叠条、KPI 卡片；
  DSH Web UI 原生插槽页面，支持明暗主题。
- 清理建议：按安全/谨慎/不要动分级；支持一键清空回收站、清理缓存、孤立投影缓存、
  孤儿附件；深度扫描不可信时自动禁用孤儿附件清理。
- 会话管理：搜索与筛选、批量删除、运行中拒绝删除；默认移入回收站可恢复，
  永久删除需二次确认；按引用关系只删除仅属于该会话的附件。
- 回收站：恢复（会话日志、投影缓存、独占附件）、永久删除、清空。
- 路径迁移：DSH 数据目录 / profile 迁移到其它磁盘，原路径创建 Junction；
  目标校验、在线 robocopy 预拷贝（可取消）、切换/回滚脚本生成。
- 智能一键迁移：生成独立 PowerShell 控制台，自动倒计时关闭 DSH、最终同步、
  改名为备份、创建并验证 Junction、可选保留备份、自动重启 DSH。
- 迁移验证：迁移前快照（会话数、插件包数、源路径），重启后校验 Junction 目标、
  会话数量、插件包数量与写探针。
- `storage_inspect` agent 工具：报告、会话删除、回收站、缓存/孤儿清理；
  迁移操作不暴露给 agent。
- 文档：设计说明（docs/DESIGN.md）、贡献指南、安全策略、行为准则、MIT 许可证、
  GitHub Actions 检查工作流。

### Security

- POST 接口同源校验 + CSRF 自定义头 + JSON Content-Type + 请求体上限。
- 删除/移动前 `assertInside` 路径校验；运行中会话拒绝删除；默认回收站。
- 迁移脚本失败自动恢复原目录名；智能控制台不杀进程树，避免误杀自身。
