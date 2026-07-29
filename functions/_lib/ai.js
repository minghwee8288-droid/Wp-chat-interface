import { drainBody } from './http.js'

// ====================================================================
// The one place the model lives. Swap the provider/model here and every
// summary call follows. OpenRouter is OpenAI-compatible, so this is a plain
// fetch — no SDK in the Worker bundle.
// ====================================================================

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Default model string per the brief. Overridable via env so the exact
// OpenRouter slug (which occasionally carries a suffix like `-exp`) can be
// corrected without a code change.
export const AI_MODEL = 'deepseek/deepseek-v3.2'

export const REFRESH_MS = 6 * 60 * 60 * 1000 // 6 hours

// Input caps — the whole cost constraint. Even a first summary never sends more
// than FIRST_MESSAGE_CAP messages; an incremental update never sends more than
// INCREMENTAL_MESSAGE_CAP *new* ones. Long bodies are clipped, and the joined
// transcript is hard-capped by characters, truncating oldest-first.
export const FIRST_MESSAGE_CAP = 40
export const INCREMENTAL_MESSAGE_CAP = 40
const PER_MESSAGE_CHARS = 800
const MAX_TRANSCRIPT_CHARS = 12000 // ~3k tokens, a hard ceiling on every call
const MAX_OUTPUT_TOKENS = 400

/** A model/parse failure the endpoint turns into a graceful "couldn't refresh". */
export class AiError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AiError'
  }
}

// --------------------------------------------------------------------
// Pure helpers (no network) — unit-tested without hitting DeepSeek.
// --------------------------------------------------------------------

const clip = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > PER_MESSAGE_CHARS ? t.slice(0, PER_MESSAGE_CHARS) + '…' : t
}

/** A media-only message still carries meaning; represent it, with any caption. */
function mediaPlaceholder(m) {
  const kind = m.media_type || 'media'
  const cap = m.media_caption ? `: ${clip(m.media_caption)}` : ''
  return `[${kind}${cap}]`
}

/**
 * One transcript line per message, oldest-first. The label tells the model who
 * spoke: in a group, inbound messages use the sender's name; one-to-one inbound
 * is "Customer"; every outbound is "Agent".
 */
export function formatTranscript(messages, isGroup) {
  return (messages || [])
    .map((m) => {
      const who =
        m.direction === 'outbound'
          ? 'Agent'
          : isGroup
            ? m.sender_name || 'Member'
            : 'Customer'
      const text = m.body && m.body.trim() ? clip(m.body) : mediaPlaceholder(m)
      return `${who}: ${text}`
    })
    .join('\n')
}

const SYSTEM_PROMPT = [
  'You summarize a customer-support WhatsApp conversation for the team.',
  'Return ONLY a JSON object, no prose and no markdown fences, with exactly these keys:',
  '  "summary": a concise plain-language summary of the conversation so far (2-4 sentences).',
  '  "attention_required": boolean — true if a human should look at this soon.',
  '  "attention_level": one of "management", "team", "general", or null when attention_required is false.',
  '  "attention_reason": a short string (why), or null when attention_required is false.',
  'Flag attention for things like: an angry or upset customer, a stalled or at-risk deal,',
  'an unanswered question, or an explicit escalation request. Use "management" for the most',
  'serious (churn/complaint/legal), "team" for something the handling team should act on,',
  '"general" for a mild flag. If nothing needs attention, set attention_required=false and the',
  'other two fields to null. For a group chat, note it is a group and you may reference senders.',
].join('\n')

/**
 * Build the OpenAI-format messages array.
 *   mode 'first'       — summarize the supplied recent history.
 *   mode 'incremental' — update existingSummary using ONLY the supplied new
 *                        messages; the full history is never included.
 * Returns { messages, truncated } where truncated notes oldest-first char clipping.
 */
export function buildSummaryRequest({ mode, existingSummary, messages, isGroup }) {
  let transcript = formatTranscript(messages, isGroup)
  let truncated = false
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    // Keep the most recent — slice from the end.
    transcript = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS)
    truncated = true
  }

  const groupNote = isGroup ? 'This is a group chat.\n' : ''
  const truncNote = truncated ? '\n(Note: earlier messages were omitted for length.)' : ''

  const user =
    mode === 'incremental'
      ? `${groupNote}Here is the existing summary of this conversation:\n"""\n${existingSummary || ''}\n"""\n\n` +
        `Update it to incorporate ONLY these new messages (oldest to newest). Preserve important earlier context from the existing summary; do not drop it.\n\n` +
        `New messages:\n${transcript}${truncNote}`
      : `${groupNote}Summarize this conversation. Messages (oldest to newest):\n${transcript}${truncNote}`

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    truncated,
  }
}

