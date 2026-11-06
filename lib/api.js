/**
 * dsh-storage-monitor · Host HTTP API
 *
 * 页面与 agent 工具共用同一套操作函数（见 lib/report.js、lib/sessions.js），
 * 这里只做路由、参数校验和同源/CSRF 防护。
 *
 * 路由（挂在 /storage-monitor 前缀下）：
 *   GET  /storage-monitor/api/report?deep=0|1&refresh=1
 *   POST /storage-monitor/api/delete-sessions   { ids, mode, deleteAttachments }
 *   POST /storage-monitor/api/trash/purge       { names? }
 *   POST /storage-monitor/api/trash/restore     { names }
 *   POST /storage-monitor/api/cleanup           { action: 'cache'|'projcache'|'orphans' }
 *   GET  /storage-monitor/api/health
 */
import { buildReport, measureWorkspaces } from './report.js'
import {
  cancelJob,
  generateScripts,
  getJob,
  invalidateMigrationScan,
  launchRunner,
  migrationStatus,
  startCopy,
  validateMigration,
  verifyMigration,
} from './migrate.js'
import {
  cleanCache,
  cleanOrphanAttachments,
  cleanOrphanProjectionCache,
  deleteSessions,
  listTrash,
  purgeTrash,
  restoreTrash,
} from './sessions.js'
import { resolveDshHome, resolveProfileDir } from './util.js'

const MAX_BODY_BYTES = 1024 * 1024
const ROUTE_PREFIX = '/storage-monitor'

export function createReportCache() {
  let entry = null
  let queue = Promise.resolve()
  const hit = (deep) => entry && entry.deep === deep && Date.now() - entry.time < (deep ? 300000 : 60000)
  return {
    async get(ctx, deep, refresh) {
      if (!refresh && hit(deep)) return entry.data
      // 串行化构建：避免“预热 + 页面请求 + 深度扫描”同时扫描几 GB 目录互相拖慢。
      const task = queue.then(async () => {
        if (!refresh && hit(deep)) return entry.data
        const data = await buildReport(ctx, { deep })
        entry = { time: Date.now(), deep, data }
        return data
      })
      queue = task.then(
        () => undefined,
        () => undefined,
      )
      return task
    },
    invalidate() {
      entry = null
    },
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 同源检查：跨站页面即使带上 cookie 也不能触发删除。 */
function assertSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return
  let host
  try {
    host = new URL(origin).host
  } catch {
    throw new Error('Origin 非法')
  }
  if (host !== req.headers.host) throw new Error('拒绝跨站请求')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ cache: ReturnType<typeof createReportCache> }} options
 */
