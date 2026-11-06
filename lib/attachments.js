/**
 * dsh-storage-monitor · 附件引用扫描
 *
 * 会话日志里以 `attachmentId` 引用附件对象：
 *   - 图片/普通附件对象：<DSH_HOME>/attachments/v1/objects/<2位>/<sha256>
 *   - 通用文件对象：    <DSH_HOME>/attachments/v1/file-objects/<2位>/<sha256>
 *   - 文件硬链接视图：  <DSH_HOME>/attachments/v1/files/<2位>/<sha256>/<name>
 *
 * 宿主没有暴露“按会话枚举附件”的 API，因此这里通过 sessionPersistence
 * 打开会话日志、遍历事件里的 attachmentId 得到准确引用关系：
 *   - 删除会话时，只删“仅被该会话引用”的附件，共享附件保留；
 *   - 深度扫描时，统计孤儿附件（没有任何会话引用的对象）。
 */
import path from 'node:path'
import { listDir, safeStat } from './util.js'

const ATTACHMENT_KEYS = new Set(['attachmentId'])
const MAX_DEPTH = 40

/** 遍历一个事件树，收集 attachmentId 字符串。 */
function collectAttachmentIds(value, out, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentIds(item, out, depth + 1)
    return
  }
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (ATTACHMENT_KEYS.has(key) && typeof child === 'string' && child.length > 0) {
      out.add(child)
      continue
    }
    if (child !== null && typeof child === 'object') collectAttachmentIds(child, out, depth + 1)
  }
}

/** 从事件数组收集附件 id。 */
export function attachmentIdsFromEvents(events) {
  const ids = new Set()
  for (const event of events ?? []) collectAttachmentIds(event, ids)
  return ids
}

/** 读取一个会话的全部事件；失败返回 { error }。 */
export async function readSessionEvents(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence) return { error: 'sessionPersistence 服务不可用' }
  let handle
  try {
    handle = await persistence.open(sessionId, 'read')
    const result = await handle.read(0, Number.MAX_SAFE_INTEGER)
    return { events: result.events ?? [], eventState: result.eventState }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        /* 关闭失败不影响结论 */
      }
    }
  }
}

/** 读取一个会话引用的附件 id 集合。 */
export async function attachmentIdsOfSession(ctx, sessionId) {
  const { events, error } = await readSessionEvents(ctx, sessionId)
  if (error) return { ids: new Set(), error }
  return { ids: attachmentIdsFromEvents(events) }
}

function digestOf(attachmentId) {
  const raw = String(attachmentId ?? '').trim()
  const digest = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw
  if (!/^[0-9a-f]{64}$/i.test(digest)) return undefined
  return digest.toLowerCase()
}

/**
 * 附件 id → 可能的磁盘路径集合。
 * 同一个 id 可能是图片对象、通用文件对象（且带一个硬链接视图目录）。
 */
export function attachmentPaths(dshHome, attachmentId) {
  const digest = digestOf(attachmentId)
  if (!digest) return undefined
  const root = path.join(dshHome, 'attachments', 'v1')
  const shard = digest.slice(0, 2)
  return {
    digest,
    imageObject: path.join(root, 'objects', shard, digest),
    fileObject: path.join(root, 'file-objects', shard, digest),
    fileViewDir: path.join(root, 'files', shard, digest),
  }
}

/** 附件对象占用的实际字节数（对象文件 + 硬链接视图目录）。 */
export async function attachmentBytes(dshHome, attachmentId) {
  const paths = attachmentPaths(dshHome, attachmentId)
  if (!paths) return 0
  const image = await safeStat(paths.imageObject)
  if (image?.isFile()) return image.size
  const fileObject = await safeStat(paths.fileObject)
  // 通用文件的 files/<shard>/<digest>/<name> 是同一 inode 的硬链接，
  // 磁盘上只占一份，不能重复累加。
  if (fileObject?.isFile()) return fileObject.size
  return 0
}

/** 列出附件存储里所有对象 digest（图片 + 通用文件 + 视图）。 */
export async function listAttachmentDigests(dshHome) {
  const root = path.join(dshHome, 'attachments', 'v1')
  const digests = new Set()
  const images = path.join(root, 'objects')
  const files = path.join(root, 'file-objects')
  const views = path.join(root, 'files')
  for (const shard of await listDir(images)) {
    if (!shard.isDirectory()) continue
    for (const entry of await listDir(path.join(images, shard.name))) {
      if (entry.isFile()) digests.add(entry.name.toLowerCase())
    }
  }
  for (const shard of await listDir(files)) {
    if (!shard.isDirectory()) continue
    for (const entry of await listDir(path.join(files, shard.name))) {
      if (entry.isFile()) digests.add(entry.name.toLowerCase())
    }
  }
  for (const shard of await listDir(views)) {
    if (!shard.isDirectory()) continue
    for (const entry of await listDir(path.join(views, shard.name))) {
      if (entry.isDirectory()) digests.add(entry.name.toLowerCase())
    }
  }
  return digests
}

/** 附件存储结构的内存缓存（供深度扫描复用）。 */
export function createAttachmentIndex(dshHome) {
  return {
    dshHome,
    /** @type {Map<string, Set<string>>} attachmentId → 引用它的 sessionId 集合 */
    refs: new Map(),
    /** @type {Map<string, number>} attachmentId → 字节数 */
    bytes: new Map(),
  }
}

/** 记录一次引用。 */
export function noteReference(index, sessionId, attachmentId) {
  let set = index.refs.get(attachmentId)
  if (!set) {
    set = new Set()
    index.refs.set(attachmentId, set)
  }
  set.add(sessionId)
}

/** 补齐被引用附件的字节数。 */
export async function hydrateAttachmentBytes(index) {
  for (const attachmentId of index.refs.keys()) {
    if (!index.bytes.has(attachmentId)) {
      index.bytes.set(attachmentId, await attachmentBytes(index.dshHome, attachmentId))
    }
  }
}

/** 一个会话的附件归属：{ bytes, count, sharedCount }。 */
export function sessionAttachmentStats(index, sessionId) {
  let bytes = 0
  let count = 0
  let sharedCount = 0
  for (const [attachmentId, sessions] of index.refs.entries()) {
    if (!sessions.has(sessionId)) continue
    count += 1
    bytes += index.bytes.get(attachmentId) ?? 0
    if (sessions.size > 1) sharedCount += 1
  }
  return { bytes, count, sharedCount }
}
