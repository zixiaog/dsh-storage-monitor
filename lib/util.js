/**
 * dsh-storage-monitor · Host 侧基础工具
 *
 * 只依赖 Node 内置模块：插件安装在 profile 里，无法可靠 import 宿主包
 * （@deepseek-ai/* 只存在于 dsh 安装目录/asar 内），因此所有能力都通过
 * Node API + ctx 服务完成。
 */
import { promises as fsp } from 'node:fs'
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 解析 DSH_HOME：优先环境变量，其次 ~/.dsh。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 解析当前 profile 目录；没有 profile 时返回 undefined。
 *
 * 注意：DSH_PROFILE_DIR 只注入到 shell，宿主进程里通常没有；因此还要从
 * DSH_HOME/profiles 里推断（单 profile 直接取，多 profile 取最近修改的
 * cordis.patch.yml 所在目录）。
 */
export function resolveProfileDir() {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim())
  const home = resolveDshHome()
  const profileName = process.env.DSH_PROFILE
  if (typeof profileName === 'string' && profileName.trim()) {
    const named = path.join(home, 'profiles', profileName.trim())
    if (existsSync(named)) return named
  }
  const profilesRoot = path.join(home, 'profiles')
  let candidates = []
  try {
    candidates = readdirSync(profilesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return undefined
  }
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return path.join(profilesRoot, candidates[0].name)
  let best
  let bestTime = -1
  for (const entry of candidates) {
    const dir = path.join(profilesRoot, entry.name)
    const marker = path.join(dir, 'cordis.patch.yml')
    try {
      const time = statSync(marker).mtimeMs
      if (time > bestTime) {
        bestTime = time
        best = dir
      }
    } catch {
      /* 没有 patch 的 profile 优先级最低 */
      if (!best) best = dir
    }
  }
  return best
}

/** 存储监测插件自己的数据目录（回收站等）。 */
export function monitorRoot(dshHome) {
  return path.join(dshHome, 'storage-monitor')
}

/** 人类可读字节数。 */
export function humanBytes(bytes) {
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

/** 目录/文件是否存在。 */
export async function exists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/** 读取 stat；不存在返回 undefined（不抛错）。 */
export async function safeStat(target) {
  try {
    return await fsp.stat(target)
  } catch {
    return undefined
  }
}

/** 读取 JSON；不存在/损坏返回 undefined。 */
export async function readJson(target) {
  try {
    return JSON.parse(await fsp.readFile(target, 'utf8'))
  } catch {
    return undefined
  }
}

/** 原子写 JSON（先写临时文件再改名）。 */
export async function writeJson(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(temporary, target)
}

/** 确保 target 位于 root 内（含根自身），用于所有删除/移动前的路径校验。 */
export function assertInside(root, target) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (relative === '') return resolvedTarget
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝操作工作目录之外的路径: ${resolvedTarget}`)
  }
  return resolvedTarget
}

/**
 * 递归统计目录大小与文件数。
 *
 * 设计取舍：
 * - 不跟随符号链接（junction/symlink 只记一次自身，避免把 profile 链接算两遍）。
 * - 单次遍历同时产出一级子项占用，供分类明细直接使用。
 * - 目录内按 48 个一批并发 stat，避免大目录把页面拖到数秒。
 * - `maxEntries` 兜底，防止异常大的目录把扫描拖死；被截断时返回 truncated。
 *
 * @param {string} target 目标路径（文件或目录）
 * @param {{ maxEntries?: number, ignore?: (name: string, fullPath: string) => boolean }} [options]
 * @returns {Promise<{ bytes: number, files: number, dirs: number, entries: number, truncated: boolean, children: Array<{ name: string, path: string, bytes: number, files: number, isDirectory: boolean }> }>}
 */
export async function measure(target, options = {}) {
  const maxEntries = options.maxEntries ?? 200000
  const ignore = options.ignore
  const result = { bytes: 0, files: 0, dirs: 0, entries: 0, truncated: false, children: [] }
  let stat
  try {
    // 根路径可能本身是 Junction（迁移后）：lstat 会把它当成链接，必须用 stat 跟随。
    stat = await fsp.stat(target)
  } catch {
    return result
  }
  if (!stat.isDirectory()) {
    result.bytes = stat.size
    result.files = 1
    result.entries = 1
    return result
  }
  result.dirs = 1
  const childAccumulator = new Map()
  const stack = [{ dir: target, depth: 0, rootChild: undefined }]
  const BATCH = options.batch ?? 128
  while (stack.length > 0) {
    if (result.entries >= maxEntries) {
      result.truncated = true
      break
    }
    const current = stack.pop()
    let names = []
    try {
      names = await fsp.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (let offset = 0; offset < names.length; offset += BATCH) {
      if (result.entries >= maxEntries) {
        result.truncated = true
        break
      }
      const batch = names.slice(offset, offset + BATCH)
      const inspected = await Promise.all(
        batch.map(async (entry) => {
          const fullPath = path.join(current.dir, entry.name)
          if (ignore && ignore(entry.name, fullPath)) return null
          if (entry.isSymbolicLink()) return null
          let entryStat
          try {
            entryStat = await fsp.stat(fullPath)
          } catch {
            return null
          }
          return { entry, fullPath, entryStat }
        }),
      )
      for (const item of inspected) {
        if (!item) continue
        result.entries += 1
        if (result.entries > maxEntries) {
          result.truncated = true
          break
        }
        const rootChild = current.depth === 0 ? item.entry.name : current.rootChild
        const accumulator = childAccumulator.get(rootChild) ?? {
          name: rootChild,
          path: current.depth === 0 ? item.fullPath : path.join(target, rootChild),
          bytes: 0,
          files: 0,
          isDirectory: false,
        }
        if (item.entryStat.isDirectory()) {
          result.dirs += 1
          accumulator.isDirectory = true
          stack.push({ dir: item.fullPath, depth: current.depth + 1, rootChild })
        } else if (item.entryStat.isFile()) {
          result.bytes += item.entryStat.size
          result.files += 1
          accumulator.bytes += item.entryStat.size
          accumulator.files += 1
        } else {
          // 其他类型（管道、设备等）通常不计入存储占用。
          continue
        }
        childAccumulator.set(rootChild, accumulator)
      }
    }
  }
  result.children = [...childAccumulator.values()].sort((a, b) => b.bytes - a.bytes)
  return result
}

/** 单文件字节数。 */
export async function fileBytes(target) {
  const stat = await safeStat(target)
  return stat && stat.isFile() ? stat.size : 0
}

/** 删除目录/文件（不存在视为成功）。 */
export async function remove(target) {
  await fsp.rm(target, { recursive: true, force: true })
}

/** 移动目录/文件；跨盘时退回“复制再删除”。 */
export async function move(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  try {
    await fsp.rename(from, to)
  } catch (error) {
    if (error && (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'ENOTEMPTY')) {
      await fsp.cp(from, to, { recursive: true, force: true })
      await fsp.rm(from, { recursive: true, force: true })
      return
    }
    throw error
  }
}

/** 时间戳 → ISO。 */
export function iso(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : null
}

/** 读取目录项（失败返回空数组）。 */
export async function listDir(target, options = {}) {
  try {
    return await fsp.readdir(target, { withFileTypes: true, ...options })
  } catch {
    return []
  }
}

/** 截断文本。 */
export function clampText(text, max = 80) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

/**
 * 有限并发映射。深度扫描要逐个解码会话日志，并发 2 既能提速，
 * 又不会把多个大日志的事件树同时留在内存里。
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    }),
  )
  return results
}
