import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Play, Square, CheckCircle2, AlertTriangle } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { displayName } from '../lib/format.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TERMINAL = new Set(['done', 'failed', 'canceled'])

/** Human label for a job's scope. */
function scopeLabel(job, conversations) {
  const s = job?.scope || {}
  if (s.type === 'range') return `${s.from} → ${s.to}`
  if (s.type === 'conversation') {
    const conv = conversations.find((c) => String(c.id) === String(s.conversation_id))
    return conv ? displayName(conv) : `Conversation #${s.conversation_id}`
  }
  return '—'
}

export default function Sync() {
  const { isAdmin } = useAuth()

  const [mode, setMode] = useState('range') // 'range' | 'conversation'
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [conversationId, setConversationId] = useState('')
  const [conversations, setConversations] = useState([])

  const [job, setJob] = useState(null)
  const [driving, setDriving] = useState(false)
  const [error, setError] = useState(null)

  // Lets Stop halt the loop cooperatively without tearing down the request.
  const drivingRef = useRef(false)

  // Conversation picker + a resumable job, loaded once.
  useEffect(() => {
    let cancelled = false
    api.conversations().then((d) => !cancelled && setConversations(d.conversations || [])).catch(() => {})
    api
      .syncStatus()
      .then((d) => {
        if (cancelled) return
        const active = (d.jobs || []).find((j) => !TERMINAL.has(j.status))
        if (active) setJob(active)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const drive = useCallback(
    async (jobId) => {
      drivingRef.current = true
      setDriving(true)
      setError(null)
      try {
        // Loop of bounded steps. Each returns the whole job, so progress
        // updates every iteration.
        // eslint-disable-next-line no-constant-condition
        while (drivingRef.current) {
          const res = await api.syncStep(jobId)
          setJob(res.job)
          if (res.done || TERMINAL.has(res.job?.status)) break
          // Another driver holds the lease, or a soft backoff was requested.
          if (res.busy || res.backoff) await sleep(1500)
        }
      } catch (err) {
        if (err.status !== 401) setError(err.message || 'Sync step failed')
      } finally {
        drivingRef.current = false
        setDriving(false)
      }
    },
    []
  )

  const start = async () => {
    setError(null)
    let scope
    if (mode === 'range') {
      if (!from || !to) return setError('Choose a start and end date.')
      if (from > to) return setError('The start date must be on or before the end date.')
      scope = { type: 'range', from, to }
    } else {
      if (!conversationId) return setError('Choose a conversation.')
      scope = { type: 'conversation', conversation_id: Number(conversationId) }
    }

    try {
      const { job: created } = await api.syncStart(scope)
      setJob(created)
      drive(created.id)
    } catch (err) {
      setError(err.message || 'Could not start the sync')
    }
  }

  const stop = () => {
    // Cooperative: halts the client loop. The job stays resumable — the server
    // lease expires within ~2 minutes and its cursor is intact.
    drivingRef.current = false
    setDriving(false)
  }

  if (!isAdmin) return <Navigate to="/inbox" replace />

  const running = job && !TERMINAL.has(job.status)
  const finished = job && TERMINAL.has(job.status)

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <Link to="/inbox" className="btn btn-secondary btn-sm page-back">
          <ArrowLeft size={14} />
          Back to inbox
        </Link>

        <section className="card">
          <div className="card-head">
            <RefreshCw size={17} style={{ color: 'var(--text-2)' }} />
            <h2 className="card-title">Sync missed messages</h2>
          </div>

          <div className="card-body">
            <p className="sync-lede">
              Backfill inbound messages Whapi has that we do not — after a disconnection, or
              to import history. Synced messages are marked read, never trigger notifications, and
              never reorder your conversations by their old timestamps.
            </p>

            <div className="sync-mode">
              <label className={`sync-mode-opt${mode === 'range' ? ' is-on' : ''}`}>
                <input
                  type="radio"
                  name="sync-mode"
                  checked={mode === 'range'}
                  onChange={() => setMode('range')}
                />
                A date range
              </label>
              <label className={`sync-mode-opt${mode === 'conversation' ? ' is-on' : ''}`}>
                <input
                  type="radio"
                  name="sync-mode"
                  checked={mode === 'conversation'}
                  onChange={() => setMode('conversation')}
                />
                A single conversation
              </label>
            </div>

            {mode === 'range' ? (
              <div className="form-grid">
                <div className="field">
                  <label className="label" htmlFor="sync-from">From</label>
                  <input
                    id="sync-from"
                    className="input"
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="sync-to">To</label>
                  <input
                    id="sync-to"
                    className="input"
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="field">
                <label className="label" htmlFor="sync-conv">Conversation</label>
                <select
                  id="sync-conv"
                  className="select"
                  value={conversationId}
                  onChange={(e) => setConversationId(e.target.value)}
                >
                  <option value="">Choose a conversation…</option>
                  {conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {displayName(c)}
                      {c.is_group ? ' (group)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {error ? <div className="alert alert-error">{error}</div> : null}

            <div className="form-grid-actions">
              {running ? (
                <button type="button" className="btn btn-secondary" onClick={stop} disabled={!driving}>
                  <Square size={14} />
                  {driving ? 'Stop' : 'Paused'}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={start}>
                  <Play size={15} />
                  Start sync
                </button>
              )}
              {running && !driving ? (
                <button type="button" className="btn btn-primary" onClick={() => drive(job.id)}>
                  <Play size={15} />
                  Resume
                </button>
              ) : null}
            </div>
          </div>
        </section>

        {job ? (
          <section className="card">
            <div className="card-head">
              {finished ? (
                job.status === 'done' ? (
                  <CheckCircle2 size={17} style={{ color: 'var(--success)' }} />
                ) : (
                  <AlertTriangle size={17} style={{ color: 'var(--danger)' }} />
                )
              ) : (
                <span className="spinner" style={{ color: 'var(--text-3)' }} />
              )}
              <h2 className="card-title">
                {finished
                  ? job.status === 'done'
                    ? 'Sync complete'
                    : `Sync ${job.status}`
                  : driving
                    ? 'Syncing…'
                    : 'Paused'}
              </h2>
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
                {scopeLabel(job, conversations)}
              </span>
            </div>

            <div className="card-body">
              <div className="sync-stats">
                <div className="sync-stat">
                  <span className="sync-stat-num">{job.conversations_done ?? 0}</span>
                  <span className="sync-stat-label">Conversations processed</span>
                </div>
                <div className="sync-stat">
                  <span className="sync-stat-num">{job.messages_added ?? 0}</span>
                  <span className="sync-stat-label">Messages added</span>
                </div>
                <div className="sync-stat">
                  <span className="sync-stat-num">{job.media_failed ?? 0}</span>
                  <span className="sync-stat-label">Attachments unavailable</span>
                </div>
              </div>

              {Array.isArray(job.errors) && job.errors.length ? (
                <div className="sync-errors">
                  <div className="sync-errors-title">
                    {job.errors.length} chat{job.errors.length === 1 ? '' : 's'} could not be read
                  </div>
                  <ul className="sync-errors-list">
                    {job.errors.slice(0, 8).map((e, i) => (
                      <li key={i}>
                        <code>{e.chat || '—'}</code> · {e.error}
                      </li>
                    ))}
                    {job.errors.length > 8 ? <li>…and {job.errors.length - 8} more</li> : null}
                  </ul>
                </div>
              ) : null}

              {job.last_error && job.status === 'failed' ? (
                <div className="alert alert-error">{job.last_error}</div>
              ) : null}

              {finished && job.status === 'done' ? (
                <p className="sync-done-note">
                  {job.messages_added
                    ? 'New messages are in the inbox. Attachments marked unavailable had expired on Whapi and cannot be recovered.'
                    : 'Everything was already up to date — nothing needed adding.'}
                </p>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
