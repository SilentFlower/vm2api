const CLAUDE_UA = /^claude-(?:code|cli)\/([^\s()]*)/i
const CLAUDE_FAMILY_UA = /^claude-(?:code|cli)(?:\/|\s|$)/i
const VERSION = /^\d+(?:\.\d+){2,3}$/
const WILDCARD_VERSION = /^\d+(?:\.\d+){0,2}\.\*$/

export const DEFAULT_CLIENT_ACCESS = Object.freeze({
  enabled: false,
  allowed_claude_code_versions: '',
  blocked_claude_code_versions: '',
  allowed_user_agents: '',
})

function splitRules(value) {
  return String(value || '')
    .split(/[,\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function versionParts(version) {
  return version.split('.').map(Number)
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] || 0) - (b[i] || 0)
    if (delta) return delta
  }
  return 0
}

function parseVersionRule(raw, setting) {
  if (VERSION.test(raw)) return (version) => compareVersions(version, raw) === 0
  if (WILDCARD_VERSION.test(raw)) {
    const prefix = raw.slice(0, -1)
    return (version) => version.startsWith(prefix)
  }
  const range = raw.match(/^(\d+(?:\.\d+){2,3})-(\d+(?:\.\d+){2,3})$/)
  if (range && compareVersions(range[1], range[2]) <= 0) {
    return (version) => compareVersions(version, range[1]) >= 0 && compareVersions(version, range[2]) <= 0
  }
  throw new Error(`${setting} 包含无效版本规则：${raw}`)
}

function parseAgentPattern(raw) {
  if (!/^[\x20-\x7e]+$/.test(raw)) throw new Error(`allowed_user_agents 包含无效规则：${raw}`)
  const escaped = raw.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * 解析客户端准入设置，保存配置时同步检查规则语法。
 * @param {object} raw 原始路由配置。
 * @returns {object} 已规范化的准入配置。
 */
export function normalizeClientAccess(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const config = {
    enabled: source.enabled === true,
    allowed_claude_code_versions: String(source.allowed_claude_code_versions || '').trim(),
    blocked_claude_code_versions: String(source.blocked_claude_code_versions || '').trim(),
    allowed_user_agents: String(source.allowed_user_agents || '').trim(),
  }
  splitRules(config.allowed_claude_code_versions).forEach((rule) =>
    parseVersionRule(rule, 'allowed_claude_code_versions'),
  )
  splitRules(config.blocked_claude_code_versions).forEach((rule) =>
    parseVersionRule(rule, 'blocked_claude_code_versions'),
  )
  splitRules(config.allowed_user_agents).forEach(parseAgentPattern)
  return config
}

/**
 * 检查真实入站 User-Agent；未启用策略时完全保持原行为。
 * @param {string} userAgent 请求头中的原始 User-Agent。
 * @param {object} raw 已保存的准入配置。
 * @returns {object|null} 拒绝详情，允许时返回 null。
 */
export function checkClientAccess(userAgent, raw = {}) {
  const config = normalizeClientAccess(raw)
  if (!config.enabled) return null
  const ua = String(userAgent || '')
  const claude = ua.match(CLAUDE_UA)
  if (CLAUDE_FAMILY_UA.test(ua)) {
    const version = claude?.[1] || ''
    const allowed = splitRules(config.allowed_claude_code_versions).map((rule) =>
      parseVersionRule(rule, 'allowed_claude_code_versions'),
    )
    const blocked = splitRules(config.blocked_claude_code_versions).map((rule) =>
      parseVersionRule(rule, 'blocked_claude_code_versions'),
    )
    if (!VERSION.test(version)) {
      return { setting: 'allowed_claude_code_versions', reason: 'Claude Code User-Agent 缺少有效版本号' }
    }
    if (blocked.some((matches) => matches(version))) {
      return { setting: 'blocked_claude_code_versions', reason: `Claude Code 版本 ${version} 已禁止访问` }
    }
    if (allowed.length && !allowed.some((matches) => matches(version))) {
      return { setting: 'allowed_claude_code_versions', reason: `Claude Code 版本 ${version} 不在允许范围内` }
    }
    return null
  }
  const agents = splitRules(config.allowed_user_agents).map(parseAgentPattern)
  if (agents.length && !agents.some((pattern) => pattern.test(ua))) {
    return { setting: 'allowed_user_agents', reason: '当前客户端 User-Agent 不允许访问' }
  }
  return null
}
