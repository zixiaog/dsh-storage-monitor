/**
 * dsh-storage-monitor · 路径迁移 / 映射
 *
 * 目标：把 DSH 数据目录（或 profile）搬到其它磁盘，并在原路径创建 Windows
 * Junction，让 DSH 继续使用原路径、但实际数据落在新盘上。
 *
 * 为什么不能在线切换：
 *   - 会话日志、附件、插件包在 DSH 运行期间有打开的文件句柄，Windows 无法
 *     原子地 rename 正在使用的目录；
 *   - 因此流程拆成两步：
 *       1) 在线预拷贝（本模块，DSH 运行时执行），把绝大部分文件搬到目标盘；
 *       2) 关闭 DSH 后运行生成的 PowerShell 脚本：robocopy /MIR 做最终同步，
 *          把原目录改名为备份，创建 Junction，验证映射，再删除备份释放空间。
 *
 * 安全设计：
 *   - 预拷贝只读源目录、只写目标目录，不改动源；
 *   - 切换脚本在 DSH 退出后才执行，并带自动回滚（Junction 创建失败会还原目录名）；
 *   - 默认保留备份开关 `-KeepBackup`，不加时验证映射成功后才删备份；
 *   - 回滚脚本可把数据从目标盘搬回原盘并移除 Junction。
 */
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { constants as fsConstants, promises as fsp, existsSync } from 'node:fs'
import { measure, resolveDshHome, resolveProfileDir, humanBytes } from './util.js'

const execFileAsync = promisify(execFile)

const MIGRATION_VERSION = 1

// ---------------------------------------------------------------------------
// 基础路径工具
// ---------------------------------------------------------------------------

function normalizeLinkTarget(value, baseDir) {
  if (!value) return undefined
  let target = String(value)
  if (target.startsWith('\\\\?\\')) target = target.slice(4)
  if (!path.isAbsolute(target)) target = path.resolve(baseDir, target)
  return path.resolve(target)
}

/** lstat + Junction 信息。 */
export async function linkInfo(target) {
  let stat
  try {
    stat = await fsp.lstat(target)
  } catch {
    return { exists: false, isDirectory: false, isJunction: false, target: undefined }
  }
  let linkTarget
  if (stat.isSymbolicLink()) {
    try {
      linkTarget = normalizeLinkTarget(await fsp.readlink(target), path.dirname(target))
    } catch {
      linkTarget = undefined
    }
  }
  return {
    exists: true,
    isDirectory: stat.isDirectory() || Boolean(linkTarget),
    isJunction: stat.isSymbolicLink(),
    target: linkTarget,
    mtime: stat.mtimeMs,
  }
}

