/**
 * dsh-storage-monitor · 存储占用报告
 *
 * 报告分两层：
 *   1. 文件系统层（永远可用）：DSH_HOME 下的分类占用、会话日志、插件目录、
 *      运行时、缓存、工作区项目目录。
 *   2. 引用层（深度扫描）：按会话日志里的 attachmentId 反推附件归属，
 *      得到每个会话的附件占用、共享附件、孤儿附件。
 *
 * 只读：本模块不删除、不移动任何文件。
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import {
  clampText,
  humanBytes,
  listDir,
  mapLimit,
  measure,
  readJson,
  resolveDshHome,
  resolveProfileDir,
  safeStat,
} from './util.js'
import {
  createAttachmentIndex,
  hydrateAttachmentBytes,
  listAttachmentDigests,
  noteReference,
  readSessionEvents,
  sessionAttachmentStats,
  attachmentIdsFromEvents,
  attachmentPaths,
} from './attachments.js'
import { listTrash } from './sessions.js'

/** 与 DSH 生命周期强相关、不归入“插件数据”的目录。 */
const SYSTEM_DIRS = new Set([
  'sessions',
  'attachments',
  'cache',
  'storages',
  'profiles',
  'plugins',
  'electron',
  'dsh-runtimes',
  'storage-monitor',
])

const DAY = 24 * 60 * 60 * 1000

/** 读取 session_projcache 快照（标题、最后活动时间、空会话标记）。 */
async function readProjectionCache(dshHome) {
  const dir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  const map = new Map()
  const byId = new Map()
  for (const entry of await listDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const fullPath = path.join(dir, entry.name)
    const record = await readJson(fullPath)
    if (!record) continue
    const rows = record.record?.rows ?? {}
    const titleValue = rows.title?.val
    const title = typeof titleValue === 'string' ? titleValue : titleValue?.title
    const prompt = rows.turnOutline?.val?.turns?.[0]?.prompt
    const metadata = rows.sessionListMetadata?.val ?? {}
    const stat = await safeStat(fullPath)
    const info = {
      path: fullPath,
      bytes: stat?.size ?? 0,
      mtime: stat?.mtimeMs ?? 0,
      title: typeof title === 'string' && title.trim() ? title.trim() : undefined,
      prompt: typeof prompt === 'string' ? prompt : undefined,
      lastPromptAt: typeof metadata.lastPromptAt === 'number' ? metadata.lastPromptAt : undefined,
      blank: metadata.blank === true,
    }
    map.set(entry.name.slice(0, -'.json'.length), info)
    byId.set(entry.name, info)
  }
  return { map, byId }
}

/** 从 projcache 或首条 prompt 推导标题。 */
function titleOf(cache, snapshot) {
  if (cache?.title) return cache.title
  if (cache?.prompt) return clampText(cache.prompt, 64)
  return `会话 ${String(snapshot.header.id).slice(0, 18)}`
}

/** 会话目录里当前日志之外的历史代（v0..v3）也计入会话占用。 */
async function sessionDirectoryBytes(directory) {
  let bytes = 0
  let files = 0
  for (const entry of await listDir(directory)) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.lock')) continue
    const stat = await safeStat(path.join(directory, entry.name))
    if (stat?.isFile()) {
      bytes += stat.size
      files += 1
    }
  }
  return { bytes, files }
}

/** 有限并发扫描全部会话日志，建立 attachmentId → sessionId 索引。 */
async function buildAttachmentIndex(ctx, dshHome, snapshots, options = {}) {
  const index = createAttachmentIndex(dshHome)
  const failures = []
  const list = snapshots.slice(0, options.limit ?? snapshots.length)
  await mapLimit(list, 2, async (snapshot) => {
    const sessionId = String(snapshot.header.id)
    const { events, error } = await readSessionEvents(ctx, sessionId)
    if (error) {
      failures.push({ sessionId, error })
      return
    }
    for (const attachmentId of attachmentIdsFromEvents(events)) noteReference(index, sessionId, attachmentId)
  })
  await hydrateAttachmentBytes(index)
  return { index, failures }
}

