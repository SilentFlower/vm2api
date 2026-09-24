import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkClientAccess, normalizeClientAccess } from '../../src/lib/protocol/client-access-policy.mjs'
import { detectWarmupIntercept, warmupMessage, warmupSse } from '../../src/lib/protocol/warmup-intercept.mjs'
import { createPeakPrimeMonitor, normalizePeakPrimeConfig } from '../../src/lib/admin/peak-prime.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

test('客户端准入支持版本范围、通配、拒绝优先和普通 UA 白名单', () => {
  const config = {
    enabled: true,
    allowed_claude_code_versions: '2.1.89-2.1.280, 2.2.*',
    blocked_claude_code_versions: '2.1.100',
    allowed_user_agents: 'my-client/*, curl/*',
  }
  assert.equal(checkClientAccess('claude-cli/2.1.241 (linux)', config), null)
  assert.equal(checkClientAccess('claude-code/2.2.1', config), null)
  assert.equal(checkClientAccess('my-client/1.0', config), null)
  assert.equal(checkClientAccess('claude-cli/2.1.100', config)?.setting, 'blocked_claude_code_versions')
  assert.equal(checkClientAccess('claude-cli/2.1.281', config)?.setting, 'allowed_claude_code_versions')
  assert.equal(checkClientAccess('node-fetch/1.0', config)?.setting, 'allowed_user_agents')
  assert.equal(checkClientAccess('claude-cli/', config)?.setting, 'allowed_claude_code_versions')
  assert.equal(checkClientAccess('claude-cli', config)?.setting, 'allowed_claude_code_versions')
  assert.equal(checkClientAccess('node-fetch/1.0', { enabled: false, allowed_user_agents: 'curl/*' }), null)
  assert.throws(() => normalizeClientAccess({ allowed_claude_code_versions: '2.1.5-' }), /无效版本规则/)
})

test('辅助请求本地响应与 Stage1/2 分类器透传', () => {
  const config = { title_enabled: true, suggestion_enabled: true, haiku_probe_enabled: true }
  const base = { model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'Warmup' }] }
  assert.equal(detectWarmupIntercept(base, config, { claudeCode: false }), null)
  assert.equal(detectWarmupIntercept(base, config, { claudeCode: true }), 'haiku_probe')
  const stage1 = {
    ...base,
    system: '<transcript> Classifier Stage1',
    messages: [{ role: 'user', content: '<transcript>Warmup</transcript>' }],
  }
  assert.equal(detectWarmupIntercept(stage1, config, { claudeCode: true }), null)
  const stage2 = { ...base, system: 'Stage 2 classifier', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(detectWarmupIntercept(stage2, config, { claudeCode: true }), null)
  const title = { ...base, model: 'claude-sonnet-5', max_tokens: 64, stream: true }
  assert.equal(detectWarmupIntercept(title, config, { claudeCode: true }), 'text_title')
  const response = warmupMessage(title, 'text_title')
  assert.equal(response.content[0].text, 'New Conversation')
  assert.match(warmupSse(response), /event: message_stop/)
  const structuredTitle = {
    ...base,
    stream: true,
    max_tokens: 32_000,
    thinking: { type: 'disabled' },
    output_config: { format: { schema: { required: ['title'], properties: { title: { type: 'string' } } } } },
  }
  assert.equal(detectWarmupIntercept(structuredTitle, config, { claudeCode: true }), 'json_title')
})

test('峰值预热只跑可用 Claude 槽，重启后同小时不重复', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-peak-prime-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const now = new Date(2026, 8, 24, 4, 10, 5).getTime()
  const statePath = path.join(dir, 'prime.json')
  const targets = [
    { id: 'claude-1', status: 'running', schedulable: true, claude: { access_token: 'token' } },
    {
      id: 'claude-cool',
      status: 'running',
      schedulable: true,
      cooldown_until: now + 60_000,
      claude: { access_token: 'token' },
    },
    { id: 'codex-1', status: 'running', schedulable: true, platform: 'openai', claude: { access_token: 'token' } },
  ]
  let calls = 0
  const opts = {
    config: { enabled: true, hours: [4], minute: 10 },
    statePath,
    now: () => now,
    listTargets: () => targets,
    canRun: () => ({ ok: true }),
    runChat: async () => {
      calls++
      return { ok: true, status: 200, duration_ms: 12 }
    },
  }
  const first = createPeakPrimeMonitor(opts)
  const result = await first.tick()
  assert.equal(result.last_run.success, 1)
  assert.equal(result.records[0].vm_id, 'claude-1')
  await first.tick()
  await createPeakPrimeMonitor(opts).tick()
  assert.equal(calls, 1)
  assert.throws(() => normalizePeakPrimeConfig({ hours: [24] }), /hours/)
})

test('请求入口在读取请求体前拒绝 UA，本地辅助响应不进入账号池', async () => {
  let reads = 0
  let hops = 0
  const response = { statusCode: 200, on() {}, write() {}, end() {} }
  const routing = {
    client_access: { enabled: true, allowed_user_agents: 'claude-cli/*' },
    warmup_intercept: { title_enabled: true },
  }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.statusCode = status
      response.body = body
      return body
    },
    writeSSEHeaders: () => {},
    readBody: async () => {
      reads++
      return { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'Warmup' }] }
    },
    requireAuth: () => true,
    cfg: { limits: { max_body_bytes: 1024 } },
    requestLog: { start: () => ({ request_id: 'ported-features' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { requests: 0, errors: 0, by_route: {} },
    getRoutingConfig: () => routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      run: () => {
        hops++
        throw new Error('不应进入账号池')
      },
    },
  })
  const req = { method: 'POST', url: '/v1/messages', apiKeyKind: 'managed', headers: { 'user-agent': 'blocked/1.0' } }
  await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
  assert.equal(response.statusCode, 403)
  assert.equal(reads, 0)
  req.headers['user-agent'] = 'claude-cli/2.1.241'
  await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.content[0].text, 'New Conversation')
  assert.equal(reads, 1)
  assert.equal(hops, 0)
})
