#!/usr/bin/env node
//
// Standalone local history backfill — imports up to a year of WhatsApp history
// from Whapi into the database. Runs from a workstation with `node`, NOT as a
// Cloudflare Worker: it exists precisely to escape the Worker subrequest limit
// that made the in-app manual sync fail ("too many subrequests") on large
// ranges.
//
// It reuses the LIVE app's persistence, unchanged, so there is zero drift:
//   • persistHistorical()  — functions/_lib/sync.js — is the exact function the
//     in-app sync uses. It owns the dedup key (whapi_message_id), the direction
//     handling (from_me -> outbound with sender columns), the media pipeline,
//     the group handling, and the "insert as read / don't touch unread / only
//     move last_message_at forward" rules. This script does NOT reimplement any
//     of that — it pages Whapi and hands each raw message to persistHistorical.
//   • listChats / listMessages — functions/_lib/whapi.js — for pagination.
//   • getDb — functions/_lib/db.js — the same @supabase/supabase-js client.
//
// NOTE ON DATABASE_URL: the brief mentioned a DATABASE_URL, but the shared
// persistence layer reaches Supabase over HTTPS (PostgREST) via supabase-js,
// which needs SUPABASE_URL + the service role key — a raw Postgres DATABASE_URL
// is neither used nor required. Using anything else would mean reimplementing
// persistence, which is exactly what we must not do.
//
// USAGE:
//   node scripts/backfill.mjs [FROM] [TO] [options]
//     FROM, TO      YYYY-MM-DD (default: 12 months ago .. today, UTC)
//     --delay=MS    ms between Whapi calls (default 250; also BACKFILL_DELAY_MS)
//     --page=N      messages per Whapi page (default 100)
//     --reset       ignore any saved cursor and start fresh
//     --cursor=PATH cursor file (default scripts/.backfill-cursor.json)
//
// Safe to run repeatedly and to interrupt (Ctrl-C): a local cursor file records
// progress, dedup makes re-runs write nothing twice, and a finished window is a
// no-op on re-run.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { persistHistorical } from '../functions/_lib/sync.js'
import { describeAttachment } from '../functions/_lib/ingest.js'
import { listChats, listMessages } from '../functions/_lib/whapi.js'
import { getDb } from '../functions/_lib/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Thrown on an account-level Whapi failure (402 / unauthorised) — must stop. */
export class AccountError extends Error {}

const MAX_429_RETRIES = 8
const MAX_MESSAGES_PER_CHAT = 100000 // safety valve against a pathological loop

// The shared persistence emits diagnostic and expected-media-failure logs;
// silence just those known-noisy lines so per-chat progress stays readable.
const NOISE = /^(sync\.diag|ingest: media fetch failed|ingest: media upload failed|ingest: recovered media)/

/**
 * Wrap the current global fetch so that ONLY Whapi-gate calls are throttled and
 * 429-retried. Supabase (our DB) and direct media CDN downloads pass straight
 * through. The shared modules call the global fetch, so this covers list AND
 * media fetches without touching shared code. Returns a restore fn.
 */
function installThrottle(whapiHost, delayMs, warn) {
  const realFetch = globalThis.fetch.bind(globalThis)
  let lastAt = 0
  globalThis.fetch = async (input, init) => {
    let host
    try {
      host = new URL(typeof input === 'string' ? input : input.url).host
    } catch {
      return realFetch(input, init)
    }
    if (host !== whapiHost) return realFetch(input, init)

    for (let attempt = 0; ; attempt++) {
      const wait = delayMs - (Date.now() - lastAt)
      if (wait > 0) await sleep(wait)
      lastAt = Date.now()

      const res = await realFetch(input, init)
      if (res.status !== 429) return res
      try {
        await res.body?.cancel()
      } catch {
        /* already consumed */
      }
      if (attempt >= MAX_429_RETRIES) return res
      const retryAfter = Number(res.headers.get('retry-after'))
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(60000, 1000 * 2 ** attempt)
      warn(`   … rate limited (429) — backing off ${Math.round(backoff / 1000)}s`)
      await sleep(backoff)
    }
  }
  return () => {
    globalThis.fetch = realFetch
  }
}

function installLogFilter() {
  const log = console.log
  const err = console.error
  console.log = (...a) => (typeof a[0] === 'string' && NOISE.test(a[0]) ? undefined : log(...a))
  console.error = (...a) => (typeof a[0] === 'string' && NOISE.test(a[0]) ? undefined : err(...a))
  return () => {
    console.log = log
    console.error = err
  }
}

const EMPTY_TOTALS = { chats: 0, found: 0, added: 0, duplicate: 0, skipped: 0, mediaStored: 0, mediaExpired: 0 }

