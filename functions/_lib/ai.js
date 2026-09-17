import { drainBody } from './http.js'

// ====================================================================
// The one place the model lives. Swap the provider/model here and every
// summary call follows. OpenRouter is OpenAI-compatible, so this is a plain
// fetch — no SDK in the Worker bundle.
//
// Two-tier architecture: ONE call produces a BIG summary (the compacted memory,
// source of truth) + a SHORT summary (what the panel shows) + the department
// classification + the attention flag.
// ====================================================================

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Default model string per the brief. Overridable via env so the exact
// OpenRouter slug (which occasionally carries a suffix like `-exp`) can be
// corrected without a code change.
export const AI_MODEL = 'deepseek/deepseek-v3.2'

export const REFRESH_MS = 2 * 60 * 60 * 1000 // 2 hours

// Input caps — the whole cost constraint.
//   FIRST seed: the last SEED_WINDOW_DAYS of messages, capped to FIRST_MESSAGE_CAP.
//   INCREMENTAL: only the NEW messages since the cursor, capped to INCREMENTAL_MESSAGE_CAP.
// The full history is never re-read; compaction folds new activity into the big
// summary and compresses older detail.
export const SEED_WINDOW_DAYS = 30
export const FIRST_MESSAGE_CAP = 60
export const INCREMENTAL_MESSAGE_CAP = 40

// The big summary is bounded by instruction to this target; the model compresses
// older/resolved detail to stay under it, so incremental calls do not grow
// without limit. Expected steady-state big summary ≈ this size.
export const BIG_SUMMARY_TARGET_CHARS = 1500

const PER_MESSAGE_CHARS = 800
const MAX_TRANSCRIPT_CHARS = 12000 // ~3k tokens, a hard ceiling on the transcript
// Big (~375t) + short (~90t) + classification/attention fields — 700 is ample.
const MAX_OUTPUT_TOKENS = 700

const DEPARTMENTS = ['sales', 'operations', 'unclear']
const LEVELS = ['management', 'team', 'general']

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
  'You maintain a running memory of a customer-support WhatsApp conversation for the team.',
  'Return ONLY a JSON object — no prose, no markdown fences — with EXACTLY these keys:',
  `  "big_summary": a detailed, factual running record of the WHOLE conversation, formatted as a structured list of bullet points (each line starting with "• ") grouped under these headings, each heading on its own line ending with a colon:`,
  '      Key facts: names, numbers, dates, amounts, decisions',
  '      Current status: what is pending and the stage of any process (e.g. a verification)',
  '      Recent activity: what happened in the latest messages',
  '      Action needed: what needs follow-up',
  `    Put a newline between the heading and its bullets and between every bullet; omit a heading only when it genuinely has nothing. This is the memory. Keep it UNDER ~${BIG_SUMMARY_TARGET_CHARS} characters: compress older or resolved detail to make room for new activity.`,
  `  SCOPE: cover ONLY the last ${SEED_WINDOW_DAYS} days of the conversation. Drop anything whose activity falls entirely outside that window, even if it is still unresolved — it is out of scope. Within the window, never drop a still-pending or unresolved item.`,
  '  "short_summary": 2-3 concise bullet points (each line starting with "• ") covering the most important current state — NOT a paragraph. Derived from big_summary.',
  '  "department": one of "sales" (pricing, negotiation, quotes, sales enquiries), "operations" (documents, paperwork, process/operational matters), or "unclear" (cannot confidently determine).',
  '  "attention_required": boolean — true if a human should look at this soon.',
  '  "attention_level": one of "management", "team", "general", or null when attention_required is false.',
  '  "attention_reason": a short string (why), or null when attention_required is false.',
  'Attention: flag an angry/upset customer, a stalled/at-risk deal, an unanswered question, or an explicit escalation. "management" = most serious (churn/complaint/legal), "team" = the handling team should act, "general" = mild. If nothing needs attention: attention_required=false and the other two null.',
  'For a group chat, note it is a group and you may reference senders.',
  'Format the big_summary as a structured list with bullet points ("• "), grouped under the headings above. Format the short_summary as 2-3 bullet points ("• "), not a paragraph. Both stay plain-text JSON strings: use "• " for bullets and "\\n" for line breaks inside the string — no markdown fences.',
].join('\n')

