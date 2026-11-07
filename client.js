/**
 * dsh-storage-monitor · Client 半侧（v2 设计）
 *
 * 浏览器端唯一格式要求：window.__ModuleLoader__.load({ id, factory })。
 * React 从宿主模块表 require('react')；样式只用 --dsw-alias-* / --dsw-static-* token。
 *
 * 页面模块：
 *   概览 / 分类明细 / 会话管理 / 清理建议 / 路径迁移 / 回收站
 *
 * 设计约定：
 *   - 所有视觉走本文件的 CSS 类（注入一个 <style>），颜色全部来自宿主主题 token；
 *   - 组件按职责拆分：基础控件、图表、业务视图、迁移向导；
 *   - 数据全部来自 Host 的 /storage-monitor/api/*，不在前端猜任何路径或大小。
 */
window.__ModuleLoader__.load({
  id: 'dsh-storage-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const ID = 'dsh-storage-monitor'
    const NS = 'dsh-storage-monitor'
    const TITLE = '存储空间'

    const T = {
      text: 'var(--dsw-alias-label-primary, #1a1a1a)',
      text2: 'var(--dsw-alias-label-secondary, #5f5f66)',
      text3: 'var(--dsw-alias-label-tertiary, #8a8a93)',
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      layer: 'var(--dsw-alias-bg-layer-1, #f7f7f8)',
      layer2: 'var(--dsw-alias-bg-layer-2, #efeff1)',
      border: 'var(--dsw-alias-border-l1, #e6e6ea)',
      border2: 'var(--dsw-alias-border-l2, #d6d6dc)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      success: 'var(--dsw-alias-state-success-primary, #16a34a)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      danger: 'var(--dsw-alias-state-error-primary, #dc2626)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.045))',
      overlay: 'var(--dsw-alias-bg-mask-drop, rgba(0,0,0,0.42))',
    }

    const ACCENT = 'var(--stm-accent)'

    const CHART_COLORS = ['#4d6bfe', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#64748b']

    // -----------------------------------------------------------------------
    // 文案
    // -----------------------------------------------------------------------
    const ZH = {
      'panel.title': '存储空间',
      'panel.subtitle': 'DSH 数据目录',
      'panel.scanAt': '扫描于 {time}',
      'panel.recommend': '迁移到其它磁盘可释放 C 盘空间',
      'action.refresh': '重新扫描',
      'action.refreshing': '扫描中…',
      'action.deep': '深度扫描',
      'action.deepHint': '读取全部会话日志，统计每个会话的附件归属与孤儿附件，可能需要 10~20 秒。',
      'action.deepDone': '深度扫描',
      'action.copy': '复制',
      'action.copied': '已复制',
      'kpi.total': '总占用',
      'kpi.totalHint': 'DSH 数据目录（含运行时）',
      'kpi.cleanable': '可安全清理',
      'kpi.cleanableHint': '缓存 / 回收站 / 孤儿文件',
      'kpi.sessions': '会话',
      'kpi.sessionsHint': '含 {live} 个运行中',
      'kpi.attachments': '附件',
      'kpi.attachmentsHint': '{files} 个对象文件',
      'kpi.workspace': '工作区',
      'kpi.workspaceHint': '{n} 个项目目录',
      'chart.categories': '占用构成',
      'chart.categoriesHint': '按 DSH 数据目录一级分类',
      'chart.topSessions': '最大的会话',
      'chart.topSessionsHint': '日志 + 投影缓存 + 独占附件',
      'chart.total': '合计',
      'chart.other': '其他',
      'chart.detail': '查看分类明细',
      'tab.overview': '概览',
      'tab.detail': '分类',
      'tab.sessions': '会话',
      'tab.advice': '建议',
      'tab.migration': '迁移',
      'tab.trash': '回收站',
      'clean.safe': '可安全清理',
      'clean.caution': '谨慎清理',
      'clean.danger': '不要删',
      'clean.user': '用户数据',
      'cat.sessions': '会话日志',
      'cat.attachments': '附件',
      'cat.cache': '缓存',
      'cat.storages': '存储索引',
      'cat.plugins': '插件目录',
      'cat.profiles': '已安装插件包',
      'cat.runtime': '运行时',
      'cat.pluginData': '插件数据',
      'cat.logs': '日志与配置',
      'cat.trash': '回收站',
      'catHint.sessions': '每个会话一个目录，包含压缩事件日志；删除会话请用「会话」页。',
      'catHint.attachments': '图片与文件按 SHA-256 去重存储，被多个会话共享的对象只占一份。',
      'catHint.cache': '可随时重建的派生缓存，清理不影响历史数据。',
      'catHint.storages': '会话投影缓存与工作区注册表；投影缓存可重建，注册表不要手删。',
      'catHint.plugins': '遗留插件目录与插件管理器临时文件；优先在插件管理页卸载。',
      'catHint.profiles': 'profile 的 node_modules，即已安装插件本体；请通过插件管理页卸载。',
      'catHint.runtime': 'DSH 桌面运行时与 Electron，删除后应用无法启动。',
      'catHint.pluginData': '各插件自己在 DSH 目录下创建的数据（QQ 通道、皮肤、宠物等）。',
      'catHint.logs': 'DSH 根目录下的日志与配置；日志可清，配置请勿手改。',
      'catHint.trash': '本插件删除会话后的回收站，确认无误后可清空。',
      'detail.files': '{n} 个文件',
      'detail.expand': '查看明细',
      'detail.collapse': '收起',
      'detail.noItems': '没有可展示的子项',
      'detail.truncated': '目录过大，统计已截断',
      'workspace.title': '工作区项目文件',
      'workspace.hint': '这些目录不在 DSH 数据目录内，是项目本身的占用；DSH 不会自动清理。',
      'workspace.measure': '测量体积',
      'workspace.measuring': '测量中…',
      'workspace.unmeasured': '未测量',
      'workspace.measureHint': '项目可能有数万文件，默认不扫描以免拖慢页面；点按钮显式测量，结果缓存 10 分钟。',
      'workspace.truncated': '统计截断',
      'workspace.sessions': '{n} 个会话',
      'workspace.missing': '目录不存在',
      'workspace.cleanable': '可单独清理',
      'sessions.search': '搜索标题、id、路径…',
      'sessions.filter.all': '全部',
      'sessions.filter.blank': '空会话',
      'sessions.filter.stale': '90 天未用',
      'sessions.filter.archived': '已归档',
      'sessions.filter.pinned': '已固定',
      'sessions.filter.live': '运行中',
      'sessions.col.title': '会话',
      'sessions.col.workspace': '工作区',
      'sessions.col.last': '最后活动',
      'sessions.col.size': '占用',
      'sessions.col.state': '状态',
      'sessions.col.actions': '',
      'sessions.badge.live': '运行中',
      'sessions.badge.pinned': '已固定',
      'sessions.badge.archived': '已归档',
      'sessions.badge.blank': '空会话',
      'sessions.badge.subagent': '子会话',
      'sessions.badge.children': '有子会话',
      'sessions.delete': '删除',
      'sessions.selected': '已选 {n} 个',
      'sessions.bulkDelete': '批量删除',
      'sessions.liveHint': '运行中的会话不可删除，请先停止。',
      'sessions.deepHint': '深度扫描后可看到每个会话独占的附件占用。',
      'sessions.empty': '没有匹配的会话',
      'sessions.total': '共 {n} 个会话',
      'sessions.attachment': '附件 {size}',
      'sessions.log': '日志 {size}',
      'sessions.day': '今天',
      'sessions.daysAgo': '{n} 天前',
      'sessions.clearSelect': '取消选择',
      'modal.title': '删除会话',
      'modal.warning': '会话日志、投影缓存与仅属于它的附件会被移除；被其它会话共享的附件自动保留。',
      'modal.mode.trash': '移入回收站（推荐，可恢复）',
      'modal.mode.purge': '永久删除（不可恢复）',
      'modal.attachments': '同时删除仅属于这些会话的附件',
      'modal.attachmentsHint': '删除前会读取会话日志核对引用关系；读取失败时自动跳过附件删除。',
      'modal.cancel': '取消',
      'modal.confirmTrash': '移入回收站',
      'modal.confirmPurge': '永久删除',
      'modal.confirmPurgeArm': '确认永久删除',
      'modal.deleting': '删除中…',
      'modal.resultTitle': '删除完成',
      'modal.result': '完成 {ok} 个，共 {size}；保留共享附件 {shared} 个。',
      'modal.refused': '拒绝 {n} 个：{reason}',
      'modal.close': '关闭',
      'modal.irreversible': '我已知晓此操作不可恢复',
      'advice.safe': '安全',
      'advice.caution': '谨慎',
      'advice.danger': '不要动',
      'advice.reclaim': '可释放 {size}',
      'advice.items': '{n} 项',
      'advice.action': '立即清理',
      'advice.review': '去查看',
      'advice.trash.title': '清空回收站',
      'advice.trash.detail': '回收站里的会话仍占用磁盘，确认不再需要后可永久删除。',
      'advice.cache.title': '清理 DSH 缓存',
      'advice.cache.detail': '请求图片等派生缓存，删除后会在下次使用时自动重建，不影响历史消息。',
      'advice.projcache.title': '清理孤立投影缓存',
      'advice.projcache.detail': '会话已不存在、但仍残留在 session_projcache 里的投影缓存文件。',
      'advice.orphans.title': '清理孤儿附件',
      'advice.orphans.detail': '没有任何会话引用的附件对象（通常是会话删除后遗留），可安全删除。',
      'advice.blank.title': '清理空会话',
      'advice.blank.detail': '没有产生任何内容的会话，删除不会丢失对话。',
      'advice.stale.title': '处理 90 天未使用的会话',
      'advice.stale.detail': '长期未使用的历史会话占用最多，建议先移入回收站观察。',
      'advice.archived.title': '处理已归档会话',
      'advice.archived.detail': '归档不会释放磁盘空间；确认不再需要后可删除。',
      'advice.shared.title': '共享附件会被保留',
      'advice.shared.detail': '有 {n} 个附件被多个会话同时引用，删除单个会话时不会删除它们。',
      'advice.scanIncomplete.title': '深度扫描不完整',
      'advice.scanIncomplete.detail': '有 {n} 个会话日志无法读取，附件归属可能不准确；孤儿附件清理已禁用。',
      'advice.runtime.title': '运行时不要手动删除',
      'advice.runtime.detail': 'dsh-runtimes 与 electron 是应用本体，手动删除会导致 DSH 无法启动。',
      'advice.workspaces.title': '工作区项目文件',
      'advice.workspaces.detail': '项目目录的 node_modules / dist / build 通常最大，请用项目工具清理，本插件不代删。',
      'trash.empty': '回收站是空的',
      'trash.hint': '这里只存放本插件删除的会话；恢复会把日志、投影缓存与独占附件放回原位置。',
      'trash.restore': '恢复',
      'trash.purge': '永久删除',
      'trash.purgeAll': '清空回收站',
      'trash.deletedAt': '删除于 {time}',
      'trash.restored': '已恢复 {n} 个会话',
      'mig.title': '路径迁移与映射',
      'mig.subtitle': '把 DSH 数据目录搬到其它磁盘，并在原路径创建 Junction，原路径继续可用。',
      'mig.warning': '迁移的最后一步必须在 DSH 完全退出后执行。脚本会做最终同步、创建映射、验证并清理旧目录。',
      'mig.step1': '选择源目录',
      'mig.step2': '选择目标磁盘',
      'mig.step3': '校验',
      'mig.step4': '预拷贝（可选）',
      'mig.step5': '关闭 DSH 后运行切换脚本',
      'mig.source': '源目录',
      'mig.sourceHint': '推荐整体迁移 DSH 数据目录：一次包含 profile、插件、会话与附件。',
      'mig.target': '目标目录',
      'mig.targetHint': '建议使用其它磁盘上的专用空目录，例如 F:\\DSHData。',
      'mig.targetPlaceholder': '例如 F:\\DSHData',
      'mig.suggest': '使用推荐路径',
      'mig.free': '剩余 {size}',
      'mig.excludeCache': '不迁移缓存目录（cache，可重建）',
      'mig.excludeCacheHint': '少拷贝约 50MB，迁移后自动重建。',
      'mig.validate': '校验目标',
      'mig.validating': '校验中…',
      'mig.checks': '校验结果',
      'mig.estimate': '迁移估算',
      'mig.copyBytes': '需复制',
      'mig.files': '文件',
      'mig.required': '建议空间',
      'mig.scriptDir': '脚本目录',
      'mig.startCopy': '开始预拷贝',
      'mig.copying': '正在预拷贝…',
      'mig.cancel': '取消预拷贝',
      'mig.cancelled': '预拷贝已取消',
      'mig.copyDone': '预拷贝完成',
      'mig.copyFailed': '预拷贝失败',
      'mig.elapsed': '已用 {time}',
      'mig.phase.copying': '复制中（robocopy）',
      'mig.phase.done': '完成',
      'mig.generateScript': '生成切换脚本',
      'mig.generating': '生成中…',
      'mig.switchScript': '切换脚本',
      'mig.runSteps': '接下来：',
      'mig.closeDsh': '完全退出 DSH（含托盘图标）。',
      'mig.runCommand': '在 PowerShell 中运行下面的命令（或双击同名 .bat）。',
      'mig.copyCommand': '复制命令',
      'mig.scriptSaved': '脚本已生成：{path}',
      'mig.mapped': '已映射',
      'mig.mappedTo': '数据在 {target}',
      'mig.unmapped': '未映射',
      'mig.coveredByHome': '随数据目录映射',
      'mig.coveredByHint': '位于已映射的 DSH 数据目录内，无需单独 Junction',
      'mig.rollback': '生成回滚脚本',
      'mig.rollbackAuto': '生成并启动回滚控制台',
      'mig.rollbackAutoHint': '自动关闭 DSH、移除映射、把数据复制回原盘，完成后自动重启 DSH。',
      'mig.rollbackHint': '回滚会把数据搬回原盘并移除原路径的 Junction，同样需要先退出 DSH。',
      'mig.onlyWindows': '路径映射迁移目前仅支持 Windows（NTFS Junction）。',
      'mig.recommended': '推荐',
      'mig.sourceSize': '当前 {size} · {files} 个文件',
      'mig.refresh': '刷新磁盘与映射状态',
      'mig.error': '迁移操作失败',
      'mig.keepBackup': '脚本默认验证成功后删除旧目录以释放空间；想保留备份可给脚本加 -KeepBackup。',
      'mig.smart.title': '智能迁移（一键）',
      'mig.smart.hint': '生成并启动独立控制台脚本：窗口保持前台显示进度，自动关闭 DSH、迁移、验证并重启。',
      'mig.smart.warning': '启动后约 5 秒会关闭 DSH，页面会断开。请先保存工作，并保持控制台窗口打开直到出现 DONE。',
      'mig.smart.restart': '迁移完成后自动重启 DSH',
      'mig.smart.keepBackup': '保留旧目录备份（不立即释放 C 盘空间）',
      'mig.smart.launch': '生成并启动迁移控制台',
      'mig.smart.launching': '正在启动控制台…',
      'mig.smart.launched': '控制台已启动：{path}',
      'mig.smart.closing': 'DSH 即将关闭，请切换到迁移控制台窗口查看进度。',
      'mig.launchingOverlay': '正在启动迁移控制台…',
      'mig.rollback.launchingOverlay': '正在启动回滚控制台…',
      'mig.launchingHint': '正在生成脚本并等待独立控制台窗口出现，通常需要 5–15 秒，请保持页面打开。',
      'mig.smart.needValidate': '先完成校验再启动智能迁移。',
      'mig.verify.title': '迁移验证',
      'mig.verify.ok': '验证通过',
      'mig.verify.fail': '需要检查',
      'mig.verify.none': '重启后自动验证',
      'mig.noValidation': '先完成校验再开始预拷贝。',
      'mig.targetInSource': '目标目录不能位于源目录内。',
      'mig.supported': 'Windows · NTFS Junction',
      'mig.flow.smart': '一键迁移',
      'mig.flow.manual': '手动模式',
      'mig.flow.status': '映射状态',
      'mig.flow.smartSub': '自动关闭并重启 DSH，控制台窗口显示实时进度',
      'mig.flow.manualSub': '自己控制节奏：预拷贝 → 生成脚本 → 退出 DSH 后运行',
      'mig.flow.statusSub': '查看已映射路径与迁移验证结果',
      'mig.flow.source': '选择源目录',
      'mig.flow.target': '选择目标目录并校验',
      'mig.flow.start': '开始迁移',
      'mig.flow.manualPre': '预拷贝（可选）',
      'mig.flow.manualScript': '生成并运行切换脚本',
      'mig.flow.emptyStatus': '当前没有已映射的路径',
      'mig.flow.emptyStatusHint': '完成一次迁移后，这里会显示映射目标和验证结果。',
      'mig.flow.goSmart': '去一键迁移',
      'mig.flow.mappedHint': '这个路径已经映射到其它磁盘，不能再迁移一次。',
      'mig.flow.statusLink': '查看映射状态',
      'mig.flow.needValidate': '先完成第 2 步的目标校验。',
      'mig.flow.docHint': '不确定选哪个？用「一键迁移」：它会在独立控制台里自动完成关闭、同步、映射、验证和重启。',
      'mig.flow.runManual': '生成切换脚本后，退出 DSH 再手动运行；适合需要自己控制时间点的场景。',
      'mig.flow.stepDone': '已完成',
      'common.loading': '正在读取存储数据…',
      'common.error': '读取失败',
      'common.retry': '重试',
      'common.close': '关闭',
      'common.none': '无',
      'common.deepScanning': '正在深度扫描会话与附件引用…',
      'common.working': '处理中…',
      'common.unknown': '未知',
      'toast.refreshed': '已重新扫描',
      'toast.failed': '操作失败：{message}',
      'toast.cleaned': '已释放 {size}',
      'toast.scriptReady': '切换脚本已生成',
      'toast.copied': '已复制到剪贴板',
      'error.noReport': '还没有报告数据',
      'error.notInstalled': 'Host 侧 API 不可用：请确认插件已启用并重启 DSH。',
      'empty.tip': '暂无数据',
      'empty.sessions': '没有会话',
    }

    const EN = {
      'panel.title': 'Storage',
      'panel.subtitle': 'DSH data directory',
      'panel.scanAt': 'Scanned at {time}',
      'panel.recommend': 'Move data to another drive to free C:',
      'action.refresh': 'Rescan',
      'action.refreshing': 'Scanning…',
      'action.deep': 'Deep scan',
      'action.deepHint': 'Reads every session log to attribute attachments and find orphan objects. Takes 10–20 seconds.',
      'action.deepDone': 'Deep scan',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'kpi.total': 'Total usage',
      'kpi.totalHint': 'DSH data dir (incl. runtime)',
      'kpi.cleanable': 'Safely cleanable',
      'kpi.cleanableHint': 'Caches / trash / orphans',
      'kpi.sessions': 'Sessions',
      'kpi.sessionsHint': '{live} running',
      'kpi.attachments': 'Attachments',
      'kpi.attachmentsHint': '{files} object files',
      'kpi.workspace': 'Workspaces',
      'kpi.workspaceHint': '{n} project directories',
      'chart.categories': 'Usage composition',
      'chart.categoriesHint': 'Top-level categories under the DSH data dir',
      'chart.topSessions': 'Largest sessions',
      'chart.topSessionsHint': 'Log + projection cache + exclusive attachments',
      'chart.total': 'Total',
      'chart.other': 'Other',
      'chart.detail': 'Open breakdown',
      'tab.overview': 'Overview',
      'tab.detail': 'Categories',
      'tab.sessions': 'Sessions',
      'tab.advice': 'Advice',
      'tab.migration': 'Migration',
      'tab.trash': 'Trash',
      'clean.safe': 'Safe to clean',
      'clean.caution': 'Clean with care',
      'clean.danger': 'Do not delete',
      'clean.user': 'User data',
      'cat.sessions': 'Session logs',
      'cat.attachments': 'Attachments',
      'cat.cache': 'Cache',
      'cat.storages': 'Storage indexes',
      'cat.plugins': 'Plugin directories',
      'cat.profiles': 'Installed plugin packages',
      'cat.runtime': 'Runtime',
      'cat.pluginData': 'Plugin data',
      'cat.logs': 'Logs & config',
      'cat.trash': 'Trash',
      'catHint.sessions': 'One directory per session with a compressed event log. Delete via Sessions.',
      'catHint.attachments': 'Images and files deduplicated by SHA-256; shared objects are stored once.',
      'catHint.cache': 'Derived caches that rebuild automatically; clearing keeps history intact.',
      'catHint.storages': 'Projection caches and the workspace registry. Do not hand-delete the registry.',
      'catHint.plugins': 'Legacy plugin directories and plugin-manager temporaries; uninstall from Plugins.',
      'catHint.profiles': 'The profile node_modules (installed plugins). Uninstall from the Plugins page.',
      'catHint.runtime': 'The DSH desktop runtime and Electron. Removing them breaks the app.',
      'catHint.pluginData': 'Data created under the DSH directory by individual plugins.',
      'catHint.logs': 'Logs and config at the DSH root; logs are disposable, config is not.',
      'catHint.trash': 'Sessions deleted by this plugin; empty it once you are sure.',
      'detail.files': '{n} files',
      'detail.expand': 'Show items',
      'detail.collapse': 'Hide',
      'detail.noItems': 'No child items',
      'detail.truncated': 'Directory too large; measurement truncated',
      'workspace.title': 'Workspace project files',
      'workspace.hint': 'These directories are outside the DSH data dir and belong to your projects.',
      'workspace.measure': 'Measure',
      'workspace.measuring': 'Measuring…',
      'workspace.unmeasured': 'Not measured',
      'workspace.measureHint': 'Projects can contain tens of thousands of files. Measure explicitly; results are cached for 10 minutes.',
      'workspace.truncated': 'Truncated',
      'workspace.sessions': '{n} sessions',
      'workspace.missing': 'Missing',
      'workspace.cleanable': 'Can be cleaned separately',
      'sessions.search': 'Search title, id, path…',
      'sessions.filter.all': 'All',
      'sessions.filter.blank': 'Blank',
      'sessions.filter.stale': 'Unused 90d',
      'sessions.filter.archived': 'Archived',
      'sessions.filter.pinned': 'Pinned',
      'sessions.filter.live': 'Running',
      'sessions.col.title': 'Session',
      'sessions.col.workspace': 'Workspace',
      'sessions.col.last': 'Last activity',
      'sessions.col.size': 'Usage',
      'sessions.col.state': 'State',
      'sessions.col.actions': '',
      'sessions.badge.live': 'Running',
      'sessions.badge.pinned': 'Pinned',
      'sessions.badge.archived': 'Archived',
      'sessions.badge.blank': 'Blank',
      'sessions.badge.subagent': 'Subagent',
      'sessions.badge.children': 'Has children',
      'sessions.delete': 'Delete',
      'sessions.selected': '{n} selected',
      'sessions.bulkDelete': 'Delete selected',
      'sessions.liveHint': 'Running sessions cannot be deleted; stop them first.',
      'sessions.deepHint': 'Run a deep scan to see exclusive attachment usage per session.',
      'sessions.empty': 'No matching sessions',
      'sessions.total': '{n} sessions',
      'sessions.attachment': 'attachments {size}',
      'sessions.log': 'log {size}',
      'sessions.day': 'today',
      'sessions.daysAgo': '{n}d ago',
      'sessions.clearSelect': 'Clear selection',
      'modal.title': 'Delete sessions',
      'modal.warning': 'Session logs, projection caches and attachments used only by these sessions are removed; shared attachments are kept.',
      'modal.mode.trash': 'Move to trash (recommended, restorable)',
      'modal.mode.purge': 'Delete permanently (irreversible)',
      'modal.attachments': 'Also delete attachments used only by these sessions',
      'modal.attachmentsHint': 'References are verified from session logs first; on read failure attachment deletion is skipped.',
      'modal.cancel': 'Cancel',
      'modal.confirmTrash': 'Move to trash',
      'modal.confirmPurge': 'Delete permanently',
      'modal.confirmPurgeArm': 'Confirm permanent delete',
      'modal.deleting': 'Deleting…',
      'modal.resultTitle': 'Deletion finished',
      'modal.result': '{ok} completed, {size} total; kept {shared} shared attachments.',
      'modal.refused': '{n} refused: {reason}',
      'modal.close': 'Close',
      'modal.irreversible': 'I understand this cannot be undone',
      'advice.safe': 'Safe',
      'advice.caution': 'Careful',
      'advice.danger': 'Do not touch',
      'advice.reclaim': 'Reclaimable {size}',
      'advice.items': '{n} items',
      'advice.action': 'Clean now',
      'advice.review': 'Review',
      'advice.trash.title': 'Empty the trash',
      'advice.trash.detail': 'Trashed sessions still occupy disk; purge them once you are sure.',
      'advice.cache.title': 'Clear DSH caches',
      'advice.cache.detail': 'Derived caches rebuild on next use; message history is unaffected.',
      'advice.projcache.title': 'Remove orphan projection caches',
      'advice.projcache.detail': 'Projection cache files whose session no longer exists.',
      'advice.orphans.title': 'Remove orphan attachments',
      'advice.orphans.detail': 'Attachment objects not referenced by any session, usually left over after deletions.',
      'advice.blank.title': 'Clean up blank sessions',
      'advice.blank.detail': 'Sessions with no content; deleting them loses nothing.',
      'advice.stale.title': 'Review sessions unused for 90 days',
      'advice.stale.detail': 'Old sessions usually dominate. Move them to trash first and purge later.',
      'advice.archived.title': 'Review archived sessions',
      'advice.archived.detail': 'Archiving does not free disk. Delete them if you no longer need them.',
      'advice.shared.title': 'Shared attachments are kept',
      'advice.shared.detail': '{n} attachments are referenced by several sessions and are kept.',
      'advice.scanIncomplete.title': 'Deep scan incomplete',
      'advice.scanIncomplete.detail': '{n} session logs could not be read; orphan cleanup is disabled.',
      'advice.runtime.title': 'Never delete the runtime by hand',
      'advice.runtime.detail': 'dsh-runtimes and electron are the application itself; deleting them breaks DSH.',
      'advice.workspaces.title': 'Workspace project files',
      'advice.workspaces.detail': 'node_modules, dist and build output usually dominate; clean them with your own project tooling.',
      'trash.empty': 'Trash is empty',
      'trash.hint': 'Only sessions deleted through this plugin live here. Restore puts logs, projection cache and exclusive attachments back.',
      'trash.restore': 'Restore',
      'trash.purge': 'Delete permanently',
      'trash.purgeAll': 'Empty trash',
      'trash.deletedAt': 'Deleted {time}',
      'trash.restored': 'Restored {n} sessions',
      'mig.title': 'Path migration & mapping',
      'mig.subtitle': 'Move the DSH data directory to another drive and keep the original path via a junction.',
      'mig.warning': 'The final step must run after DSH is fully closed. The script mirrors data, creates the junction, verifies it and removes the old directory.',
      'mig.step1': 'Choose source',
      'mig.step2': 'Choose target drive',
      'mig.step3': 'Validate',
      'mig.step4': 'Pre-copy (optional)',
      'mig.step5': 'Run switch script after quitting DSH',
      'mig.source': 'Source',
      'mig.sourceHint': 'Migrating the whole DSH data dir is recommended: it includes profile, plugins, sessions and attachments.',
      'mig.target': 'Target directory',
      'mig.targetHint': 'Use a dedicated empty directory on another drive, e.g. F:\\DSHData.',
      'mig.targetPlaceholder': 'e.g. F:\\DSHData',
      'mig.suggest': 'Use suggested path',
      'mig.free': '{size} free',
      'mig.excludeCache': 'Skip the cache directory (rebuildable)',
      'mig.excludeCacheHint': 'Saves about 50MB; the cache rebuilds automatically.',
      'mig.validate': 'Validate target',
      'mig.validating': 'Validating…',
      'mig.checks': 'Validation',
      'mig.estimate': 'Estimate',
      'mig.copyBytes': 'To copy',
      'mig.files': 'Files',
      'mig.required': 'Recommended space',
      'mig.scriptDir': 'Script directory',
      'mig.startCopy': 'Start pre-copy',
      'mig.copying': 'Pre-copying…',
      'mig.cancel': 'Cancel pre-copy',
      'mig.cancelled': 'Pre-copy cancelled',
      'mig.copyDone': 'Pre-copy finished',
      'mig.copyFailed': 'Pre-copy failed',
      'mig.elapsed': '{time} elapsed',
      'mig.phase.copying': 'Copying (robocopy)',
      'mig.phase.done': 'Done',
      'mig.generateScript': 'Generate switch script',
      'mig.generating': 'Generating…',
      'mig.switchScript': 'Switch script',
      'mig.runSteps': 'Next steps:',
      'mig.closeDsh': 'Quit DSH completely (including the tray icon).',
      'mig.runCommand': 'Run the command below in PowerShell (or double-click the generated .bat).',
      'mig.copyCommand': 'Copy command',
      'mig.scriptSaved': 'Script created: {path}',
      'mig.mapped': 'Mapped',
      'mig.mappedTo': 'Data lives at {target}',
      'mig.unmapped': 'Not mapped',
      'mig.coveredByHome': 'Covered by DSH_HOME',
      'mig.coveredByHint': 'Lives inside the mapped DSH data directory; no separate junction needed',
      'mig.rollback': 'Generate rollback script',
      'mig.rollbackAuto': 'Launch rollback console',
      'mig.rollbackAutoHint': 'Closes DSH, removes the junction, copies data back to the original drive, then restarts DSH.',
      'mig.rollbackHint': 'Rollback moves data back to the original drive and removes the junction. DSH must be closed.',
      'mig.onlyWindows': 'Path migration currently supports Windows only (NTFS junction).',
      'mig.recommended': 'Recommended',
      'mig.sourceSize': '{size} · {files} files',
      'mig.refresh': 'Refresh drives & mappings',
      'mig.error': 'Migration failed',
      'mig.keepBackup': 'The script deletes the old directory after verification to free space; pass -KeepBackup to keep a backup.',
      'mig.smart.title': 'One-click smart migration',
      'mig.smart.hint': 'Generates and launches a detached console: it shows progress, closes DSH, migrates, verifies and restarts DSH.',
      'mig.smart.warning': 'DSH will be closed after about 5 seconds and this page will disconnect. Save your work and keep the console window open until DONE.',
      'mig.smart.restart': 'Restart DSH automatically after migration',
      'mig.smart.keepBackup': 'Keep the old directory backup (does not free C: immediately)',
      'mig.smart.launch': 'Generate & launch migration console',
      'mig.smart.launching': 'Launching console…',
      'mig.smart.launched': 'Console launched: {path}',
      'mig.smart.closing': 'DSH is about to close. Switch to the migration console to watch progress.',
      'mig.launchingOverlay': 'Starting the migration console…',
      'mig.rollback.launchingOverlay': 'Starting the rollback console…',
      'mig.launchingHint': 'Generating the script and waiting for the detached console window. This usually takes 5–15 seconds; keep this page open.',
      'mig.smart.needValidate': 'Validate the target before starting smart migration.',
      'mig.verify.title': 'Migration verification',
      'mig.verify.ok': 'Verified',
      'mig.verify.fail': 'Needs attention',
      'mig.verify.none': 'Verified automatically after restart',
      'mig.noValidation': 'Validate the target before pre-copying.',
      'mig.targetInSource': 'The target must not be inside the source directory.',
      'mig.supported': 'Windows · NTFS junction',
      'mig.flow.smart': 'One-click',
      'mig.flow.manual': 'Manual',
      'mig.flow.status': 'Mapping',
      'mig.flow.smartSub': 'Closes and restarts DSH automatically; the console shows live progress',
      'mig.flow.manualSub': 'Pre-copy → generate script → run it yourself after quitting DSH',
      'mig.flow.statusSub': 'Mapped paths and verification results',
      'mig.flow.source': 'Choose source',
      'mig.flow.target': 'Choose target and validate',
      'mig.flow.start': 'Start migration',
      'mig.flow.manualPre': 'Pre-copy (optional)',
      'mig.flow.manualScript': 'Generate and run the switch script',
      'mig.flow.emptyStatus': 'Nothing is mapped yet',
      'mig.flow.emptyStatusHint': 'After a migration this page shows the junction target and verification results.',
      'mig.flow.goSmart': 'Go to one-click migration',
      'mig.flow.mappedHint': 'This path is already mapped to another drive; it cannot be migrated again.',
      'mig.flow.statusLink': 'View mapping status',
      'mig.flow.needValidate': 'Complete the target validation in step 2 first.',
      'mig.flow.docHint': 'Not sure? Use One-click: an independent console closes DSH, mirrors data, creates the junction, verifies it and restarts DSH.',
      'mig.flow.runManual': 'Generate the script, quit DSH, then run it manually.',
      'mig.flow.stepDone': 'Done',
      'common.loading': 'Reading storage data…',
      'common.error': 'Failed to load',
      'common.retry': 'Retry',
      'common.close': 'Close',
      'common.none': 'None',
      'common.deepScanning': 'Scanning sessions and attachment references…',
      'common.working': 'Working…',
      'common.unknown': 'Unknown',
      'toast.refreshed': 'Rescanned',
      'toast.failed': 'Failed: {message}',
      'toast.cleaned': 'Freed {size}',
      'toast.scriptReady': 'Switch script created',
      'toast.copied': 'Copied to clipboard',
      'error.noReport': 'No report data yet',
      'error.notInstalled': 'Host API unavailable: make sure the plugin is enabled and DSH was restarted.',
      'empty.tip': 'No data',
      'empty.sessions': 'No sessions',
    }

    function makeTranslator(dict) {
      return (key, params) => {
        const template = dict[key] ?? ZH[key] ?? key
        if (!params) return template
        return String(template).replace(/\{(\w+)\}/g, (_, name) => (params[name] == null ? '' : String(params[name])))
      }
    }

    // -----------------------------------------------------------------------
    // 工具函数
    // -----------------------------------------------------------------------
    function human(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = n
      let index = -1
      do {
        value /= 1024
        index += 1
      } while (value >= 1024 && index < units.length - 1)
      return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`
    }

    function percent(value) {
      const n = Number(value) || 0
      return `${(n * 100).toFixed(n > 0 && n < 0.01 ? 2 : 1)}%`
    }

    function formatTime(timestamp) {
      if (!timestamp) return '—'
      try {
        return new Date(timestamp).toLocaleString()
      } catch {
        return '—'
      }
    }

    function formatDuration(ms) {
      const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
    }

    function severityColor(severity) {
      if (severity === 'safe') return T.success
      if (severity === 'caution') return T.warn
      if (severity === 'danger') return T.danger
      return T.text3
    }

    function cleanableMeta(t, cleanable) {
      if (cleanable === 'safe') return { label: t('clean.safe'), color: T.success }
      if (cleanable === 'caution') return { label: t('clean.caution'), color: T.warn }
      if (cleanable === 'danger') return { label: t('clean.danger'), color: T.danger }
      return { label: t('clean.user'), color: T.text3 }
    }

    async function api(path, options = {}) {
      const method = options.method ?? 'GET'
      const headers = { 'x-dsh-storage-monitor': '1' }
      let body
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(options.body)
      }
      const response = await fetch(`/storage-monitor${path}`, { method, headers, body, cache: 'no-store' })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload.data
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
          return true
        } catch {
          return false
        }
      }
    }

    // -----------------------------------------------------------------------
    // 设计系统 CSS（颜色全部来自宿主 token）
    // -----------------------------------------------------------------------
    const CSS = `
.stm-root{--stm-accent:#3b5bdb;--stm-accent-hover:#314fc7;--stm-accent-soft:rgba(59,91,219,.14);--stm-on-accent:#fff;--stm-danger:#dc2626;height:100%;overflow-y:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:24px 28px 64px;box-sizing:border-box;font-family:inherit;font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
.stm-wrap{max-width:1160px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.stm-hero{position:relative;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;padding:22px 24px;background:linear-gradient(180deg,var(--stm-accent-soft),transparent 60%),var(--dsw-alias-bg-layer-1)}
.stm-hero::before{content:'';position:absolute;width:420px;height:420px;right:-120px;top:-260px;border-radius:50%;background:radial-gradient(closest-side,var(--stm-accent-soft),transparent);pointer-events:none}
.stm-hero-top{position:relative;display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
.stm-brand{display:flex;align-items:center;gap:12px}
.stm-logo{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:var(--stm-accent);background:var(--stm-accent-soft);border:1px solid var(--stm-accent);flex:none}
.stm-title{margin:0;font-size:22px;font-weight:650;letter-spacing:-.015em;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.stm-sub{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.stm-pathchip{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;padding:3px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stm-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-left:auto}
.stm-nav{display:flex;gap:4px;padding:4px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow-x:auto;scrollbar-width:none}
.stm-nav::-webkit-scrollbar{display:none}
.stm-nav button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;padding:7px 13px;border-radius:10px;cursor:pointer;white-space:nowrap;display:flex;gap:6px;align-items:center;transition:background .15s,color .15s}
.stm-nav button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.stm-nav button[aria-current="page"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.08),0 0 0 1px var(--dsw-alias-border-l1)}
.stm-nav .count{font-size:10px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 6px;line-height:16px;min-width:16px;text-align:center}
.stm-view{display:flex;flex-direction:column;gap:14px;animation:stm-fade .2s ease}
@keyframes stm-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.stm-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:12px}
.stm-kpi{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;min-width:0}
.stm-kpi::after{content:'';position:absolute;right:-24px;bottom:-34px;width:96px;height:96px;border-radius:50%;background:radial-gradient(closest-side,color-mix(in srgb,var(--kpi-color) 18%,transparent),transparent)}
.stm-kpi-label{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.stm-kpi-value{font-size:23px;font-weight:650;letter-spacing:-.02em;margin:3px 0 1px;font-variant-numeric:tabular-nums}
.stm-kpi-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary);position:relative;z-index:1}
.stm-grid-2{display:grid;grid-template-columns:minmax(0,1.06fr) minmax(0,.94fr);gap:14px}
.stm-grid-2-even{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px}
@media (max-width:900px){.stm-grid-2{grid-template-columns:1fr}}
.stm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);padding:16px 18px;min-width:0;box-sizing:border-box}
.stm-card-head{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.stm-card-title{font-size:12.5px;font-weight:600;letter-spacing:.01em}
.stm-muted{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.stm-flex1{flex:1;min-width:0}
.stm-donut-wrap{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.stm-donut{position:relative;flex:none}
.stm-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;text-align:center}
.stm-donut-center b{font-size:17px;font-weight:650;letter-spacing:-.01em}
.stm-donut-center span{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.stm-legend{flex:1;min-width:220px;display:flex;flex-direction:column;gap:2px}
.stm-legend-row{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:4px 0;border-radius:6px}
.stm-legend-dot{width:8px;height:8px;border-radius:3px;flex:none}
.stm-legend-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stm-legend-val{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none}
.stm-legend-pct{width:44px;text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;font-size:10.5px}
.stm-bars{display:flex;flex-direction:column;gap:11px}
.stm-bar-row{display:flex;flex-direction:column;gap:5px}
.stm-bar-top{display:flex;align-items:baseline;gap:8px;font-size:11.5px}
.stm-bar-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stm-bar-val{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;font-size:11px}
.stm-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.stm-track>span{display:block;height:100%;border-radius:999px;transition:width .4s cubic-bezier(.2,.8,.2,1)}
.stm-stack{display:flex;height:18px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);margin:4px 0 14px}
.stm-stack span{height:100%;transition:width .4s ease}
.stm-legend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:2px 18px}
.stm-cat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px}
.stm-cat{border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;min-width:0}
.stm-cat-top{display:flex;align-items:flex-start;gap:10px}
.stm-cat-ico{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--cat-color);background:color-mix(in srgb,var(--cat-color) 12%,transparent);border:1px solid color-mix(in srgb,var(--cat-color) 20%,transparent);flex:none}
.stm-cat-name{font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.stm-cat-size{font-size:16px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:1px}
.stm-cat-actions{margin-left:auto;flex:none}
.stm-mini-bar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin:10px 0 8px}
.stm-mini-bar>span{display:block;height:100%;border-radius:999px}
.stm-cat-hint{font-size:10.8px;color:var(--dsw-alias-label-tertiary);line-height:1.55;min-height:34px}
.stm-items{border-top:1px dashed var(--dsw-alias-border-l1);margin-top:8px;padding-top:6px}
.stm-item{display:flex;align-items:baseline;gap:8px;font-size:11px;padding:3px 0}
.stm-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stm-item-val{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.stm-item-note{font-size:10px;color:var(--dsw-alias-label-tertiary);max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
.stm-table-card{border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.stm-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:13px 15px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.stm-table-scroll{overflow:auto;max-height:560px}
.stm-thead,.stm-row{display:grid;grid-template-columns:34px minmax(190px,2.1fr) minmax(110px,1.1fr) 92px 124px minmax(128px,1.1fr) 46px;gap:10px;align-items:center;min-width:840px;padding:9px 15px}
.stm-thead{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.stm-row{font-size:11.5px;border-bottom:1px solid var(--dsw-alias-border-l1);transition:background .12s}
.stm-row:last-child{border-bottom:0}
.stm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.stm-cell-main{min-width:0}
.stm-cell-title{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stm-cell-id{font-size:9.8px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace}
.stm-cell-sub{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stm-badges{display:flex;gap:4px;flex-wrap:wrap}
.stm-chip-row{display:flex;gap:5px;flex-wrap:wrap;align-items:center}
.stm-advice-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px}
.stm-advice{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px 14px 18px;overflow:hidden}
.stm-advice::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--advice-color)}
.stm-advice-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.stm-advice-title{font-size:12.5px;font-weight:600;flex:1;min-width:120px}
.stm-advice-size{font-size:12px;font-weight:650;color:var(--advice-color);font-variant-numeric:tabular-nums}
.stm-advice-detail{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin-top:5px}
.stm-advice-actions{display:flex;justify-content:flex-end;margin-top:9px}
.stm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:36px 16px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}
.stm-empty svg{opacity:.55}
.stm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;height:30px;padding:0 12px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s,transform .06s;font-family:inherit}
.stm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.stm-btn:active:not(:disabled){transform:translateY(1px)}
.stm-btn:disabled{opacity:.55;cursor:not-allowed}
.stm-btn.sm{height:26px;padding:0 9px;font-size:11px;border-radius:8px}
.stm-btn.primary{background:var(--stm-accent);border-color:var(--stm-accent);color:var(--stm-on-accent)}
.stm-btn.primary:hover:not(:disabled){background:var(--stm-accent-hover);filter:none}
.stm-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:transparent}
.stm-btn.danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.stm-btn.solid-danger{background:var(--stm-danger);border-color:var(--stm-danger);color:#fff}
.stm-btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.stm-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.stm-iconbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);width:26px;height:26px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.stm-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.stm-toggle{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);height:30px;border-radius:999px;padding:0 10px 0 8px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px}
.stm-toggle[aria-checked="true"]{border-color:var(--stm-accent);background:var(--stm-accent-soft);color:var(--dsw-alias-label-primary)}
.stm-toggle[aria-checked="true"] .stm-switch{background:var(--stm-accent)}
.stm-toggle[aria-checked="true"] .stm-switch span{left:13px}
.stm-switch{width:26px;height:15px;border-radius:999px;background:var(--dsw-alias-border-l2);position:relative;flex:none;transition:background .15s}
.stm-switch span{position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}
.stm-input{height:32px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 10px;outline:none;min-width:0;box-sizing:border-box}
.stm-input:focus{border-color:var(--stm-accent);box-shadow:0 0 0 3px var(--stm-accent-soft)}
.stm-chip{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;height:26px;padding:0 10px;border-radius:999px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.stm-chip[data-active="true"]{border-color:var(--stm-accent);background:var(--stm-accent-soft);color:var(--dsw-alias-label-primary);font-weight:550}
.stm-tag{display:inline-flex;align-items:center;gap:4px;font-size:10px;line-height:17px;padding:0 7px;border-radius:999px;color:var(--tag-color);background:color-mix(in srgb,var(--tag-color) 11%,transparent);border:1px solid transparent;white-space:nowrap;flex:none}
.stm-tag.outline{background:transparent;border-color:color-mix(in srgb,var(--tag-color) 38%,transparent)}
.stm-progress{height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;position:relative}
.stm-progress>span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--stm-accent),#7c3aed);transition:width .3s}
.stm-progress.indeterminate>span{width:38%;animation:stm-slide 1.2s ease-in-out infinite}
@keyframes stm-slide{0%{transform:translateX(-110%)}100%{transform:translateX(300%)}}
.stm-progress-meta{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:6px}
.stm-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.stm-field-label{font-size:11px;font-weight:550;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;align-items:center}
.stm-field-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:1.55}
.stm-sources{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}
.stm-source{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-base);padding:13px 14px;cursor:pointer;transition:border-color .15s,background .15s;text-align:left;font:inherit;color:inherit}
.stm-source:hover{border-color:var(--dsw-alias-border-l2)}
.stm-source[data-selected="true"]{border-color:var(--stm-accent);background:var(--stm-accent-soft);box-shadow:0 0 0 3px rgba(59,91,219,.12)}
.stm-source-head{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;flex-wrap:wrap}
.stm-source-path{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin-top:5px;line-height:1.5}
.stm-source-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:7px}
.stm-check{display:flex;align-items:flex-start;gap:8px;padding:6px 0;font-size:11.5px;line-height:1.5}
.stm-check-icon{width:16px;height:16px;flex:none;display:flex;align-items:center;justify-content:center;margin-top:1px}
.stm-steps{display:flex;flex-direction:column;gap:0;counter-reset:step}
.stm-step{display:flex;gap:11px;align-items:flex-start;padding:9px 0;position:relative}
.stm-step:not(:last-child)::after{content:'';position:absolute;left:11px;top:30px;bottom:-9px;width:1px;background:var(--dsw-alias-border-l1)}
.stm-step-dot{width:23px;height:23px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none;z-index:1}
.stm-step[data-active="true"] .stm-step-dot{border-color:var(--stm-accent);color:var(--stm-accent);background:var(--stm-accent-soft)}
.stm-step[data-done="true"] .stm-step-dot{border-color:var(--dsw-alias-state-success-primary);color:#fff;background:var(--dsw-alias-state-success-primary)}
.stm-step-body{flex:1;min-width:0;padding-top:1px}
.stm-step-title{font-size:12px;font-weight:550}
.stm-step-desc{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px;line-height:1.55}
.stm-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.8px;line-height:1.65;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.stm-callout{display:flex;gap:10px;border:1px solid color-mix(in srgb,var(--callout-color) 32%,transparent);background:color-mix(in srgb,var(--callout-color) 8%,transparent);border-radius:12px;padding:11px 13px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.stm-callout b{color:var(--dsw-alias-label-primary)}
.stm-callout .ico{color:var(--callout-color);flex:none;margin-top:1px}
.stm-modal-mask{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-drop,rgba(0,0,0,.42));display:flex;align-items:center;justify-content:center;padding:20px;animation:stm-fade .15s ease}
.stm-modal{width:min(580px,100%);max-height:min(82vh,760px);overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.3);padding:20px 22px;box-sizing:border-box}
.stm-modal-title{font-size:16px;font-weight:650;letter-spacing:-.01em}
.stm-modal-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.65;margin:6px 0 12px}
.stm-modal-list{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;max-height:170px;overflow:auto;margin-bottom:12px}
.stm-modal-row{display:flex;gap:8px;align-items:baseline;font-size:11.5px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.stm-modal-row:last-child{border-bottom:0}
.stm-radio{display:flex;gap:8px;align-items:flex-start;font-size:12px;padding:7px 0;cursor:pointer;line-height:1.5}
.stm-radio input{margin-top:2px;accent-color:var(--stm-accent)}
.stm-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:1100;background:var(--dsw-alias-toast-bg,#1f2937);color:#fff;padding:9px 16px;border-radius:11px;font-size:12px;box-shadow:0 12px 34px rgba(0,0,0,.32);max-width:70vw;animation:stm-toast .2s ease}
.stm-launch-mask{position:fixed;inset:0;z-index:1200;background:var(--dsw-alias-bg-mask-drop,rgba(0,0,0,.5));display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px)}
.stm-launch-card{display:flex;align-items:center;gap:16px;max-width:460px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:18px;padding:20px 24px;box-shadow:0 24px 70px rgba(0,0,0,.35)}
.stm-launch-title{font-size:14px;font-weight:650;letter-spacing:-.01em}
.stm-launch-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:4px;line-height:1.55}
@keyframes stm-toast{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
.stm-skel{height:92px;border-radius:16px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1) 25%,var(--dsw-alias-bg-layer-2) 37%,var(--dsw-alias-bg-layer-1) 63%);background-size:400% 100%;animation:stm-shimmer 1.3s ease infinite}
@keyframes stm-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
.stm-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--stm-accent-soft);border-top-color:var(--stm-accent);animation:stm-rotate .8s linear infinite;flex:none}
@keyframes stm-rotate{to{transform:rotate(360deg)}}
.stm-fade-in{animation:stm-fade .2s ease}
.stm-flow{display:flex;flex-direction:column;gap:12px}
.stm-flow-head{display:flex;gap:11px;align-items:flex-start}
.stm-flow-num{width:26px;height:26px;border-radius:50%;background:var(--stm-accent);color:var(--stm-on-accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:650;flex:none}
.stm-flow-num[data-done="true"]{background:#15803d;color:#fff}
.stm-flow-num[data-muted="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1)}
.stm-flow-title{font-size:13.5px;font-weight:650;letter-spacing:-.005em}
.stm-flow-sub{font-size:10.8px;color:var(--dsw-alias-label-tertiary);margin-top:2px;line-height:1.55}
.stm-flow-body{margin-top:12px}
.stm-flow-body .stm-sources{margin-bottom:0}
@media (max-width:640px){.stm-root{padding:16px 14px 56px}.stm-hero{padding:18px}.stm-title{font-size:19px}.stm-grid-2,.stm-grid-2-even{grid-template-columns:1fr}}
`

    // -----------------------------------------------------------------------
    // 图标
    // -----------------------------------------------------------------------
    const ICON_PATHS = {
      storage: ['M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z', 'M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7', 'M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5'],
      chart: ['M4 19V5', 'M4 19h16', 'M8 15l3-4 3 2 4-6'],
      sessions: ['M4 5h16v11H9l-5 4V5Z', 'M8 9h8', 'M8 12h5'],
      attachment: ['M20 11l-8.5 8.5a4 4 0 0 1-5.7-5.7L15 4.6a3 3 0 0 1 4.2 4.2l-9.2 9.2a1.5 1.5 0 0 1-2.1-2.1l8.5-8.5'],
      cache: ['M12 3a9 9 0 1 0 9 9', 'M12 7a5 5 0 1 0 5 5', 'M17 3v4h-4'],
      layers: ['M12 3l9 5-9 5-9-5 9-5Z', 'M3 13l9 5 9-5', 'M3 17l9 5 9-5'],
      package: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
      runtime: ['M9 3h6l1 3h3v14H5V6h3l1-3Z', 'M9 11h6', 'M9 15h6'],
      plugin: ['M9 3v4a2 2 0 1 0 4 0V3', 'M3 9h4a2 2 0 1 0 0 4H3', 'M17 9h4v4h-4', 'M9 21v-4a2 2 0 1 1 4 0v4', 'M3 17v4h6v-4', 'M15 17v4h6v-4'],
      log: ['M6 3h9l4 4v14H6V3Z', 'M15 3v4h4', 'M9 11h6', 'M9 15h6'],
      trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
      shield: ['M12 3l8 3v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6l8-3Z', 'M9 12l2 2 4-4'],
      move: ['M12 3v18', 'M8 7l4-4 4 4', 'M8 17l4 4 4-4', 'M3 12h18', 'M7 8l-4 4 4 4', 'M17 8l4 4-4 4'],
      link: ['M10 13a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7L11 6.3', 'M14 11a4 4 0 0 0-5.7 0L6 13.3a4 4 0 0 0 5.7 5.7l1.3-1.3'],
      check: ['M4.5 12.5l5 5L20 6.5'],
      alert: ['M12 3l9 17H3L12 3Z', 'M12 9v5', 'M12 17.2v.1'],
      info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v5', 'M12 7.6v.1'],
      x: ['M6 6l12 12', 'M18 6L6 18'],
      search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'M16 16l4 4'],
      refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v5h-5'],
      copy: ['M9 9h11v11H9V9Z', 'M5 15H4V4h11v1'],
      download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 20h16'],
      folder: ['M3 6h6l2 2h10v11H3V6Z'],
      drive: ['M3 6h18v12H3V6Z', 'M7 15h.01', 'M11 15h2', 'M17 15h.01'],
      clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7v5l3 2'],
      play: ['M8 5l11 7-11 7V5Z'],
      stop: ['M6 6h12v12H6z'],
      arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
      sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z', 'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z'],
      database: ['M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z', 'M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5H4V5h5'],
      lock: ['M6 11h12v9H6v-9Z', 'M9 11V8a3 3 0 0 1 6 0v3'],
      home: ['M4 11l8-7 8 7', 'M6 10v10h12V10', 'M10 20v-6h4v6'],
    }

    function Icon(props) {
      const size = props.size ?? 17
      const paths = ICON_PATHS[props.name] ?? ICON_PATHS.info
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props.strokeWidth ?? 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none', ...(props.style ?? {}) },
        },
        ...paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    // -----------------------------------------------------------------------
    // 基础组件
    // -----------------------------------------------------------------------
    function Card(props) {
      return h('div', { className: `stm-card ${props.className ?? ''}`, style: props.style }, props.children)
    }

    function CardHead(props) {
      return h(
        'div',
        { className: 'stm-card-head' },
        props.icon ? h(Icon, { name: props.icon, size: 15, style: { color: props.color ?? T.text3 } }) : null,
        h('div', { className: 'stm-card-title' }, props.title),
        props.hint ? h('div', { className: 'stm-muted' }, props.hint) : null,
        h('div', { className: 'stm-flex1' }),
        props.extra,
      )
    }

    function Tag(props) {
      return h(
        'span',
        {
          className: `stm-tag ${props.outline ? 'outline' : ''}`,
          style: { '--tag-color': props.color ?? T.text3, ...(props.style ?? {}) },
          title: props.title,
        },
        props.children,
      )
    }

    function Btn(props) {
      const variant = props.variant ? ` ${props.variant}` : ''
      return h(
        'button',
        {
          type: 'button',
          className: `stm-btn${props.small ? ' sm' : ''}${variant}`,
          onClick: props.onClick,
          disabled: props.disabled,
          title: props.title,
          'aria-label': props['aria-label'],
          style: props.style,
        },
        props.loading ? h('span', { className: 'stm-spin' }) : null,
        props.children,
      )
    }

    function IconBtn(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'stm-iconbtn',
          onClick: props.onClick,
          title: props.title,
          'aria-label': props['aria-label'] ?? props.title,
          disabled: props.disabled,
          style: props.disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined,
        },
        h(Icon, { name: props.icon, size: props.size ?? 15 }),
      )
    }

    function Toggle(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'stm-toggle',
          role: 'switch',
          'aria-checked': Boolean(props.checked),
          onClick: () => props.onChange?.(!props.checked),
          disabled: props.disabled,
          title: props.title,
        },
        h('span', { className: 'stm-switch', 'aria-hidden': true }, h('span')),
        props.children,
      )
    }

    function Chip(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'stm-chip',
          'data-active': Boolean(props.active),
          onClick: props.onClick,
        },
        props.children,
      )
    }

    function StatTile(props) {
      return h(
        'div',
        { className: 'stm-kpi', style: { '--kpi-color': props.color ?? ACCENT } },
        h('div', { className: 'stm-kpi-label' }, props.icon ? h(Icon, { name: props.icon, size: 13 }) : null, props.label),
        h('div', { className: 'stm-kpi-value' }, props.value),
        h('div', { className: 'stm-kpi-hint' }, props.hint),
      )
    }

    function Progress(props) {
      const indeterminate = props.value == null
      return h(
        'div',
        { className: `stm-progress${indeterminate ? ' indeterminate' : ''}`, 'aria-hidden': true },
        h('span', { style: indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, props.value))}%` } }),
      )
    }

    function Empty(props) {
      return h(
        'div',
        { className: 'stm-empty' },
        h(Icon, { name: props.icon ?? 'storage', size: 30 }),
        h('div', null, props.title ?? ''),
        props.hint ? h('div', { style: { fontSize: 10.5 } }, props.hint) : null,
      )
    }

    function Toast(props) {
      return props.message ? h('div', { className: 'stm-toast', role: 'status' }, props.message) : null
    }

    function LaunchOverlay(props) {
      return h(
        'div',
        { className: 'stm-launch-mask', role: 'alertdialog', 'aria-live': 'polite', 'aria-label': props.title },
        h(
          'div',
          { className: 'stm-launch-card' },
          h('span', { className: 'stm-spin', style: { width: 22, height: 22, borderWidth: 3 } }),
          h(
            'div',
            null,
            h('div', { className: 'stm-launch-title' }, props.title),
            h('div', { className: 'stm-launch-hint' }, props.hint),
          ),
        ),
      )
    }

    function Modal(props) {
      const dialogRef = useRef(null)
      const latest = useRef(props)
      latest.current = props
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && !latest.current.busy) latest.current.onClose?.()
        }
        document.addEventListener('keydown', onKey)
        const timer = setTimeout(() => {
          if (dialogRef.current) {
            const focusable = dialogRef.current.querySelector('button, input, [tabindex]')
            if (focusable) focusable.focus()
          }
        }, 10)
        return () => {
          document.removeEventListener('keydown', onKey)
          clearTimeout(timer)
        }
      }, [])
      return h(
        'div',
        {
          className: 'stm-modal-mask',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !props.busy) props.onClose?.()
          },
        },
        h(
          'div',
          {
            ref: dialogRef,
            className: 'stm-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': props.title,
          },
          props.children,
        ),
      )
    }

    function Callout(props) {
      const color =
        props.level === 'danger' ? T.danger : props.level === 'warn' ? T.warn : props.level === 'success' ? T.success : ACCENT
      return h(
        'div',
        { className: 'stm-callout', style: { '--callout-color': color } },
        h(Icon, { name: props.level === 'danger' || props.level === 'warn' ? 'alert' : 'info', size: 15, style: { color } }),
        h('div', null, props.title ? h('b', null, `${props.title} `) : null, props.children),
      )
    }

    function CodeBlock(props) {
      return h('div', { className: 'stm-code' }, props.text)
    }

    function CheckRow(props) {
      const color = props.level === 'error' ? T.danger : props.level === 'warn' ? T.warn : T.success
      const icon = props.level === 'error' ? 'x' : props.level === 'warn' ? 'alert' : 'check'
      return h(
        'div',
        { className: 'stm-check' },
        h('span', { className: 'stm-check-icon', style: { color } }, h(Icon, { name: icon, size: 14 })),
        h('div', null, props.children),
      )
    }

    // -----------------------------------------------------------------------
    // 图表
    // -----------------------------------------------------------------------
    function Donut(props) {
      const size = props.size ?? 172
      const thickness = props.thickness ?? 17
      const radius = (size - thickness) / 2
      const center = size / 2
      const circumference = 2 * Math.PI * radius
      const total = props.items.reduce((sum, item) => sum + item.bytes, 0)
      let offset = 0
      const segments = props.items.map((item, index) => {
        const length = total > 0 ? (item.bytes / total) * circumference : 0
        const segment = {
          key: item.key ?? String(index),
          color: item.color,
          dasharray: `${length} ${Math.max(0, circumference - length)}`,
          dashoffset: -offset,
        }
        offset += length
        return segment
      })
      return h(
        'div',
        { className: 'stm-donut-wrap' },
        h(
          'div',
          { className: 'stm-donut', style: { width: size, height: size } },
          h(
            'svg',
            { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': human(total) },
            h('circle', { cx: center, cy: center, r: radius, fill: 'none', stroke: T.layer2, strokeWidth: thickness }),
            h(
              'g',
              { transform: `rotate(-90 ${center} ${center})` },
              ...segments.map((segment) =>
                h('circle', {
                  key: segment.key,
                  cx: center,
                  cy: center,
                  r: radius,
                  fill: 'none',
                  stroke: segment.color,
                  strokeWidth: thickness,
                  strokeDasharray: segment.dasharray,
                  strokeDashoffset: segment.dashoffset,
                  strokeLinecap: 'butt',
                }),
              ),
            ),
          ),
          h(
            'div',
            { className: 'stm-donut-center' },
            h('b', null, human(total)),
            h('span', null, props.label ?? ''),
          ),
        ),
        h(
          'div',
          { className: 'stm-legend' },
          ...props.items.map((item, index) =>
            h(
              'div',
              { key: item.key ?? String(index), className: 'stm-legend-row' },
              h('span', { className: 'stm-legend-dot', style: { background: item.color } }),
              h('span', { className: 'stm-legend-name', title: item.label }, item.label),
              h('span', { className: 'stm-legend-val' }, human(item.bytes)),
              h('span', { className: 'stm-legend-pct' }, total > 0 ? percent(item.bytes / total) : '0%'),
            ),
          ),
        ),
      )
    }

    function Bars(props) {
      const max = Math.max(1, ...props.items.map((item) => item.bytes))
      return h(
        'div',
        { className: 'stm-bars' },
        ...props.items.map((item, index) =>
          h(
            'div',
            { key: item.key ?? String(index), className: 'stm-bar-row' },
            h(
              'div',
              { className: 'stm-bar-top' },
              h('span', { className: 'stm-bar-name', title: item.title ?? item.label }, item.label),
              h('span', { className: 'stm-bar-val' }, human(item.bytes)),
            ),
            h(
              'div',
              { className: 'stm-track' },
              h('span', {
                style: { width: `${Math.max(1.5, (item.bytes / max) * 100)}%`, background: item.color ?? ACCENT },
              }),
            ),
          ),
        ),
      )
    }

    function StackedBar(props) {
      const total = props.items.reduce((sum, item) => sum + item.bytes, 0) || 1
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'stm-stack', role: 'img', 'aria-label': props.label ?? '' },
          ...props.items.map((item, index) =>
            h('span', {
              key: item.key ?? String(index),
              style: { width: `${(item.bytes / total) * 100}%`, background: item.color },
              title: `${item.label} · ${human(item.bytes)}`,
            }),
          ),
        ),
        h(
          'div',
          { className: 'stm-legend-grid' },
          ...props.items.map((item, index) =>
            h(
              'div',
              { key: item.key ?? String(index), className: 'stm-legend-row' },
              h('span', { className: 'stm-legend-dot', style: { background: item.color } }),
              h('span', { className: 'stm-legend-name', title: item.label }, item.label),
              h('span', { className: 'stm-legend-val' }, human(item.bytes)),
              h('span', { className: 'stm-legend-pct' }, percent(item.bytes / total)),
            ),
          ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 概览
    // -----------------------------------------------------------------------
    function OverviewView(props) {
      const { t, report } = props
      const totals = report.totals
      const categories = report.categories.filter((item) => item.bytes > 0).sort((a, b) => b.bytes - a.bytes)
      const head = categories.slice(0, 8)
      const rest = categories.slice(8)
      const donutItems = head.map((item, index) => ({
        key: item.key,
        label: t(`cat.${item.key}`),
        bytes: item.bytes,
        color: CHART_COLORS[index % CHART_COLORS.length],
      }))
      if (rest.length > 0) {
        donutItems.push({
          key: 'other',
          label: t('chart.other'),
          bytes: rest.reduce((sum, item) => sum + item.bytes, 0),
          color: CHART_COLORS[8],
        })
      }
      const topSessions = report.sessions
        .filter((row) => row.totalBytes > 0)
        .slice(0, 7)
        .map((row, index) => ({
          key: row.id,
          label: row.title || row.id,
          title: `${row.title || row.id}\n${row.id}`,
          bytes: row.totalBytes,
          color: CHART_COLORS[index % CHART_COLORS.length],
        }))
      const workspaces = report.workspaces ?? []
      const measured = Boolean(report.workspacesMeasured)
      return h(
        'div',
        { className: 'stm-view' },
        h(
          'div',
          { className: 'stm-kpis' },
          h(StatTile, {
            icon: 'storage',
            label: t('kpi.total'),
            value: human(totals.dshHomeBytes),
            hint: t('kpi.totalHint'),
          }),
          h(StatTile, {
            icon: 'shield',
            color: T.success,
            label: t('kpi.cleanable'),
            value: human(totals.cleanableBytes),
            hint: t('kpi.cleanableHint'),
          }),
          h(StatTile, {
            icon: 'sessions',
            color: '#8b5cf6',
            label: t('kpi.sessions'),
            value: String(totals.sessions ?? 0),
            hint: t('kpi.sessionsHint', { live: totals.liveSessions ?? 0 }),
          }),
          h(StatTile, {
            icon: 'attachment',
            color: '#f59e0b',
            label: t('kpi.attachments'),
            value: human(totals.attachmentsBytes),
            hint: t('kpi.attachmentsHint', { files: totals.attachmentsFiles ?? 0 }),
          }),
          h(StatTile, {
            icon: 'folder',
            color: '#06b6d4',
            label: t('kpi.workspace'),
            value: measured ? human(totals.workspaceBytes) : t('workspace.unmeasured'),
            hint: measured ? t('kpi.workspaceHint', { n: workspaces.length }) : t('workspace.measureHint'),
          }),
        ),
        h(
          'div',
          { className: 'stm-grid-2' },
          h(
            Card,
            null,
            h(CardHead, {
              icon: 'chart',
              title: t('chart.categories'),
              hint: t('chart.categoriesHint'),
              extra: h(Btn, { small: true, variant: 'ghost', onClick: props.onOpenDetail }, t('chart.detail')),
            }),
            h(Donut, { items: donutItems, label: t('chart.total') }),
          ),
          h(
            Card,
            null,
            h(CardHead, { icon: 'sessions', title: t('chart.topSessions'), hint: t('chart.topSessionsHint') }),
            topSessions.length > 0
              ? h(Bars, { items: topSessions })
              : h(Empty, { icon: 'sessions', title: t('empty.sessions') }),
          ),
        ),
        h(
          Card,
          null,
          h(CardHead, { icon: 'layers', title: t('chart.categories'), hint: t('chart.categoriesHint') }),
          h(StackedBar, { items: donutItems, label: t('chart.categories') }),
        ),
        h(
          Card,
          null,
          h(CardHead, {
            icon: 'folder',
            title: t('workspace.title'),
            hint: measured ? human(totals.workspaceBytes) : t('workspace.unmeasured'),
            extra:
              h(Btn, { small: true, onClick: props.onMeasureWorkspaces, disabled: props.measuring, loading: props.measuring },
                props.measuring ? t('workspace.measuring') : t('workspace.measure')),
          }),
          workspaces.length === 0
            ? h(Empty, { icon: 'folder', title: t('empty.tip') })
            : measured
              ? h(Bars, {
                  items: workspaces
                    .filter((workspace) => workspace.measured)
                    .map((workspace, index) => ({
                      key: workspace.id,
                      label: `${workspace.title} · ${workspace.path}`,
                      title: workspace.path,
                      bytes: workspace.bytes ?? 0,
                      color: CHART_COLORS[index % CHART_COLORS.length],
                    })),
                })
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' } },
                  h('div', { className: 'stm-muted', style: { lineHeight: 1.6 } }, t('workspace.measureHint')),
                  h(
                    'div',
                    { className: 'stm-chip-row' },
                    ...workspaces.map((workspace) =>
                      h(Tag, { key: workspace.id, color: T.text3 }, `${workspace.title} · ${t('workspace.sessions', { n: workspace.sessionCount })}`),
                    ),
                  ),
                ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 分类明细
    // -----------------------------------------------------------------------
    const CATEGORY_ICONS = {
      sessions: 'sessions',
      attachments: 'attachment',
      cache: 'cache',
      storages: 'database',
      plugins: 'plugin',
      profiles: 'package',
      runtime: 'runtime',
      pluginData: 'layers',
      logs: 'log',
      trash: 'trash',
    }

    function CategoryCard(props) {
      const { t, category } = props
      const [expanded, setExpanded] = useState(false)
      const cleanable = cleanableMeta(t, category.cleanable)
      const color = cleanable.color
      const items = category.items ?? []
      return h(
        'div',
        { className: 'stm-cat', style: { '--cat-color': color } },
        h(
          'div',
          { className: 'stm-cat-top' },
          h('div', { className: 'stm-cat-ico' }, h(Icon, { name: CATEGORY_ICONS[category.key] ?? 'layers', size: 17 })),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'stm-cat-name' }, t(`cat.${category.key}`), h(Tag, { color }, cleanable.label)),
            h('div', { className: 'stm-cat-size' }, human(category.bytes)),
          ),
          h(
            'div',
            { className: 'stm-cat-actions' },
            items.length > 0
              ? h(Btn, { small: true, variant: 'ghost', onClick: () => setExpanded((value) => !value) },
                  expanded ? t('detail.collapse') : t('detail.expand'))
              : null,
          ),
        ),
        h('div', { className: 'stm-mini-bar' }, h('span', { style: { width: `${Math.min(100, (category.percent ?? 0) * 100)}%`, background: color } })),
        h(
          'div',
          { className: 'stm-muted', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('span', null, t('detail.files', { n: category.files ?? 0 })),
          h('span', { style: { opacity: 0.6 } }, percent(category.percent ?? 0)),
        ),
        h('div', { className: 'stm-cat-hint' }, t(`catHint.${category.key}`)),
        expanded
          ? h(
              'div',
              { className: 'stm-items stm-fade-in' },
              items.slice(0, 16).map((item, index) =>
                h(
                  'div',
                  { key: `${item.name}-${index}`, className: 'stm-item' },
                  h('span', { className: 'stm-item-name', title: item.path }, item.name),
                  h('span', { className: 'stm-item-val' }, human(item.bytes)),
                  item.note ? h('span', { className: 'stm-item-note', title: item.note }, item.note) : null,
                ),
              ),
            )
          : null,
      )
    }

    function DetailView(props) {
      const { t, report } = props
      return h(
        'div',
        { className: 'stm-view' },
        h(
          'div',
          { className: 'stm-chip-row', style: { justifyContent: 'space-between' } },
          h(
            'div',
            { className: 'stm-chip-row' },
            h(Tag, { color: T.text3 }, report.dshHome),
            h(Tag, { color: T.text3 }, report.profileDir ?? '—'),
          ),
          h('span', { className: 'stm-muted' }, human(report.totals.dshHomeBytes)),
        ),
        h(
          'div',
          { className: 'stm-cat-grid' },
          ...report.categories.map((category) => h(CategoryCard, { key: category.key, t, category })),
        ),
        h(
          Card,
          null,
          h(CardHead, { icon: 'folder', title: t('workspace.title'), hint: t('workspace.hint') }),
          (report.workspaces ?? []).length === 0
            ? h(Empty, { icon: 'folder', title: t('empty.tip') })
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                ...report.workspaces.map((workspace) =>
                  h(
                    'div',
                    {
                      key: workspace.id,
                      style: {
                        border: `1px solid ${T.border}`,
                        borderRadius: 12,
                        padding: '10px 12px',
                        background: T.bg,
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                      h('span', { style: { fontSize: 12, fontWeight: 600 } }, workspace.title),
                      h('span', { className: 'stm-muted', style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 10, flex: 1, minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: workspace.path }, workspace.path),
                      workspace.status === 'missing-dir' ? h(Tag, { color: T.danger }, t('workspace.missing')) : null,
                      workspace.truncated ? h(Tag, { color: T.warn }, t('workspace.truncated')) : null,
                      h('span', { style: { fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } },
                        workspace.measured ? human(workspace.bytes ?? 0) : t('workspace.unmeasured')),
                      h('span', { className: 'stm-muted' }, t('workspace.sessions', { n: workspace.sessionCount })),
                    ),
                    workspace.children?.length > 0
                      ? h(
                          'div',
                          { className: 'stm-chip-row', style: { marginTop: 7 } },
                          ...workspace.children.map((child) =>
                            h(Tag, { key: child.name, color: child.cleanable ? T.warn : T.text3, title: child.cleanable ? t('workspace.cleanable') : undefined },
                              `${child.name} · ${human(child.bytes)}`),
                          ),
                        )
                      : null,
                  ),
                ),
              ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 会话管理
    // -----------------------------------------------------------------------
    function sessionsStateBadges(t, row) {
      const badges = []
      if (row.live) badges.push(h(Tag, { key: 'live', color: T.success }, t('sessions.badge.live')))
      if (row.pinned) badges.push(h(Tag, { key: 'pinned', color: ACCENT }, t('sessions.badge.pinned')))
      if (row.archived) badges.push(h(Tag, { key: 'archived', color: T.text3 }, t('sessions.badge.archived')))
      if (row.blank) badges.push(h(Tag, { key: 'blank', color: T.text3 }, t('sessions.badge.blank')))
      if (row.isSubagent) badges.push(h(Tag, { key: 'sub', color: T.warn }, t('sessions.badge.subagent')))
      if (row.childCount > 0) badges.push(h(Tag, { key: 'children', color: T.warn }, t('sessions.badge.children')))
      return badges.length > 0 ? badges : [h('span', { key: 'none', className: 'stm-muted' }, '—')]
    }

    function SessionsView(props) {
      const { t, report, deep } = props
      const rows = props.filteredSessions
      const selected = props.selected
      const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id))
      return h(
        'div',
        { className: 'stm-view' },
        h(
          'div',
          { className: 'stm-table-card' },
          h(
            'div',
            { className: 'stm-toolbar' },
            h(
              'div',
              { style: { position: 'relative', flex: '1 1 210px', minWidth: 180 } },
              h('span', { style: { position: 'absolute', left: 9, top: 8, color: T.text3, pointerEvents: 'none' } }, h(Icon, { name: 'search', size: 14 })),
              h('input', {
                className: 'stm-input',
                style: { width: '100%', paddingLeft: 29 },
                value: props.query,
                onChange: (event) => props.setQuery(event.target.value),
                placeholder: t('sessions.search'),
                'aria-label': t('sessions.search'),
              }),
            ),
            ...['all', 'blank', 'stale', 'archived', 'pinned', 'live'].map((key) =>
              h(Chip, { key, active: props.filter === key, onClick: () => props.setFilter(key) }, t(`sessions.filter.${key}`)),
            ),
            h('div', { className: 'stm-flex1' }),
            h(Btn, {
              small: true,
              onClick: props.onToggleDeep,
              disabled: props.deepScanning,
              loading: props.deepScanning,
              title: t('action.deepHint'),
            }, deep ? t('action.deepDone') : t('action.deep')),
          ),
          selected.size > 0
            ? h(
                'div',
                { className: 'stm-toolbar', style: { background: `color-mix(in srgb, ${ACCENT} 6%, transparent)` } },
                h(Tag, { color: ACCENT }, t('sessions.selected', { n: selected.size })),
                h('div', { className: 'stm-flex1' }),
                h(Btn, { small: true, onClick: props.onClearSelection }, t('sessions.clearSelect')),
                h(Btn, { small: true, variant: 'danger', onClick: () => props.onDeleteSelected() }, t('sessions.bulkDelete')),
              )
            : null,
          h(
            'div',
            { className: 'stm-table-scroll' },
            h(
              'div',
              { className: 'stm-thead' },
              h('input', {
                type: 'checkbox',
                checked: allSelected,
                'aria-label': t('sessions.filter.all'),
                onChange: () => props.onToggleAll(rows),
              }),
              t('sessions.col.title'),
              t('sessions.col.workspace'),
              t('sessions.col.last'),
              t('sessions.col.size'),
              t('sessions.col.state'),
              t('sessions.col.actions'),
            ),
            rows.length === 0
              ? h(Empty, { icon: 'sessions', title: t('sessions.empty') })
              : rows.map((row) =>
                  h(
                    'div',
                    { key: row.id, className: 'stm-row' },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.has(row.id),
                      disabled: row.live,
                      'aria-label': row.title,
                      onChange: () => props.onToggleRow(row),
                    }),
                    h(
                      'div',
                      { className: 'stm-cell-main' },
                      h('div', { className: 'stm-cell-title', title: row.title }, row.title || row.id),
                      h('div', { className: 'stm-cell-id', title: row.id }, row.id),
                    ),
                    h('div', { className: 'stm-cell-sub', title: row.workspacePath ?? row.cwd ?? '' },
                      row.workspaceTitle ?? (row.cwd ? row.cwd : '—')),
                    h('div', { className: 'stm-cell-sub' }, row.ageDays <= 0 ? t('sessions.day') : t('sessions.daysAgo', { n: row.ageDays })),
                    h(
                      'div',
                      null,
                      h('div', { style: { fontVariantNumeric: 'tabular-nums' } }, human(row.totalBytes)),
                      h('div', { className: 'stm-cell-sub' },
                        deep && (row.attachmentBytes > 0 || row.attachmentCount > 0)
                          ? `${t('sessions.attachment', { size: human(row.attachmentBytes) })}${row.sharedAttachmentCount > 0 ? ` · ${row.sharedAttachmentCount} shared` : ''}`
                          : t('sessions.log', { size: human(row.logBytes) })),
                    ),
                    h('div', { className: 'stm-badges' }, ...sessionsStateBadges(t, row)),
                    h(
                      'div',
                      null,
                      h(Btn, {
                        small: true,
                        variant: 'danger',
                        disabled: row.live,
                        title: row.live ? t('sessions.liveHint') : undefined,
                        onClick: () => props.onDelete([row]),
                      }, t('sessions.delete')),
                    ),
                  ),
                ),
          ),
        ),
        h(
          'div',
          { className: 'stm-muted', style: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' } },
          h('span', null, t('sessions.total', { n: rows.length })),
          h('span', null, deep ? t('action.deepDone') : t('sessions.deepHint')),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 清理建议
    // -----------------------------------------------------------------------
    function AdviceView(props) {
      const { t, report, deep } = props
      const groups = [
        ['safe', t('advice.safe'), T.success],
        ['caution', t('advice.caution'), T.warn],
        ['danger', t('advice.danger'), T.danger],
      ]
      const renderAction = (item) => {
        if (item.action === 'purge-trash') return h(Btn, { small: true, variant: 'primary', onClick: () => props.onPurgeTrash() }, t('advice.action'))
        if (item.action === 'clear-cache') return h(Btn, { small: true, variant: 'primary', onClick: () => props.onClean('cache') }, t('advice.action'))
        if (item.action === 'clean-projcache') return h(Btn, { small: true, variant: 'primary', onClick: () => props.onClean('projcache') }, t('advice.action'))
        if (item.action === 'clean-orphans') {
          return h(Btn, {
            small: true,
            variant: 'primary',
            loading: props.deepScanning,
            disabled: props.deepScanning,
            onClick: async () => {
              if (!deep) await props.onToggleDeep()
              await props.onClean('orphans')
            },
          }, deep ? t('advice.action') : t('action.deep'))
        }
        if (item.action === 'review-blank-sessions') return h(Btn, { small: true, onClick: () => props.onReview('blank') }, t('advice.review'))
        if (item.action === 'review-stale-sessions') return h(Btn, { small: true, onClick: () => props.onReview('stale') }, t('advice.review'))
        if (item.action === 'review-archived-sessions') return h(Btn, { small: true, onClick: () => props.onReview('archived') }, t('advice.review'))
        return null
      }
      return h(
        'div',
        { className: 'stm-view' },
        h(Callout, { level: 'info', title: t('advice.safe') },
          deep ? t('action.deepDone') : `${t('sessions.deepHint')} ${t('action.deepHint')}`),
        ...groups.map(([severity, label, color]) => {
          const items = report.advice.filter((item) => item.severity === severity)
          if (items.length === 0) return null
          return h(
            'div',
            { key: severity, style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h(
              'div',
              { className: 'stm-chip-row', style: { padding: '2px 2px 0' } },
              h(Tag, { color }, label),
              h('span', { className: 'stm-muted' }, `${items.length}`),
            ),
            h(
              'div',
              { className: 'stm-advice-grid' },
              ...items.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'stm-advice', style: { '--advice-color': severityColor(item.severity) } },
                  h(
                    'div',
                    { className: 'stm-advice-head' },
                    h(Icon, { name: severity === 'danger' ? 'lock' : severity === 'safe' ? 'shield' : 'alert', size: 15, style: { color: severityColor(item.severity) } }),
                    h('div', { className: 'stm-advice-title' }, t(item.titleKey)),
                    item.bytes > 0 ? h('div', { className: 'stm-advice-size' }, t('advice.reclaim', { size: human(item.bytes) })) : null,
                    item.count > 0 ? h('span', { className: 'stm-muted' }, t('advice.items', { n: item.count })) : null,
                  ),
                  h('div', { className: 'stm-advice-detail' }, t(item.detailKey, { n: item.count })),
                  h('div', { className: 'stm-advice-actions' }, renderAction(item)),
                ),
              ),
            ),
          )
        }),
      )
    }

    // -----------------------------------------------------------------------
    // 回收站
    // -----------------------------------------------------------------------
    function TrashView(props) {
      const { t, report } = props
      const entries = report.trash ?? []
      return h(
        'div',
        { className: 'stm-view' },
        h(
          'div',
          { className: 'stm-card' },
          h(CardHead, {
            icon: 'trash',
            title: t('tab.trash'),
            hint: t('trash.hint'),
            extra: entries.length > 0
              ? h(Btn, { small: true, variant: 'danger', onClick: () => props.onPurgeAll() }, t('trash.purgeAll'))
              : null,
          }),
          entries.length === 0
            ? h(Empty, { icon: 'trash', title: t('trash.empty') })
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                ...entries.map((entry) =>
                  h(
                    'div',
                    {
                      key: entry.name,
                      style: { border: `1px solid ${T.border}`, borderRadius: 12, padding: '10px 12px', background: T.bg, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
                    },
                    h('div', { style: { flex: 1, minWidth: 180 } },
                      h('div', { style: { fontSize: 12, fontWeight: 600 } }, entry.title || entry.sessionId),
                      h('div', { className: 'stm-cell-id' }, `${entry.sessionId} · ${t('trash.deletedAt', { time: formatTime(entry.deletedAt) })}`),
                    ),
                    h('span', { style: { fontSize: 12, fontVariantNumeric: 'tabular-nums' } }, human(entry.bytes)),
                    entry.restorable
                      ? h(Btn, { small: true, onClick: () => props.onRestore([entry.name]) }, t('trash.restore'))
                      : null,
                    h(Btn, { small: true, variant: 'danger', onClick: () => props.onPurge([entry.name]) }, t('trash.purge')),
                  ),
                ),
              ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 迁移向导
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // 迁移向导（v3：子标签 + 分步流程）
    // -----------------------------------------------------------------------
    function MigrationView(props) {
      const { t, status, validation, job, scripts, rollbackScripts, launched } = props
      const [mode, setMode] = useState('smart')
      const [modeTouched, setModeTouched] = useState(false)
      useEffect(() => {
        if (!modeTouched && status?.sources?.some((item) => item.isJunction)) setMode('status')
      }, [status, modeTouched])
      const sources = status?.sources ?? []
      const drives = status?.drives ?? []
      const supported = Boolean(status?.supported && status.platform === 'win32')
      const busy = job?.state === 'running'
      const source = sources.find((item) => item.key === props.sourceKey)
      const mapped = Boolean(source?.isJunction)
      const anyMapped = sources.some((item) => item.isJunction)
      const verification = status?.verification
      const canValidate = supported && !mapped && !busy && props.target.trim().length > 0
      const canSmart = supported && validation?.ok === true && !mapped && !props.launching

      const stepHead = (number, title, sub, done) =>
        h(
          'div',
          { className: 'stm-flow-head' },
          h('div', { className: 'stm-flow-num', 'data-done': Boolean(done) }, done ? h(Icon, { name: 'check', size: 13 }) : number),
          h(
            'div',
            { className: 'stm-flex1' },
            h('div', { className: 'stm-flow-title' }, title),
            h('div', { className: 'stm-flow-sub' }, sub),
          ),
          done ? h(Tag, { color: T.success }, t('mig.flow.stepDone')) : null,
        )

      const sourceCard = h(
        Card,
        null,
        stepHead(1, t('mig.flow.source'), t('mig.sourceHint'), false),
        h(
          'div',
          { className: 'stm-flow-body' },
          h(
            'div',
            { className: 'stm-sources' },
            ...sources.map((item) =>
              h(
                'button',
                {
                  key: item.key,
                  type: 'button',
                  className: 'stm-source',
                  'data-selected': props.sourceKey === item.key,
                  onClick: () => props.onSelectSource(item.key),
                  disabled: busy,
                },
                h(
                  'div',
                  { className: 'stm-source-head' },
                  h(Icon, { name: item.key === 'dshHome' ? 'home' : 'package', size: 15, style: { color: ACCENT } }),
                  item.title,
                  item.recommended ? h(Tag, { color: ACCENT }, t('mig.recommended')) : null,
                  item.isJunction ? h(Tag, { color: T.success }, t('mig.mapped')) : null,
                ),
                h('div', { className: 'stm-source-path' }, item.path),
                h(
                  'div',
                  { className: 'stm-source-meta' },
                  h('span', null, t('mig.sourceSize', { size: human(item.bytes), files: item.files ?? 0 })),
                  item.insideDshHome && item.key !== 'dshHome' ? h('span', null, 'profile') : null,
                ),
              ),
            ),
          ),
        ),
      )

      const targetCard = h(
        Card,
        null,
        stepHead(2, t('mig.flow.target'), t('mig.targetHint'), validation?.ok === true),
        mapped
          ? h(
              'div',
              { className: 'stm-flow-body', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              h(Callout, { level: 'success', title: t('mig.mapped') }, t('mig.mappedTo', { target: source.junctionTarget })),
              h('div', null, h(Btn, { small: true, onClick: () => setMode('status') }, t('mig.flow.statusLink'))),
            )
          : h(
              'div',
              { className: 'stm-flow-body', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('input', {
                  className: 'stm-input',
                  style: { flex: '1 1 340px' },
                  value: props.target,
                  onChange: (event) => props.onTarget(event.target.value),
                  placeholder: t('mig.targetPlaceholder'),
                  'aria-label': t('mig.target'),
                  disabled: busy,
                }),
                h(Btn, { onClick: props.onSuggestTarget }, t('mig.suggest')),
              ),
              h(
                'div',
                { className: 'stm-chip-row' },
                ...drives.map((drive) =>
                  h(Chip, { key: drive.root, onClick: () => props.onPickDrive(drive.root) }, `${drive.root} · ${t('mig.free', { size: drive.freeHuman })}`),
                ),
              ),
              h(
                'div',
                { className: 'stm-chip-row' },
                h(Toggle, { checked: props.excludeCache, onChange: props.onExcludeCache, disabled: busy }, t('mig.excludeCache')),
                h('span', { className: 'stm-field-hint' }, t('mig.excludeCacheHint')),
              ),
              h(
                'div',
                { className: 'stm-chip-row' },
                h(Btn, { variant: 'primary', onClick: props.onValidate, disabled: !canValidate, loading: props.validating },
                  props.validating ? t('mig.validating') : t('mig.validate')),
                validation ? h(Tag, { color: validation.ok ? T.success : T.danger }, validation.ok ? 'OK' : 'ERROR') : null,
                !validation && !mapped ? h('span', { className: 'stm-field-hint' }, t('mig.flow.needValidate')) : null,
              ),
              validation
                ? h(
                    'div',
                    { className: 'stm-grid-2', style: { marginTop: 4 } },
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                      h('div', { className: 'stm-field-label' }, t('mig.checks')),
                      ...validation.checks.map((item, index) => h(CheckRow, { key: `${item.id}-${index}`, level: item.level }, item.message)),
                    ),
                    validation.estimate
                      ? h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                          h('div', { className: 'stm-field-label' }, t('mig.estimate')),
                          ...[
                            [t('mig.copyBytes'), human(validation.estimate.copyBytes)],
                            [t('mig.files'), `${validation.estimate.files ?? 0}`],
                            [t('mig.required'), validation.estimate.requiredHuman],
                            [t('mig.scriptDir'), validation.estimate.scriptDir],
                          ].map(([label, value]) =>
                            h('div', { key: label, className: 'stm-legend-row' },
                              h('span', { className: 'stm-legend-name' }, label),
                              h('span', { className: 'stm-legend-val' }, value)),
                          ),
                        )
                      : null,
                  )
                : null,
            ),
      )

      const smartCard = h(
        Card,
        null,
        stepHead(3, t('mig.flow.start'), t('mig.flow.smartSub'), Boolean(props.launched)),
        h(
          'div',
          { className: 'stm-flow-body', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h(Callout, { level: 'warn', title: t('mig.smart.warning') }, ''),
          h(
            'div',
            { className: 'stm-chip-row' },
            h(Toggle, { checked: props.smartAutoRestart, onChange: props.onSmartAutoRestart, disabled: props.launching }, t('mig.smart.restart')),
            h(Toggle, { checked: props.smartKeepBackup, onChange: props.onSmartKeepBackup, disabled: props.launching }, t('mig.smart.keepBackup')),
            h('div', { className: 'stm-flex1' }),
            h(
              Btn,
              { variant: 'primary', onClick: props.onLaunchSmart, disabled: !canSmart, loading: props.launching },
              props.launching ? t('mig.smart.launching') : t('mig.smart.launch'),
            ),
          ),
          props.launched
            ? h(Tag, { color: T.success }, t('mig.smart.launched', { path: props.launched.runnerPath }))
            : !validation?.ok
              ? h('div', { className: 'stm-field-hint' }, t('mig.flow.needValidate'))
              : h('div', { className: 'stm-field-hint' }, t('mig.flow.docHint')),
        ),
      )

      const preCopyCard = h(
        Card,
        null,
        stepHead(3, t('mig.flow.manualPre'), t('mig.flow.runManual'), job?.state === 'done'),
        h(
          'div',
          { className: 'stm-flow-body', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          job
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h(
                  'div',
                  { className: 'stm-chip-row' },
                  h(Tag, { color: job.state === 'failed' ? T.danger : job.state === 'done' ? T.success : ACCENT },
                    job.state === 'running' ? t('mig.copying') : job.state === 'done' ? t('mig.copyDone') : job.state === 'cancelled' ? t('mig.cancelled') : t('mig.copyFailed')),
                  h('span', { className: 'stm-muted' }, t('mig.elapsed', { time: formatDuration(job.elapsedMs) })),
                ),
                job.state === 'running' ? h(Progress, { value: null }) : h(Progress, { value: job.state === 'done' ? 100 : 0 }),
                job.state === 'running'
                  ? h(Btn, { onClick: props.onCancelCopy }, t('mig.cancel'))
                  : h(Btn, { onClick: props.onStartCopy, disabled: !(validation?.ok === true) || busy, variant: 'primary' }, t('mig.startCopy')),
                h('div', { className: 'stm-field-hint' }, `${human(job.copiedBytes)} / ${human(job.totalBytes)}${job.error ? ` · ${job.error}` : ''}`),
              )
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h('div', { className: 'stm-field-hint' }, t('mig.flow.runManual')),
                h(Btn, { variant: 'primary', onClick: props.onStartCopy, disabled: !(validation?.ok === true) || busy }, t('mig.startCopy')),
                !validation?.ok ? h('div', { className: 'stm-field-hint' }, t('mig.flow.needValidate')) : null,
              ),
        ),
      )

      const scriptCard = h(
        Card,
        null,
        stepHead(4, t('mig.flow.manualScript'), t('mig.closeDsh'), Boolean(scripts)),
        h(
          'div',
          { className: 'stm-flow-body', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h(
            'div',
            { className: 'stm-steps' },
            ...[
              [t('mig.step3'), validation?.ok === true],
              [t('mig.generateScript'), Boolean(scripts)],
              [t('mig.step5'), false],
            ].map(([title, done], index) =>
              h(
                'div',
                { key: title, className: 'stm-step', 'data-done': done, 'data-active': done === false && (index === 0 ? validation?.ok === true : Boolean(scripts)) },
                h('div', { className: 'stm-step-dot' }, done ? h(Icon, { name: 'check', size: 12 }) : index + 1),
                h('div', { className: 'stm-step-body' }, h('div', { className: 'stm-step-title' }, title)),
              ),
            ),
          ),
          h(Btn, { onClick: props.onGenerateScript, disabled: !(validation?.ok === true), loading: props.generating },
            props.generating ? t('mig.generating') : t('mig.generateScript')),
          scripts
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h(CodeBlock, { text: scripts.command }),
                h(
                  'div',
                  { className: 'stm-chip-row' },
                  h(Btn, { small: true, onClick: () => props.onCopyCommand(scripts.command) }, props.copied ? t('action.copied') : t('mig.copyCommand')),
                  h('span', { className: 'stm-field-hint' }, t('mig.scriptSaved', { path: scripts.scriptDir })),
                ),
                h('div', { className: 'stm-field-hint' }, t('mig.keepBackup')),
              )
            : null,
        ),
      )

      const statusCard = h(
        Card,
        null,
        h(CardHead, { icon: 'link', title: t('mig.flow.status'), hint: t('mig.flow.statusSub') }),
        !anyMapped && !verification?.verified
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '18px 0' } },
              h(Empty, { icon: 'link', title: t('mig.flow.emptyStatus'), hint: t('mig.flow.emptyStatusHint') }),
              h(Btn, { variant: 'primary', onClick: () => setMode('smart') }, t('mig.flow.goSmart')),
            )
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              ...sources.map((item) =>
                h(
                  'div',
                  { key: item.key, style: { border: `1px solid ${T.border}`, borderRadius: 12, padding: '10px 12px', background: T.bg, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                  h('div', { style: { flex: 1, minWidth: 200 } },
                    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                      h('span', { style: { fontSize: 12, fontWeight: 600 } }, item.title),
                      item.isJunction
                        ? h(Tag, { color: T.success }, t('mig.mapped'))
                        : item.coveredBy === 'dshHome'
                          ? h(Tag, { color: T.success }, t('mig.coveredByHome'))
                          : h(Tag, { color: T.text3 }, t('mig.unmapped')),
                    ),
                    h('div', { className: 'stm-cell-id' }, item.path),
                    item.isJunction
                      ? h('div', { className: 'stm-cell-sub' }, t('mig.mappedTo', { target: item.junctionTarget }))
                      : item.coveredBy === 'dshHome'
                        ? h('div', { className: 'stm-cell-sub' }, t('mig.coveredByHint'))
                        : null,
                  ),
                  h('span', { style: { fontSize: 11.5, fontVariantNumeric: 'tabular-nums' } }, human(item.bytes)),
                  item.isJunction
                    ? h(
                        'div',
                        { className: 'stm-chip-row' },
                        h(
                          Btn,
                          {
                            small: true,
                            variant: 'primary',
                            onClick: () => props.onLaunchRollback(item.key),
                            loading: props.launchingRollback,
                          },
                          t('mig.rollbackAuto'),
                        ),
                        h(
                          Btn,
                          {
                            small: true,
                            variant: 'danger',
                            onClick: () => props.onGenerateRollback(item.key),
                            loading: props.generating,
                          },
                          t('mig.rollback'),
                        ),
                      )
                    : null,
                ),
              ),
              h('div', { className: 'stm-field-hint', style: { marginTop: 4 } }, t('mig.rollbackAutoHint')),
              verification?.verified
                ? h(
                    'div',
                    { style: { marginTop: 6, borderTop: `1px dashed ${T.border}`, paddingTop: 10 } },
                    h('div', { className: 'stm-field-label', style: { marginBottom: 4 } },
                      t('mig.verify.title'),
                      h(Tag, { color: verification.results.every((result) => result.ok) ? T.success : T.danger },
                        verification.results.every((result) => result.ok) ? t('mig.verify.ok') : t('mig.verify.fail'))),
                    ...verification.results.map((result) =>
                      h('div', { key: result.sourceKey, style: { marginTop: 6 } },
                        h('div', { className: 'stm-cell-sub' }, `${result.source} → ${result.target}`),
                        ...result.checks.map((check, index) => h(CheckRow, { key: `${result.sourceKey}-${index}`, level: check.level }, check.message)),
                      ),
                    ),
                  )
                : null,
              rollbackScripts
                ? h(
                    'div',
                    { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 } },
                    h('div', { className: 'stm-field-label' }, t('mig.rollback')),
                    h(CodeBlock, { text: rollbackScripts.command }),
                    h(
                      'div',
                      { className: 'stm-chip-row' },
                      h(Btn, { small: true, onClick: () => props.onCopyCommand(rollbackScripts.command) }, props.copied ? t('action.copied') : t('mig.copyCommand')),
                      h('span', { className: 'stm-field-hint' }, t('mig.scriptSaved', { path: rollbackScripts.scriptDir })),
                    ),
                    h('div', { className: 'stm-field-hint' }, t('mig.rollbackHint')),
                  )
                : null,
            ),
      )

      const modes = [
        ['smart', t('mig.flow.smart'), null],
        ['manual', t('mig.flow.manual'), null],
        ['status', t('mig.flow.status'), anyMapped ? String(sources.filter((item) => item.isJunction).length) : null],
      ]

      return h(
        'div',
        { className: 'stm-view' },
        h(
          Card,
          { style: { padding: '14px 16px' } },
          h(
            'div',
            { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
            h('div', { className: 'stm-cat-ico', style: { '--cat-color': ACCENT } }, h(Icon, { name: 'move', size: 18 })),
            h(
              'div',
              { className: 'stm-flex1' },
              h('div', { style: { fontSize: 14, fontWeight: 650 } }, t('mig.title')),
              h('div', { className: 'stm-flow-sub' }, t('mig.subtitle')),
            ),
            h(Btn, { small: true, onClick: props.onRefresh, loading: props.loading }, t('mig.refresh')),
          ),
          h(
            'div',
            { className: 'stm-nav', style: { marginTop: 12 } },
            ...modes.map(([key, label, count]) =>
              h(
                'button',
                { key, type: 'button', 'aria-current': mode === key ? 'page' : undefined, onClick: () => { setModeTouched(true); setMode(key) } },
                label,
                count != null ? h('span', { className: 'count' }, count) : null,
              ),
            ),
          ),
        ),
        !supported ? h(Callout, { level: 'danger', title: t('mig.onlyWindows') }, '') : null,
        !status
          ? h(Empty, { icon: 'move', title: t('common.loading') })
          : mode === 'smart'
            ? h('div', { className: 'stm-flow' }, sourceCard, targetCard, smartCard)
            : mode === 'manual'
              ? h('div', { className: 'stm-flow' }, sourceCard, targetCard, preCopyCard, scriptCard)
              : statusCard,
      )
    }

    // -----------------------------------------------------------------------
    // 删除会话弹窗
    // -----------------------------------------------------------------------
    function DeleteModal(props) {
      const { t, modal, onClose, onConfirm } = props
      if (!modal) return null
      if (modal.kind === 'result') {
        const result = modal.result ?? {}
        const failed = (result.results ?? []).filter((item) => (item.errors ?? []).length > 0)
        return h(
          Modal,
          { title: t('modal.resultTitle'), onClose },
          h('div', { className: 'stm-modal-title' }, t('modal.resultTitle')),
          h('div', { className: 'stm-modal-sub' },
            t('modal.result', {
              ok: result.totals?.deleted ?? 0,
              size: human(result.totals?.bytes ?? 0),
              shared: result.totals?.sharedAttachments ?? 0,
            })),
          (result.refused ?? []).length > 0
            ? h(Callout, { level: 'warn', title: t('modal.refused', { n: result.refused.length, reason: '' }) },
                result.refused.map((item) => item.reason).join('；'))
            : null,
          failed.length > 0 ? h(Callout, { level: 'danger', title: t('mig.error') }, failed.map((item) => `${item.id}: ${item.errors.join('；')}`).join('\n')) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 16 } },
            h(Btn, { variant: 'primary', onClick: onClose }, t('modal.close'))),
        )
      }
      const rows = modal.rows ?? []
      const busy = Boolean(modal.busy)
      const mode = modal.mode ?? 'trash'
      const armed = Boolean(modal.armed)
      const deleteAttachments = modal.deleteAttachments !== false
      const totalBytes = rows.reduce((sum, row) => sum + (row.totalBytes ?? 0), 0)
      const set = (patch) => props.setModal((current) => ({ ...current, ...patch }))
      const submit = () => {
        if (busy) return
        if (mode === 'purge' && !armed) {
          set({ armed: true })
          return
        }
        onConfirm(mode, deleteAttachments)
      }
      return h(
        Modal,
        { title: t('modal.title'), onClose, busy },
        h('div', { className: 'stm-modal-title' }, t('modal.title')),
        h('div', { className: 'stm-modal-sub' }, t('modal.warning')),
        h(
          'div',
          { className: 'stm-modal-list' },
          ...rows.map((row) =>
            h('div', { key: row.id, className: 'stm-modal-row' },
              h('span', { className: 'stm-item-name', title: row.title }, row.title || row.id),
              h('span', { className: 'stm-cell-id' }, row.id),
              h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, human(row.totalBytes)),
            ),
          ),
        ),
        h('div', { className: 'stm-muted', style: { marginBottom: 8 } }, `合计 ${human(totalBytes)}`),
        h('label', { className: 'stm-radio' },
          h('input', { type: 'radio', name: 'stm-delete-mode', checked: mode === 'trash', disabled: busy, onChange: () => set({ mode: 'trash', armed: false }) }),
          t('modal.mode.trash')),
        h('label', { className: 'stm-radio', style: { color: mode === 'purge' ? T.danger : undefined } },
          h('input', { type: 'radio', name: 'stm-delete-mode', checked: mode === 'purge', disabled: busy, onChange: () => set({ mode: 'purge', armed: false }) }),
          t('modal.mode.purge')),
        mode === 'purge'
          ? h('label', { className: 'stm-radio', style: { color: T.danger } },
              h('input', { type: 'checkbox', checked: armed, disabled: busy, onChange: (event) => set({ armed: event.target.checked }) }),
              t('modal.irreversible'))
          : null,
        h('label', { className: 'stm-radio', style: { alignItems: 'flex-start' } },
          h('input', { type: 'checkbox', checked: deleteAttachments, disabled: busy, onChange: (event) => set({ deleteAttachments: event.target.checked }) }),
          h('span', null,
            t('modal.attachments'),
            h('span', { className: 'stm-field-hint', style: { display: 'block' } }, t('modal.attachmentsHint')))),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
          h(Btn, { onClick: onClose, disabled: busy }, t('modal.cancel')),
          h(Btn, {
            variant: mode === 'purge' ? 'solid-danger' : 'primary',
            disabled: busy || (mode === 'purge' && !armed),
            onClick: submit,
          }, busy ? t('modal.deleting') : mode === 'purge' ? (armed ? t('modal.confirmPurgeArm') : t('modal.confirmPurge')) : t('modal.confirmTrash'))),
      )
    }

    // -----------------------------------------------------------------------
    // 页面
    // -----------------------------------------------------------------------
    function Page(props) {
      const t = props.t
      const [report, setReport] = useState(null)
      const [loading, setLoading] = useState(true)
      const [deepScanning, setDeepScanning] = useState(false)
      const [error, setError] = useState(null)
      const [tab, setTab] = useState('overview')
      const [filter, setFilter] = useState('all')
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState(() => new Set())
      const [modal, setModal] = useState(null)
      const [toast, setToast] = useState(null)
      const [deep, setDeep] = useState(false)
      const [measuringWorkspaces, setMeasuringWorkspaces] = useState(false)

      const [migration, setMigration] = useState(null)
      const [migrationLoading, setMigrationLoading] = useState(false)
      const [sourceKey, setSourceKey] = useState('dshHome')
      const [target, setTarget] = useState('')
      const [excludeCache, setExcludeCache] = useState(true)
      const [validation, setValidation] = useState(null)
      const [validating, setValidating] = useState(false)
      const [job, setJob] = useState(null)
      const [scripts, setScripts] = useState(null)
      const [rollbackScripts, setRollbackScripts] = useState(null)
      const [generating, setGenerating] = useState(false)
      const [copied, setCopied] = useState(false)
      const [smartAutoRestart, setSmartAutoRestart] = useState(true)
      const [smartKeepBackup, setSmartKeepBackup] = useState(false)
      const [launching, setLaunching] = useState(false)
      const [launchingRollback, setLaunchingRollback] = useState(false)
      const [launched, setLaunched] = useState(null)

      const toastTimer = useRef(null)
      const copiedTimer = useRef(null)

      const notify = useCallback((message) => {
        setToast(message)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 4600)
      }, [])
      useEffect(() => () => {
        if (toastTimer.current) clearTimeout(toastTimer.current)
        if (copiedTimer.current) clearTimeout(copiedTimer.current)
      }, [])

      const load = useCallback(async (nextDeep, refresh, quiet) => {
        if (nextDeep) setDeepScanning(true)
        else if (!quiet) setLoading(true)
        setError(null)
        try {
          const data = await api(`/api/report?deep=${nextDeep ? 1 : 0}${refresh ? '&refresh=1' : ''}`)
          setReport(data)
          setDeep(Boolean(data.deep))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setLoading(false)
          setDeepScanning(false)
        }
      }, [])

      useEffect(() => { void load(false, false, false) }, [load])

      const refresh = useCallback(async (quiet) => {
        await load(deep || Boolean(report?.deep), true, quiet)
      }, [deep, report, load])

      const clean = useCallback(async (action) => {
        try {
          const result = await api('/api/cleanup', { method: 'POST', body: { action } })
          notify(t('toast.cleaned', { size: human(result?.bytes ?? 0) }))
          await refresh(true)
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        }
      }, [notify, refresh, t])

      const purgeTrash = useCallback(async (names) => {
        try {
          const result = await api('/api/trash/purge', { method: 'POST', body: names ? { names } : {} })
          notify(t('toast.cleaned', { size: human(result?.bytes ?? 0) }))
          await refresh(true)
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        }
      }, [notify, refresh, t])

      const restoreTrash = useCallback(async (names) => {
        try {
          const result = await api('/api/trash/restore', { method: 'POST', body: { names } })
          const ok = (result?.results ?? []).filter((item) => item.ok).length
          notify(t('trash.restored', { n: ok }))
          await refresh(true)
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        }
      }, [notify, refresh, t])

      const toggleDeep = useCallback(async () => {
        const next = !deep
        setDeep(next)
        await load(next, true, next)
      }, [deep, load])

      const measureWorkspaceSizes = useCallback(async () => {
        setMeasuringWorkspaces(true)
        try {
          await api('/api/measure-workspaces', { method: 'POST', body: {} })
          notify(t('toast.refreshed'))
          await refresh(true)
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setMeasuringWorkspaces(false)
        }
      }, [notify, refresh, t])

      // ---------- 迁移数据 ----------
      const loadMigration = useCallback(async (refreshStatus) => {
        setMigrationLoading(true)
        try {
          const data = await api(`/api/migrate/status${refreshStatus ? '?refresh=1' : ''}`)
          setMigration(data)
          setJob(data.job ?? null)
          setTarget((current) => current || data.suggestedTarget || '')
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setMigrationLoading(false)
        }
      }, [notify, t])

      useEffect(() => {
        if (tab === 'migration' && !migration) void loadMigration(false)
      }, [tab, migration, loadMigration])

      useEffect(() => {
        if (!job || job.state !== 'running') return
        const timer = setInterval(async () => {
          try {
            const latest = await api('/api/migrate/copy')
            setJob(latest)
            if (latest?.state !== 'running') {
              void loadMigration(true)
              try {
                const status = await api('/api/migrate/status')
                setJob(status.job ?? latest)
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* 轮询失败忽略，下次继续 */
          }
        }, 900)
        return () => clearInterval(timer)
      }, [job?.state, loadMigration])

      const selectSource = useCallback((key) => {
        setSourceKey(key)
        setValidation(null)
        setScripts(null)
        setRollbackScripts(null)
      }, [])
      const runValidate = useCallback(async () => {
        setValidating(true)
        setValidation(null)
        try {
          const result = await api('/api/migrate/validate', { method: 'POST', body: { sourceKey, target, excludeCache } })
          setValidation(result)
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setValidating(false)
        }
      }, [sourceKey, target, excludeCache, notify, t])

      const startCopyJob = useCallback(async () => {
        try {
          const started = await api('/api/migrate/copy/start', { method: 'POST', body: { sourceKey, target, excludeCache } })
          setJob(started)
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        }
      }, [sourceKey, target, excludeCache, notify, t])

      const cancelCopyJob = useCallback(async () => {
        try {
          const cancelled = await api('/api/migrate/copy/cancel', { method: 'POST', body: {} })
          setJob(cancelled)
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        }
      }, [notify, t])

      const generateSwitchScripts = useCallback(async () => {
        setGenerating(true)
        try {
          const result = await api('/api/migrate/scripts', { method: 'POST', body: { sourceKey, target, excludeCache } })
          setScripts(result)
          notify(t('toast.scriptReady'))
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setGenerating(false)
        }
      }, [sourceKey, target, excludeCache, notify, t])

      const generateRollbackScripts = useCallback(async (key) => {
        setGenerating(true)
        try {
          const result = await api('/api/migrate/scripts', { method: 'POST', body: { sourceKey: key, mode: 'rollback' } })
          setRollbackScripts(result)
          notify(t('toast.scriptReady'))
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setGenerating(false)
        }
      }, [notify, t])

      const launchSmart = useCallback(async () => {
        setLaunching(true)
        try {
          const result = await api('/api/migrate/run', {
            method: 'POST',
            body: {
              sourceKey,
              target,
              excludeCache,
              autoRestart: smartAutoRestart,
              keepBackup: smartKeepBackup,
            },
          })
          setLaunched(result)
          notify(t('toast.scriptReady'))
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setLaunching(false)
        }
      }, [sourceKey, target, excludeCache, smartAutoRestart, smartKeepBackup, notify, t])

      const launchRollback = useCallback(async (key) => {
        setLaunchingRollback(true)
        try {
          await api('/api/migrate/run', {
            method: 'POST',
            body: { sourceKey: key, mode: 'rollback', autoRestart: true },
          })
          notify(t('toast.scriptReady'))
        } catch (cause) {
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setLaunchingRollback(false)
        }
      }, [notify, t])

      const copyCommand = useCallback(async (text) => {
        if (!text) return
        const ok = await copyText(text)
        if (ok) {
          setCopied(true)
          notify(t('toast.copied'))
          if (copiedTimer.current) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => setCopied(false), 1800)
        }
      }, [notify, t])

      // ---------- 会话操作 ----------
      const sessions = report?.sessions ?? []
      const filteredSessions = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        return sessions.filter((row) => {
          if (filter === 'blank' && !row.blank) return false
          if (filter === 'archived' && !row.archived) return false
          if (filter === 'pinned' && !row.pinned) return false
          if (filter === 'live' && !row.live) return false
          if (filter === 'stale' && !(row.ageDays >= 90 && !row.live)) return false
          if (!keyword) return true
          return (
            String(row.title ?? '').toLowerCase().includes(keyword) ||
            String(row.id).toLowerCase().includes(keyword) ||
            String(row.cwd ?? '').toLowerCase().includes(keyword) ||
            String(row.workspaceTitle ?? '').toLowerCase().includes(keyword)
          )
        })
      }, [sessions, filter, query])

      const selectedRows = useMemo(() => sessions.filter((row) => selected.has(row.id)), [sessions, selected])

      const openDelete = (rows) => {
        const deletable = rows.filter((row) => !row.live)
        if (deletable.length === 0) {
          notify(t('sessions.liveHint'))
          return
        }
        if (deletable.length < rows.length) notify(t('sessions.liveHint'))
        setModal({ kind: 'delete', rows: deletable })
      }

      const confirmDelete = async (mode, deleteAttachments) => {
        const rows = modal?.rows ?? []
        setModal({ kind: 'delete', rows, busy: true, mode, deleteAttachments })
        try {
          const result = await api('/api/delete-sessions', {
            method: 'POST',
            body: { ids: rows.map((row) => row.id), mode, deleteAttachments },
          })
          setModal({ kind: 'result', result })
          setSelected(new Set())
          await refresh(true)
        } catch (cause) {
          setModal(null)
          notify(t('toast.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        }
      }

      const toggleRow = (row) => {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(row.id)) next.delete(row.id)
          else next.add(row.id)
          return next
        })
      }
      const toggleAll = (rows) => {
        setSelected((current) => {
          const next = new Set(current)
          const all = rows.length > 0 && rows.every((row) => next.has(row.id))
          for (const row of rows) {
            if (row.live) continue
            if (all) next.delete(row.id)
            else next.add(row.id)
          }
          return next
        })
      }

      const tabs = [
        ['overview', t('tab.overview')],
        ['detail', t('tab.detail')],
        ['sessions', t('tab.sessions'), sessions.length],
        ['advice', t('tab.advice'), (report?.advice ?? []).length],
        ['migration', t('tab.migration'), null],
        ['trash', t('tab.trash'), (report?.trash ?? []).length],
      ]

      const activeTabCount = (tabKey) => {
        if (tabKey === 'sessions') return sessions.length
        if (tabKey === 'advice') return (report?.advice ?? []).length
        if (tabKey === 'trash') return (report?.trash ?? []).length
        return null
      }

      const renderBody = () => {
        if (loading) {
          return h(
            'div',
            { className: 'stm-view' },
            h('div', { className: 'stm-muted' }, t('common.loading')),
            ...Array.from({ length: 4 }, (_, index) => h('div', { key: index, className: 'stm-skel' })),
          )
        }
        if (error) {
          return h(
            'div',
            { className: 'stm-view' },
            h(
              Card,
              null,
              h(Empty, { icon: 'alert', title: t('common.error'), hint: error }),
              h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: 10 } },
                h(Btn, { variant: 'primary', onClick: () => void load(deep, true, false) }, t('common.retry'))),
              h('div', { className: 'stm-field-hint', style: { textAlign: 'center', marginTop: 8 } },
                /fetch|HTTP 404|HTTP 500/i.test(error) ? t('error.notInstalled') : ''),
            ),
          )
        }
        if (!report) return h(Empty, { icon: 'storage', title: t('error.noReport') })
        if (tab === 'overview') {
          return h(OverviewView, {
            t,
            report,
            onOpenDetail: () => setTab('detail'),
            onMeasureWorkspaces: () => void measureWorkspaceSizes(),
            measuring: measuringWorkspaces,
          })
        }
        if (tab === 'detail') return h(DetailView, { t, report })
        if (tab === 'sessions') {
          return h(SessionsView, {
            t,
            report,
            deep,
            deepScanning,
            filteredSessions,
            selected,
            query,
            setQuery,
            filter,
            setFilter,
            onToggleDeep: () => void toggleDeep(),
            onClearSelection: () => setSelected(new Set()),
            onToggleAll: toggleAll,
            onToggleRow: toggleRow,
            onDelete: openDelete,
            onDeleteSelected: () => openDelete(selectedRows),
          })
        }
        if (tab === 'advice') {
          return h(AdviceView, {
            t,
            report,
            deep,
            deepScanning,
            onPurgeTrash: () => void purgeTrash(),
            onClean: (action) => void clean(action),
            onToggleDeep: () => void toggleDeep(),
            onReview: (nextFilter) => {
              setFilter(nextFilter)
              setTab('sessions')
            },
          })
        }
        if (tab === 'migration') {
          return h(MigrationView, {
            t,
            status: migration,
            loading: migrationLoading,
            validation,
            validating,
            sourceKey,
            target,
            excludeCache,
            job,
            scripts,
            rollbackScripts,
            generating,
            copied,
            smartAutoRestart,
            smartKeepBackup,
            launching,
            launchingRollback,
            launched,
            onRefresh: () => void loadMigration(true),
            onSelectSource: selectSource,
            onTarget: setTarget,
            onExcludeCache: setExcludeCache,
            onSmartAutoRestart: setSmartAutoRestart,
            onSmartKeepBackup: setSmartKeepBackup,
            onLaunchSmart: () => void launchSmart(),
            onLaunchRollback: (key) => void launchRollback(key),
            onSuggestTarget: () => {
              if (migration?.suggestedTarget) setTarget(migration.suggestedTarget)
            },
            onPickDrive: (root) => {
              const base = target.trim() ? target.split(/[\\/]/).pop() : 'DSHData'
              setTarget(`${root}\\${base || 'DSHData'}`)
              setValidation(null)
              setScripts(null)
            },
            onValidate: () => void runValidate(),
            onStartCopy: () => void startCopyJob(),
            onCancelCopy: () => void cancelCopyJob(),
            onGenerateScript: () => void generateSwitchScripts(),
            onGenerateRollback: (key) => void generateRollbackScripts(key),
            onCopyCommand: (text) => void copyCommand(text),
          })
        }
        if (tab === 'trash') {
          return h(TrashView, {
            t,
            report,
            onPurge: (names) => void purgeTrash(names),
            onPurgeAll: () => void purgeTrash(),
            onRestore: (names) => void restoreTrash(names),
          })
        }
        return null
      }

      return h(
        'div',
        { className: 'stm-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'stm-wrap' },
          h(
            'div',
            { className: 'stm-hero' },
            h(
              'div',
              { className: 'stm-hero-top' },
              h(
                'div',
                { className: 'stm-brand' },
                h('div', { className: 'stm-logo' }, h(Icon, { name: 'storage', size: 21 })),
                h(
                  'div',
                  null,
                  h('h1', { className: 'stm-title' },
                    t('panel.title'),
                    deep ? h(Tag, { color: ACCENT }, t('action.deepDone')) : null,
                  ),
                  h(
                    'div',
                    { className: 'stm-sub' },
                    h('span', null, `${t('panel.subtitle')}`),
                    report ? h('span', { className: 'stm-pathchip', title: report.dshHome }, report.dshHome) : null,
                    report?.profileDir ? h('span', { className: 'stm-pathchip', title: report.profileDir }, report.profileDir) : null,
                    report ? h('span', null, t('panel.scanAt', { time: formatTime(report.generatedAt) })) : null,
                  ),
                ),
              ),
              h(
                'div',
                { className: 'stm-actions' },
                h(Toggle, { checked: deep, onChange: () => void toggleDeep(), disabled: loading || deepScanning }, t('action.deep')),
                h(Btn, { variant: 'primary', onClick: () => void refresh(false), disabled: loading || deepScanning, loading: loading || deepScanning },
                  loading || deepScanning ? t('action.refreshing') : t('action.refresh')),
              ),
            ),
          ),
          h(
            'div',
            { className: 'stm-nav' },
            ...tabs.map(([key, label, count]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  'aria-current': tab === key ? 'page' : undefined,
                  onClick: () => setTab(key),
                },
                label,
                count != null ? h('span', { className: 'count' }, String(count)) : null,
              ),
            ),
          ),
          renderBody(),
        ),
        launching || launchingRollback
          ? h(LaunchOverlay, {
              title: launchingRollback ? t('mig.rollback.launchingOverlay') : t('mig.launchingOverlay'),
              hint: t('mig.launchingHint'),
            })
          : null,
        h(DeleteModal, {
          t,
          modal,
          onClose: () => setModal(null),
          setModal,
          onConfirm: (mode, deleteAttachments) => void confirmDelete(mode, deleteAttachments),
        }),
        h(Toast, { message: toast }),
      )
    }

    // -----------------------------------------------------------------------
    // 侧栏图标与注册
    // -----------------------------------------------------------------------
    function SidebarIcon(props) {
      return h(
        'span',
        { style: { display: 'flex', color: props?.active ? 'var(--stm-accent)' : 'currentColor' } },
        h(Icon, { name: 'storage', size: props?.size ?? 18 }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = makeTranslator(ZH)
        try {
          ctx.locale.register(NS, { zh: ZH, en: EN })
          t = ctx.locale.bind(NS)
        } catch (error) {
          console.warn('[storage-monitor] locale 注册失败，使用内置中文文案', error)
        }

        const Panel = () => h(Page, { t })

        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: ID, locale: NS }, Panel),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: ID, order: 35, locale: NS, label: () => t('panel.title') },
              SidebarIcon,
            ),
          ),
        )
      },
    }
  },
})