function nearestExisting(target) {
  let current = path.resolve(target)
  for (;;) {
    if (existsSync(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
}

async function freeSpace(target) {
  try {
    const stat = await fsp.statfs(nearestExisting(target))
    const blockSize = Number(stat.bsize) || 4096
    const free = Number(stat.bavail ?? stat.bfree) * blockSize
    const total = Number(stat.blocks) * blockSize
    return { free, total, ok: true }
  } catch (error) {
    return { free: 0, total: 0, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function canWrite(target) {
  const existing = nearestExisting(target)
  try {
    await fsp.access(existing, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

function sameVolume(a, b) {
  return path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase()
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

// ---------------------------------------------------------------------------
// 源定义与扫描
// ---------------------------------------------------------------------------

export function sourceDefinitions() {
  const dshHome = resolveDshHome()
  const profileDir = resolveProfileDir()
  const sources = [
    {
      key: 'dshHome',
      title: 'DSH 数据目录',
      description: '会话、附件、缓存、插件、运行时全部在这里（含 profile）',
      path: dshHome,
      recommended: true,
    },
  ]
  if (profileDir) {
    sources.push({
      key: 'profile',
      title: 'profile 目录',
      description: '已安装插件与 profile 配置；位于 DSH 数据目录内部',
      path: profileDir,
      insideDshHome: isInside(dshHome, profileDir) || path.resolve(profileDir) === path.resolve(dshHome),
    })
  }
  return sources
}

/** 单个源路径的扫描结果（60 秒缓存，避免切换页面反复测量）。 */
const scanCache = new Map()

export async function scanSource(key, options = {}) {
  const definition = sourceDefinitions().find((item) => item.key === key)
  if (!definition) throw new Error(`未知的迁移源: ${String(key)}`)
  const cached = scanCache.get(key)
  if (!options.refresh && cached && Date.now() - cached.time < 60000) return cached.data
  const info = await linkInfo(definition.path)
  const effectivePath = info.isJunction && info.target ? info.target : definition.path
  const measured = await measure(effectivePath, { maxEntries: 400000 })
  let coveredBy = null
  if (definition.key === 'profile' && definition.insideDshHome) {
    try {
      const homeInfo = await linkInfo(resolveDshHome())
      if (homeInfo.isJunction && homeInfo.target) coveredBy = 'dshHome'
    } catch {}
  }
  const data = {
    key: definition.key,
    title: definition.title,
    description: definition.description,
    path: definition.path,
    effectivePath,
    recommended: Boolean(definition.recommended),
    insideDshHome: Boolean(definition.insideDshHome),
    coveredBy,
    exists: info.exists,
    isJunction: info.isJunction,
    junctionTarget: info.target ?? null,
    bytes: measured.bytes,
    files: measured.files,
    truncated: measured.truncated,
    children: measured.children.slice(0, 6).map((child) => ({
      name: child.name,
      bytes: child.bytes,
      files: child.files,
      isDirectory: child.isDirectory,
    })),
  }
  scanCache.set(key, { time: Date.now(), data })
  return data
}

/** 列出本机固定磁盘与剩余空间。 */
export async function listDrives() {
  const drives = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    if (!existsSync(root)) continue
    const space = await freeSpace(root)
    if (!space.ok) continue
    drives.push({ root: `${letter}:`, free: space.free, total: space.total, freeHuman: humanBytes(space.free) })
  }
  return drives
}

function suggestedTarget(drives, sourcePath) {
  const sourceRoot = path.parse(path.resolve(sourcePath)).root
  const other = drives.find((drive) => drive.root.toLowerCase() !== sourceRoot.toLowerCase().replace(/\\$/, '') && drive.free > 8 * 1024 * 1024 * 1024)
  const drive = other ?? drives.find((item) => item.free > 3 * 1024 * 1024 * 1024) ?? drives[0]
  if (!drive) return undefined
  const folder = path.basename(path.resolve(sourcePath)).replace(/^\./, '') || 'dsh-data'
  return path.join(`${drive.root}\\`, `DSH-${folder}`)
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function check(list, id, level, message, extra = {}) {
  list.push({ id, level, message, ...extra })
}

/**
 * 校验迁移目标。
 * @param {{ sourceKey: string, target: string, excludeCache?: boolean }} request
 */
export async function validateMigration(request) {
  const checks = []
  if (process.platform !== 'win32') {
    check(checks, 'platform', 'error', '路径映射迁移目前仅支持 Windows（依赖 NTFS Junction）')
  }
  const sourceKey = String(request?.sourceKey ?? 'dshHome')
  const rawTarget = String(request?.target ?? '').trim()
  const excludeCache = request?.excludeCache !== false
  const source = await scanSource(sourceKey, { refresh: true })

  if (!source.exists) check(checks, 'source-exists', 'error', '源路径不存在')
  if (source.isJunction) {
    check(checks, 'source-junction', 'error', `源路径已经是映射（→ ${source.junctionTarget ?? '未知目标'}），无需再次迁移`)
  }

  if (!rawTarget) {
    check(checks, 'target-required', 'error', '请填写目标目录')
    return { ok: false, source, target: rawTarget, checks, estimate: null, drives: await listDrives() }
  }
  if (!path.isAbsolute(rawTarget)) check(checks, 'target-absolute', 'error', '目标目录必须是绝对路径，例如 F:\\DSHData')
  const target = path.resolve(rawTarget)
  if (path.parse(target).root.toLowerCase() === target.toLowerCase()) check(checks, 'target-root', 'error', '不要把整块磁盘根目录作为目标，请选择专用子目录')
  if (path.resolve(target).toLowerCase() === path.resolve(source.path).toLowerCase()) check(checks, 'target-same', 'error', '目标目录不能与源目录相同')
  if (isInside(source.path, target)) check(checks, 'target-inside-source', 'error', '目标目录不能位于源目录内部')
  if (isInside(target, source.path)) check(checks, 'source-inside-target', 'error', '源目录不能位于目标目录内部')

  if (source.exists && target) {
    const targetInfo = await linkInfo(target)
    if (targetInfo.exists) {
      if (!targetInfo.isDirectory) check(checks, 'target-type', 'error', '目标路径已存在且不是目录')
      else {
        const entries = await fsp.readdir(target).catch(() => [])
        // 允许预拷贝产生的目录：只要包含迁移标记或为空。
        const marker = await fsp.stat(path.join(target, '.dsh-storage-monitor-migration')).catch(() => undefined)
        if (entries.length > 0 && !marker) check(checks, 'target-empty', 'error', '目标目录必须为空（或由此工具预拷贝产生）')
      }
    } else if (!(await canWrite(target))) {
      check(checks, 'target-writable', 'error', '目标目录不可写（检查磁盘权限）')
    }
    if (!sameVolume(source.path, target)) {
      check(checks, 'target-volume', 'ok', '目标位于其它磁盘，迁移后可释放源盘空间')
    } else {
      check(checks, 'target-volume', 'warn', '目标与源在同一磁盘，映射后不会释放该磁盘空间')
    }

    const excludeBytes = excludeCache ? (source.children.find((child) => child.name === 'cache')?.bytes ?? 0) : 0
    const needed = Math.max(0, source.bytes - excludeBytes)
    const space = await freeSpace(target)
    if (!space.ok) check(checks, 'target-space', 'error', '无法读取目标磁盘剩余空间')
    else if (space.free < needed * 1.05 + 200 * 1024 * 1024) {
      check(checks, 'target-space', 'error', `目标磁盘剩余 ${humanBytes(space.free)}，至少需要 ${humanBytes(needed * 1.05 + 200 * 1024 * 1024)}`)
    } else {
      check(checks, 'target-space', 'ok', `目标磁盘剩余 ${humanBytes(space.free)}，需要约 ${humanBytes(needed)}`)
    }

    // 脚本目录（目标同级 "<target>-migration"）必须可写。
    const scriptDir = `${target}-migration`
    if (!(await canWrite(scriptDir))) check(checks, 'script-dir', 'error', '无法在目标同级的迁移脚本目录写入文件')
    else check(checks, 'script-dir', 'ok', `切换脚本会写到 ${scriptDir}`)

    if (sourceKey === 'profile') {
      const home = await scanSource('dshHome').catch(() => undefined)
      if (home?.isJunction) check(checks, 'profile-parent', 'warn', 'DSH 数据目录已映射，profile 已随数据目录迁移，通常无需单独迁移')
      else check(checks, 'profile-parent', 'warn', '只迁移 profile 时，DSH 数据目录仍留在原盘；如需整体迁移请选择 DSH 数据目录')
    }
    if (sourceKey === 'dshHome') {
      check(checks, 'includes-profile', 'ok', 'DSH 数据目录包含 profile，一次迁移即可全部搬到目标盘')
    }

    const estimate = {
      sourceBytes: source.bytes,
      excludedBytes: excludeBytes,
      copyBytes: needed,
      files: source.files,
      free: space.ok ? space.free : null,
      freeHuman: space.ok ? humanBytes(space.free) : null,
      required: needed * 1.05 + 200 * 1024 * 1024,
      requiredHuman: humanBytes(needed * 1.05 + 200 * 1024 * 1024),
      scriptDir,
    }
    const ok = !checks.some((item) => item.level === 'error')
    return { ok, source, target, checks, estimate, drives: await listDrives(), excludeCache }
  }

  const ok = !checks.some((item) => item.level === 'error')
  return { ok, source, target, checks, estimate: null, drives: await listDrives(), excludeCache }
}

// ---------------------------------------------------------------------------
// 在线预拷贝任务
// ---------------------------------------------------------------------------

let activeJob = null

function jobSnapshot() {
  if (!activeJob) return null
  const elapsed = (activeJob.finishedAt ?? Date.now()) - activeJob.startedAt
  return {
    id: activeJob.id,
    sourceKey: activeJob.sourceKey,
    source: activeJob.source,
    target: activeJob.target,
    excludeCache: activeJob.excludeCache,
    state: activeJob.state,
    phase: activeJob.phase ?? 'preparing',
    totalBytes: activeJob.totalBytes,
    copiedBytes: activeJob.copiedBytes,
    totalFiles: activeJob.totalFiles,
    copiedFiles: activeJob.copiedFiles,
    scannedFiles: activeJob.scannedFiles ?? 0,
    links: activeJob.links,
    copiedLinks: activeJob.copiedLinks,
    skipped: activeJob.skipped.slice(0, 30),
    skippedCount: activeJob.skipped.length,
    startedAt: activeJob.startedAt,
    finishedAt: activeJob.finishedAt ?? null,
    elapsedMs: elapsed,
    error: activeJob.error ?? null,
    current: activeJob.current ?? null,
  }
}

/**
 * 启动在线预拷贝（调用 Windows robocopy，保留 Junction，多线程复制）。
 * robocopy 不提供可解析的进度，进度以“阶段 + 已用时间 + 完成后统计”呈现；
 * 真正的最终同步由关闭 DSH 后的切换脚本再跑一次 /MIR 完成。
 * @param {{ sourceKey: string, target: string, excludeCache?: boolean }} request
 */
export async function startCopy(request) {
  if (process.platform !== 'win32') throw new Error('路径映射迁移目前仅支持 Windows（Junction）')
  if (activeJob && activeJob.state === 'running') throw new Error('已有迁移任务在运行')
  const validation = await validateMigration(request)
  if (!validation.ok) {
    const first = validation.checks.find((item) => item.level === 'error')
    throw new Error(first ? first.message : '迁移校验未通过')
  }
  const target = validation.target
  await fsp.mkdir(target, { recursive: true })
  // 标记目录，下次校验允许非空目标（预拷贝产物）。
  const markerPath = path.join(target, '.dsh-storage-monitor-migration')
  if (!existsSync(markerPath)) {
    await fsp.writeFile(
      markerPath,
      JSON.stringify({ version: MIGRATION_VERSION, source: validation.source.path, createdAt: Date.now() }, null, 2),
      'utf8',
    )
  }
  activeJob = {
    id: `migrate-${Date.now()}`,
    sourceKey: validation.source.key,
    source: validation.source.path,
    target,
    excludeCache: Boolean(request?.excludeCache),
    state: 'running',
    phase: 'copying',
    totalBytes: validation.estimate?.copyBytes ?? 0,
    copiedBytes: 0,
    totalFiles: validation.source.files,
    copiedFiles: 0,
    links: 0,
    copiedLinks: 0,
    skipped: [],
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    child: null,
    cancelled: false,
  }
  const job = activeJob
  const args = [job.source, target, '/E', '/SL', '/SJ', '/MT:8', '/R:2', '/W:2', '/NFL', '/NDL', '/NP', '/NJH', '/NJS']
  if (job.excludeCache) args.push('/XD', path.join(job.source, 'cache'))
  let child
  try {
    child = spawn('robocopy', args, { windowsHide: true, stdio: 'ignore' })
  } catch (error) {
    job.state = 'failed'
    job.error = `无法启动 robocopy：${error instanceof Error ? error.message : String(error)}`
    job.finishedAt = Date.now()
    return jobSnapshot()
  }
  job.child = child
  child.on('error', (error) => {
    job.state = 'failed'
    job.error = `robocopy 启动失败：${error instanceof Error ? error.message : String(error)}`
    job.finishedAt = Date.now()
  })
  child.on('close', (code) => {
    job.child = null
    if (job.cancelled) {
      job.state = 'cancelled'
      job.finishedAt = Date.now()
      return
    }
    if (code >= 8) {
      job.state = 'failed'
      job.error = `robocopy 退出码 ${code}（>=8 表示复制失败）`
      job.finishedAt = Date.now()
      return
    }
    measure(target, { maxEntries: 400000 })
      .then((measured) => {
        job.copiedBytes = measured.bytes
        job.copiedFiles = measured.files
        job.totalBytes = Math.max(job.totalBytes, measured.bytes)
        job.totalFiles = Math.max(job.totalFiles, measured.files)
      })
      .catch(() => {})
      .finally(() => {
        job.state = 'done'
        job.finishedAt = Date.now()
      })
  })
  return jobSnapshot()
}

export function getJob() {
  return jobSnapshot()
}

export function cancelJob() {
  if (!activeJob || activeJob.state !== 'running') return jobSnapshot()
  activeJob.cancelled = true
  try {
    activeJob.child?.kill()
  } catch {
    /* 忽略终止失败 */
  }
  activeJob.state = 'cancelled'
  activeJob.finishedAt = Date.now()
  return jobSnapshot()
}

// ---------------------------------------------------------------------------
// 切换 / 回滚脚本
// ---------------------------------------------------------------------------

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function shellQuoteForBat(value) {
  return String(value).replace(/"/g, '""')
}

function resolvePort(ctx) {
  try {
    const origin = ctx.get('webServer')?.getOrigin?.()
    if (origin) return Number(new URL(origin).port) || 64886
  } catch {
    /* 使用默认端口 */
  }
  return 64886
}

function buildScripts({ source, target, sourceKey, excludeCache, port, pid }) {
  const excludeLine = excludeCache ? `  $rcArgs += @('/XD', (Join-Path $Source 'cache'))` : ''
  const common = `
param([switch]$KeepBackup, [switch]$RemoveTarget)
$ErrorActionPreference = 'Stop'
$Source = ${psQuote(source)}
$Target = ${psQuote(target)}
$Port = ${Number(port) || 64886}
$DshPid = ${Number(pid) || 0}
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile = Join-Path $PSScriptRoot ('migration-' + $Stamp + '.log')

function Log([string]$Message) {
  $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $Message
  Write-Host $line
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Wait-DshStopped {
  if ($DshPid -gt 0) {
    Log ('waiting for DSH process ' + $DshPid + ' to exit ...')
    $deadline = (Get-Date).AddMinutes(3)
    while (Get-Process -Id $DshPid -ErrorAction SilentlyContinue) {
      if ((Get-Date) -gt $deadline) { throw 'DSH is still running. Quit DSH completely, then run this script again.' }
      Start-Sleep -Seconds 2
    }
  }
  Log ('waiting for web port ' + $Port + ' to be free ...')
  $deadline = (Get-Date).AddMinutes(3)
  while (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { throw ('port ' + $Port + ' is still listening. Quit DSH completely, then run again.') }
    Start-Sleep -Seconds 2
  }
  Log 'DSH is stopped'
}

function Copy-Tree([string]$From, [string]$To) {
  if (-not (Test-Path -LiteralPath $From)) { throw ('source does not exist: ' + $From) }
  $rcArgs = @($From, $To, '/MIR', '/SL', '/SJ', '/R:2', '/W:2', '/NFL', '/NDL', '/NP', '/NJH', '/NJS')
${excludeLine}
  Log ('robocopy ' + $From + ' -> ' + $To)
  & robocopy @rcArgs | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw ('robocopy failed with exit code ' + $code) }
  Log ('robocopy exit code ' + $code)
}
`

  const switchScript = `#Requires -Version 5.1
<#
  dsh-storage-monitor - switch ${sourceKey} to another drive.
  Generated: ${new Date().toISOString()}
  Source : ${source}
  Target : ${target}

  Run this script ONLY after quitting DeepSeek Harness (DSH).
  It mirrors the data, renames the old directory to a backup, creates a
  junction at the original path, verifies it, then removes the backup
  unless -KeepBackup is given.
#>
${common}
Log '=== switch ${sourceKey} ==='
Wait-DshStopped
if (-not (Test-Path -LiteralPath $Target)) { throw ('target does not exist: ' + $Target) }
if (-not (Test-Path -LiteralPath $Source)) { throw ('source does not exist: ' + $Source) }
$sourceItem = Get-Item -LiteralPath $Source -Force
if ($sourceItem.LinkType -eq 'Junction') { throw 'source is already a junction; nothing to do' }

Copy-Tree $Source $Target

$Backup = $Source + '.pre-migration-' + $Stamp
Log ('renaming source to ' + $Backup)
Rename-Item -LiteralPath $Source -NewName (Split-Path -Leaf $Backup)

$junctionCreated = $false
try {
  New-Item -ItemType Junction -Path $Source -Target $Target | Out-Null
  $junctionCreated = $true
  $probeName = '.stm-verify-' + $Stamp + '.tmp'
  Set-Content -LiteralPath (Join-Path $Source $probeName) -Value 'ok' -Encoding ASCII
  if (-not (Test-Path -LiteralPath (Join-Path $Target $probeName))) {
    throw 'junction verification failed: a write through the original path did not land on the target'
  }
  Remove-Item -LiteralPath (Join-Path $Source $probeName) -Force
  Log 'junction verified'
} catch {
  Log ('ERROR: ' + $_.Exception.Message)
  if ($junctionCreated) { cmd /c rmdir "$Source" | Out-Null }
  if (Test-Path -LiteralPath $Backup) { Rename-Item -LiteralPath $Backup -NewName (Split-Path -Leaf $Source) }
  throw
}

if ($KeepBackup) {
  Log ('backup kept at ' + $Backup + ' (source drive space is NOT reclaimed until it is deleted)')
} else {
  Log ('removing backup ' + $Backup)
  cmd /c rd /s /q "$Backup" | Out-Null
  if (Test-Path -LiteralPath $Backup) {
    Log ('WARNING: backup could not be fully removed. Delete it manually to reclaim space: ' + $Backup)
  } else {
    Log 'backup removed; source drive space reclaimed'
  }
}
Log 'DONE. Start DSH again - the original path now maps to the target.'
Log ('Target: ' + $Target)
`

  const rollbackScript = `#Requires -Version 5.1
<#
  dsh-storage-monitor - rollback ${sourceKey} mapping.
  Generated: ${new Date().toISOString()}
  Source : ${source}
  Target : ${target}

  Run this ONLY after quitting DSH. Removes the junction at the original path
  and copies the data back. The target directory is kept unless -RemoveTarget.
#>
${common}
Log '=== rollback ${sourceKey} ==='
Wait-DshStopped
if (-not (Test-Path -LiteralPath $Source)) { throw ('original path is missing: ' + $Source) }
$sourceItem = Get-Item -LiteralPath $Source -Force
if ($sourceItem.LinkType -ne 'Junction') { throw 'the original path is not a junction; nothing to roll back' }
cmd /c rmdir "$Source" | Out-Null
if (Test-Path -LiteralPath $Source) { throw 'failed to remove the junction' }
Log 'junction removed'
Copy-Tree $Target $Source
if ($RemoveTarget) {
  Log ('removing target directory ' + $Target)
  cmd /c rd /s /q "$Target" | Out-Null
}
Log 'DONE. Data restored to the original path. Start DSH again.'
`

  return { switchScript, rollbackScript, common }
}

/**
 * 生成切换 / 回滚脚本（写入目标同级目录）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ sourceKey: string, target?: string, excludeCache?: boolean, mode?: 'switch'|'rollback' }} request
 */
export async function generateScripts(ctx, request) {
  const mode = request?.mode === 'rollback' ? 'rollback' : 'switch'
  let source
  let target
  let excludeCache = request?.excludeCache !== false
  let warnings = []
  if (mode === 'rollback') {
    source = await scanSource(String(request?.sourceKey ?? 'dshHome'), { refresh: true })
    if (!source.isJunction || !source.junctionTarget) throw new Error('该路径不是映射（没有 Junction），无需回滚')
    target = source.junctionTarget
    const targetInfo = await linkInfo(target)
    if (!targetInfo.exists || !targetInfo.isDirectory) throw new Error(`映射目标不存在或不是目录：${target}`)
  } else {
    const validation = await validateMigration(request)
    if (!validation.ok) {
      const first = validation.checks.find((item) => item.level === 'error')
      throw new Error(first ? first.message : '迁移校验未通过')
    }
    source = validation.source
    target = validation.target
    excludeCache = request?.excludeCache !== false
    warnings = validation.checks.filter((item) => item.level === 'warn').map((item) => item.message)
  }
  const scriptDir = `${target}-migration`
  await fsp.mkdir(scriptDir, { recursive: true })
  // 预拷贝不是必需的：即使只生成脚本，也先把目标目录建好，脚本运行时才能 /MIR。
  await fsp.mkdir(target, { recursive: true })
  const markerPath = path.join(target, '.dsh-storage-monitor-migration')
  if (!existsSync(markerPath)) {
    await fsp.writeFile(
      markerPath,
      JSON.stringify({ version: MIGRATION_VERSION, source: source.path, createdAt: Date.now() }, null, 2),
      'utf8',
    )
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const { switchScript, rollbackScript } = buildScripts({
    source: source.path,
    target,
    sourceKey: source.key,
    excludeCache,
    port: resolvePort(ctx),
    pid: process.pid,
  })
  const switchPath = path.join(scriptDir, `switch-${source.key}-${stamp}.ps1`)
  const rollbackPath = path.join(scriptDir, `rollback-${source.key}-${stamp}.ps1`)
  // Windows PowerShell 5.1 默认按 ANSI 读取无 BOM 的 .ps1；路径可能含中文，必须写 UTF-8 BOM。
  const BOM = '\uFEFF'
  await fsp.writeFile(switchPath, BOM + switchScript, 'utf8')
  await fsp.writeFile(rollbackPath, BOM + rollbackScript, 'utf8')
  const switchBat = path.join(scriptDir, `switch-${source.key}-${stamp}.bat`)
  const rollbackBat = path.join(scriptDir, `rollback-${source.key}-${stamp}.bat`)
  await fsp.writeFile(
    switchBat,
    `@echo off\r\nchcp 65001 >nul\r\necho Close DSH completely before continuing.\r\npause\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${shellQuoteForBat(path.basename(switchPath))}" %*\r\necho.\r\npause\r\n`,
    'utf8',
  )
  await fsp.writeFile(
    rollbackBat,
    `@echo off\r\nchcp 65001 >nul\r\necho Close DSH completely before continuing.\r\npause\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${shellQuoteForBat(path.basename(rollbackPath))}" %*\r\necho.\r\npause\r\n`,
    'utf8',
  )
  const readmePath = path.join(scriptDir, 'README.txt')
  await fsp.writeFile(
    readmePath,
    [
      'dsh-storage-monitor migration scripts',
      '',
      `Source: ${source.path}`,
      `Target: ${target}`,
      '',
      'Steps:',
      '1. Quit DeepSeek Harness completely (tray icon too).',
      '2. Double-click the switch .bat, or run:',
      `   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${switchPath}"`,
      '3. Wait for "DONE", then start DSH again.',
      '',
      'The original path will be a junction to the target; data lives on the target drive.',
      'To undo, run the rollback script the same way.',
      '',
      `Generated: ${new Date().toISOString()}`,
    ].join('\r\n'),
    'utf8',
  )
  return {
    scriptDir,
    switchPath,
    rollbackPath,
    switchBat,
    rollbackBat,
    readmePath,
    command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${switchPath}"`,
    batCommand: `"${switchBat}"`,
    source: source.path,
    target,
    excludeCache,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 智能迁移：生成常驻控制台脚本 + 自动关闭/重启 DSH
// ---------------------------------------------------------------------------

function runnerDir(target) {
  return `${target}-migration`
}

function snapshotPathFor(target) {
  return path.join(runnerDir(target), 'snapshot.json')
}

/** 记录迁移前的基线，供重启后验证。 */
export async function createSnapshot(ctx, request) {
  const source = await scanSource(request?.sourceKey ?? 'dshHome', { refresh: true })
  const target = path.resolve(String(request?.target ?? ''))
  const persistence = ctx.get('sessionPersistence')
  let sessions = null
  try {
    sessions = persistence ? (await persistence.list()).length : null
  } catch {
    sessions = null
  }
  const profileDir = resolveProfileDir()
  let profilePackages = null
  if (profileDir) {
    try {
      profilePackages = (await fsp.readdir(path.join(profileDir, 'node_modules'))).filter((name) => !name.startsWith('.')).length
    } catch {
      profilePackages = null
    }
  }
  const snapshot = {
    version: MIGRATION_VERSION,
    createdAt: Date.now(),
    sourceKey: source.key,
    source: source.path,
    target,
    excludeCache: request?.excludeCache !== false,
    sessions,
    profilePackages,
    sourceBytes: source.bytes,
    sourceFiles: source.files,
  }
  await fsp.mkdir(runnerDir(target), { recursive: true })
  await fsp.writeFile(snapshotPathFor(target), JSON.stringify(snapshot, null, 2), 'utf8')
  return snapshot
}

export function buildRunnerScript(options) {
  const {
    source,
    sourceKey,
    target,
    port,
    pid,
    excludeCache,
    keepBackup,
    autoRestart,
    execPath,
    restartArgs,
    workingDir,
    electronPath,
    sourceBytes,
    snapshotPath,
    profileDir,
    mode = 'switch',
    startedFile,
  } = options
  const isRollback = mode === 'rollback'
  const argsLiteral = ['@(' , ...restartArgs.map((arg, index) => `  ${psQuote(arg)}${index === restartArgs.length - 1 ? '' : ','}`), ')'].join('\n')
  const excludeLine = excludeCache ? `  $rcArgs += @('/XD', (Join-Path $Source 'cache'))` : ''
  return `#Requires -Version 5.1
<#
  dsh-storage-monitor - one-click ${isRollback ? 'rollback' : 'migration'} console
  Generated: ${new Date().toISOString()}
  Source : ${source}
  Target : ${target}

  This window is intentionally detached from DSH. It will:
    1. wait a few seconds (Ctrl+C to cancel),
    2. close DSH (graceful window close, forced fallback, leftover cleanup),
    3. ${isRollback ? 'remove the junction and copy the data back,' : 'mirror the data to the target (robocopy),'}
    4. ${isRollback ? 'verify the original path,' : 'rename the old directory, create a junction, verify it,'}
    5. optionally restart DSH and wait for its web port.

  KEEP THIS WINDOW OPEN until it says DONE.
#>
param([switch]$RemoveTarget)
$ErrorActionPreference = 'Stop'
$Mode = ${psQuote(mode)}
$StartedFile = ${psQuote(startedFile ?? '')}
try { if ($StartedFile) { Set-Content -LiteralPath $StartedFile -Value ((Get-Date).ToString('o')) -Encoding ASCII } } catch {}
$Source = ${psQuote(source)}
$Target = ${psQuote(target)}
$Port = ${Number(port) || 64886}
$DshPid = ${Number(pid) || 0}
$ElectronPath = ${psQuote(electronPath)}
$ExecPath = ${psQuote(execPath)}
$WorkingDir = ${psQuote(workingDir)}
$RestartArgs = ${argsLiteral}
$SourceBytes = ${Number(sourceBytes) || 0}
$ExcludeCache = $${excludeCache ? 'true' : 'false'}
$KeepBackup = $${keepBackup ? 'true' : 'false'}
$AutoRestart = $${autoRestart ? 'true' : 'false'}
$SnapshotPath = ${psQuote(snapshotPath)}
$ProfileDir = ${psQuote(profileDir ?? '')}
$ScriptDir = $PSScriptRoot
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile = Join-Path $ScriptDir ('runner-' + $Stamp + '.log')
$Renamed = $false
$RollbackRemoved = $false
$Backup = ''
try { $Host.UI.RawUI.WindowTitle = '${isRollback ? 'DSH Storage Rollback' : 'DSH Storage Migration'} - keep this window open' } catch {}
try { Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate($PID) } catch {}

function Log([string]$Message, [string]$Color = 'Gray') {
  $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $Message
  Write-Host $line -ForegroundColor $Color
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
}
function Section([string]$Title) {
  Write-Host ''
  Write-Host ('=== ' + $Title + ' ===') -ForegroundColor Cyan
  Log ('--- ' + $Title + ' ---') 'Cyan'
}
function Test-Port([int]$TargetPort) {
  try {
    $client = New-Object Net.Sockets.TcpClient
    $task = $client.ConnectAsync('127.0.0.1', $TargetPort)
    $ok = $task.Wait(600) -and $client.Connected
    $client.Close()
    return $ok
  } catch { return $false }
}
function Wait-PortClosed([int]$TimeoutSec = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Test-Port $Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 400 }
  if (Test-Port $Port) { throw ('port ' + $Port + ' is still listening after ' + $TimeoutSec + 's') }
}
function Wait-PortOpen([int]$TimeoutSec = 180) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while (-not (Test-Port $Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  return (Test-Port $Port)
}
function Get-DirBytes([string]$Dir) {
  try {
    $sum = (Get-ChildItem -LiteralPath $Dir -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return 0 }
    return [int64]$sum
  } catch { return 0 }
}
function Stop-DshProcesses {
  $parent = Split-Path -Parent $ExecPath
  $electronParent = Split-Path -Parent $ElectronPath
  $killed = @()
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    try {
      if ($p.Id -eq $PID) { continue }
      $path = $p.Path
      if (-not $path) { continue }
      $isDsh = ($path -eq $ExecPath) -or ($path -eq $ElectronPath)
      if (-not $isDsh -and $parent) { $isDsh = $path.StartsWith($parent + '\\', [System.StringComparison]::OrdinalIgnoreCase) }
      if (-not $isDsh -and $electronParent) { $isDsh = $path.StartsWith($electronParent + '\\', [System.StringComparison]::OrdinalIgnoreCase) }
      if (-not $isDsh) { continue }
      $killed += $p.Id
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    } catch {}
  }
  if ($killed.Count -gt 0) { Log ('force-stopped leftover DSH process(es): ' + ($killed -join ', ')) 'Yellow' }
  $deadline = (Get-Date).AddSeconds(15)
  while ($killed.Count -gt 0 -and (Get-Date) -lt $deadline) {
    $alive = @()
    foreach ($id in $killed) { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $alive += $id } }
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
  }
}
function Close-Dsh {
  Section '关闭 DSH'
  $targets = @()
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    try {
      if ($p.Id -eq $PID) { continue }
      if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle) {
        if ($p.Id -eq $DshPid -or $p.Path -eq $ElectronPath -or $p.MainWindowTitle -match 'DeepSeek') { $targets += $p }
      }
    } catch {}
  }
  foreach ($p in ($targets | Sort-Object Id -Unique)) {
    Log ('sending close to window process ' + $p.Id + ' (' + $p.MainWindowTitle + ')')
    try { & taskkill /PID $p.Id 2>$null | Out-Null } catch {}
  }
  if ($targets.Count -eq 0) {
    Log 'no DSH window found; asking the host process to close'
    try { & taskkill /PID $DshPid 2>$null | Out-Null } catch {}
  }
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Process -Id $DshPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Get-Process -Id $DshPid -ErrorAction SilentlyContinue) {
    Log 'graceful close timed out; forcing DSH host process to exit' 'Yellow'
    try { & taskkill /PID $DshPid /F 2>$null | Out-Null } catch {}
  }
  # Electron leaves GPU/renderer/cache processes behind; keep them alive and the next
  # instance fails to acquire the disk cache ("Unable to move/create cache").
  Stop-DshProcesses
  Start-Sleep -Seconds 2
  Wait-PortClosed 60
  Start-Sleep -Seconds 1
  Log 'DSH is closed' 'Green'
}
function Invoke-RobocopySync {
  Section '最终同步数据'
  $rcArgs = @($Source, $Target, '/MIR', '/SL', '/SJ', '/MT:8', '/R:2', '/W:2', '/NFL', '/NDL', '/NP', '/NJH', '/NJS')
${excludeLine}
  Log ('robocopy ' + $Source + ' -> ' + $Target)
  $started = Get-Date
  $proc = Start-Process -FilePath 'robocopy.exe' -ArgumentList $rcArgs -NoNewWindow -PassThru
  while (-not $proc.HasExited) {
    $current = Get-DirBytes $Target
    $status = ('已同步 {0:N2} GB / 预计 {1:N2} GB，已用 {2:mm\\:ss}' -f ($current / 1GB), ($SourceBytes / 1GB), ((Get-Date) - $started))
    Write-Progress -Activity '最终同步数据（robocopy /MIR）' -Status $status
    Start-Sleep -Seconds 2
  }
  Write-Progress -Activity '最终同步数据（robocopy /MIR）' -Completed
  $code = $proc.ExitCode
  if ($code -ge 8) { throw ('robocopy failed with exit code ' + $code) }
  Log ('robocopy finished, exit code ' + $code) 'Green'
}
function Switch-Data {
  Section '创建映射并验证'
  $sourceItem = Get-Item -LiteralPath $Source -Force
  if ($sourceItem.LinkType -eq 'Junction') { throw 'source is already a junction' }
  $script:Backup = $Source + '.pre-migration-' + $Stamp
  Log ('renaming ' + $Source + ' -> ' + $script:Backup)
  Rename-Item -LiteralPath $Source -NewName (Split-Path -Leaf $script:Backup)
  $script:Renamed = $true
  try {
    New-Item -ItemType Junction -Path $Source -Target $Target | Out-Null
    $probeName = '.stm-verify-' + $Stamp + '.tmp'
    Set-Content -LiteralPath (Join-Path $Source $probeName) -Value 'ok' -Encoding ASCII
    if (-not (Test-Path -LiteralPath (Join-Path $Target $probeName))) { throw 'junction verification failed' }
    Remove-Item -LiteralPath (Join-Path $Source $probeName) -Force
    Log 'junction verified' 'Green'
  } catch {
    Log ('ERROR: ' + $_.Exception.Message) 'Red'
    try { cmd /c rmdir "$Source" | Out-Null } catch {}
    if (Test-Path -LiteralPath $script:Backup) { Rename-Item -LiteralPath $script:Backup -NewName (Split-Path -Leaf $Source) }
    $script:Renamed = $false
    throw
  }
  if ($KeepBackup) {
    Log ('backup kept: ' + $script:Backup + ' (delete it manually to reclaim space)') 'Yellow'
  } else {
    Log ('removing backup ' + $script:Backup)
    cmd /c rd /s /q "$($script:Backup)" | Out-Null
    if (Test-Path -LiteralPath $script:Backup) { Log 'WARNING: backup not fully removed; delete it manually to reclaim space' 'Yellow' }
    else { Log 'backup removed; source drive space reclaimed' 'Green' }
  }
}
function Invoke-Rollback {
  Section '移除映射并还原数据'
  $sourceItem = Get-Item -LiteralPath $Source -Force
  if ($sourceItem.LinkType -ne 'Junction') { throw 'the original path is not a junction; nothing to roll back' }
  Log ('removing junction ' + $Source)
  cmd /c rmdir "$Source" | Out-Null
  if (Test-Path -LiteralPath $Source) { throw 'failed to remove the junction' }
  $script:RollbackRemoved = $true
  Log 'junction removed' 'Green'
  Section '复制数据回原盘'
  $rcArgs = @($Target, $Source, '/MIR', '/SL', '/SJ', '/MT:8', '/R:2', '/W:2', '/NFL', '/NDL', '/NP', '/NJH', '/NJS')
  Log ('robocopy ' + $Target + ' -> ' + $Source)
  $started = Get-Date
  $proc = Start-Process -FilePath 'robocopy.exe' -ArgumentList $rcArgs -NoNewWindow -PassThru
  while (-not $proc.HasExited) {
    $current = Get-DirBytes $Source
    $status = ('已还原 {0:N2} GB，已用 {1:mm\\:ss}' -f ($current / 1GB), ((Get-Date) - $started))
    Write-Progress -Activity '复制数据回原盘（robocopy /MIR）' -Status $status
    Start-Sleep -Seconds 2
  }
  Write-Progress -Activity '复制数据回原盘（robocopy /MIR）' -Completed
  if ($proc.ExitCode -ge 8) { throw ('robocopy failed with exit code ' + $proc.ExitCode) }
  if (-not (Test-Path -LiteralPath $Source)) { throw 'original path was not recreated' }
  $probeName = '.stm-verify-' + $Stamp + '.tmp'
  Set-Content -LiteralPath (Join-Path $Source $probeName) -Value 'ok' -Encoding ASCII
  Remove-Item -LiteralPath (Join-Path $Source $probeName) -Force
  Log 'data restored to the original path' 'Green'
  if ($RemoveTarget) {
    Log ('removing target directory ' + $Target)
    cmd /c rd /s /q "$Target" | Out-Null
    if (Test-Path -LiteralPath $Target) { Log 'WARNING: target directory not fully removed' 'Yellow' }
  }
}
function Get-DshProcesses {
  $appDir = Split-Path -Parent $ExecPath
  $electronParent = Split-Path -Parent $ElectronPath
  $result = @()
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    try {
      $procPath = $p.Path
      if (-not $procPath) { continue }
      $isDsh = ($procPath -eq $ExecPath) -or ($procPath -eq $ElectronPath)
      if (-not $isDsh -and $appDir) { $isDsh = $procPath.StartsWith($appDir + '\\', [System.StringComparison]::OrdinalIgnoreCase) }
      if (-not $isDsh -and $electronParent) { $isDsh = $procPath.StartsWith($electronParent + '\\', [System.StringComparison]::OrdinalIgnoreCase) }
      if ($isDsh) { $result += $p }
    } catch {}
  }
  return $result
}
function Get-DshPort {
  $pids = @(Get-DshProcesses | Select-Object -ExpandProperty Id)
  if ($pids.Count -eq 0) { return $null }
  try {
    $conn = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess } | Select-Object -First 1
    if ($conn) { return [string]$conn.LocalPort }
  } catch {}
  try {
    foreach ($line in (& netstat -ano 2>$null | Select-String 'LISTENING')) {
      $parts = @($line.ToString() -split '\\s+' | Where-Object { $_ })
      if ($parts.Count -ge 5) {
        $owner = 0
        if ([int]::TryParse($parts[-1], [ref]$owner) -and ($pids -contains $owner)) {
          $portPart = ($parts[1] -split ':')[-1]
          return [string]$portPart
        }
      }
    }
  } catch {}
  return $null
}
function Wait-DshWindow([int]$TimeoutSec = 120) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $window = Get-DshProcesses | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 1
    if ($window) { return $window }
    Start-Sleep -Milliseconds 750
  }
  return $null
}
function Restart-Dsh {
  Section '重启 DSH'
  if (-not (Test-Path -LiteralPath $ExecPath)) {
    Log ('launcher not found: ' + $ExecPath + '; start DSH manually') 'Yellow'
    return $false
  }
  # Give the old process tree a moment to release the Chromium user-data/cache locks.
  Start-Sleep -Seconds 2
  $quoted = @()
  foreach ($arg in $RestartArgs) {
    if ($arg -match '[\\s"]') { $quoted += ('"' + ($arg -replace '"', '\\"') + '"') } else { $quoted += $arg }
  }
  $startDir = $WorkingDir
  if (-not $startDir -or -not (Test-Path -LiteralPath $startDir)) { $startDir = Split-Path -Parent $ExecPath }
  Log ('starting ' + $ExecPath)
  # Do NOT redirect stdio here: redirecting the Electron launcher can prevent the
  # GUI process from coming up on some DSH builds. Detect the window/port instead.
  $proc = Start-Process -FilePath $ExecPath -ArgumentList $quoted -WorkingDirectory $startDir -PassThru
  Log ('started DSH pid ' + $proc.Id)
  $window = Wait-DshWindow 120
  if ($window) {
    $newPort = Get-DshPort
    if ($newPort) { Log ('DSH restarted; web port ' + $newPort) 'Green' }
    else { Log ('DSH window is up: ' + $window.MainWindowTitle) 'Green' }
    return $true
  }
  Log 'DSH window did not appear within 120s; start DSH manually, then verify from the plugin page.' 'Yellow'
  return $false
}
function Resolve-DshPnpm {
  $appDir = Split-Path -Parent $ExecPath
  $runtimeRoot = Join-Path $appDir 'resources\\runtime'
  if (-not (Test-Path -LiteralPath $runtimeRoot)) { return $null }
  $node = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -File -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  $pnpm = Get-ChildItem -LiteralPath $runtimeRoot -Recurse -File -Filter 'pnpm.cjs' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node -or -not $pnpm) { return $null }
  return [pscustomobject]@{ Node = $node.FullName; Pnpm = $pnpm.FullName }
}
function Get-NativePath([string]$NodeExe, [string]$Path) {
  # Junction 迁移后 $Path 是逻辑路径（仍在旧盘）。pnpm 按 cwd 判定项目所在盘，
  # 用逻辑路径跑 pnpm 会把 metadata 写回旧盘；这里用 DSH 自带 node 的
  # fs.realpathSync 解析成真实路径（不依赖 PowerShell 版本对 Junction 的支持）。
  if (-not $Path) { return $Path }
  try {
    $env:STM_NATIVEPATH_IN = $Path
    $out = & $NodeExe -e "process.stdout.write(require('fs').realpathSync(process.env.STM_NATIVEPATH_IN || ''))" 2>$null
    if ($out) {
      $resolved = ([string]($out -join '')).Trim()
      if ($resolved -and (Test-Path -LiteralPath $resolved)) { return $resolved }
    }
  } catch {} finally {
    Remove-Item Env:STM_NATIVEPATH_IN -ErrorAction SilentlyContinue
  }
  return $Path
}
function Get-PnpmMetadataField([string]$Path, [string]$Field) {
  $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
  if (-not $raw) { return $null }
  $trim = ([string]$raw).Trim()
  if ($trim.StartsWith('{')) {
    try {
      $json = $trim | ConvertFrom-Json
      $value = $json.$Field
      if ($value) { return [string]$value }
    } catch {}
  }
  $match = [regex]::Match($raw, ('(?m)^"?' + $Field + '"?\\s*[:=]\\s*"?([^"\\r\\n,]+)"?'))
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return $null
}
function Get-PnpmStoreDir([string]$Path) { return Get-PnpmMetadataField $Path 'storeDir' }
function Get-PnpmVirtualStoreDir([string]$Path) { return Get-PnpmMetadataField $Path 'virtualStoreDir' }
function Set-PnpmMetadataField([string]$Text, [string]$Field, [string]$Value) {
  $line = $Field + ': ' + $Value
  $pattern = '(?m)^"?' + $Field + '"?\\s*:.*$'
  if ($Text -match $pattern) { return ($Text -replace $pattern, $line) }
  return $Text.TrimEnd() + [Environment]::NewLine + $line + [Environment]::NewLine
}
function Set-PnpmMetadata([string]$Path, [string]$StoreDir, [string]$VirtualStoreDir) {
  $raw = Get-Content -LiteralPath $Path -Raw
  if (([string]$raw).TrimStart().StartsWith('{')) {
    $json = $raw | ConvertFrom-Json
    if ($StoreDir) { $json.storeDir = $StoreDir }
    if ($VirtualStoreDir) { $json.virtualStoreDir = $VirtualStoreDir }
    $text = $json | ConvertTo-Json -Depth 60
  } else {
    $text = [string]$raw
    if ($StoreDir) { $text = Set-PnpmMetadataField $text 'storeDir' $StoreDir }
    if ($VirtualStoreDir) { $text = Set-PnpmMetadataField $text 'virtualStoreDir' $VirtualStoreDir }
  }
  [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}
function Invoke-PnpmRelink($PnpmInfo, [string]$StoreDir, [string]$WorkDir) {
  Section '重链 pnpm 依赖'
  Log ('pnpm install --force --store-dir ' + $StoreDir)
  Log '正在重新链接 profile 依赖；这一步可能需要几分钟并需要联网。'
  $modules = Join-Path $WorkDir 'node_modules\\.modules.yaml'
  Push-Location -LiteralPath $WorkDir
  try {
    $env:CI = 'true'
    $relinkLog = Join-Path $ScriptDir ('pnpm-relink-' + $Stamp + '.log')
    & $PnpmInfo.Node $PnpmInfo.Pnpm install --force --store-dir $StoreDir --reporter=append-only *> $relinkLog
    $code = $LASTEXITCODE
    if (Test-Path -LiteralPath $relinkLog) {
      Get-Content -LiteralPath $relinkLog -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Log ([string]$_) 'Gray' }
    }
    if ($code -ne 0) { throw ('pnpm install --force 失败，exit code ' + $code + '，日志：' + $relinkLog) }
    $newStore = Get-PnpmStoreDir $modules
    if ($newStore) { Log ('依赖已重链，pnpm store: ' + $newStore) 'Green' }
    else { Log 'pnpm install 已成功，但未能读取新的 storeDir' 'Yellow' }
  } catch {
    Log ('完整重链失败：' + $_.Exception.Message) 'Yellow'
    Log ('metadata 已修正；卸载/安装插件仍可继续。可稍后手动执行：pnpm install --force --store-dir ' + $StoreDir) 'Yellow'
  } finally {
    Remove-Item Env:CI -ErrorAction SilentlyContinue
    Pop-Location
  }
}
function Repair-PnpmStore {
  Section '修复 pnpm store（跨盘迁移）'
  if (-not $ProfileDir -or -not (Test-Path -LiteralPath $ProfileDir)) { Log '未找到 profile 目录，跳过 pnpm store 修复' 'Yellow'; return }
  $modules = Join-Path $ProfileDir 'node_modules\\.modules.yaml'
  if (-not (Test-Path -LiteralPath $modules)) { Log 'profile 没有 pnpm 依赖记录，跳过 pnpm store 修复' 'Gray'; return }
  $pnpmInfo = Resolve-DshPnpm
  if (-not $pnpmInfo) {
    Log '未找到 DSH 自带的 node/pnpm；请手动在该 profile 运行 pnpm install --force' 'Yellow'
    return
  }
  # Junction 迁移后 $ProfileDir 是逻辑路径（仍在旧盘）。pnpm 按 cwd 判定项目所在盘，
  # 用逻辑路径跑 pnpm 会把 metadata 写回旧盘；先解析成真实路径再做所有判断。
  $realProfile = Get-NativePath $pnpmInfo.Node $ProfileDir
  $oldStore = Get-PnpmStoreDir $modules
  $oldVirtual = Get-PnpmVirtualStoreDir $modules
  $targetVirtual = Join-Path $realProfile 'node_modules\\.pnpm'
  $profileRoot = [System.IO.Path]::GetPathRoot($realProfile)
  $storeRoot = [System.IO.Path]::GetPathRoot($oldStore)
  if (-not $oldStore -or -not $storeRoot) { Log 'storeDir 为空，跳过' 'Yellow'; return }
  $storeSameDisk = $profileRoot -and $storeRoot -and ($storeRoot -ieq $profileRoot)
  $virtualOk = (-not $oldVirtual) -or (([string]$oldVirtual).TrimEnd('\\') -ieq ([string]$targetVirtual).TrimEnd('\\'))
  if ($storeSameDisk -and $virtualOk) {
    Log ('pnpm store 已在同一磁盘（' + $storeRoot + '）且 virtualStoreDir 一致，无需修复') 'Green'
    return
  }
  Log ('检测到 pnpm store 在 ' + $storeRoot + '，profile 真实路径：' + $realProfile) 'Yellow'
  Log '正在检查并修正 pnpm metadata（不重装依赖）...'
  Push-Location -LiteralPath $realProfile
  $installFallback = $false
  try {
    $env:CI = 'true'
    $storeLines = @(& $pnpmInfo.Node $pnpmInfo.Pnpm store path 2>$null)
    $targetStore = $storeLines | Where-Object { $_ -match '^[A-Za-z]:' } | Select-Object -Last 1
    if (-not $targetStore) { throw '无法获取当前 pnpm store 路径' }
    $targetStore = ([string]$targetStore).Trim()
    # pnpm store path 按 cwd（真实路径）解析 store：非系统盘 pnpm 的跨盘默认是
    # <drive>\\.pnpm-store\\v<major>（失败日志 "Using the store at D:\\.pnpm-store\\v11
    # instead" 实证）。下面只是兜底，防止 store path 因 cwd 异常返回旧盘路径。
    $targetRoot = [System.IO.Path]::GetPathRoot($targetStore)
    if (-not $targetRoot -or $targetRoot -ine $profileRoot) {
      $leaf = Split-Path -Leaf $oldStore
      if ($leaf -notmatch '^v[0-9]+$') { $leaf = 'v11' }
      $targetStore = Join-Path $profileRoot ('.pnpm-store\\' + $leaf)
      Log ('pnpm store 不在 profile 所在磁盘，改用 pnpm 跨盘默认: ' + $targetStore) 'Yellow'
    }
    Log ('目标 storeDir: ' + $targetStore)
    Log ('目标 virtualStoreDir: ' + $targetVirtual)
    if (($oldStore -ieq $targetStore) -and $virtualOk) { Log 'metadata 已一致，无需修改' 'Green'; return }
    $backup = $modules + '.bak-' + $Stamp
    Copy-Item -LiteralPath $modules -Destination $backup -Force
    Set-PnpmMetadata $modules $targetStore $targetVirtual
    $afterStore = Get-PnpmStoreDir $modules
    if (-not $afterStore -or $afterStore -ine $targetStore) { throw 'metadata 写入后校验失败' }
    Log ('已修正 pnpm metadata：storeDir ' + $oldStore + ' -> ' + $targetStore + '；virtualStoreDir -> ' + $targetVirtual) 'Green'
    # workspace-state 缓存的键是项目路径；仍是旧路径时删掉，让 pnpm 自动重建。
    $stateFile = Join-Path $realProfile 'node_modules\\.pnpm-workspace-state-v1.json'
    if (Test-Path -LiteralPath $stateFile) {
      try {
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        $keys = @()
        if ($state.projects) { $keys = @($state.projects.PSObject.Properties.Name) }
        $hasReal = $false
        foreach ($key in $keys) {
          try { if ([System.IO.Path]::GetFullPath($key).TrimEnd('\\') -ieq $realProfile.TrimEnd('\\')) { $hasReal = $true } } catch {}
        }
        if ($keys.Count -gt 0 -and -not $hasReal) {
          Remove-Item -LiteralPath $stateFile -Force
          Log '已删除记录旧路径的 workspace-state 缓存（pnpm 会自动重建）' 'Gray'
        }
      } catch {}
    }
    Log 'metadata 已修正；接下来执行完整重链。' 'Green'
    Invoke-PnpmRelink $pnpmInfo $targetStore $realProfile
    return
  } catch {
    Log ('metadata 修复失败：' + $_.Exception.Message) 'Yellow'
    $installFallback = $true
  } finally {
    Remove-Item Env:CI -ErrorAction SilentlyContinue
    Pop-Location
  }
  if ($installFallback) {
    Log '尝试 pnpm install --force 作为兜底...' 'Yellow'
    Push-Location -LiteralPath $realProfile
    try {
      $env:CI = 'true'
      $repairLog = Join-Path $ScriptDir ('pnpm-repair-' + $Stamp + '.log')
      & $pnpmInfo.Node $pnpmInfo.Pnpm install --force --reporter=append-only *> $repairLog
      $code = $LASTEXITCODE
      if (Test-Path -LiteralPath $repairLog) {
        Get-Content -LiteralPath $repairLog -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Log ([string]$_) 'Gray' }
      }
      if ($code -ne 0) { throw ('pnpm install --force 失败，exit code ' + $code + '，日志：' + $repairLog) }
      $newStore = Get-PnpmStoreDir $modules
      if ($newStore) {
        $newRoot = [System.IO.Path]::GetPathRoot($newStore)
        if ($newRoot -and $profileRoot -and $newRoot -ieq $profileRoot) { Log ('pnpm store 已切换到 ' + $newStore) 'Green' }
        else { Log ('pnpm store 仍为 ' + $newStore + '；后续安装插件若报错，请手动运行 pnpm install --force') 'Yellow' }
      }
    } catch {
      Log ('pnpm store 自动修复失败：' + $_.Exception.Message) 'Yellow'
      Log ('请手动在 ' + $realProfile + ' 运行：pnpm install --force') 'Yellow'
    } finally {
      Remove-Item Env:CI -ErrorAction SilentlyContinue
      Pop-Location
    }
  }
}
function Show-Summary {
  Section '完成'
  if ($Mode -eq 'rollback') {
    Log ('Original path : ' + $Source) 'Green'
    Log ('Data target   : ' + $Target + $(if ($RemoveTarget) { ' (removed)' } else { ' (kept)' }))
    Log 'The junction was removed and the data was copied back to the original drive.'
  } else {
    Log ('Original path : ' + $Source) 'Green'
    Log ('Data target   : ' + $Target) 'Green'
    Log 'The original path is now a junction; DSH keeps using it.'
  }
  if (Test-Path -LiteralPath $SnapshotPath) { Log ('Snapshot      : ' + $SnapshotPath) }
  Log 'Open the Storage plugin page to see the verification result.' 'Cyan'
}

Section $(if ($Mode -eq 'rollback') { '回滚计划' } else { '迁移计划' })
Log ('Mode   : ' + $Mode)
Log ('Source : ' + $Source)
Log ('Target : ' + $Target)
if ($Mode -eq 'rollback') {
  Log 'Rollback removes the junction and copies data back to the source drive.'
} else {
  Log ('Backup : ' + $(if ($KeepBackup) { 'keep old backup' } else { 'remove old backup after verification' }))
}
Log ('Restart DSH automatically: ' + $AutoRestart)
Log 'Close DSH now? The operation starts in 5 seconds. Press Ctrl+C to cancel.' 'Yellow'
for ($i = 5; $i -gt 0; $i--) { Write-Host ('  ' + $i + ' ...'); Start-Sleep -Seconds 1 }

try {
  Close-Dsh
  if ($Mode -eq 'rollback') {
    Invoke-Rollback
  } else {
    Invoke-RobocopySync
    Switch-Data
  }
  Repair-PnpmStore
  if ($AutoRestart) { Restart-Dsh | Out-Null }
  Show-Summary
  Log 'DONE. Keep this window open until you have verified your data, then close it.' 'Green'
} catch {
  Log (('{0} FAILED: ' -f $Mode.ToUpperInvariant()) + $_.Exception.Message) 'Red'
  if ($Mode -eq 'rollback') {
    # Keep DSH bootable: if the junction was removed and the restore failed, put it back.
    if ($script:RollbackRemoved -and -not (Test-Path -LiteralPath $Source)) {
      Log 'restoring the junction so DSH can still start...' 'Yellow'
      try { New-Item -ItemType Junction -Path $Source -Target $Target | Out-Null } catch {}
    }
  } elseif ($script:Renamed -and (Test-Path -LiteralPath $Backup)) {
    Log 'restoring the original directory...' 'Yellow'
    try { cmd /c rmdir "$Source" | Out-Null } catch {}
    try { Rename-Item -LiteralPath $Backup -NewName (Split-Path -Leaf $Source) } catch {}
    $script:Renamed = $false
  }
  Log 'Original data was left in place (or restored). Check the log above.' 'Yellow'
  if ($AutoRestart) { try { Restart-Dsh | Out-Null } catch {} }
} finally {
  Write-Host ''
  try { [void](Read-Host 'Press Enter to close this window') } catch {}
  # Explicitly terminate the PowerShell host: on Windows Terminal / cmd-start
  # launchers the tab can otherwise stay open after the script returns.
  try { [Environment]::Exit(0) } catch { exit 0 }
}
`
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return existsSync(file)
}

/** 生成常驻迁移/回滚控制台脚本。 */
export async function generateRunner(ctx, request) {
  if (process.platform !== 'win32') throw new Error('路径映射迁移目前仅支持 Windows（Junction）')
  const mode = request?.mode === 'rollback' ? 'rollback' : 'switch'
  const autoRestart = request?.autoRestart !== false
  let source
  let target
  let excludeCache = false
  let keepBackup = false
  let snapshot
  let sourceBytes = 0

  if (mode === 'rollback') {
    source = await scanSource(String(request?.sourceKey ?? 'dshHome'), { refresh: true })
    if (!source.isJunction || !source.junctionTarget) throw new Error('该路径不是映射（没有 Junction），无需回滚')
    target = source.junctionTarget
    const targetInfo = await linkInfo(target)
    if (!targetInfo.exists || !targetInfo.isDirectory) throw new Error(`映射目标不存在或不是目录：${target}`)
    sourceBytes = source.bytes
  } else {
    const validation = await validateMigration(request)
    if (!validation.ok) {
      const first = validation.checks.find((item) => item.level === 'error')
      throw new Error(first ? first.message : '迁移校验未通过')
    }
    source = validation.source
    target = validation.target
    excludeCache = request?.excludeCache !== false
    keepBackup = request?.keepBackup === true
    snapshot = await createSnapshot(ctx, { sourceKey: source.key, target, excludeCache })
    sourceBytes = validation.estimate?.copyBytes ?? source.bytes
  }

  const scriptDir = runnerDir(target)
  await fsp.mkdir(scriptDir, { recursive: true })
  await fsp.mkdir(target, { recursive: true })
  if (mode === 'switch') {
    const markerPath = path.join(target, '.dsh-storage-monitor-migration')
    if (!existsSync(markerPath)) {
      await fsp.writeFile(
        markerPath,
        JSON.stringify({ version: MIGRATION_VERSION, source: source.path, createdAt: Date.now() }, null, 2),
        'utf8',
      )
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const prefix = mode === 'rollback' ? 'rollback' : 'run'
  const runnerPath = path.join(scriptDir, `${prefix}-${source.key}-${stamp}.ps1`)
  const startedFile = `${runnerPath}.started`
  const script = buildRunnerScript({
    source: source.path,
    sourceKey: source.key,
    target,
    port: resolvePort(ctx),
    pid: process.pid,
    excludeCache,
    keepBackup,
    autoRestart,
    execPath: process.execPath,
    restartArgs: process.argv.slice(1),
    workingDir: process.cwd(),
    electronPath: path.join(resolveDshHome(), 'electron', 'electron.exe'),
    sourceBytes,
    snapshotPath: snapshotPathFor(target),
    profileDir: resolveProfileDir(),
    mode,
    startedFile,
  })
  await fsp.rm(startedFile, { force: true })
  await fsp.writeFile(runnerPath, '\uFEFF' + script, 'utf8')
  const batPath = path.join(scriptDir, `${prefix}-${source.key}-${stamp}.bat`)
  await fsp.writeFile(
    batPath,
    `@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${shellQuoteForBat(path.basename(runnerPath))}"\r\n`,
    'utf8',
  )
  return {
    mode,
    runnerPath,
    batPath,
    scriptDir,
    startedFile,
    snapshot,
    snapshotPath: snapshotPathFor(target),
    target,
    source: source.path,
    excludeCache,
    keepBackup,
    autoRestart,
    command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${runnerPath}"`,
    batCommand: `"${batPath}"`,
    launch: {
      execPath: process.execPath,
      args: process.argv.slice(1),
      cwd: process.cwd(),
    },
  }
}

/**
 * 生成并启动迁移/回滚控制台（独立进程；DSH 退出后继续运行）。
 * 通过控制台脚本开头写出的 .started 标记确认窗口真的起来了；起不来会回退到
 * cmd start 启动器，仍失败则抛错并把手动命令返回给页面。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function launchRunner(ctx, request) {
  if (process.platform !== 'win32') throw new Error('路径映射迁移目前仅支持 Windows（Junction）')
  if (activeJob && activeJob.state === 'running') throw new Error('预拷贝任务运行中，请先等待或取消')
  const runner = await generateRunner(ctx, request)
  const spawnConsole = (label) => {
    const inner = `-NoProfile -ExecutionPolicy Bypass -File "${runner.runnerPath.replace(/"/g, '\\"')}"`
    const command = `Start-Process -FilePath 'powershell.exe' -ArgumentList ${psQuote(inner)} -WindowStyle Normal`
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: runner.scriptDir,
      })
      child.unref()
      return child
    } catch (error) {
      console.warn(`[storage-monitor] ${label} launcher failed:`, error)
      return undefined
    }
  }

  let child = spawnConsole('Start-Process')
  let started = await waitForFile(runner.startedFile, 7000)
  if (!started) {
    // Fallback: `cmd /c start` opens a real console window on hosts where Start-Process
    // from a GUI process is swallowed.
    try {
      const fallback = spawn(
        'cmd.exe',
        ['/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner.runnerPath],
        { detached: true, stdio: 'ignore', windowsHide: true, cwd: runner.scriptDir },
      )
      fallback.unref()
      child = fallback
    } catch (error) {
      console.warn('[storage-monitor] cmd start launcher failed:', error)
    }
    started = await waitForFile(runner.startedFile, 7000)
  }
  if (!started) {
    await fsp.rm(runner.startedFile, { force: true })
    throw new Error(
      `控制台未能自动启动。请手动运行：${runner.command}（或双击 ${runner.batPath}）`,
    )
  }
  return { ...runner, launched: true, consolePid: child?.pid ?? null }
}

/** 重启后验证迁移结果（原路径已映射时）。 */
export async function verifyMigration(ctx) {
  const results = []
  let persistence = ctx.get('sessionPersistence')
  for (const definition of sourceDefinitions()) {
    const info = await linkInfo(definition.path)
    if (!info.exists || !info.isJunction || !info.target) continue
    const target = info.target
    const checks = []
    let snapshot
    try {
      snapshot = JSON.parse(await fsp.readFile(snapshotPathFor(target), 'utf8'))
    } catch {
      snapshot = undefined
    }
    checks.push({ id: 'junction', level: 'ok', message: `原路径已映射到 ${target}` })
    const targetInfo = await linkInfo(target)
    if (!targetInfo.exists || !targetInfo.isDirectory) {
      checks.push({ id: 'target', level: 'error', message: '映射目标目录不存在' })
    } else {
      checks.push({ id: 'target', level: 'ok', message: '映射目标目录存在' })
    }
    if (snapshot) {
      if (snapshot.source && path.resolve(snapshot.source) === path.resolve(definition.path)) {
        checks.push({ id: 'snapshot-source', level: 'ok', message: '迁移前快照与当前路径一致' })
      } else {
        checks.push({ id: 'snapshot-source', level: 'warn', message: '迁移前快照记录的源路径不一致' })
      }
      if (typeof snapshot.sessions === 'number') {
        try {
          const now = persistence ? (await persistence.list()).length : null
          if (now != null) {
            if (now >= snapshot.sessions) checks.push({ id: 'sessions', level: 'ok', message: `会话数量正常：迁移前 ${snapshot.sessions}，当前 ${now}` })
            else checks.push({ id: 'sessions', level: 'error', message: `会话数量减少：迁移前 ${snapshot.sessions}，当前 ${now}` })
          }
        } catch {
          checks.push({ id: 'sessions', level: 'warn', message: '无法读取会话数量' })
        }
      }
      const profileDir = resolveProfileDir()
      if (profileDir && typeof snapshot.profilePackages === 'number') {
        try {
          const now = (await fsp.readdir(path.join(profileDir, 'node_modules'))).filter((name) => !name.startsWith('.')).length
          if (now >= snapshot.profilePackages) checks.push({ id: 'profile', level: 'ok', message: `插件包数量正常：迁移前 ${snapshot.profilePackages}，当前 ${now}` })
          else checks.push({ id: 'profile', level: 'warn', message: `插件包数量变化：迁移前 ${snapshot.profilePackages}，当前 ${now}` })
        } catch {
          checks.push({ id: 'profile', level: 'warn', message: '无法读取插件包数量' })
        }
      }
    } else {
      checks.push({ id: 'snapshot', level: 'warn', message: '未找到迁移前快照，只能做基础验证' })
    }
    try {
      const probe = path.join(definition.path, `.stm-verify-${Date.now()}.tmp`)
      await fsp.writeFile(probe, 'ok', 'utf8')
      const mirrored = path.join(target, path.basename(probe))
      const exists = existsSync(mirrored)
      await fsp.rm(probe, { force: true })
      checks.push(exists
        ? { id: 'write', level: 'ok', message: '通过原路径写入的数据落在目标盘' }
        : { id: 'write', level: 'warn', message: '探针文件未在目标盘找到，但原路径可写' })
    } catch (error) {
      checks.push({ id: 'write', level: 'error', message: `原路径不可写：${error instanceof Error ? error.message : String(error)}` })
    }
    results.push({
      sourceKey: definition.key,
      title: definition.title,
      source: definition.path,
      target,
      snapshot: snapshot ?? null,
      checks,
      ok: !checks.some((item) => item.level === 'error'),
    })
  }
  return { verified: results.length > 0, results }
}

// ---------------------------------------------------------------------------
// 状态汇总
// ---------------------------------------------------------------------------

function parseModulesField(raw, field) {
  const text = String(raw ?? '')
  if (text.trimStart().startsWith('{')) {
    try {
      const json = JSON.parse(text)
      if (json[field]) return String(json[field])
    } catch {}
  }
  const match = text.match(new RegExp(`^\\s*"?${field}"?\\s*[:=]\\s*"?([^"\\r\\n,]+)"?`, 'm'))
  return match ? match[1].trim() : null
}

function parsePnpmStoreDir(raw) {
  return parseModulesField(raw, 'storeDir')
}

function samePath(a, b) {
  if (!a || !b) return false
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase()
}

function expectedPnpmStore(profileDir, oldStore) {
  const root = path.parse(profileDir).root
  const leafMatch = path.basename(String(oldStore ?? '')).match(/^v\d+$/)
  const leaf = leafMatch ? leafMatch[0] : 'v11'
  const systemRoot = `${process.env.SystemDrive || 'C:'}\\`
  // 非系统盘：pnpm 的跨盘默认是 <drive>\.pnpm-store\v<major>，不是
  // <drive>\pnpm-store（插件管理器失败日志 "Using the store at D:\.pnpm-store\v11
  // instead" 与 `pnpm store path` 输出实证；D:\.pnpm-store 也确实存在）。
  if (root && root.toLowerCase() !== systemRoot.toLowerCase()) {
    return path.join(root, '.pnpm-store', leaf)
  }
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) return path.join(localAppData, 'pnpm', 'store', leaf)
  return path.join(root, '.pnpm-store', leaf)
}

async function findRuntimeFile(root, fileName, depth = 0) {
  if (!root || depth > 7) return null
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return path.join(root, entry.name)
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findRuntimeFile(path.join(root, entry.name), fileName, depth + 1)
    if (found) return found
  }
  return null
}

async function readPnpmStoreFromLogs(profileDir, modulesMtime) {
  const logsRoot = path.join(profileDir, '.plugin-manager', 'logs')
  let names
  try {
    names = await fsp.readdir(logsRoot)
  } catch {
    return null
  }
  const logs = []
  for (const name of names) {
    if (!name.startsWith('operation-')) continue
    const logPath = path.join(logsRoot, name, 'pnpm.log')
    try {
      const stat = await fsp.stat(logPath)
      // ignore errors from before the metadata was last rewritten
      if (modulesMtime && stat.mtimeMs + 2000 < modulesMtime) continue
      logs.push({ logPath, mtime: stat.mtimeMs })
    } catch {}
  }
  logs.sort((a, b) => b.mtime - a.mtime)
  for (const item of logs.slice(0, 10)) {
    let raw
    try {
      raw = await fsp.readFile(item.logPath, 'utf8')
    } catch {
      continue
    }
    const tail = raw.slice(-200_000)
    const wanted =
      tail.match(/Using the store at ([A-Za-z]:\\[^\s"]+?)(?:\s+instead|\s*\.)/i) ??
      tail.match(/pnpm now wants to use the store at "([^"]+)"/i)
    if (!wanted) continue
    const virtual = tail.match(/virtual store at "([^"]+)"/i)
    return {
      store: wanted[1].trim(),
      virtualStore: virtual ? virtual[1].trim() : null,
      logPath: item.logPath,
    }
  }
  return null
}

async function readPnpmStoreFromPnpm(profileDir) {
  const runtimeRoot = path.join(path.dirname(process.execPath), 'resources', 'runtime')
  if (!existsSync(runtimeRoot)) return null
  const [nodePath, pnpmPath] = await Promise.all([
    findRuntimeFile(runtimeRoot, 'node.exe'),
    findRuntimeFile(runtimeRoot, 'pnpm.cjs'),
  ])
  if (!nodePath || !pnpmPath) return null
  try {
    const { stdout } = await execFileAsync(nodePath, [pnpmPath, 'store', 'path'], {
      cwd: profileDir,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
    const line = String(stdout)
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => /^[A-Za-z]:\\/.test(item))
      .pop()
    return line || null
  } catch {
    return null
  }
}

/**
 * 检测 DSH 自己实际使用的 pnpm store。
 * 优先读取插件管理器最近一次失败日志里 "Using the store at ..." 的目标路径；
 * 这是 DSH 自己的 pnpm 选择，比按盘符猜规则更可靠。
 */
async function detectPnpmStore(profileDir, oldStore, modulesMtime) {
  const fromLog = await readPnpmStoreFromLogs(profileDir, modulesMtime)
  if (fromLog) {
    return { store: fromLog.store, virtualStore: fromLog.virtualStore, source: 'log', logPath: fromLog.logPath }
  }
  const fromPnpm = await readPnpmStoreFromPnpm(profileDir)
  const profileRoot = path.parse(profileDir).root.toLowerCase()
  if (fromPnpm && path.parse(fromPnpm).root.toLowerCase() === profileRoot) {
    return { store: fromPnpm, virtualStore: null, source: 'pnpm' }
  }
  return { store: expectedPnpmStore(profileDir, oldStore), virtualStore: null, source: 'convention' }
}

/** 读取当前 profile 的 pnpm store 记录与期望值（不修改任何文件）。 */
export async function inspectPnpmStore(profileDirOverride) {
  const logicalDir = profileDirOverride || resolveProfileDir()
  if (!logicalDir) return { ok: false, exists: false, error: '未找到 profile 目录' }
  // Junction 迁移后必须用真实路径判断盘符：逻辑路径仍落在旧盘，会让期望值
  // 算回 C:\...\store，和 DSH 插件管理器实际跑 pnpm 的路径（真实路径）不一致。
  let profileDir = logicalDir
  try {
    profileDir = await fsp.realpath(logicalDir)
  } catch {
    /* 路径暂时不可解析时退回原路径 */
  }
  const modulesPath = path.join(profileDir, 'node_modules', '.modules.yaml')
  if (!existsSync(modulesPath)) {
    return {
      ok: true,
      exists: false,
      profileDir: logicalDir,
      realProfileDir: profileDir,
      modulesPath,
      storeDir: null,
      virtualStoreDir: null,
      expectedStore: null,
      expectedVirtualStore: null,
      needsRepair: false,
    }
  }
  let raw
  let modulesMtime = 0
  try {
    raw = await fsp.readFile(modulesPath, 'utf8')
    modulesMtime = (await fsp.stat(modulesPath)).mtimeMs
  } catch (error) {
    return {
      ok: false,
      exists: true,
      profileDir: logicalDir,
      realProfileDir: profileDir,
      modulesPath,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const storeDir = parsePnpmStoreDir(raw)
  const virtualStoreDir = parseModulesField(raw, 'virtualStoreDir')
  const detected = await detectPnpmStore(profileDir, storeDir, modulesMtime)
  const expectedStore = detected.store
  const expectedVirtualStore = detected.virtualStore || path.join(profileDir, 'node_modules', '.pnpm')
  // storeDir 缺失或不一致需要修复；virtualStoreDir 已存在但不一致同样需要修复
  // （否则修完 storeDir 会立刻撞上 ERR_PNPM_UNEXPECTED_VIRTUAL_STORE）。
  let needsRepair = !samePath(storeDir, expectedStore)
  if (virtualStoreDir) needsRepair = needsRepair || !samePath(virtualStoreDir, expectedVirtualStore)
  else if (detected.virtualStore) needsRepair = true
  return {
    ok: true,
    exists: true,
    profileDir: logicalDir,
    realProfileDir: profileDir,
    modulesPath,
    storeDir,
    virtualStoreDir,
    expectedStore,
    expectedVirtualStore,
    storeSource: detected.source,
    storeLogPath: detected.logPath ?? null,
    needsRepair,
  }
}

function replaceYamlField(text, field, value) {
  const line = `${field}: ${value}`
  const pattern = new RegExp(`^\\s*"?${field}"?\\s*:.*$`, 'm')
  if (pattern.test(text)) return text.replace(pattern, line)
  return `${text.replace(/\s*$/, '')}\n${line}\n`
}

/**
 * 修正 node_modules/.modules.yaml 的 storeDir 与 virtualStoreDir 为真实路径下的
 * 当前值（Junction 跨盘迁移后两者都会指向旧盘），并清理记录旧项目路径的
 * workspace-state 缓存。只改 metadata，不重装依赖；用于迁移后插件管理器报
 * ERR_PNPM_UNEXPECTED_STORE / ERR_PNPM_UNEXPECTED_VIRTUAL_STORE 时的插内修复。
 */
export async function repairPnpmStore(profileDirOverride) {
  const before = await inspectPnpmStore(profileDirOverride)
  if (!before.ok || !before.exists) return { ...before, repaired: false }
  if (!before.needsRepair) return { ...before, repaired: false }
  const backup = `${before.modulesPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const raw = await fsp.readFile(before.modulesPath, 'utf8')
  let output
  if (raw.trimStart().startsWith('{')) {
    const json = JSON.parse(raw)
    if (before.expectedStore) json.storeDir = before.expectedStore
    if (before.expectedVirtualStore) json.virtualStoreDir = before.expectedVirtualStore
    output = JSON.stringify(json, null, 2) + '\n'
  } else {
    output = raw
    if (before.expectedStore) output = replaceYamlField(output, 'storeDir', before.expectedStore)
    if (before.expectedVirtualStore) output = replaceYamlField(output, 'virtualStoreDir', before.expectedVirtualStore)
  }
  await fsp.copyFile(before.modulesPath, backup)
  await fsp.writeFile(before.modulesPath, output, 'utf8')
  // workspace-state 缓存用“项目路径”作键；键还是旧（Junction 逻辑）路径时删掉，
  // 让 pnpm 下次安装时按真实路径自动重建。
  try {
    const realProfile = before.realProfileDir || before.profileDir
    const statePath = path.join(realProfile, 'node_modules', '.pnpm-workspace-state-v1.json')
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'))
    const keys = Object.keys(state?.projects ?? {})
    if (keys.length > 0 && !keys.some((key) => samePath(key, realProfile))) {
      await fsp.rm(statePath, { force: true })
    }
  } catch {
    /* 缓存不存在或不可读时忽略 */
  }
  const after = await inspectPnpmStore(profileDirOverride)
  return {
    ...after,
    repaired: true,
    previousStore: before.storeDir,
    previousVirtualStore: before.virtualStoreDir,
    backup,
  }
}

export async function migrationStatus(ctx) {
  const sources = []
  for (const definition of sourceDefinitions()) {
    try {
      sources.push(await scanSource(definition.key))
    } catch (error) {
      sources.push({
        key: definition.key,
        title: definition.title,
        description: definition.description,
        path: definition.path,
        exists: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const drives = await listDrives()
  let verification = null
  try {
    verification = await verifyMigration(ctx)
  } catch {
    verification = null
  }
  let pnpmStore = null
  try {
    pnpmStore = await inspectPnpmStore()
  } catch (error) {
    pnpmStore = { ok: false, exists: false, error: error instanceof Error ? error.message : String(error) }
  }
  return {
    sources,
    drives,
    job: getJob(),
    pid: process.pid,
    platform: process.platform,
    supported: process.platform === 'win32',
    verification,
    pnpmStore,
    launch: {
      execPath: process.execPath,
      argv: process.argv,
      cwd: process.cwd(),
      versions: { electron: process.versions.electron ?? null, node: process.versions.node },
    },
    suggestedTarget: suggestedTarget(drives, sources.find((item) => item.key === 'dshHome')?.path ?? resolveDshHome()),
    generatedAt: Date.now(),
  }
}

export function invalidateMigrationScan() {
  scanCache.clear()
}
