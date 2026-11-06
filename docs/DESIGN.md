# dsh-storage-monitor · 设计说明

> DSH 存储空间监测与安全清理插件
> 版本 0.1.0 · 适用于 DeepSeek Harness Desktop（profile: desktop）

---

## 1. 目标与边界

这个插件回答三个问题：

1. **DSH 到底占了多少磁盘？** 按会话、附件、缓存、插件、运行时、插件数据、工作区项目等维度分类统计，并用图表展示。
2. **哪些能安全清理？** 给出带风险分级的建议，能自动执行的安全项直接执行（缓存、回收站、孤儿附件、孤立投影缓存）。
3. **如何彻底删除一个会话？** 提供会话管理页：删除日志、投影缓存、仅属于该会话的附件，并默认移入回收站，可恢复。

明确不做的事：

- 不修改 `cordis.patch.yml`、不写 profile 配置、不卸载插件（卸载请用「插件管理」页）；
- 不删除运行时（`electron` / `dsh-runtimes`）和工作区项目文件（只统计与建议）；
- 不把删除做成不可逆的一步：默认走回收站，永久删除需要二次确认。

---

## 2. 为什么需要这个插件

DSH 的持久化层有两条明确约束（来自 `@deepseek-ai/dsh-session-persistence-jsonl` 与
`@deepseek-ai/dsh-attachment-local` 的 README）：

- **会话日志没有任何删除 API**：`sessionPersistence` 只有 create/open/stat/list/flush，
  日志"积累到被外部删除为止"；
- **附件永远不会自动删除**：图片/文件按 SHA-256 去重存放在 `attachments/v1`，
  对象只增不减。

因此磁盘占用只增不减，且分散在多个目录里。本插件把"统计 + 建议 + 删除"做成一个页面，
并且把删除会话时必须一起处理的东西（投影缓存、工作区解绑、固定/归档状态、独占附件）
全部纳入同一套流程，避免用户手删目录留下悬空状态。

---

## 3. 数据来源

所有统计都来自真实的文件系统与服务查询，没有估算：

| 数据 | 来源 |
| --- | --- |
| 会话列表、日志大小、日志路径 | `ctx.sessionPersistence.list()`（`SessionPersistenceSnapshot.sizeBytes` / `location.path`） |
| 会话是否运行中 | `ctx.sessions.list()`（活会话 id 集合） |
| 会话标题、最后活动时间、空会话 | `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 的 `title` / `turnOutline` / `sessionListMetadata` 行 |
| 会话所属工作区 | `ctx.workspaceRegistry.list()` 的 `sessionIds` + `path` |
| 固定 / 归档状态 | `<DSH_HOME>/storages/workspace.json` 的 `pinnedSessionIds` / `archivedSessionIds` |
| 会话引用了哪些附件 | 通过 `sessionPersistence.open(id, 'read')` 读取事件，遍历 `attachmentId`（深度扫描/删除时） |
| 附件对象大小 | `<DSH_HOME>/attachments/v1/objects/<2位>/<sha256>` 等 |
| 目录占用 | Node `fs` 递归统计（48 个一批并发 stat，不跟随符号链接，条目数上限兜底） |
| 插件包体积 | profile `node_modules` 下每个包的 `realpath` 真实目录（避免 pnpm 链接重复计数） |
| DSH_HOME / profile | `DSH_HOME` 环境变量；profile 目录从环境变量或 `<DSH_HOME>/profiles` 推断 |

### 磁盘布局（本插件实际识别的路径）

```text
<DSH_HOME>/
  sessions/<cwd归一化目录>/<会话id>/session.v4.jsonl.zstd   # 会话日志（zstd 帧）
  attachments/v1/objects/<xx>/<sha256>                       # 图片对象
  attachments/v1/file-objects/<xx>/<sha256>                  # 通用文件对象
  attachments/v1/files/<xx>/<sha256>/<name>                  # 文件硬链接视图
  cache/attachments/request-images/...                       # 请求图片派生缓存（可重建）
  storages/session_projcache/sessions/<id>.json              # 投影缓存（标题/统计）
  storages/workspace.json                                    # 工作区注册表
  profiles/<profile>/node_modules/...                        # 已安装插件包
  plugins/                                                   # 遗留插件目录 + 插件管理临时文件
  dsh-runtimes/, electron/                                   # 运行时（不要删）
  storage-monitor/trash/                                     # 本插件的会话回收站