/** Enumerate every chat, paging /chats until exhausted. ~ceil(N/100)+1 calls. */
async function allChats(env) {
  const chats = []
  let offset = 0
  for (;;) {
    const page = await listChats(env, { offset, count: 100 })
    if (!page.ok) {
      if (page.accountError) throw new AccountError(page.error)
      throw new Error(`Could not list chats: ${page.error}`)
    }
    if (!page.chats.length) break
    chats.push(...page.chats)
    offset += page.chats.length
    if (page.total && chats.length >= page.total) break
    if (!page.total && page.chats.length < 100) break
  }
  return chats
}

/**
 * Page a chat's messages within [fromTs,toTs] and persist each via the shared
 * persistHistorical. Stops on an empty page. onPage(offset) persists the resume
 * point after each page.
 */
async function processChat(env, db, chat, startOffset, opts, shouldStop, onPage) {
  const { fromTs, toTs, page } = opts
  const stat = { found: 0, added: 0, duplicate: 0, skipped: 0, mediaStored: 0, mediaExpired: 0 }
  let offset = startOffset

  for (;;) {
    if (shouldStop()) return { stat, offset, done: false }

    const list = await listMessages(env, chat.id, { offset, count: page, timeFrom: fromTs, timeTo: toTs })
    if (!list.ok) {
      if (list.accountError) throw new AccountError(list.error)
      // A per-chat failure is not fatal — record and move on, as the app does.
      return { stat, offset, done: true, error: list.error }
    }

    const msgs = list.messages
    if (!msgs.length) return { stat, offset, done: true }

    for (const msg of msgs) {
      // Defensive window guard (time_from/time_to should already bound it).
      const ts = Number(msg?.timestamp)
      if (Number.isFinite(ts) && (ts < fromTs || ts > toTs)) continue

      stat.found++
      const hadMedia = Boolean(describeAttachment(msg))
      const r = await persistHistorical(env, db, msg, chat.name)
      if (r.added) stat.added++
      else if (r.duplicate) stat.duplicate++
      else if (r.skipped) stat.skipped++
      // Only count media on newly-added rows, so a re-run does not double-count.
      if (hadMedia && r.added) {
        if (r.mediaFailed) stat.mediaExpired++
        else stat.mediaStored++
      }
    }

    offset += msgs.length
    onPage(offset)
    if (offset > MAX_MESSAGES_PER_CHAT) return { stat, offset, done: true, capped: true }
  }
}

/**
 * Run the whole backfill. Testable: pass an explicit config and (in tests) set
 * a stubbed globalThis.fetch first — the throttle wraps whatever is current.
 *
 * @returns { totals, chatsTotal, doneCount, interrupted }
 */
export async function runBackfill({
  env,
  from,
  to,
  fromTs,
  toTs,
  delayMs = 250,
  page = 100,
  cursorFile,
  reset = false,
  isStopping = () => false,
  log = console.log,
  warn = (m) => process.stderr.write(`${m}\n`),
}) {
  const whapiHost = new URL(env.WHAPI_API_URL || 'https://gate.whapi.cloud').host
  const restoreFetch = installThrottle(whapiHost, delayMs, warn)
  const restoreLog = installLogFilter()

  const db = getDb(env)

  const readCursor = () => {
    if (reset || !cursorFile || !fs.existsSync(cursorFile)) return null
    try {
      const c = JSON.parse(fs.readFileSync(cursorFile, 'utf8'))
      if (c?.window?.from === from && c?.window?.to === to) return c
      warn(`   (ignoring cursor for a different window ${c?.window?.from}..${c?.window?.to})`)
      return null
    } catch {
      return null
    }
  }
  const writeCursor = (c) => cursorFile && fs.writeFileSync(cursorFile, JSON.stringify(c, null, 2))

  try {
    const prior = readCursor()
    const done = new Set(prior?.processed || [])
    const totals = { ...EMPTY_TOTALS, ...(prior?.totals || {}) }
    const resumeCurrent = prior?.current || null
    if (prior) log(`Resuming: ${done.size} chats already done.\n`)

    const chats = await allChats(env)
    log(`${chats.length} chats to consider.\n`)

    const cursor = { window: { from, to }, processed: [...done], current: resumeCurrent, totals }
    const persist = () => writeCursor(cursor)

    let interrupted = false
    let index = 0
    for (const chat of chats) {
      index++
      if (done.has(chat.id)) continue
      if (isStopping()) {
        interrupted = true
        break
      }

      const startOffset =
        resumeCurrent && resumeCurrent.id === chat.id ? Number(resumeCurrent.msgOffset) || 0 : 0

      const { stat, done: finished, error, capped } = await processChat(
        env,
        db,
        chat,
        startOffset,
        { fromTs, toTs, page },
        isStopping,
        (offset) => {
          cursor.current = { id: chat.id, msgOffset: offset }
          persist()
        }
      )

      for (const k of Object.keys(stat)) totals[k] += stat[k]

      const kind = chat.isGroup ? 'group' : 'chat'
      log(
        `[${index}/${chats.length}] ${chat.name || chat.id} (${kind}): ` +
          `found ${stat.found}, added ${stat.added}, dup ${stat.duplicate}` +
          (stat.skipped ? `, skipped ${stat.skipped}` : '') +
          (stat.mediaStored || stat.mediaExpired ? `, media ✓${stat.mediaStored} ✗${stat.mediaExpired}` : '') +
          (capped ? '  ⚠ hit message cap' : '') +
          (error ? `  ⚠ ${error}` : '')
      )

      if (finished) {
        done.add(chat.id)
        totals.chats++
        cursor.processed = [...done]
        cursor.current = null
        persist()
      } else {
        interrupted = true
        persist()
        break
      }
    }

    // Clean finish (nothing left, not interrupted): drop the cursor.
    if (!interrupted && done.size >= chats.length && cursorFile) {
      try {
        fs.unlinkSync(cursorFile)
      } catch {
        /* ignore */
      }
    }

    return { totals, chatsTotal: chats.length, doneCount: done.size, interrupted }
  } finally {
    restoreLog()
    restoreFetch()
  }
}