/** The ISO date (YYYY-MM-DD) on which the rolling summary window opens. */
export function windowCutoffDate(now = Date.now()) {
  return new Date(now - SEED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 
 * Build the OpenAI-format messages array.
 *   mode 'first'       — seed the big summary from the supplied recent history.
 *   mode 'incremental' — compact: fold ONLY the supplied new messages into the
 *                        supplied existing big summary. The full history is never
 *                        included.
 */
export function buildSummaryRequest({ mode, existingBigSummary, messages, isGroup }) {
  let transcript = formatTranscript(messages, isGroup)
  let truncated = false
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    // Keep the most recent — slice from the end.
    transcript = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS)
    truncated = true
  }

  const groupNote = isGroup ? 'This is a group chat.\n' : ''
  const truncNote = truncated ? '\n(Note: earlier messages were omitted for length.)' : ''

  // The rolling 30-day boundary, stated to the model as a date so it can age
  // content out of the carried-over memory rather than accumulating forever.
  const cutoff = windowCutoffDate()
  const cutoffNote =
    `The reporting window is the last ${SEED_WINDOW_DAYS} days: everything on or after ${cutoff}.\n`

  const user =
    mode === 'incremental'
      ? `${groupNote}${cutoffNote}Here is the existing big_summary (the memory so far):\n"""\n${existingBigSummary || ''}\n"""\n\n` +
        `Update it by folding in ONLY these NEW messages (oldest to newest) and compacting older/resolved detail to stay under ~${BIG_SUMMARY_TARGET_CHARS} characters. Do NOT re-summarize from scratch.\n\n` +
        `ROLLING WINDOW: the existing big_summary may hold items that have now aged out. REMOVE any item whose activity is entirely older than ${cutoff}, even if it is unresolved. Keep every still-pending item that falls inside the window. Then derive short_summary, department and attention from the updated big_summary.\n\n` +
        `New messages:\n${transcript}${truncNote}`
      : `${groupNote}${cutoffNote}Build the big_summary from these recent messages (the last ${SEED_WINDOW_DAYS} days, oldest to newest), then derive short_summary, department and attention from it.\n\n` +
        `Messages:\n${transcript}${truncNote}`

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    truncated,
  }
}

/**
 * Defensive parse of the model's reply. Strips markdown fences, extracts the
 * outermost {...}, JSON.parses, then validates and coerces every field. Throws
 * AiError only when there is NO usable summary at all — so a partially-sloppy
 * response still yields a record and the endpoint never blanks a good summary.
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

  const big = typeof obj.big_summary === 'string' ? obj.big_summary.trim() : ''
  const short = typeof obj.short_summary === 'string' ? obj.short_summary.trim() : ''
  if (!big && !short) throw new AiError('model response had no summary')
  // Tolerate one-of-two: derive the missing side rather than failing.
  const bigOut = big || short
  const shortOut = short || (big.length > 300 ? big.slice(0, 300).trim() + '…' : big)

  const department = DEPARTMENTS.includes(obj.department) ? obj.department : 'unclear'

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
    big_summary: bigOut,
    short_summary: shortOut,
    department,
    attention_required: attention,
    attention_level: level,
    attention_reason: reason,
  }
}

/**
 * Decide, without any model call, what to do on open. The big summary is the
 * memory; the short is what is shown.
 *   - nothing stored, messages exist            -> generate/first   (seed)
 *   - nothing stored, no messages               -> empty
 *   - stored summary, NO new messages           -> cached           (DORMANT: never call the model, any age)
 *   - stored summary, new messages, < 2h old    -> cached
 *   - stored, new messages, >= 2h, has big       -> generate/incremental  (compact)
 *   - stored, new messages, >= 2h, no big (e.g.
 *     a migrated short-only row)                 -> generate/first        (seed the big)
 *
 * The dormant guard (no new messages -> cached) is absolute and is what makes a
 * closed/quiet conversation cost zero forever.
 */
