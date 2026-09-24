import fs from 'node:fs'
import path from 'node:path'
import { isHealthProbeTarget } from './health-probe.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'

export const DEFAULT_PEAK_PRIME = Object.freeze({
  enabled: false,
  hours: Object.freeze([4, 5, 6]),
  minute: 10,
  model: 'claude-haiku-4-5',
  timeout_ms: 60_000,
})

/**
 * 规范化峰值预热时段与请求参数。
 * @param {object} raw 路由中的原始配置。
 * @returns {object} 可用于定时器的配置。
 */
export function normalizePeakPrimeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const input = Array.isArray(src.hours) ? src.hours : DEFAULT_PEAK_PRIME.hours
  const hours = [...new Set(input.map(Number))].sort((a, b) => a - b)
  if (!hours.length || hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
    throw new Error('peak_prime.hours 必须是 0-23 的非空小时列表')
  }
  const minute = Number(src.minute ?? DEFAULT_PEAK_PRIME.minute)
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('peak_prime.minute 必须是 0-59 的整数')
  }
  const model = String(src.model || DEFAULT_PEAK_PRIME.model).trim()
  if (!/^claude-[a-z0-9.-]+$/i.test(model) || !/haiku/i.test(model)) {
    throw new Error('peak_prime.model 必须是 Claude Haiku 模型')
  }
  const timeout = Number(src.timeout_ms ?? DEFAULT_PEAK_PRIME.timeout_ms)
  if (!Number.isInteger(timeout) || timeout < 10_000 || timeout > 180_000) {
    throw new Error('peak_prime.timeout_ms 必须在 10000-180000 之间')
  }
  return { enabled: src.enabled === true, hours, minute, model, timeout_ms: timeout }
}

function localKey(now) {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}`
}

function nextRun(config, now) {
  if (!config.enabled) return null
  for (let day = 0; day < 8; day++) {
    for (const hour of config.hours) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour, config.minute)
      if (date.getTime() > now.getTime()) return date.toISOString()
    }
  }
  return null
}

/**
 * 创建按本地时钟执行的逐槽峰值预热器。
 * @param {object} opts 配置、槽位查询、真实请求回调和可选状态文件。
 * @returns {object} 启停、手动执行和状态查询接口。
 */
export function createPeakPrimeMonitor(opts = {}) {
  let config = normalizePeakPrimeConfig(opts.config)
  let timer = null
  let inflight = null
  const nowFn = opts.now || (() => Date.now())
  const statePath = opts.statePath || null
  let state = { last_key: null, last_run: null, records: [] }
  if (statePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      state = {
        last_key: saved.last_key || null,
        last_run: saved.last_run || null,
        records: Array.isArray(saved.records) ? saved.records.slice(-50) : [],
      }
    } catch {}
  }
  const persist = () => {
    if (!statePath) return
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      atomicWriteJson(statePath, state, { mode: 0o600 })
    } catch (error) {
      console.warn('[peak-prime] 状态写入失败', error?.message || error)
    }
  }
  const getStatus = () => ({
    config,
    running: !!inflight,
    next_run_at: nextRun(config, new Date(nowFn())),
    last_run: state.last_run,
    records: [...state.records],
  })
  const runOnce = ({ scheduledKey = null } = {}) => {
    if (inflight) return inflight
    if (scheduledKey && state.last_key === scheduledKey) return Promise.resolve(getStatus())
    if (scheduledKey) {
      // 先落盘再发送真实请求，重启也不会在同一分钟重复消耗账号额度。
      state.last_key = scheduledKey
      persist()
    }
    inflight = (async () => {
      const started = nowFn()
      const targets = (opts.listTargets?.() || []).filter(
        (vm) =>
          !isCodexVm(vm) &&
          isHealthProbeTarget(vm) &&
          Number(vm.cooldown_until || 0) <= started &&
          Number(vm.claude?.temp_unschedulable_until || 0) <= started,
      )
      const records = []
      for (const vm of targets) {
        const gate = opts.canRun?.(vm)
        if (gate?.ok === false) {
          records.push({
            at: new Date(nowFn()).toISOString(),
            vm_id: vm.id,
            ok: false,
            skipped: gate.reason || 'quota',
          })
          continue
        }
        try {
          const result = await opts.runChat(vm, config)
          records.push({
            at: new Date(nowFn()).toISOString(),
            vm_id: vm.id,
            ok: result?.ok === true,
            status: Number(result?.status || 0),
            duration_ms: Number(result?.duration_ms || 0),
            error: result?.ok ? null : String(result?.error?.message || result?.error || 'prime_failed').slice(0, 300),
          })
        } catch (error) {
          records.push({
            at: new Date(nowFn()).toISOString(),
            vm_id: vm.id,
            ok: false,
            error: String(error?.message || error).slice(0, 300),
          })
        }
      }
      state.last_run = {
        at: new Date(started).toISOString(),
        scheduled: !!scheduledKey,
        total: targets.length,
        success: records.filter((record) => record.ok).length,
        skipped: records.filter((record) => record.skipped).length,
      }
      state.records = [...state.records, ...records].slice(-50)
      persist()
      return getStatus()
    })().finally(() => {
      inflight = null
    })
    return inflight
  }
  const tick = () => {
    if (!config.enabled) return Promise.resolve(getStatus())
    const now = new Date(nowFn())
    if (!config.hours.includes(now.getHours()) || now.getMinutes() !== config.minute)
      return Promise.resolve(getStatus())
    return runOnce({ scheduledKey: localKey(now) })
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const start = () => {
    stop()
    if (!config.enabled) return { started: false }
    timer = setInterval(() => {
      tick().catch((error) => console.warn('[peak-prime] 执行失败', error?.message || error))
    }, 30_000)
    timer.unref?.()
    tick().catch((error) => console.warn('[peak-prime] 执行失败', error?.message || error))
    return { started: true }
  }
  const setConfig = (raw) => {
    config = normalizePeakPrimeConfig(raw)
    start()
    return config
  }
  return { getConfig: () => config, getStatus, runOnce, tick, start, stop, setConfig }
}
