/**
 * dsh-storage-monitor · 会话删除 / 回收站 / 清理
 *
 * DSH 的 sessionPersistence 明确“没有删除 API，日志只能由外部移除”
 * （见 @deepseek-ai/dsh-session-persistence-jsonl README），所以这里实现
 * 一套带回收站的删除流程：
 *
 *   1. 校验：会话存在、未在运行、路径在 sessions 根内；
 *   2. 计算会话足迹：日志目录 + 投影缓存 + 仅属于它的附件；
 *   3. 默认移入 <DSH_HOME>/storage-monitor/trash/<时间>__<id>/（可恢复）；
 *   4. 从工作区解绑、取消固定/归档；
 *   5. 永久删除时才真正 rm；
 *   6. 附件按“是否仍被其它会话引用”决定删/留，避免误删共享图片。
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import {
  assertInside,
  clampText,
  exists,
  listDir,
  mapLimit,
  measure,
  move,
  readJson,
  remove,
  resolveDshHome,
  safeStat,
  writeJson,
} from './util.js'
import {
  attachmentIdsFromEvents,
  attachmentPaths,
  listAttachmentDigests,
  readSessionEvents,
} from './attachments.js'

const TRASH_VERSION = 1
const MAX_BATCH = 100

export function trashRoot(dshHome) {
  return path.join(dshHome, 'storage-monitor', 'trash')
}

function sessionsRoot(dshHome) {
  return path.join(dshHome, 'sessions')
}

function projcachePath(dshHome, sessionId) {
  return path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

function validSessionId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('/') && !id.includes('\\') && !id.includes('..')
}

/** 读取会话标题（projcache → 首条 prompt → 空）。 */
async function titleForSession(dshHome, sessionId) {
  const record = await readJson(projcachePath(dshHome, sessionId))
  const rows = record?.record?.rows ?? {}
  const titleValue = rows.title?.val
  const title = typeof titleValue === 'string' ? titleValue : titleValue?.title
  if (typeof title === 'string' && title.trim()) return title.trim()
  const prompt = rows.turnOutline?.val?.turns?.[0]?.prompt
  return typeof prompt === 'string' && prompt.trim() ? clampText(prompt, 64) : null
}

/** 回收站条目列表。 */
export async function listTrash(dshHome) {
  const root = trashRoot(dshHome)
  const entries = []
  for (const entry of await listDir(root)) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const manifest = await readJson(path.join(dir, 'manifest.json'))
    const measured = await measure(dir, { maxEntries: 200000 })
    entries.push({
      name: entry.name,
      path: dir,
      bytes: measured.bytes,
      files: measured.files,
      sessionId: manifest?.sessionId ?? entry.name.split('__').slice(1).join('__'),
      title: manifest?.title ?? null,
      deletedAt: manifest?.deletedAt ?? null,
      mode: manifest?.mode ?? 'trash',
      attachmentCount: manifest?.attachments?.length ?? 0,
      restorable: Boolean(manifest?.sessionDir),
    })
  }
  return entries.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
}

/** 扫描全部会话的附件引用；返回 attachmentId → sessionId 集合。 */
async function buildReferenceIndex(ctx, snapshots) {
  const refs = new Map()
  const failures = []
  let scanned = 0
  await mapLimit(snapshots, 2, async (snapshot) => {
    const sessionId = String(snapshot.header.id)
    const { events, error } = await readSessionEvents(ctx, sessionId)
    if (error) {
      failures.push({ sessionId, error })
      return
    }
    scanned += 1
    for (const attachmentId of attachmentIdsFromEvents(events)) {
      let set = refs.get(attachmentId)
      if (!set) {
        set = new Set()
        refs.set(attachmentId, set)
      }
      set.add(sessionId)
    }
  })
  return { refs, failures, scanned }
}

/** 把附件对象移动到回收站，返回移动记录。 */
async function stageAttachment(dshHome, destinationRoot, attachmentId) {
  const paths = attachmentPaths(dshHome, attachmentId)
  if (!paths) return []
  const staged = []
  const targets = [
    ['image', paths.imageObject],
    ['fileObject', paths.fileObject],
    ['fileView', paths.fileViewDir],
  ]
  for (const [kind, source] of targets) {
    if (!(await exists(source))) continue
    const relative = path.relative(path.join(dshHome, 'attachments', 'v1'), source)
    const destination = path.join(destinationRoot, 'attachments', relative)
    await move(source, destination)
    staged.push({ kind, from: source, to: destination, attachmentId })
  }
  return staged
}