/** 孤儿附件统计：磁盘上的对象 - 被任何会话引用的对象。 */
async function orphanStats(dshHome, index) {
  const digests = await listAttachmentDigests(dshHome)
  const referenced = new Set()
  for (const attachmentId of index.refs.keys()) {
    const paths = attachmentPaths(dshHome, attachmentId)
    if (paths) referenced.add(paths.digest)
  }
  let bytes = 0
  let count = 0
  const root = path.join(dshHome, 'attachments', 'v1')
  for (const digest of digests) {
    if (referenced.has(digest)) continue
    const shard = digest.slice(0, 2)
    const image = await safeStat(path.join(root, 'objects', shard, digest))
    const fileObject = await safeStat(path.join(root, 'file-objects', shard, digest))
    const size = image?.isFile() ? image.size : fileObject?.isFile() ? fileObject.size : 0
    if (size > 0) bytes += size
    count += 1
  }
  return { bytes, count, total: digests.size }
}

/** 组装分类。 */
function category(key, bytes, files, cleanable, items = []) {
  return { key, bytes, files, cleanable, items }
}

/** profile 下已安装插件包的体积（深度扫描时解析 symlink 到真实目录并统计）。 */
async function profileBundleSizes(profileDir, options = {}) {
  if (!profileDir) return []
  const withSizes = options.withSizes === true
  const nodeModules = path.join(profileDir, 'node_modules')
  const rows = []
  for (const entry of await listDir(nodeModules)) {
    if (entry.name === '.bin' || entry.name === '.pnpm' || entry.name === '.ignored' || entry.name === '.modules.yaml') continue
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const scoped of await listDir(path.join(nodeModules, entry.name))) {
        if (scoped.name.startsWith('.')) continue
        const linkPath = path.join(nodeModules, entry.name, scoped.name)
        rows.push(await bundleRow(`${entry.name}/${scoped.name}`, linkPath, withSizes))
      }
    } else {
      rows.push(await bundleRow(entry.name, path.join(nodeModules, entry.name), withSizes))
    }
  }
  return rows.filter(Boolean).sort((a, b) => b.bytes - a.bytes)
}

async function bundleRow(name, linkPath, withSizes) {
  let realPath = linkPath
  try {
    realPath = await fsp.realpath(linkPath)
  } catch {
    return undefined
  }
  const stat = await safeStat(realPath)
  if (!stat) return undefined
  if (!withSizes) return { name, path: linkPath, bytes: 0, files: 0, truncated: false, pending: true }
  if (stat.isDirectory()) {
    const measured = await measure(realPath, { maxEntries: 60000 })
    return { name, path: linkPath, bytes: measured.bytes, files: measured.files, truncated: measured.truncated, pending: false }
  }
  return { name, path: linkPath, bytes: stat.size, files: 1, truncated: false, pending: false }
}

/**
 * 工作区项目目录体积测量。
 *
 * 项目目录不是 DSH 自己的数据，而且可能有几万到几十万个文件（本次实测有一个
 * 1007MB / 79,930 文件的工作区，逐个 stat 要 20 秒）。因此默认报告**不测**，
 * 避免把页面拖死；由用户点「测量工作区体积」显式触发，结果缓存 10 分钟。
 */
let workspaceMeasurement = null
const WORKSPACE_MEASURE_TTL = 10 * 60 * 1000

function cachedWorkspaceRows() {
  if (!workspaceMeasurement) return null
  if (Date.now() - workspaceMeasurement.time > WORKSPACE_MEASURE_TTL) return null
  return workspaceMeasurement.rows
}

function workspaceIdentity(workspace) {
  return {
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
    sessionCount: workspace.sessionIds.length,
  }
}

