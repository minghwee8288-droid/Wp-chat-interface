// ====================================================================
// Daily EOD digest to Thomas — a STANDALONE Cloudflare Worker (cron).
//
// Reads Supabase over HTTP (PostgREST, service role — no Postgres driver, no
// SDK) and sends one email via Resend. It ONLY reads the DB and sends mail:
// it never writes, never generates summaries, never touches the Pages app.
// ====================================================================

const RESEND_URL = 'https://api.resend.com/emails'
const DAY_MS = 24 * 60 * 60 * 1000

const LEVEL_RANK = { management: 0, team: 1, general: 2 }
const LEVEL_LABEL = { management: 'Management', team: 'Team', general: 'General' }
const LEVEL_COLOR = { management: '#c0392b', team: '#b6791f', general: '#2f6fb0' }

// --------------------------------------------------------------------
// Config
// --------------------------------------------------------------------
function readConfig(env) {
  const supabaseUrl = env.SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  const resendKey = env.RESEND_API_KEY
  const from = env.EOD_FROM
  const to = env.EOD_TO
  const missing = [
    ['SUPABASE_URL', supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceKey],
    ['RESEND_API_KEY', resendKey],
    ['EOD_FROM', from],
    ['EOD_TO', to],
  ].filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) throw new Error(`EOD config missing: ${missing.join(', ')}`)

  // EOD_PENDING_DAYS: default 7, clamped to the valid 3–10 range.
  let days = Number(env.EOD_PENDING_DAYS)
  if (!Number.isFinite(days)) days = 7
  days = Math.min(10, Math.max(3, Math.round(days)))

  return { supabaseUrl: String(supabaseUrl).replace(/\/+$/, ''), serviceKey, resendKey, from, to, pendingDays: days }
}

// --------------------------------------------------------------------
// Supabase over HTTP (PostgREST)
// --------------------------------------------------------------------
async function pg(cfg, pathAndQuery) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`Supabase ${res.status}: ${body}`)
  }
  return res.json()
}

async function fetchEodData(cfg, now) {
  const cutoffIso = new Date(now - cfg.pendingDays * DAY_MS).toISOString()

  // Membership: (a) flagged summaries; (b) inbound + stale conversations.
  const [flaggedRows, pendingRows] = await Promise.all([
    pg(cfg, `wp_chat_summaries?attention_required=eq.true&select=conversation_id`),
    pg(cfg, `wp_chat_conversations?last_direction=eq.inbound&last_message_at=lte.${encodeURIComponent(cutoffIso)}&select=id`),
  ])

  const flaggedIds = new Set(flaggedRows.map((r) => r.conversation_id))
  const pendingIds = new Set(pendingRows.map((r) => r.id))
  const ids = [...new Set([...flaggedIds, ...pendingIds])]
  if (!ids.length) return { conversations: [], summaries: [], flaggedIds, pendingIds }

  const inList = `in.(${ids.join(',')})`
  const [conversations, summaries] = await Promise.all([
    pg(cfg, `wp_chat_conversations?id=${inList}&select=id,customer_name,customer_number,is_group,member_count,last_message_at,last_direction,assigned_to`),
    pg(cfg, `wp_chat_summaries?conversation_id=${inList}&select=conversation_id,attention_required,attention_level,attention_reason,big_summary,short_summary,summary_text`),
  ])
  return { conversations, summaries, flaggedIds, pendingIds }
}

// --------------------------------------------------------------------
// Assembly (pure — unit-testable without network)
// --------------------------------------------------------------------
export function daysSince(iso, now) {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((now - t) / DAY_MS))
}

/**
 * The EOD reads EXISTING summaries — no model calls. big_summary is the point of
 * the EOD; fall back to short_summary, then the legacy summary_text, so a
 * conversation summarized before the big-summary rollout still appears.
 */
export function pickSummary(s) {
  const big = (s?.big_summary || '').trim()
  const short = (s?.short_summary || '').trim()
  const legacy = (s?.summary_text || '').trim()
  return big || short || legacy || '(No summary available yet.)'
}

