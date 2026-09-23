import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { persistAccountTier, persistAccountTierPreference, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'

test('manual account tier survives probes and auto mode resumes inferred writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-account-tier-'))
  const dir = path.join(root, 'vms')
  const file = path.join(dir, 'vm-01.json')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: 'vm-01',
      claude: { has_access: true, account_tier_mode: 'manual', account_tier: 'pro' },
    }),
  )
  try {
    persistAccountTier(root, 'vm-01', 'max')
    let vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(vm.claude.account_tier, 'pro')
    assert.equal(summarizeVm(vm).account_tier_mode, 'manual')

    persistAccountTierPreference(root, 'vm-01', { mode: 'auto' })
    vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(vm.claude.account_tier_mode, 'auto')
    assert.equal(vm.claude.account_tier, undefined)

    persistAccountTier(root, 'vm-01', 'max')
    vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(vm.claude.account_tier, 'max')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