export function decideRefresh({ summaryRow, latestMessageId, hasMessages, now, refreshMs = REFRESH_MS }) {
  const big = summaryRow && summaryRow.big_summary && summaryRow.big_summary.trim()
  const short = summaryRow && summaryRow.short_summary && summaryRow.short_summary.trim()

  // Nothing usable stored: behave like a first generation, ignoring the 2h gate.
  if (!big && !short) {
    return hasMessages ? { action: 'generate', mode: 'first' } : { action: 'empty' }
  }

  const cursor = summaryRow.last_summarized_message_id
  const hasNew =
    latestMessageId != null && (cursor == null || Number(latestMessageId) > Number(cursor))
  if (!hasNew) return { action: 'cached' } // dormant — the critical cost guard

  const generatedAt = summaryRow.generated_at ? new Date(summaryRow.generated_at).getTime() : 0
  const stale = now - generatedAt >= refreshMs
  if (!stale) return { action: 'cached' }

  // New activity + stale: compact if we have a big summary, otherwise (re)seed it.
  return { action: 'generate', mode: big ? 'incremental' : 'first' }
}

// --------------------------------------------------------------------
// Network
// --------------------------------------------------------------------

/** Low-level model call. Returns the raw assistant text. Throws AiError. */
export async function callOpenRouter(env, requestMessages, options = {}) {
  const key = env?.OPENROUTER_API_KEY
  if (!key) throw new AiError('OPENROUTER_API_KEY is not configured')
  const model = env?.OPENROUTER_MODEL || AI_MODEL
  // Defaults are the summary path's long-standing values, so that caller is
  // byte-for-byte unchanged; the ask path passes its own wider budget.
  const maxTokens = options.maxTokens || MAX_OUTPUT_TOKENS
  const temperature = options.temperature ?? 0.2

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
        temperature,
        max_tokens: maxTokens,
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
 * Produce a parsed two-tier summary. `generate` is injectable so the endpoint
 * (and tests) can stub the network. Returns the parsed fields plus the new
 * cursor (id of the newest message folded in) and the model.
 */
export async function produceSummary({ env, mode, existingBigSummary, messages, isGroup, generate }) {
  const run = generate || ((rm) => callOpenRouter(env, rm))
  const { messages: requestMessages } = buildSummaryRequest({ mode, existingBigSummary, messages, isGroup })
  const raw = await run(requestMessages)
  const parsed = parseSummaryResponse(raw)
  const lastId = messages && messages.length ? messages[messages.length - 1].id : null
  return { ...parsed, last_summarized_message_id: lastId, model: env?.OPENROUTER_MODEL || AI_MODEL }
}

// ====================================================================
// Ask-AI — the interactive "Chat with AI" side of the panel.
//
// Deliberately SEPARATE from the summary pipeline above: that one is a cached,
// background, cost-guarded memory keyed to a 30-day window. This one is a
// user-initiated question answered against the WHOLE conversation, and nothing
// it returns is ever written to wp_chat_summaries. The two never interfere.
// ====================================================================

/** How many messages of history an ask may draw on. Far wider than a summary. */
export const ASK_MESSAGE_CAP = 400

/** Transcript ceiling for an ask — larger than the summary's, still bounded. */
const ASK_MAX_TRANSCRIPT_CHARS = 40000

/** Room for a drafted reply plus a short rationale. */
const ASK_MAX_OUTPUT_TOKENS = 900

/** Turns of prior ask/answer context carried back, so follow-ups make sense. */
export const ASK_HISTORY_TURNS = 6

const ASK_SYSTEM_PROMPT = [
  'You are an assistant embedded in a customer-support WhatsApp team inbox.',
  'You are given the transcript of ONE conversation and a question from the agent handling it.',
  '',
  'You do two kinds of work:',
  '  1. ANSWER questions about the conversation — find details, dates, amounts, names, commitments, whatever was asked. Search the whole transcript.',
  '  2. DRAFT a message for the agent to send to this contact, when asked for one (e.g. "write a follow-up", "what should I say about the invoice", "draft a reply").',
  '',
  'Return ONLY a JSON object — no prose, no markdown fences — with these keys:',
  '  "answer": your reply to the agent, in plain text. Keep it tight and factual. Use "• " bullets for lists and "\n" for line breaks. This is what the agent reads, NOT what gets sent to the contact.',
  '  "draft": when the agent asked you to write/draft/suggest a message to SEND to the contact, the message text itself, ready to send as-is — no greeting placeholders like [Name] unless the name is genuinely unknown, no commentary, no quotes around it. When the agent only asked a question, this MUST be null.',
  '',
  'Rules:',
  '  - Ground every claim in the transcript. If it is not there, say so plainly rather than inventing it.',
  '  - A draft must match the language and tone already used with this contact, and read like the agent wrote it — never mention that it was AI-generated.',
  '  - Keep a draft to what a real support agent would actually send: short, direct, no corporate padding.',
  '  - When you produce a draft, keep "answer" to one short line (e.g. "Here is a follow-up you can send:"), since the draft is displayed separately.',
].join('\n')

/**
 * Build the ask request. `history` is prior [{role:'user'|'assistant', content}]
 * turns from this panel session so follow-ups ("make it shorter") resolve; it is
 * capped by the caller and never persisted server-side.
 */
export function buildAskRequest({ question, messages, isGroup, history = [] }) {
  let transcript = formatTranscript(messages, isGroup)
  let truncated = false
  if (transcript.length > ASK_MAX_TRANSCRIPT_CHARS) {
    // Keep the most recent — the tail is what a question usually concerns.
    transcript = transcript.slice(transcript.length - ASK_MAX_TRANSCRIPT_CHARS)
    truncated = true
  }

  const groupNote = isGroup
    ? 'This is a GROUP chat; inbound lines are labelled with the sender name.\n'
    : ''
  const truncNote = truncated
    ? '\n(Note: the oldest messages were omitted for length; this is the most recent history.)'
    : ''

  const turns = (history || [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-ASK_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: clip(t.content) }))

  return {
    messages: [
      { role: 'system', content: ASK_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `${groupNote}Conversation transcript (oldest to newest):\n"""\n${transcript}\n"""${truncNote}`,
      },
      // The transcript is established once; the turns that follow are the
      // actual back-and-forth, so "make it shorter" refers to the last draft.
      ...turns,
      { role: 'user', content: String(question || '').trim() },
    ],
    truncated,
  }
}