```

---

## 4. 分类体系

| key | 名称 | 包含 | 默认清理等级 | 说明 |
| --- | --- | --- | --- | --- |
| `sessions` | 会话日志 | `sessions/` 全部会话目录（含历史格式代与 lock 文件） | 谨慎 | 删除会丢对话；请走「会话管理」 |
| `attachments` | 附件 | `attachments/v1` 的 objects / file-objects / files / tmp | 谨慎 | 按内容寻址去重；共享对象只占一份 |
| `cache` | 缓存 | `<DSH_HOME>/cache`（请求图片变体等） | 安全 | 可随时重建，不影响历史 |
| `storages` | 存储索引 | 投影缓存 + 工作区注册表 | 谨慎 | 投影缓存可重建；注册表不要手删 |
| `plugins` | 插件目录 | `<DSH_HOME>/plugins` + profile `.plugin-manager` | 谨慎 | 优先通过插件管理页卸载 |
| `profiles` | 已安装插件包 | profile `node_modules`（含 `.pnpm` 真实目录） | 不要删 | 深度扫描时列出单包体积 |
| `runtime` | 运行时 | `dsh-runtimes` + `electron`（约 600MB） | 不要删 | 删除后应用无法启动 |
| `pluginData` | 插件数据 | DSH 根目录下非系统目录（qq 通道、皮肤、宠物等） | 谨慎 | 各插件自己的数据 |
| `logs` | 日志与配置 | DSH 根目录下的 `*.log` / `*.jsonl` / `*.json` | 谨慎 | 日志可清；`cordis.patch.yml` 等配置勿手改 |
| `trash` | 回收站 | `<DSH_HOME>/storage-monitor/trash` | 安全 | 确认后可清空 |

**工作区项目文件**单独列出（不在 DSH_HOME 内，不计入 DSH 总占用）：读取工作区注册表，
列出每个工作区目录与会话数；`node_modules` / `dist` / `build` 等子目录在测量后标出。
嵌套工作区（例如 `default/qq/agent-workspace` 在 `default` 内）合计时只算最外层，避免重复。

> 工作区体积**默认不测**：项目目录可能有几万个文件（本机实测有一个 1,007MB / 79,930 文件
> 的工作区，逐个 stat 需要约 20 秒）。页面提供「测量工作区体积」按钮显式触发，结果缓存
> 10 分钟；不测量时显示"未测量"，不阻塞报告与图表。

---

## 5. 页面与交互（v2 设计）

页面是 Web UI 的原生 React 插槽组件（`main` + `sidebar.panellist`），不嵌 iframe，
因此跟随主题明暗切换。v2 采用模块化设计系统：

- 一个注入的 `<style>` 定义 `stm-*` 组件类，颜色全部来自 `--dsw-alias-*` token；
- 顶部 Hero（品牌标识 + 路径 chip + 扫描时间 + 全局动作），下面胶囊式分段导航；
- 六个模块：概览、分类、会话、建议、迁移、回收站；
- 组件按职责拆分：基础控件（按钮/标签/开关/进度/弹窗）、图表（环形图/条形图/堆叠条）、
  业务视图（分类卡/会话表/建议卡/回收站/迁移向导）。

**概览**：5 个 KPI 卡（总占用、可安全清理、会话、附件、工作区）→ 占用环形图 + 最大会话 →
全宽「占用构成」堆叠条 → 工作区体积。

**分类**：每个分类一张卡片：图标、可清理等级、体积、占比条、说明、Top 子项；
点「查看明细」展开，不再堆一长列表格。

**会话**：搜索 + 快捷筛选 chip（全部/空会话/90 天未用/已归档/已固定/运行中）、
批量选择工具条、粘性表头、状态徽标、行内删除；深度扫描后显示附件占用。

**建议**：按 安全 / 谨慎 / 不要动 分组，带可释放空间与一键动作。

**迁移**：分步向导（选源 → 选盘 → 校验 → 预拷贝 → 生成脚本），显示磁盘剩余空间、
校验清单、迁移估算、可取消的预拷贝进度、最终命令与复制按钮、当前映射状态。

**回收站**：条目卡片、恢复/永久删除/清空。

图表用 SVG / div 手写，不引入图表库：
1. 环形图：DSH_HOME 一级分类占比（Top 8 + 其他），中心显示合计；
2. 横向条形图：占用最大的会话、工作区体积；
3. 堆叠条：全宽占用构成 + 图例百分比。

会话表里"大小 = 日志 + 附件"的双行展示（深度扫描后显示附件部分与共享数量）。

---

## 6. 清理建议规则

建议由数据实时计算，带风险分级：

| 建议 | 分级 | 触发条件 | 动作 |
| --- | --- | --- | --- |
| 清空回收站 | 安全 | `trash` 非空 | 一键永久删除回收站条目 |
| 清理 DSH 缓存 | 安全 | `cache` 非空 | 清空 `<DSH_HOME>/cache` 内容 |
| 清理孤立投影缓存 | 安全 | 存在会话已不存在的 `session_projcache/*.json` | 删除这些 json |
| 清理孤儿附件 | 安全 | 深度扫描成功且存在无引用对象 | 删除无任何会话引用的对象 |
| 清理空会话 | 安全 | 存在 `blank` 且非运行中的会话 | 跳转会话管理并筛选「空会话」 |
| 90 天未用会话 | 谨慎 | `ageDays >= 90`、未固定、非运行中 | 跳转筛选 |
| 已归档会话 | 谨慎 | `archived` | 跳转筛选（归档不释放空间） |
| 共享附件提示 | 谨慎 | 深度扫描发现一个附件被多个会话引用 | 仅提示：删除单会话时保留 |
| 运行时 | 不要动 | 永远显示 | 仅提示 |
| 工作区项目 | 谨慎 | 工作区总占用 > 0 | 仅提示，交给项目工具 |

失败保护：

- 深度扫描有任何会话读不出来时，**不生成"清理孤儿附件"建议**；
- 真正的孤儿清理接口再次校验，只要有一个会话读失败就整体中止（宁可不删）；
- 删除会话时附件引用核对失败，则只删会话、保留全部附件，并在结果里标出
  `skippedAttachmentCleanup`。

---

## 7. 会话删除设计（核心）

### 7.1 一次删除会处理什么

对每个会话：

1. **校验**：id 合法、会话存在、**不在运行中**（`ctx.sessions.list()`）、
   日志路径位于 `<DSH_HOME>/sessions` 内（`assertInside`，拒绝 `..`/软链逃逸）；
2. **计算足迹**：会话目录（含 v0~v4 历史代与 lock）+ 投影缓存 + 仅属于它的附件；
3. **会话目录整体移入回收站** `<DSH_HOME>/storage-monitor/trash/<ISO>__<id>/session`；
4. **投影缓存**移入同目录 `projcache.json`；
5. **附件按引用关系处理**：
   - 读取目标会话日志，收集 `attachmentId`；
   - 读取其它所有会话日志，建立 `attachmentId → 引用会话集合`；
   - 只处理"没有任何其它会话引用"的对象；共享附件保留并在结果里计数；
   - 回收站模式把对象移入 `trash/<entry>/attachments/...`，永久删除模式直接 `rm`；
6. **工作区解绑**：`workspace.detachSession(id)`，并 `unpinSession` / `unarchiveSession`；
7. **写清单** `manifest.json`：会话目录、投影缓存、附件映射、原工作区 id、字节统计；
8. `mode === 'purge'` 时在以上都成功后删除整个回收站条目。

### 7.2 回收站与恢复

- 回收站条目 = 一次删除操作，包含 `manifest.json`；
- 「恢复」按清单把 `session/` 移回原会话目录、`projcache.json` 移回、附件移回，
  再尝试把会话重新挂到原工作区；
- 恢复前检查同名会话是否已存在，存在则拒绝（不覆盖）；
- 固定/归档状态不恢复（删除时已清理，属于有意为之）。

### 7.3 安全边界

- **运行中的会话拒绝删除**（UI 禁用 + 服务端二次校验）；
- 批量删除一次最多 100 个；id 去重；非法 id 拒绝；
- 所有路径在删除/移动前做 `assertInside`；
- 默认 `trash`，永久删除在 UI 里需要勾选"我已知晓不可恢复"；
- 删除子会话不会连带父会话；反过来父会话删除后子会话的 lineage 追踪会失效——
  会话表对"有子会话"的会话显示警示徽标，由用户决定；
- 删除当前会话会被拒绝（它一定在 `sessions.list()` 里）。

### 7.4 已知限制

- `sessionPersistence` 没有删除 API，删除是文件系统层面的；删除瞬间如果另一个进程
  正在写同一会话，存在竞态（运行中检测只能覆盖本进程的活会话）；
- 深度扫描/附件核对要逐条解码 zstd 会话日志，30 个会话约 7~12 秒；
  并发限制为 2，避免一次把多个大日志的事件树留在内存里；
- 没有实现"按会话物理重建/迁移"，历史格式代文件会跟随会话目录一起进回收站。

---

## 7.5 路径迁移与映射（新增）

目标：把 DSH 数据目录（默认 `C:\Users\<user>\.dsh`，包含 `profiles\desktop`）搬到其它磁盘，
**原路径保持不变**：在原路径创建 Windows Junction 指向新目录。DSH 及所有插件继续使用
`C:\Users\<user>\.dsh\...`，实际数据落在目标盘，C 盘空间释放。

### 为什么不能在线切换

会话日志、附件、插件包在 DSH 运行期间都有打开的文件句柄，Windows 无法安全 rename
正在使用的目录。因此流程分成「在线预拷贝」+「离线切换脚本」两段：

```text
[在线] 校验 → robocopy 预拷贝（可取消）→ 生成 switch / rollback 脚本
                 ↓ 用户完全退出 DSH
[离线] 脚本等待进程退出 → robocopy /MIR 最终同步 → 原目录改名备份
       → 创建 Junction → 写入探针文件验证映射 → 删除备份释放空间
```

### 脚本做了什么

- **等待 DSH 退出**：同时检查生成时的宿主进程 PID 与 Web 端口（默认 64886），
  最多 3 分钟；未退出则报错退出，不修改任何东西；
- **最终同步**：`robocopy /MIR /SL /SJ /MT:8`，保留 Junction/符号链接（pnpm 的
  node_modules 依赖这一点），排除可选跳过的 `cache`；
- **改名 + 建映射**：`Rename-Item` 原目录为 `<原名>.pre-migration-<时间>`，
  `New-Item -ItemType Junction` 在原路径创建映射；
- **验证**：通过原路径写一个探针文件，确认真的落在目标目录；失败自动回滚目录名；
- **清理**：验证成功后才删除备份（默认），C 盘空间这时才真正释放；
  加 `-KeepBackup` 可保留备份；
- **回滚脚本**：先退出 DSH，删除 Junction，再 `robocopy /MIR` 把数据搬回原盘；
  默认保留目标目录，加 `-RemoveTarget` 才删除。

### 实现细节

- 迁移源可选「DSH 数据目录」（推荐，一次包含 profile）或「profile 目录」；
- 目标必须是绝对路径、专用子目录、与源不同盘（同盘会给警告）、剩余空间 ≥ 1.05× + 200MB；
- 预拷贝走 robocopy，12.6k 文件 / 266MB 实测约 41 秒；可随时取消；
- 脚本写到 `<目标目录>-migration\`，同时生成 `.ps1` 与可双击的 `.bat`；
- `.ps1` 以 UTF-8 BOM 写入（Windows PowerShell 5.1 对中文路径必要）；
- 后端检测原路径已是 Junction 时，改为提供「生成回滚脚本」，不再重复迁移；
- 迁移状态卡实时显示每个路径是否已映射、映射目标、占用大小。

### 智能一键迁移（控制台）

除了「生成脚本后手动运行」，迁移页还提供**一键智能迁移**：

1. 选择源、目标并完成校验；
2. 打开「迁移完成后自动重启 DSH」（默认开）、按需打开「保留旧目录备份」；
3. 点「生成并启动迁移控制台」：插件生成带完整流程的 `run-*.ps1`，通过
   `Start-Process powershell.exe` 打开**独立控制台窗口**（标题
   “DSH Storage Migration - keep this window open”，启动时尝试激活到前台）；
4. 控制台显示 5 秒倒计时（Ctrl+C 可取消），然后自动关闭 DSH：
   - 先对 DSH 主窗口进程发优雅关闭（`taskkill` 不带 `/F`）；
   - 25 秒内未退出则强制结束宿主进程（不杀进程树，避免误杀迁移控制台）；
   - 等待 Web 端口释放；
5. 执行 `robocopy /MIR /SL /SJ /MT:8` 最终同步，`Write-Progress` 实时显示
   已同步字节、预计总量与已用时间；
6. 改名 → 创建 Junction → 写探针验证 →（默认）删除旧目录；
7. 自动重启 DSH：用捕获到的 `process.execPath` + `process.argv.slice(1)` + `cwd`
   重放启动命令，等待 Web 端口就绪；
8. 控制台打印 DONE 并停在 `Press Enter to close`，不会自动关闭；
9. DSH 重启后，迁移页读取 `<目标>-migration\snapshot.json`（迁移前会话数、
   插件包数、源路径），自动执行验证：Junction 目标、会话数量、插件包数量、
   通过原路径写探针。结果显示在「迁移验证」卡片。

失败处理：控制台捕获异常；如果已经改名，会自动删除 Junction、把备份改回原名；
若开启自动重启，会尝试重新启动 DSH 并保持窗口，方便查看日志。

控制台窗口**不要中途关闭**：真正危险的窗口只有“改名 + 建 Junction”这几百毫秒，
脚本已在失败时自动回滚，但进程被外部杀死时无法补救。脚本同步写
`runner-<时间>.log`。

### 安全边界

- 智能模式由控制台脚本关闭 DSH；手动模式由用户退出 DSH 后运行脚本；两种方式都不会在
  DSH 运行中替换根目录；
- 关闭优先优雅（`taskkill` 窗口进程）；25 秒超时才强制结束宿主进程，且不杀进程树，
  避免误杀迁移控制台；
- 预拷贝只读源、只写目标，不修改源；
- 切换前先完整镜像，Junction 创建失败会恢复目录名；备份删除发生在验证成功之后；
- 回滚脚本可逆；目标目录默认保留；
- 仅支持 Windows（NTFS Junction）；非 Windows 平台迁移页明确禁用；
- 控制台窗口需保持打开；迁移前快照用于重启后验证。

---

## 8. API 协议

所有路由挂在 `/storage-monitor` 前缀下（由 `ctx.webServer.register({kind:'prefix'})` 提供），
页面与 agent 工具共用同一套 Host 实现。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回 dshHome / profileDir |
| GET | `/api/client` | 诊断：当前 Client 启动图里的本插件条目与 bundle 路径 |
| GET | `/api/report?deep=0\|1&refresh=0\|1` | 存储报告（quick 缓存 60s，deep 缓存 5min，`refresh=1` 强制重建） |
| POST | `/api/delete-sessions` | `{ids, mode:'trash'\|'purge', deleteAttachments}` |
| POST | `/api/measure-workspaces` | 显式测量全部工作区体积（可能约 20 秒），结果缓存 10 分钟 |
| GET | `/api/trash` | 回收站列表 |
| POST | `/api/trash/purge` | `{names?}` 省略 names = 清空 |
| POST | `/api/trash/restore` | `{names}` |
| POST | `/api/cleanup` | `{action:'cache'\|'projcache'\|'orphans'}` |
| GET | `/api/migrate/status` | 迁移状态：源路径、是否已映射、映射目标、磁盘剩余空间 |
| POST | `/api/migrate/validate` | `{sourceKey,target,excludeCache}` 校验目标并返回检查清单 |
| POST | `/api/migrate/copy/start` | `{sourceKey,target,excludeCache}` 启动 robocopy 预拷贝任务 |
| GET | `/api/migrate/copy` | 预拷贝任务进度（state/phase/elapsed） |
| POST | `/api/migrate/copy/cancel` | 取消预拷贝 |
| POST | `/api/migrate/scripts` | `{sourceKey,target,excludeCache}` 生成切换/回滚脚本；`{sourceKey,mode:'rollback'}` 为已映射路径生成回滚脚本 |

迁移接口属于**用户操作**：不注册为 agent 工具，避免模型自行移动用户数据。

POST 安全：

- 校验 `Origin` 与 `Host` 同源（有 Origin 时必须一致）；
- 必须带 `x-dsh-storage-monitor: 1`（跨源表单无法伪造，且自定义头会触发预检）；
- `Content-Type: application/json`，请求体上限 1 MiB；
- 响应 `cache-control: no-store`。

---

## 9. Agent 工具

同时注册 `storage_inspect` 工具（Host 与页面共用实现）：

```json
{
  "action": "report | delete_sessions | list_trash | purge_trash | restore_trash | measure_workspaces | cleanup",
  "deep": true,
  "ids": ["session-..."],
  "mode": "trash | purge",
  "deleteAttachments": true,
  "cleanupAction": "cache | projcache | orphans",
  "names": ["2026-...__session-..."]
}
```

`report` 返回精简版（总量、分类、建议、Top 12 会话），避免把完整报告塞进上下文。
删除同样走运行中拒绝、回收站默认、附件引用核对等全部保护。
**路径迁移不暴露给 agent**（`lib/migrate.js` 只有 HTTP 入口），因为替换 DSH 根目录
必须由用户确认并在退出 DSH 后执行。

---

## 10. 安装 / 卸载

```text
plugin_manager install_bundle  target = <本目录绝对路径>
```

安装后：

- 「存储空间」入口出现在左侧栏（order 35，在插件与自动化任务之后、鸿蒙开发台之前）；
- 插件行 `dsh-storage-monitor` 出现在插件管理页，`meta.title` / `meta.description` 来自
  `locale/zh.json` / `locale/en.json`，图标为 `icon.svg`；
- 卸载用插件管理页移除 bundle 即可；本插件不写 profile 配置，移除后只会留下
  `<DSH_HOME>/storage-monitor/trash`（可手动删除）。

---

## 11. 验证记录（本次安装实例）

- `install_bundle`：`application: applied`，`warnings: []`；
- `Slots.listSubTree('main')` 与 `sidebar.panellist` 均出现 `dsh-storage-monitor` 且 `active: true`；
- `/api/health` 200；`/api/report?deep=0&refresh=1` 200，耗时 3.2 秒，返回 29 个会话、10 个分类，
  总占用 1.13GB（其中运行时 605.7MB、插件包 266.2MB、附件 172.9MB、会话 57.1MB、缓存 50.1MB）；
- `/api/report?deep=1&refresh=1` 200，耗时 12.1 秒：扫描 29 个会话，669 个被引用附件对象，
  7 个孤儿对象（2.3MB），157 个共享附件；有会话读失败时不产出孤儿清理建议；
- `/api/measure-workspaces` 200，耗时 19.9 秒，测出 5 个工作区共 1433.4MB
  （其中 `sn-mes-hdrd` 978.8MB / 79,929 文件，`桥梁方案` 286MB，`default` 166MB；
  嵌套的 `qq/agent-workspace` 不重复计入）；之后报告仍为 2.9 秒；
- Client bundle 通过 combo URL（`/plugins/??dsh-storage-monitor/client.js&rev=...`）返回
  200 / `text/javascript`（142,516 bytes，v2 模块化界面）；
- 删除闭环在空会话 `session-03e93ffd-…` 上实测：移入回收站 → 报告列表消失 → 回收站可见 →
  恢复 → 会话回到列表 → 永久删除 → 列表与回收站均清空；
  删除时附件核对（`deleteAttachments: true`）实测耗时 7.3 秒（29 个会话），共享附件保留逻辑未误删；
- 迁移：`/api/migrate/status` 200（识别 2 个源、5 块磁盘、推荐目标）；`/api/migrate/validate` 200
  （profile → 其它盘检查通过，返回文件数/所需空间）；`/api/migrate/scripts` 200，生成
  switch/rollback `.ps1` + `.bat`，`.ps1` 带 UTF-8 BOM；`/api/migrate/copy/start` 启动 robocopy
  任务、轮询 running、cancel 成功；独立测试中 266MB / 12.6k 文件的预拷贝耗时约 41 秒；
- 智能一键迁移：生成 `run-*.ps1`（含倒计时、优雅/强制关闭、robocopy 进度、Junction 验证、
  删除备份、自动重启、失败回滚），通过 PowerShell 语法解析；启动信息（execPath / argv / cwd）
  已捕获（当前实例为 `DeepSeek Harness.exe` + 6 个内部参数）；`/api/migrate/verify` 返回空结果；
  实际切换**未执行**（会关闭当前 DSH），首次使用建议先保留备份；
- 渲染冒烟测试：概览、分类、会话、建议、回收站、迁移（空闲/校验通过/校验失败/拷贝中/拷贝完成/
  已生成脚本/已映射+回滚）、删除/永久删除弹窗、加载/错误/未测量状态全部通过；
- 切换脚本本身**未实际执行**（执行会退出当前 DSH 进程，从而中断本会话）；脚本逻辑已通过
  生成内容检查与 junction 原语实测，需用户关闭 DSH 后自行运行；
- 视觉渲染未做浏览器端截图验证（本会话无浏览器控制能力），页面注册、bundle 分发与 API 行为已确认。

---

## 12. 目录结构

```text
dsh-storage-monitor/
  package.json          # bundle manifest + dsh.client
  cordis.patch.yml      # 插入一行 Host/Client 插件
  index.js              # Host 入口：路由 + 预热 + storage_inspect 工具
  client.js             # Client 页面（v2：设计系统 + 六个模块）
  lib/
    api.js              # HTTP 路由、同源/CSRF 防护、报告缓存
    report.js           # 分类统计、会话元数据、深度扫描、清理建议
    sessions.js         # 删除/回收站/恢复/清理动作
    attachments.js      # 附件引用扫描与对象路径
    migrate.js          # 路径迁移：扫描/校验/robocopy 预拷贝/生成切换与回滚脚本
    util.js             # 目录测量、字节格式化、路径校验、有限并发
  locale/zh.json        # 插件管理页元数据（中文）
  locale/en.json        # 插件管理页元数据（英文）
  icon.svg              # 原创建型图标
```

