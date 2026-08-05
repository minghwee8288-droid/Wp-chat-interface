import { useEffect, useState } from 'react'
import { Sparkles, AlertTriangle, X } from 'lucide-react'
import { api } from '../lib/api.js'

const ATTENTION = { management: 'Management', team: 'Team', general: 'General' }

// The endpoint now returns immediately and generates in the background, so we
// poll for the finished text instead of holding one long request open.
const POLL_MS = 3000
const MAX_POLLS = 12 // ~36s, then stop and keep whatever we have

/**
 * Fixed-position anchored to the tapped icon. Fixed (not absolute) so it escapes
 * the conversation list's overflow, and clamped to the viewport so it never
 * overflows a 390px screen. Flips above the anchor when the row sits low.
 */
function computePosition(rect) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(300, vw - 16)
  const left = Math.max(8, Math.min(Math.round(rect.right - width), vw - width - 8))
  const style = { position: 'fixed', width, left }
  if (rect.bottom < vh * 0.62) style.top = Math.round(rect.bottom + 6)
  else style.bottom = Math.round(vh - rect.top + 6)
  return style
}

/**
 * Compact AI short-summary popover launched from a conversation row. Reuses the
 * SAME summary endpoint (api.summary) — no second summary path — and caches the
 * result per conversation so re-opening is instant and taps stay lazy.
 */
export default function SummaryPopover({ conversation, anchorRect, cache, onClose }) {
  const cached = cache.get(conversation.id)
  const [pos] = useState(() => computePosition(anchorRect))
  const [status, setStatus] = useState(cached ? (cached.summary ? 'ready' : 'empty') : 'loading')
  const [summary, setSummary] = useState(cached?.summary ?? null)
  const [stale, setStale] = useState(Boolean(cached?.stale))

  // Close on anything that moves the anchor or on Escape.
  useEffect(() => {
    const onScroll = () => onClose()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Lazy fetch — only when opened, and only if not already cached. A response
  // flagged `generating` means the model is running server-side, so we show any
  // stale text right away and re-poll until the fresh summary lands.
  useEffect(() => {
    if (cache.has(conversation.id)) return
    const controller = new AbortController()
    let timer = null
    let attempts = 0
    let stopped = false

    const finish = (entry) => {
      cache.set(conversation.id, entry)
      setSummary(entry.summary)
      setStale(Boolean(entry.stale))
      setStatus(entry.summary ? 'ready' : 'empty')
    }

    const poll = () => {
      attempts += 1
      api
        .summary(conversation.id, controller.signal)
        .then((res) => {
          if (stopped || controller.signal.aborted) return

          if (res?.generating) {
            // Show the stale summary while the fresh one generates — but don't
            // cache it, so the next open still asks for the finished text.
            if (res.summary) {
              setSummary(res.summary)
              setStale(Boolean(res.refresh_failed))
            }
            setStatus('generating')
            if (attempts < MAX_POLLS) timer = setTimeout(poll, POLL_MS)
            return
          }

          if (res?.summary) {
            finish({ summary: res.summary, stale: Boolean(res.refresh_failed) })
          } else {
            finish({ summary: null })
          }
        })
        .catch((err) => {
          if (stopped || controller.signal.aborted || err?.name === 'AbortError') return
          setStatus('error')
        })
    }

    poll()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }, [conversation.id, cache])

  const level = summary?.attention_required ? summary.attention_level || 'general' : null

  return (
    <>
      <div className="summary-pop-backdrop" onClick={onClose} />
      <div className="summary-pop" style={pos} role="dialog" aria-label="AI summary">
        <div className="summary-pop-head">
          <span className="summary-pop-title">
            <Sparkles size={13} />
            AI summary
          </span>
          <button type="button" className="summary-pop-close" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {(status === 'loading' || status === 'generating') && !summary ? (
          <div className="summary-pop-note">
            <span className="spinner" />
            Summarizing…
          </div>
        ) : status === 'error' ? (
          <div className="summary-pop-note">Couldn’t load the summary.</div>
        ) : status === 'empty' || !summary ? (
          <div className="summary-pop-note">No summary yet.</div>
        ) : (
          <div className="summary-pop-body">
            {level ? (
              <div className={`summary-pop-attn summary-pop-attn--${level}`}>
                <AlertTriangle size={12} className="summary-pop-attn-icon" />
                <span>
                  <strong>{ATTENTION[level]}</strong>
                  {summary.attention_reason ? ` — ${summary.attention_reason}` : ''}
                </span>
              </div>
            ) : null}
            <p className="summary-pop-text">{summary.text}</p>
            {status === 'generating' ? (
              <div className="summary-pop-stale">
                <span className="spinner" />
                Updating…
              </div>
            ) : stale ? (
              <div className="summary-pop-stale">Couldn’t refresh — showing the last summary.</div>
            ) : null}
          </div>
        )}
      </div>
    </>
  )
}