export function createHandler(ctx, options) {
  const cache = options.cache

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://storage-monitor.local')
    const pathname = url.pathname
    if (!pathname.startsWith(ROUTE_PREFIX + '/')) {
      sendJson(res, 404, { ok: false, error: 'Not found' })
      return
    }
    const route = pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '')
    const method = req.method ?? 'GET'

    try {
      if (route === '/api/health') {
        sendJson(res, 200, { ok: true, dshHome: resolveDshHome(), profileDir: resolveProfileDir(), now: Date.now() })
        return
      }

      if (route === '/api/client') {
        // 只读诊断：确认 Client 半侧已进入 Web 启动图，并给出 bundle URL。
        const clientModules = ctx.get('clientModules')
        const graph = clientModules?.graph?.()
        sendJson(res, 200, {
          ok: true,
          data: {
            entries: (graph?.entries ?? []).filter((entry) => String(entry.id).includes('storage-monitor')),
            clientPath: clientModules?.clientPath?.('dsh-storage-monitor') ?? null,
          },
        })
        return
      }

      if (route === '/api/report' && (method === 'GET' || method === 'HEAD')) {
        const deep = url.searchParams.get('deep') === '1'
        const refresh = url.searchParams.get('refresh') === '1'
        const data = await cache.get(ctx, deep, refresh)
        sendJson(res, 200, { ok: true, data })
        return
      }

      if (route === '/api/trash' && method === 'GET') {
        sendJson(res, 200, { ok: true, data: await listTrash(resolveDshHome()) })
        return
      }

      if (route === '/api/migrate/status' && method === 'GET') {
        if (url.searchParams.get('refresh') === '1') invalidateMigrationScan()
        sendJson(res, 200, { ok: true, data: await migrationStatus(ctx) })
        return
      }

      if (route === '/api/migrate/copy' && method === 'GET') {
        sendJson(res, 200, { ok: true, data: getJob() })
        return
      }

      if (route === '/api/migrate/verify' && method === 'GET') {
        sendJson(res, 200, { ok: true, data: await verifyMigration(ctx) })
        return
      }

      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' })
        return
      }
      assertSameOrigin(req)
      // 自定义头会触发 CORS 预检，跨源页面无法伪造；用于挡住表单类 CSRF。
      if (req.headers['x-dsh-storage-monitor'] !== '1') {
        sendJson(res, 403, { ok: false, error: '缺少同源操作标记' })
        return
      }
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        sendJson(res, 415, { ok: false, error: '需要 application/json' })
        return
      }
      const body = await readJsonBody(req)

      if (route === '/api/delete-sessions') {
        const result = await deleteSessions(ctx, {
          ids: body?.ids,
          mode: body?.mode,
          deleteAttachments: body?.deleteAttachments !== false,
        })
        cache.invalidate()
        sendJson(res, 200, { ok: true, data: result })
        return
      }

      if (route === '/api/trash/purge') {
        const result = await purgeTrash(resolveDshHome(), body?.names)
        cache.invalidate()
        sendJson(res, 200, { ok: true, data: result })
        return
      }

      if (route === '/api/trash/restore') {
        const result = await restoreTrash(ctx, resolveDshHome(), body?.names)
        cache.invalidate()
        sendJson(res, 200, { ok: true, data: result })
        return
      }

      if (route === '/api/measure-workspaces') {
        const rows = await measureWorkspaces(ctx)
        cache.invalidate()
        sendJson(res, 200, { ok: true, data: { rows, measuredAt: Date.now() } })
        return
      }

      if (route === '/api/migrate/validate') {
        const result = await validateMigration(body)
        sendJson(res, 200, { ok: true, data: result })
        return
      }

      if (route === '/api/migrate/copy/start') {
        const job = await startCopy(body)
        sendJson(res, 200, { ok: true, data: job })
        return
      }

      if (route === '/api/migrate/copy/cancel') {
        sendJson(res, 200, { ok: true, data: cancelJob() })
        return
      }

      if (route === '/api/migrate/scripts') {
        const result = await generateScripts(ctx, body)
        sendJson(res, 200, { ok: true, data: result })
        return
      }

      if (route === '/api/migrate/run') {
        // 生成并启动独立控制台；DSH 会在约 5 秒后被脚本关闭并迁移，然后自动重启。
        const result = await launchRunner(ctx, body)
        sendJson(res, 200, { ok: true, data: result })
        return
      }

      if (route === '/api/cleanup') {
        const action = body?.action
        const dshHome = resolveDshHome()
        let data
        if (action === 'cache') data = await cleanCache(dshHome)
        else if (action === 'projcache') data = await cleanOrphanProjectionCache(ctx, dshHome)
        else if (action === 'orphans') data = await cleanOrphanAttachments(ctx, dshHome)
        else throw new Error(`未知清理动作: ${String(action)}`)
        cache.invalidate()
        sendJson(res, 200, { ok: true, data })
        return
      }

      if (route === '/api/trash') {
        sendJson(res, 200, { ok: true, data: await listTrash(resolveDshHome()) })
        return
      }

      sendJson(res, 404, { ok: false, error: 'Not found' })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
