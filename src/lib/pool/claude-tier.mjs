import { isFableUnavailablePro, isInventedFableWindow } from '../oauth/crs-usage-probe.mjs'

export const ACCOUNT_TIER_MODES = Object.freeze(['auto', 'manual'])

/**
 * 规范化套餐识别模式，旧槽位缺少字段时保持自动识别。
 * @param {unknown} raw 原始模式。
 * @return {'auto'|'manual'} 规范化后的模式。
 */
export function normalizeAccountTierMode(raw) {
  return String(raw || '').toLowerCase() === 'manual' ? 'manual' : 'auto'
}

/**
 * 校验创建或切换槽位时提交的套餐偏好。
 * @param {{ account_tier_mode?: unknown, accountTierMode?: unknown, account_tier?: unknown, accountTier?: unknown }} input 提交体。
 * @return {{ ok: true, mode: 'auto'|'manual', tier: 'pro'|'max'|null } | { ok: false, error: string }} 校验结果。
 */
export function parseAccountTierPreference(input = {}) {
  const rawMode = input.account_tier_mode ?? input.accountTierMode ?? 'auto'
  const mode = String(rawMode || '')
    .trim()
    .toLowerCase()
  if (!ACCOUNT_TIER_MODES.includes(mode)) {
    return { ok: false, error: 'account_tier_mode must be auto or manual' }
  }
  if (mode === 'auto') return { ok: true, mode: 'auto', tier: null }
  const tier = String(input.account_tier ?? input.accountTier ?? '')
    .trim()
    .toLowerCase()
  if (tier !== 'pro' && tier !== 'max') {
    return { ok: false, error: 'manual account tier must be pro or max' }
  }
  return { ok: true, mode: 'manual', tier }
}

function quotaView(vm = {}, quota = {}) {
  return {
    utilization_7d_oi: quota.utilization_7d_oi ?? vm.utilization_7d_oi,
    reset_7d_oi: quota.reset_7d_oi || vm.reset_7d_oi,
    status_7d_oi: quota.status_7d_oi || vm.status_7d_oi,
    '7d_oi': quota['7d_oi'] || vm['7d_oi'],
    usage_has_fable: quota.usage_has_fable ?? vm.usage_has_fable,
  }
}

/** Official /usage listing a Fable model, or a real 7d_oi window, is Max. */
export function hasClaudeFableUsage(vm = {}, quota = {}) {
  const q = quotaView(vm, quota)
  if (q.usage_has_fable === true) return true
  const fb = quota.fable || vm.fable || {}
  if (fb.ok) return true
  const oi = q['7d_oi'] || {}
  const hasOi =
    q.utilization_7d_oi != null ||
    q.reset_7d_oi ||
    q.status_7d_oi ||
    oi.utilization != null ||
    oi.reset ||
    oi.resets_at ||
    oi.status
  if (!hasOi) return false
  return !isInventedFableWindow(fb, q)
}

/**
 * Claude-only: official /usage 有 Fable 模型或真实 7d_oi=Max。
 * 落盘 pro / Fable hop 拒绝不能盖掉 usage 里的 Fable。
 * Shared by the panel and the pool picker so they cannot drift.
 */
export function inferClaudeTier(vm = {}, quota = {}) {
  const hasToken = !!(vm.has_token || vm.has_access)
  if (!hasToken) return { key: 'none', label: null }
  const fb = quota.fable || vm.fable || {}
  const q = quotaView(vm, quota)
  const stored = String(vm.account_tier || quota.account_tier || '').toLowerCase()
  if (normalizeAccountTierMode(vm.account_tier_mode || quota.account_tier_mode) === 'manual') {
    if (stored === 'pro') return { key: 'pro', label: 'Pro' }
    if (stored === 'max') return { key: 'max', label: 'Max' }
    return { key: 'unknown', label: null }
  }
  if (hasClaudeFableUsage(vm, quota) || stored === 'max') {
    return { key: 'max', label: 'Max' }
  }
  if (stored === 'pro' || isFableUnavailablePro(fb, q)) {
    return { key: 'pro', label: 'Pro' }
  }
  return { key: 'unknown', label: null }
}