// ------------------------------------------------------------------- direct run
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = val
  }
}

const fmtDate = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

async function cli() {
  loadEnvFile(path.join(ROOT, '.env'))
  loadEnvFile(path.join(__dirname, '.env'))

  const flags = {}
  const positional = []
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2]
    else positional.push(a)
  }

  const die = (msg) => {
    process.stderr.write(`\n✖ ${msg}\n`)
    process.exit(1)
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  const now = new Date()
  const fromD = new Date(now)
  fromD.setUTCFullYear(fromD.getUTCFullYear() - 1)
  const from = positional[0] || fmtDate(fromD)
  const to = positional[1] || fmtDate(now)
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) die(`Dates must be YYYY-MM-DD. Got FROM=${from} TO=${to}`)
  if (from > to) die(`FROM (${from}) must be on or before TO (${to}).`)

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
    WHAPI_TOKEN: process.env.WHAPI_TOKEN,
    WHAPI_API_URL: process.env.WHAPI_API_URL || 'https://gate.whapi.cloud',
    BUSINESS_NUMBER: process.env.BUSINESS_NUMBER,
  }
  const missing = Object.entries({
    SUPABASE_URL: env.SUPABASE_URL,
    'SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)': env.SUPABASE_SERVICE_ROLE_KEY,
    WHAPI_TOKEN: env.WHAPI_TOKEN,
    BUSINESS_NUMBER: env.BUSINESS_NUMBER,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) die(`Missing config: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`)

  const delayMs = Number(flags.delay ?? process.env.BACKFILL_DELAY_MS ?? 250) || 250
  const page = Math.max(1, Number(flags.page ?? 100) || 100)
  const cursorFile = flags.cursor ? path.resolve(String(flags.cursor)) : path.join(__dirname, '.backfill-cursor.json')
  const reset = Boolean(flags.reset)

  const fromTs = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000)
  const toTs = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000)

  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) process.exit(130)
    stopping = true
    process.stderr.write('\n… finishing the current page, then saving and exiting (Ctrl-C again to force)\n')
  })

  const startedAt = Date.now()
  console.log(`\nBackfill ${from} → ${to}  (delay ${delayMs}ms/call, page ${page})`)
  console.log(`Cursor: ${cursorFile}${reset ? ' (reset)' : ''}\n`)

  let result
  try {
    result = await runBackfill({
      env, from, to, fromTs, toTs, delayMs, page, cursorFile, reset,
      isStopping: () => stopping,
    })
  } catch (err) {
    if (err instanceof AccountError) {
      die(
        `Account-level Whapi error — STOPPING: ${err.message}\n` +
          `  Usually a 402 (quota/payment) or an unauthorised channel.\n` +
          `  Resolve it with Whapi, then re-run — the script resumes from its cursor.`
      )
    }
    process.stderr.write(`\n✖ Backfill failed: ${err?.stack || err}\n  Progress is saved — re-run to resume.\n`)
    process.exit(1)
  }

  const { totals, chatsTotal, doneCount, interrupted } = result
  const secs = Math.round((Date.now() - startedAt) / 1000)
  console.log('\n──────────────────')
  console.log(
    interrupted || doneCount < chatsTotal
      ? `Interrupted — ${doneCount}/${chatsTotal} chats done. Re-run to resume.`
      : `Done — all ${chatsTotal} chats.`
  )
  console.log(
    `Chats processed:       ${totals.chats}\n` +
      `Messages found:        ${totals.found}\n` +
      `Messages added:        ${totals.added}\n` +
      `Already present:       ${totals.duplicate}\n` +
      `Skipped (no content):  ${totals.skipped}\n` +
      `Media stored:          ${totals.mediaStored}\n` +
      `Media expired:         ${totals.mediaExpired}\n` +
      `Elapsed:               ${Math.floor(secs / 60)}m ${secs % 60}s`
  )
  console.log('──────────────────\n')
}

// Only run when invoked directly (`node scripts/backfill.mjs`), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli()
}
