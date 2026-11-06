/**
 * dsh-storage-monitor · Host 入口
 *
 * 职责：
 *   1. 在 webServer 上挂 /storage-monitor/api/*，供「存储空间」页面读取报告与执行清理；
 *   2. 注册 storage_inspect 工具，让 agent 也能查看占用、删除会话（与页面同一套实现）；
 *   3. 不直接修改任何配置或 profile 文件，只做文件系统统计与受控删除。
 */
import { createHandler, createReportCache } from './lib/api.js'
import {
  cleanCache,
  cleanOrphanAttachments,
  cleanOrphanProjectionCache,
  deleteSessions,
  listTrash,
  purgeTrash,
  restoreTrash,
} from './lib/sessions.js'
import { measureWorkspaces } from './lib/report.js'
import { resolveDshHome } from './lib/util.js'

export const name = 'dsh-storage-monitor'

/**
 * 必需依赖：
 *  - webServer：页面读取报告 / 执行清理
 *  - sessionPersistence：枚举会话日志与删除校验
 *  - workspaceRegistry：会话所属工作区与解绑
 *  - sessions：判断会话是否正在运行
 */
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'sessions']

const REPORT_FOR_TOOL = (data) => ({
  generatedAt: data.generatedAt,
  deep: data.deep,
  dshHome: data.dshHome,
  totals: data.totals,
  categories: data.categories.map((item) => ({
    key: item.key,
    bytes: item.bytes,
    human: item.humanBytes,
    percent: Number(item.percent.toFixed(4)),
    cleanable: item.cleanable,
    items: item.items.slice(0, 6).map((child) => ({ name: child.name, bytes: child.bytes })),
  })),
  advice: data.advice,
  sessions: data.sessions.slice(0, 12).map((row) => ({
    id: row.id,
    title: row.title,
    workspace: row.workspaceTitle,
    bytes: row.totalBytes,
    attachmentBytes: row.attachmentBytes,
    live: row.live,
    archived: row.archived,
    blank: row.blank,
    ageDays: row.ageDays,
  })),
  workspaces: data.workspaces.map((row) => ({ title: row.title, path: row.path, bytes: row.bytes, sessions: row.sessionCount })),
  trash: { count: data.trash.length, bytes: data.totals.trashBytes },
  attachmentScan: data.attachmentScan,
})

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['report', 'delete_sessions', 'list_trash', 'purge_trash', 'restore_trash', 'measure_workspaces', 'cleanup'],
      description: '操作：report 查看存储报告；delete_sessions 删除会话；list_trash/purge_trash/restore_trash 管理回收站；measure_workspaces 测量工作区项目体积（可能较慢）；cleanup 执行安全清理。',
    },
    deep: { type: 'boolean', description: 'report/cleanup 时是否深度扫描附件归属（更慢但更完整）。' },
    ids: { type: 'array', items: { type: 'string' }, description: 'delete_sessions 的会话 id 列表。' },
    mode: { type: 'string', enum: ['trash', 'purge'], description: 'delete_sessions 的删除方式：trash 移入回收站（默认，可恢复），purge 永久删除。' },
    deleteAttachments: { type: 'boolean', description: 'delete_sessions 时是否同时处理仅属于这些会话的附件，默认 true。' },
    cleanupAction: { type: 'string', enum: ['cache', 'projcache', 'orphans'], description: 'cleanup 的动作：cache 清缓存，projcache 清孤立投影缓存，orphans 清孤儿附件。' },
    names: { type: 'array', items: { type: 'string' }, description: '回收站条目名（list_trash 返回）。' },
  },
  required: ['action'],
}

export function apply(ctx, config) {
  const cache = createReportCache()
  const handler = createHandler(ctx, { cache })
  const log = (...args) => {
    if (config?.debug === true) console.log('[storage-monitor]', ...args)
  }

  // ---------- HTTP 路由 ----------
  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/storage-monitor',
          handler,
        }),
      'dsh-storage-monitor: http routes',
    )
    log('routes registered at /storage-monitor')
  } catch (error) {
    console.error('[storage-monitor] 注册 HTTP 路由失败：', error)
  }

  // ---------- 预热 ----------
  // 页面首次打开时希望已有报告，避免 3~6 秒空窗；启动后延迟预热，不干扰应用启动。
  try {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        void cache.get(ctx, false, false).catch(() => {})
      }, 6000)
      return () => clearTimeout(timer)
    }, 'dsh-storage-monitor: warm-up')
  } catch {
    /* 预热失败不影响主功能 */
  }

  // ---------- agent 工具 ----------
  const tools = ctx.get('tools')
  if (tools) {
    const register = () => {
      try {
        const dispose = tools.register({
          name: 'storage_inspect',
          description:
            '查看 DSH 的存储占用（分类统计：会话日志、附件、缓存、插件、运行时、工作区项目等，可深度扫描附件归属），并按需删除会话或清理缓存/孤儿附件。删除会话默认移入回收站（可在存储空间页面恢复），purge 才是永久删除；运行中的会话会被拒绝。',
          parameters: TOOL_PARAMETERS,
          output: {
            schema: { type: 'object' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          },
          async execute(args) {
            const action = args?.action
            const dshHome = resolveDshHome()
            if (action === 'report') {
              return REPORT_FOR_TOOL(await cache.get(ctx, args?.deep === true, true))
            }
            if (action === 'delete_sessions') {
              const result = await deleteSessions(ctx, {
                ids: args?.ids,
                mode: args?.mode,
                deleteAttachments: args?.deleteAttachments !== false,
              })
              cache.invalidate()
              return result
            }
            if (action === 'list_trash') {
              return { entries: await listTrash(dshHome) }
            }
            if (action === 'purge_trash') {
              const result = await purgeTrash(dshHome, args?.names)
              cache.invalidate()
              return result
            }
            if (action === 'restore_trash') {
              const result = await restoreTrash(ctx, dshHome, args?.names)
              cache.invalidate()
              return result
            }
            if (action === 'measure_workspaces') {
              const rows = await measureWorkspaces(ctx)
              cache.invalidate()
              return { rows }
            }
            if (action === 'cleanup') {
              const cleanupAction = args?.cleanupAction
              if (cleanupAction === 'cache') return cleanCache(dshHome)
              if (cleanupAction === 'projcache') return cleanOrphanProjectionCache(ctx, dshHome)
              if (cleanupAction === 'orphans') return cleanOrphanAttachments(ctx, dshHome)
              throw new Error('cleanupAction 必须是 cache / projcache / orphans')
            }
            throw new Error(`未知 action: ${String(action)}`)
          },
        })
        return dispose
      } catch (error) {
        console.error('[storage-monitor] 注册工具失败：', error)
        return undefined
      }
    }
    ctx.effect(register, 'dsh-storage-monitor: storage_inspect tool')
  }

  log('ready', `dshHome=${resolveDshHome()}`)
}