function displayName(c) {
  if (c.is_group) return c.customer_name || 'Group'
  return c.customer_name || (c.customer_number ? `+${c.customer_number}` : 'Unknown contact')
}

export function buildDigest({ conversations, summaries, flaggedIds, pendingIds, now, pendingDays }) {
  const sumBy = new Map(summaries.map((s) => [s.conversation_id, s]))

  const items = conversations.map((c) => {
    const s = sumBy.get(c.id) || {}
    const flagged = flaggedIds.has(c.id) || s.attention_required === true
    const pending = pendingIds.has(c.id)
    return {
      id: c.id,
      name: displayName(c),
      isGroup: !!c.is_group,
      assignedTo: c.assigned_to || null,
      flagged,
      pending,
      waitingDays: pending ? daysSince(c.last_message_at, now) : null,
      level: flagged ? (LEVEL_LABEL[s.attention_level] ? s.attention_level : 'general') : null,
      reason: flagged ? (s.attention_reason || null) : null,
      summary: pickSummary(s),
      lastMessageAt: c.last_message_at,
    }
  })

  const olderFirst = (a, b) => new Date(a.lastMessageAt).getTime() - new Date(b.lastMessageAt).getTime()

  // Attention first: management -> team -> general, oldest activity first within a level.
  const flagged = items
    .filter((i) => i.flagged)
    .sort((a, b) => (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || olderFirst(a, b))

  // Then pending that isn't already shown as flagged, oldest waiting first.
  const pending = items.filter((i) => i.pending && !i.flagged).sort(olderFirst)

  return {
    flagged,
    pending,
    counts: { flagged: flagged.length, pending: items.filter((i) => i.pending).length },
    pendingDays,
  }
}

// --------------------------------------------------------------------
// Email HTML (Gmail-safe: inline styles, ~600px, no <style>/<script>)
// --------------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  )
}

function card(item) {
  const meta = []
  if (item.pending && item.waitingDays != null) meta.push(`Waiting ${item.waitingDays} day${item.waitingDays === 1 ? '' : 's'}`)
  meta.push(item.assignedTo ? `Assigned: ${escapeHtml(item.assignedTo)}` : 'Unassigned')
  if (item.isGroup) meta.push('Group')

  const badge = item.level
    ? `<span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:${LEVEL_COLOR[item.level]};border-radius:10px;padding:2px 9px;margin-left:8px;vertical-align:middle;">${LEVEL_LABEL[item.level]}</span>`
    : ''
  const reason = item.reason
    ? `<div style="font-size:13px;color:${LEVEL_COLOR[item.level]};margin:6px 0 0;"><strong>Attention:</strong> ${escapeHtml(item.reason)}</div>`
    : ''

  return `
  <div style="border:1px solid #e5e5e5;border-radius:8px;padding:14px 16px;margin:0 0 12px;background:#ffffff;">
    <div style="font-size:15px;font-weight:700;color:#111;">${escapeHtml(item.name)}${badge}</div>
    <div style="font-size:12px;color:#888;margin:3px 0 0;">${meta.join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>
    ${reason}
    <div style="font-size:13px;line-height:1.5;color:#333;margin:8px 0 0;white-space:pre-wrap;">${escapeHtml(item.summary)}</div>
  </div>`
}

function section(title, count, items) {
  if (!items.length) return ''
  return `
  <div style="font-size:13px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px;">${escapeHtml(title)} (${count})</div>
  ${items.map(card).join('')}`
}

