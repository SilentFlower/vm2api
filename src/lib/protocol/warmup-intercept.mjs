export const DEFAULT_WARMUP_INTERCEPT = Object.freeze({
  title_enabled: false,
  suggestion_enabled: false,
  haiku_probe_enabled: false,
})

/**
 * 规范化辅助请求拦截开关。
 * @param {object} raw 路由中的原始配置。
 * @returns {object} 仅包含布尔开关的配置。
 */
export function normalizeWarmupIntercept(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    title_enabled: config.title_enabled === true,
    suggestion_enabled: config.suggestion_enabled === true,
    haiku_probe_enabled: config.haiku_probe_enabled === true,
  }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => typeof block === 'string' || !block?.type || block.type === 'text')
    .map((block) => (typeof block === 'string' ? block : String(block?.text || block?.content || '')))
    .join('\n')
}

function systemText(body) {
  return textOf(body?.system)
}

function requiresOnlyTitle(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(requiresOnlyTitle)
  if (
    Array.isArray(value.required) &&
    value.required.length === 1 &&
    value.required[0] === 'title' &&
    value.properties &&
    Object.prototype.hasOwnProperty.call(value.properties, 'title')
  )
    return true
  return Object.values(value).some(requiresOnlyTitle)
}

function structuredHaikuTitle(body) {
  return (
    /haiku/i.test(String(body.model || '')) &&
    body.stream === true &&
    Number(body.max_tokens) === 32_000 &&
    body.thinking?.type === 'disabled' &&
    requiresOnlyTitle(body.output_config?.format)
  )
}

/**
 * 仅识别独立的 Claude Code 辅助请求，避免把包含用户对话的分类器误判为预热。
 * @param {object} body 原始 Anthropic Messages 请求体。
 * @param {object} raw 拦截开关。
 * @param {object} options 客户端识别结果。
 * @returns {string|null} 命中的辅助请求类型。
 */
export function detectWarmupIntercept(body, raw = {}, { claudeCode = false } = {}) {
  const config = normalizeWarmupIntercept(raw)
  if (!claudeCode || !body || typeof body !== 'object') return null
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.role !== 'user') return null
  if (Array.isArray(body.tools) && body.tools.length) return null
  const text = textOf(messages[0].content)
  const system = systemText(body)
  // 分类器也可能是 Haiku 的单条短请求，先排除再看 max_tokens。
  if (/<(?:severity|block|transcript)>|classif(?:y|ier)|Stage\s*[12]/i.test(`${system}\n${text}`)) return null
  if (
    config.haiku_probe_enabled &&
    body.stream !== true &&
    /haiku/i.test(String(body.model || '')) &&
    Number(body.max_tokens) === 1
  ) {
    return 'haiku_probe'
  }
  if (config.suggestion_enabled && text.startsWith('[SUGGESTION MODE:')) return 'suggestion'
  if (!config.title_enabled) return null
  if (structuredHaikuTitle(body) || system.includes('Generate a concise, sentence-case title (3-7 words)')) {
    return 'json_title'
  }
  if (text.trim() === 'Warmup' || text.startsWith('Please write a 5-10 word title for the following conversation:')) {
    return 'text_title'
  }
  if (system.includes('nalyze if this message indicates a new conversation topic')) return 'text_title'
  return null
}

const RESPONSES = Object.freeze({
  text_title: ['msg_mock_warmup', 'New Conversation'],
  json_title: ['msg_mock_title', '{"title":"New Conversation"}'],
  suggestion: ['msg_mock_suggestion', ''],
  haiku_probe: ['msg_mock_haiku_probe', '#'],
})

/**
 * 构造与 Messages 协议兼容的本地辅助响应。
 * @param {object} request 原始请求体。
 * @param {string} kind 辅助请求类型。
 * @returns {object} Anthropic Messages 响应体。
 */
export function warmupMessage(request, kind) {
  const [id, text] = RESPONSES[kind] || RESPONSES.text_title
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: String(request?.model || ''),
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  }
}

/**
 * 将本地辅助响应编码为标准 Messages SSE 事件序列。
 * @param {object} message warmupMessage 返回的响应体。
 * @returns {string} 完整 SSE 文本。
 */
export function warmupSse(message) {
  const text = message.content[0].text
  const start = { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } }
  const events = [
    { type: 'message_start', message: start },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    },
    { type: 'message_stop' },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