/** 未测量时的占位行：只有身份信息，bytes 为 null。 */
function workspaceRowsFromRegistry(workspaceRegistry) {
  return workspaceRegistry.list().map((workspace) => ({
    ...workspaceIdentity(workspace),
    status: 'unknown',
    bytes: null,
    files: 0,
    truncated: false,
    children: [],
    measured: false,
  }))
}

/** 显式测量全部工作区体积（有缓存时直接返回）。 */
export async function measureWorkspaces(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) throw new Error('workspaceRegistry 服务不可用')
  const cached = cachedWorkspaceRows()
  if (cached) return cached
  const rows = []
  for (const workspace of registry.list()) {
    let status = 'ok'
    try {
      if (typeof workspace.status === 'function') status = await workspace.status()
    } catch {
      status = 'missing-dir'
    }
    const measured = status === 'missing-dir' ? { bytes: 0, files: 0, truncated: false, children: [] } : await measure(workspace.path, { maxEntries: 300000 })
    rows.push({
      ...workspaceIdentity(workspace),
      status: status ?? 'ok',
      bytes: measured.bytes,
      files: measured.files,
      truncated: measured.truncated,
      children: measured.children.slice(0, 6).map((child) => ({
        name: child.name,
        bytes: child.bytes,
        isDirectory: child.isDirectory,
        cleanable: /^(node_modules|dist|build|out|target|\.cache|\.next|coverage|tmp|temp)$/i.test(child.name),
      })),
      measured: true,
    })
  }
  workspaceMeasurement = { time: Date.now(), rows }
  return rows
}

/**
 * 生成完整报告。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ deep?: boolean }} [options]
 */