/** 删除附件对象（永久）。 */
async function purgeAttachment(dshHome, attachmentId) {
  const paths = attachmentPaths(dshHome, attachmentId)
  if (!paths) return 0
  let bytes = 0
  for (const target of [paths.imageObject, paths.fileObject, paths.fileViewDir]) {
    const stat = await safeStat(target)
    if (!stat) continue
    if (stat.isDirectory()) {
      const measured = await measure(target)
      bytes += measured.bytes
      await remove(target)
    } else {
      bytes += stat.size
      await remove(target)
    }
  }
  return bytes
}

async function detachFromWorkspace(registry, sessionId) {
  const warnings = []
  for (const workspace of registry?.list?.() ?? []) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      warnings.push(`工作区解绑失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    await registry?.unpinSession?.(sessionId)
  } catch {
    /* 未固定时忽略 */
  }
  try {
    await registry?.unarchiveSession?.(sessionId)
  } catch {
    /* 未归档时忽略 */
  }
  return warnings
}

/**
 * 删除一个或多个会话。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ ids: string[], mode?: 'trash'|'purge', deleteAttachments?: boolean }} request
 */
export async function deleteSessions(ctx, request) {
  const dshHome = resolveDshHome()
  const mode = request?.mode === 'purge' ? 'purge' : 'trash'
  const deleteAttachments = request?.deleteAttachments !== false
  const ids = [...new Set((Array.isArray(request?.ids) ? request.ids : []).map(String).filter(validSessionId))]
  if (ids.length === 0) throw new Error('没有可删除的会话 id')
  if (ids.length > MAX_BATCH) throw new Error(`一次最多删除 ${MAX_BATCH} 个会话`)

  const persistence = ctx.get('sessionPersistence')
  const sessionsService = ctx.get('sessions')
  const registry = ctx.get('workspaceRegistry')
  if (!persistence) throw new Error('sessionPersistence 服务不可用')

  const liveIds = new Set()
  for (const session of sessionsService?.list?.() ?? []) {
    const id = session?.id ?? session?.header?.id
    if (id) liveIds.add(String(id))
  }

  const snapshots = await persistence.list()
  const byId = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]))
  const root = sessionsRoot(dshHome)

  const refused = []
  const targets = []
  for (const id of ids) {
    if (liveIds.has(id)) {
      refused.push({ id, reason: '会话正在运行，无法删除' })
      continue
    }
    const snapshot = byId.get(id)
    if (!snapshot) {
      refused.push({ id, reason: '会话不存在（可能已被删除）' })
      continue
    }
    const locationPath = snapshot.location?.path
    if (!locationPath) {
      refused.push({ id, reason: '会话尚未写入磁盘，暂不支持删除' })
      continue
    }
    let directory
    try {
      directory = assertInside(root, path.dirname(locationPath))
      assertInside(root, locationPath)
    } catch {
      refused.push({ id, reason: '会话路径不在 sessions 目录内，已拒绝' })
      continue
    }
    targets.push({ id, snapshot, directory, locationPath })
  }

  // ---------- 附件引用关系 ----------
  let refs = new Map()
  let attachmentFailures = []
  let attachmentScanSkipped = false
  if (deleteAttachments) {
    const otherSnapshots = snapshots.filter((snapshot) => !ids.includes(String(snapshot.header.id)))
    const scanned = await buildReferenceIndex(ctx, otherSnapshots)
    refs = scanned.refs
    attachmentFailures = scanned.failures
    // 有会话读不出来时无法确认引用关系：宁可不删附件，也不误删。
    if (attachmentFailures.length > 0) attachmentScanSkipped = true
  }

  const results = []
  for (const target of targets) {
    const { id, snapshot, directory } = target
    const title = await titleForSession(dshHome, id)
    const destination = path.join(trashRoot(dshHome), `${new Date().toISOString().replace(/[:.]/g, '-')}__${id}`)

    const projcache = projcachePath(dshHome, id)
    const owningWorkspace = registry?.list?.().find((workspace) => workspace.sessionIds.includes(id)) ?? null

    // 目标会话自己的附件引用；读不出来时只搬会话、不动附件。
    let targetAttachmentIds = new Set()
    let targetScanFailed = false
    if (deleteAttachments) {
      const { events, error } = await readSessionEvents(ctx, id)
      if (error) {
        targetScanFailed = true
        attachmentFailures.push({ sessionId: id, error })
      } else {
        targetAttachmentIds = attachmentIdsFromEvents(events)
      }
    }

    const attachmentsToDelete = []
    const sharedAttachments = []
    const skipForThisTarget = attachmentScanSkipped || targetScanFailed
    for (const attachmentId of targetAttachmentIds) {
      const owners = refs.get(attachmentId)
      if (skipForThisTarget || (owners && owners.size > 0)) sharedAttachments.push(attachmentId)
      else attachmentsToDelete.push(attachmentId)
    }

    const before = {
      directory: (await measure(directory)).bytes,
      projcache: (await safeStat(projcache))?.size ?? 0,
      attachments: 0,
    }
    for (const attachmentId of attachmentsToDelete) {
      const paths = attachmentPaths(dshHome, attachmentId)
      if (!paths) continue
      const objectStat = await safeStat(paths.imageObject)
      const fileStat = await safeStat(paths.fileObject)
      before.attachments += objectStat?.size ?? fileStat?.size ?? 0
    }

    const errors = []
    try {
      // 会话目录整体进回收站（含历史代与 lock 文件）。
      if (await exists(directory)) await move(directory, path.join(destination, 'session'))
      if (await exists(projcache)) await move(projcache, path.join(destination, 'projcache.json'))
    } catch (error) {
      errors.push(`移动会话文件失败：${error instanceof Error ? error.message : String(error)}`)
      results.push({ id, ok: false, title, errors, refused: false })
      continue
    }

    let attachmentBytesFreed = 0
    const stagedAttachments = []
    for (const attachmentId of attachmentsToDelete) {
      try {
        if (mode === 'trash') {
          stagedAttachments.push(...(await stageAttachment(dshHome, destination, attachmentId)))
        } else {
          attachmentBytesFreed += await purgeAttachment(dshHome, attachmentId)
        }
      } catch (error) {
        errors.push(`附件处理失败（${attachmentId}）：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const workspaceWarnings = await detachFromWorkspace(registry, id)
    errors.push(...workspaceWarnings)

    const manifest = {
      version: TRASH_VERSION,
      sessionId: id,
      title,
      deletedAt: Date.now(),
      mode,
      sessionDir: directory,
      projcachePath: projcache,
      locationPath: target.locationPath,
      workspaceId: owningWorkspace?.id ?? null,
      bytes: {
        session: before.directory,
        projcache: before.projcache,
        attachments: mode === 'trash' ? before.attachments : before.attachments,
        total: before.directory + before.projcache + before.attachments,
      },
      attachments: stagedAttachments.map((entry) => ({ kind: entry.kind, from: entry.from, to: entry.to, attachmentId: entry.attachmentId })),
      sharedAttachments: sharedAttachments.length,
      skippedAttachmentCleanup: skipForThisTarget,
    }
    try {
      await writeJson(path.join(destination, 'manifest.json'), manifest)
    } catch (error) {
      errors.push(`写入回收站清单失败：${error instanceof Error ? error.message : String(error)}`)
    }

    let purged = false
    if (mode === 'purge') {
      try {
        await remove(destination)
        purged = true
      } catch (error) {
        errors.push(`永久删除失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    results.push({
      id,
      ok: mode === 'trash' || purged,
      title,
      mode,
      bytes: manifest.bytes.total,
      attachmentBytes: before.attachments,
      attachmentsDeleted: attachmentsToDelete.length,
      sharedAttachments: sharedAttachments.length,
      skippedAttachmentCleanup: skipForThisTarget,
      trashName: mode === 'trash' ? path.basename(destination) : null,
      errors,
      refused: false,
    })
  }

  return {
    mode,
    results,
    refused,
    attachmentFailures: attachmentFailures.slice(0, 20),
    totals: {
      bytes: results.reduce((sum, item) => sum + (item.ok ? item.bytes : 0), 0),
      deleted: results.filter((item) => item.ok).length,
      attachmentsDeleted: results.reduce((sum, item) => sum + (item.attachmentsDeleted ?? 0), 0),
      sharedAttachments: results.reduce((sum, item) => sum + (item.sharedAttachments ?? 0), 0),
    },
  }
}

/** 清空指定（或全部）回收站条目。 */
export async function purgeTrash(dshHome, names) {
  const root = trashRoot(dshHome)
  const requested = Array.isArray(names) && names.length > 0 ? names : (await listDir(root)).filter((entry) => entry.isDirectory).map((entry) => entry.name)
  let bytes = 0
  let count = 0
  const skipped = []
  for (const name of requested) {
    if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      skipped.push(name)
      continue
    }
    const target = path.join(root, name)
    try {
      assertInside(root, target)
      const measured = await measure(target)
      await remove(target)
      bytes += measured.bytes
      count += 1
    } catch (error) {
      skipped.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { bytes, count, skipped }
}

/** 从回收站恢复会话。 */
export async function restoreTrash(ctx, dshHome, names) {
  const root = trashRoot(dshHome)
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry')
  const results = []
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) continue
    const dir = path.join(root, name)
    const manifest = await readJson(path.join(dir, 'manifest.json'))
    if (!manifest?.sessionId || !manifest.sessionDir) {
      results.push({ name, ok: false, reason: '回收站条目缺少清单，无法恢复' })
      continue
    }
    const sessionId = String(manifest.sessionId)
    try {
      const current = await persistence?.stat?.(sessionId)
      if (current) {
        results.push({ name, ok: false, reason: '同名会话已经存在，无法恢复' })
        continue
      }
      const stagedSession = path.join(dir, 'session')
      if (await exists(stagedSession)) {
        assertInside(sessionsRoot(dshHome), manifest.sessionDir)
        await move(stagedSession, manifest.sessionDir)
      }
      const stagedProjcache = path.join(dir, 'projcache.json')
      if (await exists(stagedProjcache)) {
        await move(stagedProjcache, manifest.projcachePath)
      }
      for (const attachment of manifest.attachments ?? []) {
        if (!attachment?.from || !attachment?.to) continue
        if (await exists(attachment.to)) {
          assertInside(path.join(dshHome, 'attachments'), attachment.from)
          await move(attachment.to, attachment.from)
        }
      }
      const workspace = registry?.get?.(manifest.workspaceId)
      if (workspace) {
        try {
          await workspace.attachSession(sessionId)
        } catch {
          /* 工作区已被删除时忽略 */
        }
      }
      await remove(dir)
      results.push({ name, ok: true, sessionId })
    } catch (error) {
      results.push({ name, ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { results }
}

/** 清理 DSH 缓存目录内容（cache 可安全重建）。 */
export async function cleanCache(dshHome) {
  const cacheDir = path.join(dshHome, 'cache')
  let bytes = 0
  let count = 0
  for (const entry of await listDir(cacheDir)) {
    const target = path.join(cacheDir, entry.name)
    const measured = await measure(target)
    await remove(target)
    bytes += measured.bytes
    count += 1
  }
  return { bytes, count }
}

/** 清理“会话已不存在”的投影缓存。 */
export async function cleanOrphanProjectionCache(ctx, dshHome) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence) throw new Error('sessionPersistence 服务不可用')
  const live = new Set((await persistence.list()).map((snapshot) => String(snapshot.header.id)))
  const dir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  let bytes = 0
  let count = 0
  for (const entry of await listDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const stem = entry.name.slice(0, -'.json'.length)
    if (live.has(stem)) continue
    const target = path.join(dir, entry.name)
    const stat = await safeStat(target)
    await remove(target)
    bytes += stat?.size ?? 0
    count += 1
  }
  return { bytes, count }
}

/** 清理孤儿附件（没有任何会话引用）。 */
export async function cleanOrphanAttachments(ctx, dshHome) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence) throw new Error('sessionPersistence 服务不可用')
  const snapshots = await persistence.list()
  const scanned = await buildReferenceIndex(ctx, snapshots)
  if (scanned.failures.length > 0) {
    throw new Error(`有 ${scanned.failures.length} 个会话无法读取，为避免误删已中止附件清理`)
  }
  const referenced = new Set()
  for (const attachmentId of scanned.refs.keys()) {
    const paths = attachmentPaths(dshHome, attachmentId)
    if (paths) referenced.add(paths.digest)
  }
  const root = path.join(dshHome, 'attachments', 'v1')
  const digests = await listAttachmentDigests(dshHome)
  let bytes = 0
  let count = 0
  for (const digest of digests) {
    if (referenced.has(digest)) continue
    const shard = digest.slice(0, 2)
    let freed = 0
    for (const target of [
      path.join(root, 'objects', shard, digest),
      path.join(root, 'file-objects', shard, digest),
      path.join(root, 'files', shard, digest),
    ]) {
      const stat = await safeStat(target)
      if (!stat) continue
      if (stat.isDirectory()) {
        freed += (await measure(target)).bytes
        await remove(target)
      } else {
        freed += stat.size
        await remove(target)
      }
    }
    if (freed > 0) {
      bytes += freed
      count += 1
    }
  }
  return { bytes, count, scannedSessions: scanned.scanned }
}
