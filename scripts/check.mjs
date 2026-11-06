#!/usr/bin/env node
/**
 * Repository check: syntax, JSON, and bundle-manifest consistency.
 *
 * Run: node scripts/check.mjs   (or: npm test)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skipDirs = new Set(['.git', 'node_modules', 'dist', 'out', 'coverage'])
const failures = []
let checkedFiles = 0
let checkedJson = 0

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile()) inspect(full)
  }
}

function fail(message) {
  failures.push(message)
  console.error(`✗ ${message}`)
}

function inspect(file) {
  const rel = relative(root, file)
  if (file.endsWith('.js') || file.endsWith('.mjs')) {
    checkedFiles += 1
    // Inherit stdio instead of piping: works in sandboxed shells that cannot create
    // the named pipes Node's default stdio uses on Windows.
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
    if (result.status !== 0) fail(`${rel}: syntax error`)
    return
  }
  if (file.endsWith('.json')) {
    checkedJson += 1
    try {
      JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      fail(`${rel}: invalid JSON: ${error.message}`)
    }
  }
}

function requireFile(rel, label) {
  const full = join(root, rel)
  try {
    if (!statSync(full).isFile()) fail(`${label ?? rel}: not a file`)
  } catch {
    fail(`${label ?? rel}: missing`)
  }
}

function requireDir(rel, label) {
  try {
    if (!statSync(join(root, rel)).isDirectory()) fail(`${label ?? rel}: not a directory`)
  } catch {
    fail(`${label ?? rel}: missing`)
  }
}

walk(root)

// --- bundle manifest consistency -------------------------------------------
const manifestPath = join(root, 'package.json')
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  fail(`package.json: ${error.message}`)
}

if (manifest) {
  if (manifest.name !== 'dsh-storage-monitor') fail(`package.json: unexpected name ${manifest.name}`)
  if (manifest.type !== 'module') fail('package.json: type must be "module"')
  if (manifest.license !== 'MIT') fail('package.json: license should be MIT')
  if (!manifest.dsh || !manifest.dsh.bundle || !manifest.dsh.bundle.patch) fail('package.json: missing dsh.bundle.patch')
  if (!manifest.dsh || !manifest.dsh.client || manifest.dsh.client.platform !== 'web') fail('package.json: missing dsh.client.platform = web')
  if (!manifest.exports || !manifest.exports['.'] || !manifest.exports['./client']) fail('package.json: exports must include "." and "./client"')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('package.json: files list is empty')

  requireFile('index.js')
  requireFile('client.js')
  requireFile('cordis.patch.yml')
  requireFile('icon.svg')
  requireFile('locale/zh.json')
  requireFile('locale/en.json')
  requireFile('README.md')
  requireFile('LICENSE')
  requireDir('lib')
  requireDir('docs')

  if (manifest.files && !manifest.files.includes('LICENSE')) fail('package.json: files should include LICENSE')
  if (manifest.files && !manifest.files.includes('README.md')) fail('package.json: files should include README.md')
}

console.log('')
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length} problem(s)`)
  process.exit(1)
}
console.log(`OK: ${checkedFiles} JS files, ${checkedJson} JSON files, bundle manifest consistent.`)