const LEVELS = ['management', 'team', 'general']

/**
 * Defensive parse of the model's reply. Strips markdown fences, extracts the
 * outermost {...}, JSON.parses, then validates and coerces every field so a
 * plausible-but-sloppy response still yields a well-formed record. Throws
 * AiError only when there is no usable summary at all.
 */
export function parseSummaryResponse(text) {
  if (!text || typeof text !== 'string') throw new AiError('empty model response')

  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) throw new AiError('no JSON object in model response')

  let obj
  try {
    obj = JSON.parse(s.slice(start, end + 1))
  } catch {
    throw new AiError('malformed JSON in model response')
  }
  if (!obj || typeof obj !== 'object') throw new AiError('model response was not an object')

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  if (!summary) throw new AiError('model response had no summary')

  const attention = obj.attention_required === true
  let level = null
  let reason = null
  if (attention) {
    level = LEVELS.includes(obj.attention_level) ? obj.attention_level : 'general'
    reason =
      typeof obj.attention_reason === 'string' && obj.attention_reason.trim()
        ? obj.attention_reason.trim().slice(0, 300)
        : null
  }

  return {
    summary,
    attention_required: attention,
    attention_level: level,
    attention_reason: reason,
  }
}

/**
 * Decide, without any model call, what to do on open:
 *   - no messages at all, no prior summary            -> { action: 'empty' }
 *   - messages but no prior summary                   -> { action: 'generate', mode: 'first' }
 *   - prior summary, no NEW messages since its cursor -> { action: 'cached' }   (never call the model)
 *   - prior summary, new messages, but < 6h old       -> { action: 'cached' }
 *   - prior summary, new messages, and >= 6h old      -> { action: 'generate', mode: 'incremental' }
 *
 * "No new activity => never regenerate, regardless of age" and "regenerate only
 * when stale AND new messages exist" both fall out of this ordering.
 */
export function decideRefresh({ summaryRow, latestMessageId, hasMessages, now, refreshMs = REFRESH_MS }) {
  // An empty-text row is a placeholder (e.g. a first attempt that failed to
  // parse) — treat it as "no summary yet" so the next open regenerates rather
  // than caching emptiness for six hours.
  const hasSummary = summaryRow && summaryRow.summary_text && summaryRow.summary_text.trim()
  if (!hasSummary) {
    return hasMessages ? { action: 'generate', mode: 'first' } : { action: 'empty' }
  }

  const cursor = summaryRow.last_summarized_message_id
  const hasNew =
    latestMessageId != null && (cursor == null || Number(latestMessageId) > Number(cursor))
  if (!hasNew) return { action: 'cached' }

  const generatedAt = summaryRow.generated_at ? new Date(summaryRow.generated_at).getTime() : 0
  const stale = now - generatedAt >= refreshMs
  return stale ? { action: 'generate', mode: 'incremental' } : { action: 'cached' }
}

// --------------------------------------------------------------------
// Network
// --------------------------------------------------------------------

/** Low-level model call. Returns the raw assistant text. Throws AiError. */
export async function callOpenRouter(env, requestMessages) {
  const key = env?.OPENROUTER_API_KEY
  if (!key) throw new AiError('OPENROUTER_API_KEY is not configured')
  const model = env?.OPENROUTER_MODEL || AI_MODEL

  let res
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: requestMessages,
        temperature: 0.2,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
      }),
    })
  } catch (err) {
    throw new AiError(`model request failed: ${String(err?.message || err)}`)
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new AiError(`model HTTP ${res.status}: ${detail}`)
  }

  let payload
  try {
    payload = await res.json()
  } catch {
    await drainBody(res)
    throw new AiError('model returned non-JSON envelope')
  }

  const content = payload?.choices?.[0]?.message?.content
  if (!content) throw new AiError('model returned an empty choice')
  return content
}

/**
 * Produce a parsed summary from a set of messages. `generate` is injectable so
 * the endpoint (and tests) can stub the network. Returns the parsed fields plus
 * the new cursor (id of the newest message folded in).
 */
export async function produceSummary({ env, mode, existingSummary, messages, isGroup, generate }) {
  const run = generate || ((rm) => callOpenRouter(env, rm))
  const { messages: requestMessages } = buildSummaryRequest({ mode, existingSummary, messages, isGroup })
  const raw = await run(requestMessages)
  const parsed = parseSummaryResponse(raw)
  const lastId = messages && messages.length ? messages[messages.length - 1].id : null
  return { ...parsed, last_summarized_message_id: lastId, model: env?.OPENROUTER_MODEL || AI_MODEL }
}
