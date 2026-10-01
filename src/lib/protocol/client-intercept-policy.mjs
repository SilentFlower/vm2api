export const DEFAULT_WARMUP_INTERCEPT = Object.freeze({
  title_enabled: false,
  suggestion_enabled: false,
  haiku_probe_enabled: false,
  auto_mode_classifier_stage1_mode: 'passthrough',
  auto_mode_classifier_stage2_mode: 'passthrough',
})

const CLASSIFIER_MODES = new Set(['passthrough', 'mock_allow', 'mock_block', 'error'])

function classifierMode(value, key, strict) {
  if (value === undefined || value === null) return 'passthrough'
  if (CLASSIFIER_MODES.has(value)) return value
  if (strict) throw new Error(`${key} 不支持的模式：${String(value)}`)
  return 'passthrough'
}

/**
 * 规范化辅助请求拦截配置，未知分类模式安全回退为上游透传。
 * @param {object} raw 路由中的原始配置。
 * @param {object} options 保存时可启用严格校验。
 * @returns {object} 包含辅助开关和分类器处理模式的配置。
 */
export function normalizeWarmupIntercept(raw = {}, { strict = false } = {}) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    title_enabled: config.title_enabled === true,
    suggestion_enabled: config.suggestion_enabled === true,
    haiku_probe_enabled: config.haiku_probe_enabled === true,
    auto_mode_classifier_stage1_mode: classifierMode(
      config.auto_mode_classifier_stage1_mode,
      'auto_mode_classifier_stage1_mode',
      strict,
    ),
    auto_mode_classifier_stage2_mode: classifierMode(
      config.auto_mode_classifier_stage2_mode,
      'auto_mode_classifier_stage2_mode',
      strict,
    ),
  }
}

function contentTextItems(content) {
  if (typeof content === 'string') return [content]
  if (Array.isArray(content)) return content.flatMap(contentTextItems)
  if (!content || typeof content !== 'object') return []
  if (content.type && content.type !== 'text') return []
  const text = content.text ?? content.content
  return typeof text === 'string' ? [text] : []
}

function autoModeClassifierProtocol(body) {
  let hasTranscriptOpen = false
  let hasTranscriptClose = false
  let hasBlockYes = false
  let hasBlockNo = false
  let hasSeverityOpen = false
  let hasSeverityClose = false
  const observeMarkers = (text) => {
    hasBlockYes ||= text.includes('<block>yes</block>')
    hasBlockNo ||= text.includes('<block>no</block>')
    hasSeverityOpen ||= text.includes('<severity>')
    hasSeverityClose ||= text.includes('</severity>')
  }

  for (const text of contentTextItems(body.system)) observeMarkers(text)

  let insideTranscript = false
  const lastMessage = body.messages.at(-1)
  for (const text of contentTextItems(lastMessage?.content)) {
    let remaining = text
    while (remaining.length) {
      if (insideTranscript) {
        const close = remaining.indexOf('</transcript>')
        if (close < 0) break
        hasTranscriptClose = true
        insideTranscript = false
        remaining = remaining.slice(close + '</transcript>'.length)
        continue
      }
      const open = remaining.indexOf('<transcript>')
      if (open < 0) {
        observeMarkers(remaining)
        break
      }
      // transcript 内容来自待审计对话，其中的 XML 示例不能决定本地返回格式。
      observeMarkers(remaining.slice(0, open))
      hasTranscriptOpen = true
      insideTranscript = true
      remaining = remaining.slice(open + '<transcript>'.length)
    }
  }
  if (!hasTranscriptOpen || !hasTranscriptClose || insideTranscript) return null
  const block = hasBlockYes && hasBlockNo
  const severity = hasSeverityOpen && hasSeverityClose
  if (block === severity) return null
  return block ? 'block' : 'severity'
}

/**
 * 按 Claude Code Auto Mode 请求结构识别 Stage1/Stage2 及其响应协议。
 * @param {object} body 原始 Anthropic Messages 请求体。
 * @param {object} options 客户端类型和请求路径。
 * @returns {{kind: string, protocol: string}|null} 命中的分类器信息。
 */
export function detectAutoModeClassifier(body, { claudeCode = false, pathName = '/v1/messages' } = {}) {
  if (!claudeCode || pathName !== '/v1/messages' || !body || typeof body !== 'object' || body.stream === true) {
    return null
  }
  if (!Array.isArray(body.messages) || body.messages.at(-1)?.role !== 'user') return null
  if (Array.isArray(body.tools) && body.tools.length) return null
  const tokens = body.max_tokens
  if (!Number.isSafeInteger(tokens)) return null
  let kind = null
  if (tokens >= 64 && tokens <= 2304) kind = 'auto_mode_classifier_stage1'
  else if (tokens >= 4096 && tokens <= 8192) kind = 'auto_mode_classifier_stage2'
  if (!kind) return null
  const protocol = autoModeClassifierProtocol(body)
  return protocol ? { kind, protocol } : null
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
  if (detectAutoModeClassifier(body, { claudeCode })) return null
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

function messageWithText(request, id, text) {
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
 * 构造与 Messages 协议兼容的本地辅助响应。
 * @param {object} request 原始请求体。
 * @param {string} kind 辅助请求类型。
 * @returns {object} Anthropic Messages 响应体。
 */
export function warmupMessage(request, kind) {
  const [id, text] = RESPONSES[kind] || RESPONSES.text_title
  return messageWithText(request, id, text)
}

/**
 * 按识别出的 block/severity 协议构造分类器的本地模拟响应。
 * @param {object} request 原始请求体。
 * @param {{kind: string, protocol: string}} classifier 分类器阶段与协议。
 * @param {string} mode 本地模拟模式。
 * @returns {object} Anthropic Messages 响应体。
 */
export function autoModeClassifierMessage(request, classifier, mode) {
  if (mode !== 'mock_allow' && mode !== 'mock_block') throw new Error(`不支持的分类器模拟模式：${mode}`)
  const text =
    classifier.protocol === 'severity'
      ? mode === 'mock_allow'
        ? '<severity>0</severity>'
        : '<severity>100</severity>'
      : mode === 'mock_allow'
        ? '<block>no</block>'
        : '<block>yes</block><reason>blocked by local policy</reason>'
  const id = `msg_mock_${classifier.kind}`
  return messageWithText(request, id, text)
}

/**
 * 构造分类器“返回错误”模式的 Anthropic 格式错误体。
 * @param {object} request 原始请求体。
 * @returns {object} 错误响应体。
 */
export function autoModeClassifierError(request) {
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'auto mode classifier request intercepted locally',
      code: 'auto_mode_classifier_intercepted',
    },
    model: String(request?.model || 'claude-mock'),
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