export async function buildReport(ctx, options = {}) {
  const deep = options.deep === true
  const dshHome = resolveDshHome()
  const profileDir = resolveProfileDir()
  const now = Date.now()

  const persistence = ctx.get('sessionPersistence')
  const sessionsService = ctx.get('sessions')
  const registry = ctx.get('workspaceRegistry')
  if (!persistence) throw new Error('sessionPersistence 服务不可用，无法枚举会话')
  if (!registry) throw new Error('workspaceRegistry 服务不可用，无法枚举工作区')

  // ---------- 会话元数据 ----------
  const snapshots = await persistence.list()
  const cache = await readProjectionCache(dshHome)
  const liveIds = new Set()
  try {
    for (const session of sessionsService?.list?.() ?? []) {
      const id = session?.id ?? session?.header?.id
      if (id) liveIds.add(String(id))
    }
  } catch {
    /* 活会话探测失败不影响报告 */
  }

  const workspaces = registry.list()
  const workspaceBySession = new Map()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(String(sessionId), workspace)
  }
  const workspaceJson = await readJson(path.join(dshHome, 'storages', 'workspace.json'))
  const archived = new Set((workspaceJson?.global?.archivedSessionIds ?? []).map(String))
  const pinned = new Set((workspaceJson?.global?.pinnedSessionIds ?? []).map(String))

  const childrenCount = new Map()
  for (const snapshot of snapshots) {
    const parent = snapshot.header.parentSession
    if (parent) childrenCount.set(String(parent), (childrenCount.get(String(parent)) ?? 0) + 1)
  }

  // ---------- 深度附件扫描 ----------
  let attachmentIndex
  let attachmentFailures = []
  let orphans
  if (deep) {
    const built = await buildAttachmentIndex(ctx, dshHome, snapshots)
    attachmentIndex = built.index
    attachmentFailures = built.failures
    orphans = await orphanStats(dshHome, attachmentIndex)
  }

  const sessionRows = []
  for (const snapshot of snapshots) {
    const id = String(snapshot.header.id)
    const idCache = cache.map.get(id)
    const workspace = workspaceBySession.get(id)
    const locationPath = snapshot.location?.path
    const directory = locationPath ? path.dirname(locationPath) : undefined
    const dirStats = directory ? await sessionDirectoryBytes(directory) : { bytes: snapshot.sizeBytes ?? 0, files: 1 }
    const logBytes = dirStats.bytes || snapshot.sizeBytes || 0
    const projBytes = idCache?.bytes ?? 0
    const attachmentStats = attachmentIndex
      ? sessionAttachmentStats(attachmentIndex, id)
      : { bytes: 0, count: 0, sharedCount: 0 }
    const createdAt = snapshot.header.createdAt ?? 0
    const lastActivityAt = idCache?.lastPromptAt ?? idCache?.mtime ?? createdAt
    sessionRows.push({
      id,
      title: titleOf(idCache, snapshot),
      cwd: snapshot.header.cwd ?? null,
      workspaceId: workspace?.id ?? null,
      workspaceTitle: workspace?.title ?? null,
      workspacePath: workspace?.path ?? null,
      createdAt,
      lastActivityAt,
      ageDays: lastActivityAt ? Math.floor((now - lastActivityAt) / DAY) : 0,
      logBytes,
      directoryBytes: dirStats.bytes,
      projcacheBytes: projBytes,
      attachmentBytes: attachmentStats.bytes,
      attachmentCount: attachmentStats.count,
      sharedAttachmentCount: attachmentStats.sharedCount,
      totalBytes: logBytes + projBytes + attachmentStats.bytes,
      live: liveIds.has(id),
      pinned: pinned.has(id),
      archived: archived.has(id),
      blank: idCache?.blank === true || snapshot.eventCount === 0,
      isSubagent: snapshot.header.origin === 'subagent' || Boolean(snapshot.header.parentSession),
      childCount: childrenCount.get(id) ?? 0,
      eventCount: snapshot.eventCount ?? null,
      formatStatus: snapshot.formatStatus ?? null,
      locationPath: locationPath ?? null,
      directory: directory ?? null,
      deep: Boolean(attachmentIndex),
    })
  }
  sessionRows.sort((a, b) => b.totalBytes - a.totalBytes)

  // ---------- 文件系统分类 ----------
  const [sessionsMeasure, attachmentsMeasure, cacheMeasure, storagesMeasure, pluginsMeasure, profilesMeasure, runtimesMeasure, electronMeasure, llmMeasure] =
    await Promise.all([
      measure(path.join(dshHome, 'sessions')),
      measure(path.join(dshHome, 'attachments')),
      measure(path.join(dshHome, 'cache')),
      measure(path.join(dshHome, 'storages')),
      measure(path.join(dshHome, 'plugins')),
      measure(path.join(dshHome, 'profiles')),
      measure(path.join(dshHome, 'dsh-runtimes')),
      measure(path.join(dshHome, 'electron')),
      measure(path.join(dshHome, 'llm-deepseek')),
    ])

  const pluginDataDirs = []
  for (const entry of await listDir(dshHome)) {
    if (!entry.isDirectory() || SYSTEM_DIRS.has(entry.name)) continue
    pluginDataDirs.push(entry.name)
  }
  const pluginDataMeasures = []
  for (const name of pluginDataDirs) {
    if (name === 'llm-deepseek') continue
    pluginDataMeasures.push({ name, ...(await measure(path.join(dshHome, name), { maxEntries: 60000 })) })
  }

  const rootFiles = []
  for (const entry of await listDir(dshHome)) {
    if (!entry.isFile()) continue
    const stat = await safeStat(path.join(dshHome, entry.name))
    if (stat) rootFiles.push({ name: entry.name, path: path.join(dshHome, entry.name), bytes: stat.size })
  }
  rootFiles.sort((a, b) => b.bytes - a.bytes)

  const trash = await listTrash(dshHome)
  const trashBytes = trash.reduce((sum, entry) => sum + entry.bytes, 0)

  const categoryItemsFromMeasure = (measured) =>
    measured.children.map((child) => ({
      name: child.name,
      path: child.path,
      bytes: child.bytes,
      files: child.files,
      isDirectory: child.isDirectory,
    }))

  // 会话分类的明细按“工作区目录（project bucket）”展示。
  const sessionBucketItems = sessionsMeasure.children.map((child) => ({
    name: child.name,
    path: child.path,
    bytes: child.bytes,
    files: child.files,
    isDirectory: true,
  }))

  // session_projcache 里孤立的投影缓存（会话已不存在）。
  let orphanProjcache = { bytes: 0, count: 0 }
  const projcacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  for (const entry of await listDir(projcacheDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const stem = entry.name.slice(0, -'.json'.length)
    if (snapshots.some((snapshot) => String(snapshot.header.id) === stem)) continue
    const stat = await safeStat(path.join(projcacheDir, entry.name))
    if (stat?.isFile()) {
      orphanProjcache.bytes += stat.size
      orphanProjcache.count += 1
    }
  }

  const bundles = await profileBundleSizes(profileDir, { withSizes: deep })
  const pluginManagerMeasure = profileDir ? await measure(path.join(profileDir, '.plugin-manager')) : { bytes: 0, files: 0, children: [] }

  const categories = [
    category('sessions', sessionsMeasure.bytes, sessionsMeasure.files, 'caution', sessionBucketItems),
    category('attachments', attachmentsMeasure.bytes, attachmentsMeasure.files, 'caution', categoryItemsFromMeasure(attachmentsMeasure)),
    category('cache', cacheMeasure.bytes, cacheMeasure.files, 'safe', categoryItemsFromMeasure(cacheMeasure)),
    category('storages', storagesMeasure.bytes, storagesMeasure.files, 'caution', categoryItemsFromMeasure(storagesMeasure)),
    category('plugins', pluginsMeasure.bytes + pluginManagerMeasure.bytes, pluginsMeasure.files + pluginManagerMeasure.files, 'caution', [
      ...categoryItemsFromMeasure(pluginsMeasure),
      ...(pluginManagerMeasure.bytes > 0
        ? [{ name: '.plugin-manager', path: path.join(profileDir, '.plugin-manager'), bytes: pluginManagerMeasure.bytes, files: pluginManagerMeasure.files, isDirectory: true }]
        : []),
    ]),
    category(
      'profiles',
      Math.max(0, profilesMeasure.bytes - pluginManagerMeasure.bytes),
      profilesMeasure.files,
      'danger',
      [
        {
          name: 'node_modules（已装插件包）',
          path: profileDir ? path.join(profileDir, 'node_modules') : '',
          bytes: Math.max(0, profilesMeasure.bytes - pluginManagerMeasure.bytes - 0),
          files: 0,
          isDirectory: true,
          note: `${bundles.length} 个包，请通过插件管理页卸载，不要直接删目录${deep ? '' : '；深度扫描可看单包体积'}`,
        },
        ...(deep
          ? bundles.slice(0, 24).map((bundle) => ({
              name: bundle.name,
              path: bundle.path,
              bytes: bundle.bytes,
              files: bundle.files,
              isDirectory: true,
              note: '已安装插件包',
            }))
          : []),
      ],
    ),
    category('runtime', runtimesMeasure.bytes + electronMeasure.bytes, runtimesMeasure.files + electronMeasure.files, 'danger', [
      { name: 'dsh-runtimes', path: path.join(dshHome, 'dsh-runtimes'), bytes: runtimesMeasure.bytes, files: runtimesMeasure.files, isDirectory: true },
      { name: 'electron', path: path.join(dshHome, 'electron'), bytes: electronMeasure.bytes, files: electronMeasure.files, isDirectory: true },
    ]),
    category(
      'pluginData',
      pluginDataMeasures.reduce((sum, measured) => sum + measured.bytes, 0) + llmMeasure.bytes,
      pluginDataMeasures.reduce((sum, measured) => sum + measured.files, 0) + llmMeasure.files,
      'caution',
      [
        ...pluginDataMeasures
          .sort((a, b) => b.bytes - a.bytes)
          .map((measured) => ({ name: measured.name, path: path.join(dshHome, measured.name), bytes: measured.bytes, files: measured.files, isDirectory: true })),
        { name: 'llm-deepseek', path: path.join(dshHome, 'llm-deepseek'), bytes: llmMeasure.bytes, files: llmMeasure.files, isDirectory: true },
      ],
    ),
    category(
      'logs',
      rootFiles.reduce((sum, file) => sum + file.bytes, 0),
      rootFiles.length,
      'caution',
      rootFiles.map((file) => ({ name: file.name, path: file.path, bytes: file.bytes, files: 1, isDirectory: false })),
    ),
    category('trash', trashBytes, 0, 'safe', trash.map((entry) => ({ name: entry.name, path: entry.path, bytes: entry.bytes, files: 0, isDirectory: true }))),
  ]

  const workspacesRows = cachedWorkspaceRows() ?? workspaceRowsFromRegistry(registry)
  // 工作区可能互相嵌套（例如 qq/agent-workspace 位于 default 下），合计时只算最外层，避免重复。
  const measuredWorkspaces = workspacesRows.filter((row) => row.measured && row.status !== 'missing-dir')
  const topLevelWorkspaces = []
  for (const row of [...measuredWorkspaces].sort((a, b) => a.path.length - b.path.length)) {
    const normalized = path.resolve(row.path).toLowerCase() + path.sep
    if (topLevelWorkspaces.some((parent) => normalized.startsWith(path.resolve(parent.path).toLowerCase() + path.sep))) continue
    topLevelWorkspaces.push(row)
  }
  const workspaceBytes = topLevelWorkspaces.reduce((sum, row) => sum + row.bytes, 0)
  const workspacesMeasured = measuredWorkspaces.length > 0

  const dshHomeBytes = categories.reduce((sum, item) => sum + item.bytes, 0)

  // ---------- 清理建议 ----------
  const advice = []
  if (trashBytes > 0) {
    advice.push({
      id: 'purge-trash',
      severity: 'safe',
      bytes: trashBytes,
      count: trash.length,
      action: 'purge-trash',
      titleKey: 'advice.trash.title',
      detailKey: 'advice.trash.detail',
    })
  }
  if (cacheMeasure.bytes > 0) {
    advice.push({
      id: 'clear-cache',
      severity: 'safe',
      bytes: cacheMeasure.bytes,
      count: cacheMeasure.files,
      action: 'clear-cache',
      titleKey: 'advice.cache.title',
      detailKey: 'advice.cache.detail',
    })
  }
  if (orphanProjcache.count > 0) {
    advice.push({
      id: 'clean-projcache',
      severity: 'safe',
      bytes: orphanProjcache.bytes,
      count: orphanProjcache.count,
      action: 'clean-projcache',
      titleKey: 'advice.projcache.title',
      detailKey: 'advice.projcache.detail',
    })
  }
  if (orphans && orphans.count > 0 && attachmentFailures.length === 0) {
    advice.push({
      id: 'clean-orphans',
      severity: 'safe',
      bytes: orphans.bytes,
      count: orphans.count,
      action: 'clean-orphans',
      titleKey: 'advice.orphans.title',
      detailKey: 'advice.orphans.detail',
    })
  }
  if (deep && attachmentFailures.length > 0) {
    advice.push({
      id: 'scan-incomplete',
      severity: 'caution',
      bytes: 0,
      count: attachmentFailures.length,
      action: 'none',
      titleKey: 'advice.scanIncomplete.title',
      detailKey: 'advice.scanIncomplete.detail',
    })
  }

  const blank = sessionRows.filter((row) => row.blank && !row.live)
  if (blank.length > 0) {
    advice.push({
      id: 'blank-sessions',
      severity: 'safe',
      bytes: blank.reduce((sum, row) => sum + row.totalBytes, 0),
      count: blank.length,
      action: 'review-blank-sessions',
      titleKey: 'advice.blank.title',
      detailKey: 'advice.blank.detail',
    })
  }
  const stale = sessionRows.filter((row) => !row.live && !row.archived && row.ageDays >= 90 && !row.pinned)
  if (stale.length > 0) {
    advice.push({
      id: 'stale-sessions',
      severity: 'caution',
      bytes: stale.reduce((sum, row) => sum + row.totalBytes, 0),
      count: stale.length,
      action: 'review-stale-sessions',
      titleKey: 'advice.stale.title',
      detailKey: 'advice.stale.detail',
    })
  }
  const archivedRows = sessionRows.filter((row) => row.archived && !row.live)
  if (archivedRows.length > 0) {
    advice.push({
      id: 'archived-sessions',
      severity: 'caution',
      bytes: archivedRows.reduce((sum, row) => sum + row.totalBytes, 0),
      count: archivedRows.length,
      action: 'review-archived-sessions',
      titleKey: 'advice.archived.title',
      detailKey: 'advice.archived.detail',
    })
  }
  if (deep && orphans) {
    const shared = new Map()
    for (const set of attachmentIndex.refs.values()) {
      if (set.size > 1) shared.set(set.size, (shared.get(set.size) ?? 0) + 1)
    }
    const sharedCount = [...shared.values()].reduce((sum, value) => sum + value, 0)
    if (sharedCount > 0) {
      advice.push({
        id: 'shared-attachments',
        severity: 'caution',
        bytes: 0,
        count: sharedCount,
        action: 'none',
        titleKey: 'advice.shared.title',
        detailKey: 'advice.shared.detail',
      })
    }
  }
  advice.push({
    id: 'runtime',
    severity: 'danger',
    bytes: runtimesMeasure.bytes + electronMeasure.bytes,
    count: 2,
    action: 'none',
    titleKey: 'advice.runtime.title',
    detailKey: 'advice.runtime.detail',
  })
  if (workspaceBytes > 0) {
    advice.push({
      id: 'workspaces',
      severity: 'caution',
      bytes: workspaceBytes,
      count: workspacesRows.length,
      action: 'none',
      titleKey: 'advice.workspaces.title',
      detailKey: 'advice.workspaces.detail',
    })
  }

  const cleanableBytes = advice
    .filter((item) => item.severity === 'safe' && item.action !== 'review-blank-sessions')
    .reduce((sum, item) => sum + item.bytes, 0)

  const categoriesWithTotals = categories.map((item) => ({
    ...item,
    percent: dshHomeBytes > 0 ? item.bytes / dshHomeBytes : 0,
    humanBytes: humanBytes(item.bytes),
  }))

  return {
    generatedAt: now,
    dshHome,
    profileDir: profileDir ?? null,
    deep,
    totals: {
      dshHomeBytes,
      dshHomeHuman: humanBytes(dshHomeBytes),
      workspaceBytes,
      workspaceHuman: humanBytes(workspaceBytes),
      cleanableBytes,
      cleanableHuman: humanBytes(cleanableBytes),
      trashBytes,
      sessions: sessionRows.length,
      liveSessions: sessionRows.filter((row) => row.live).length,
      attachmentsBytes: attachmentsMeasure.bytes,
      attachmentsFiles: attachmentsMeasure.files,
      cacheBytes: cacheMeasure.bytes,
      pluginsBytes: categories.find((item) => item.key === 'profiles')?.bytes ?? 0,
      sessionLogBytes: sessionsMeasure.bytes,
    },
    categories: categoriesWithTotals,
    sessions: sessionRows,
    workspaces: workspacesRows,
    workspacesMeasured,
    workspaceMeasuredAt: workspacesMeasured ? workspaceMeasurement?.time ?? null : null,
    trash,
    advice: advice.map((item) => ({
      ...item,
      bytes: item.bytes,
      humanBytes: humanBytes(item.bytes),
    })),
    attachmentScan: deep
      ? {
          sessionsScanned: snapshots.length - attachmentFailures.length,
          failures: attachmentFailures.slice(0, 20),
          orphans,
          referencedObjects: attachmentIndex.refs.size,
        }
      : null,
    orphanProjcache,
    profileBundles: bundles.slice(0, 24),
    limits: {
      maxFileEntries: 200000,
    },
  }
}
