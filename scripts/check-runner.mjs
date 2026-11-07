#!/usr/bin/env node
/**
 * Parse-check the generated migration/rollback PowerShell runner with the
 * PowerShell AST parser. CONTRIBUTING requires generated scripts to be parsed
 * (never just eyeballed) before they ship.
 *
 * Run: node scripts/check-runner.mjs   (skipped on non-Windows)
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildRunnerScript } from '../lib/migrate.js'

if (process.platform !== 'win32') {
  console.log('OK: runner script check skipped (Windows only).')
  process.exit(0)
}

const base = {
  source: 'C:\\Users\\test\\.dsh',
  sourceKey: 'dshHome',
  target: 'D:\\DSH-dsh',
  port: 64886,
  pid: 1234,
  excludeCache: false,
  keepBackup: false,
  autoRestart: true,
  execPath: 'C:\\Program Files\\dsh\\DeepSeek Harness.exe',
  restartArgs: [],
  workingDir: 'C:\\Users\\test',
  electronPath: 'C:\\Users\\test\\.dsh\\electron\\electron.exe',
  sourceBytes: 1024,
  snapshotPath: 'D:\\DSH-dsh\\migration\\snapshot.json',
  profileDir: 'C:\\Users\\test\\.dsh\\profiles\\desktop',
  startedFile: '',
}

const parseCommand = `
$path = $env:STM_CHECK_FILE
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
  $errors | ForEach-Object { Write-Output ('line ' + $_.Extent.StartLineNumber + ': ' + $_.Message) }
  exit 1
}
exit 0
`

const dir = mkdtempSync(join(tmpdir(), 'stm-runner-'))
let failed = false
try {
  for (const mode of ['switch', 'rollback']) {
    const script = buildRunnerScript({ ...base, mode })
    const file = join(dir, `${mode}.ps1`)
    writeFileSync(file, '\uFEFF' + script, 'utf8')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', parseCommand], {
      stdio: 'inherit',
      env: { ...process.env, STM_CHECK_FILE: file },
    })
    if (result.status !== 0) {
      console.error(`✗ generated ${mode} runner script has PowerShell syntax errors (see lines above)`)
      failed = true
    } else {
      console.log(`✓ generated ${mode} runner script parses cleanly`)
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failed) process.exit(1)
console.log('OK: generated runner scripts parse cleanly.')