/** Defensive parse of an ask reply. Falls back to raw text over failing. */
export function parseAskResponse(text) {
  if (!text || typeof text !== 'string') throw new AiError('empty model response')

  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')

  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(s.slice(start, end + 1))
      if (obj && typeof obj === 'object') {
        const answer = typeof obj.answer === 'string' ? obj.answer.trim() : ''
        const draft = typeof obj.draft === 'string' && obj.draft.trim() ? obj.draft.trim() : null
        if (answer || draft) return { answer: answer || 'Here is a message you can send:', draft }
      }
    } catch {
      /* fall through to the plain-text salvage below */
    }
  }

  // The model answered in prose instead of JSON. That is still a usable answer,
  // so show it rather than turning a good response into an error.
  if (s) return { answer: s, draft: null }
  throw new AiError('model returned no usable answer')
}

/**
 * Run one ask. Unlike the summary path this DOES block the request: it is a
 * direct user action with a visible pending state, not a background refresh.
 */
export async function produceAnswer({ env, question, messages, isGroup, history, generate }) {
  const run = generate || ((rm) => callOpenRouter(env, rm, { maxTokens: ASK_MAX_OUTPUT_TOKENS, temperature: 0.4 }))
  const { messages: requestMessages, truncated } = buildAskRequest({ question, messages, isGroup, history })
  const raw = await run(requestMessages)
  return { ...parseAskResponse(raw), truncated, model: env?.OPENROUTER_MODEL || AI_MODEL }
}