export function renderEmail(digest, cfg, now) {
  const date = new Date(now).toLocaleDateString('en-SG', {
    timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
  const nothing = !digest.flagged.length && !digest.pending.length

  const countsLine = nothing
    ? 'Nothing needs attention today.'
    : `${digest.counts.flagged} flagged · ${digest.counts.pending} pending ${digest.pendingDays}+ days`
  const subject = nothing
    ? `EOD digest — ${date} — all clear`
    : `EOD digest — ${date} — ${digest.counts.flagged} flagged, ${digest.counts.pending} pending`

  const body = nothing
    ? `<div style="font-size:14px;color:#333;padding:8px 0;">No conversations are flagged for attention, and nothing has been waiting ${digest.pendingDays}+ days. 👍</div>`
    : `${section('Needs attention', digest.flagged.length, digest.flagged)}
       ${section(`Waiting ${digest.pendingDays}+ days`, digest.pending.length, digest.pending)}`

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f2;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="font-size:20px;font-weight:800;color:#111;">EOD digest</div>
    <div style="font-size:13px;color:#666;margin:2px 0 0;">${escapeHtml(date)}&nbsp;&nbsp;·&nbsp;&nbsp;${escapeHtml(countsLine)}</div>
    ${body}
    <div style="font-size:11px;color:#aaa;margin:26px 0 0;border-top:1px solid #e5e5e5;padding:12px 0 0;">
      Automated end-of-day summary · reads existing AI summaries, no new analysis.
    </div>
  </div></body></html>`

  const text = nothing
    ? `EOD digest — ${date}\nNothing needs attention today.`
    : `EOD digest — ${date}\n${countsLine}\n\n` +
      [...digest.flagged, ...digest.pending]
        .map((i) => `• ${i.name}${i.level ? ` [${LEVEL_LABEL[i.level]}]` : ''}${i.waitingDays != null ? ` (waiting ${i.waitingDays}d)` : ''} — ${i.assignedTo || 'Unassigned'}\n  ${i.summary}`)
        .join('\n\n')

  return { subject, html, text }
}

// --------------------------------------------------------------------
// Resend + retry
// --------------------------------------------------------------------
async function sendResend(cfg, { subject, html, text }) {
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.from, to: [cfg.to], subject, html, text }),
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 400)
    throw new Error(`Resend ${res.status}: ${body}`)
  }
  return res.json().catch(() => ({}))
}

async function withRetry(fn, label, tries = 2, delayMs = 2000) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      console.error(`EOD: ${label} attempt ${i}/${tries} failed: ${err?.message || err}`)
      if (i < tries) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

/** Best-effort alert so a broken EOD is visible in the inbox, not just the logs. */
async function sendAlert(cfg, message) {
  try {
    await sendResend(cfg, {
      subject: 'EOD digest FAILED to run',
      html: `<div style="font-family:sans-serif;font-size:14px;color:#c0392b;">The daily EOD digest could not be produced:</div><pre style="font-size:12px;color:#333;">${escapeHtml(message)}</pre>`,
      text: `EOD digest failed to run: ${message}`,
    })
  } catch (err) {
    console.error('EOD: alert email also failed:', err?.message || err)
  }
}

// --------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------
async function runEod(env) {
  const cfg = readConfig(env)
  const now = Date.now()

  let data
  try {
    data = await withRetry(() => fetchEodData(cfg, now), 'supabase-read')
  } catch (err) {
    console.error('EOD: giving up on Supabase read:', err?.message || err)
    await sendAlert(cfg, `Supabase read failed: ${err?.message || err}`)
    throw err // marks the cron run as failed in Cloudflare observability
  }

  const digest = buildDigest({ ...data, now, pendingDays: cfg.pendingDays })
  const email = renderEmail(digest, cfg, now)

  await withRetry(() => sendResend(cfg, email), 'resend-send') // throws on final failure -> cron marked failed
  console.log(`EOD sent to ${cfg.to}: ${digest.counts.flagged} flagged, ${digest.counts.pending} pending (${cfg.pendingDays}+d)`)
}

export default {
  // Cron entry point. Awaited so a thrown failure marks the run errored (visible
  // in the Cloudflare dashboard / cron-failure alerts — the manual-check surface).
  async scheduled(event, env, ctx) {
    await runEod(env)
  },
  // Health check only — never triggers a send from a public request. Test the
  // real path locally with `wrangler dev --test-scheduled` + curl /__scheduled.
  async fetch() {
    return new Response('EOD digest worker — runs on cron (0 11 * * * UTC = 19:00 SGT).', {
      headers: { 'Content-Type': 'text/plain' },
    })
  },
}
