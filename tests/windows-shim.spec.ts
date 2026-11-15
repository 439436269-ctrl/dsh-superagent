/** Windows command shims: PowerShell must forward an argument's newlines, which cmd.exe splits into separate commands. */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { windowsPowerShellShim, workerBin, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'windows-shim-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('windows command shims', () => {
  it('give PowerShell a wrapper that forwards the argument vector instead of a command line', () => {
    const script = windowsPowerShellShim('lark-cli')
    expect(script).toContain('# Written by dsh-superagent')
    expect(script).toContain("Join-Path $PSScriptRoot 'lark-cli.shim.json'")
    expect(script).toContain('& $target[0] @rest @args')
    expect(script).not.toContain('%*')
  })
  describe.runIf(process.platform === 'win32')('beside the cmd.exe one', () => {
    it('are written for every installed command', async () => {
      await writeEnvironment(testDeployment({ stateDir: dir }), ['personal-gh'])
      const bin = workerBin(dir)
      expect(readFileSync(join(bin, 'gh.ps1'), 'utf8')).toBe(windowsPowerShellShim('gh'))
      expect(readFileSync(join(bin, 'lark-cli.ps1'), 'utf8')).toBe(windowsPowerShellShim('lark-cli'))
      expect(readFileSync(join(bin, 'personal-gh.ps1'), 'utf8')).toBe(windowsPowerShellShim('personal-gh'))
      // cmd.exe readers still resolve the `.cmd`, which the PowerShell wrapper adds to rather than replaces.
      expect(readFileSync(join(bin, 'gh.cmd'), 'utf8')).toContain('shim.cjs')
    })
    it('keep a multi-paragraph argument whole, where cmd.exe sends its first line only', async () => {
      const record = join(dir, 'args.json')
      const target = join(dir, 'record.ps1')
      writeFileSync(target, `$json = ConvertTo-Json -Compress -InputObject @($args)\n[IO.File]::WriteAllText('${record.replaceAll("'", "''")}', $json)\n`)
      await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: target } }), [])
      // PowerShell resolves `gh.ps1` before `gh.cmd`; the test fails if cmd.exe, which cuts the command line at the newline, runs instead.
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$env:PATH='${workerBin(dir)};'+$env:PATH; & gh --markdown "first paragraph\n\nsecond paragraph"`])
      expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(['--markdown', 'first paragraph\n\nsecond paragraph'])
    })
    it('fail with the message the other shims print when the command is unavailable', async () => {
      await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), [])
      const error = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$env:PATH='${workerBin(dir)};'+$env:PATH; & lark-cli im`]).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ code: 1 })
      expect(String((error as { stderr?: string }).stderr)).toContain('lark-cli is unavailable: this installation has no Feishu bot.')
    })
  })
})
