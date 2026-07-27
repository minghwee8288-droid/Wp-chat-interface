import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Play, Square, CheckCircle2, AlertTriangle, Zap } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useChannel } from '../context/ChannelContext.jsx'
import { displayName } from '../lib/format.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TERMINAL = new Set(['done', 'failed', 'canceled'])

/** unix seconds -> a short local date/time. */
function fmtTs(ts) {
  const d = new Date(Number(ts) * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Is this an automatic outage-recovery job? */
const isAuto = (job) => job?.scope?.type === 'auto'

/** Human label for a job's scope. */
function scopeLabel(job, conversations) {
  const s = job?.scope || {}
  if (s.type === 'auto') return `${fmtTs(s.from_ts)} → ${fmtTs(s.to_ts)}`
  if (s.type === 'range') return `${s.from} → ${s.to}`
  if (s.type === 'conversation') {
    const conv = conversations.find((c) => String(c.id) === String(s.conversation_id))
    return conv ? displayName(conv) : `Conversation #${s.conversation_id}`
  }
  return '—'
}

export default function Sync() {
  const { isAdmin } = useAuth()
  const channel = useChannel()

  const [mode, setMode] = useState('range') // 'range' | 'conversation'
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [conversationId, setConversationId] = useState('')
  const [conversations, setConversations] = useState([])

  const [job, setJob] = useState(null)
  const [jobs, setJobs] = useState([])
  const [driving, setDriving] = useState(false)
  const [error, setError] = useState(null)

  // Lets Stop halt the loop cooperatively without tearing down the request.
  const drivingRef = useRef(false)

  const loadJobs = useCallback(async () => {
    try {
      const d = await api.syncStatus()
      setJobs(d.jobs || [])
      return d.jobs || []
    } catch {
      return []
    }
  }, [])

  // Conversation picker + recent jobs, loaded once, then polled so auto
  // recoveries (driven from ChannelContext) show up live.
  useEffect(() => {
    let cancelled = false
    api.conversations().then((d) => !cancelled && setConversations(d.conversations || [])).catch(() => {})
    loadJobs().then((list) => {
      if (cancelled) return
      // Resume a manual job that was mid-run (not an auto one — those drive
      // themselves from the channel poll).
      const active = list.find((j) => !TERMINAL.has(j.status) && !isAuto(j))
      if (active) setJob(active)
    })
    const t = setInterval(() => !cancelled && loadJobs(), 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [loadJobs])

  const drive = useCallback(
    async (jobId, promote = false) => {
      drivingRef.current = true
      setDriving(true)
      setError(null)
      try {
        // Loop of bounded steps. Each returns the whole job, so progress
        // updates every iteration. `promote` runs a deferred (too-long) job.
        // eslint-disable-next-line no-constant-condition
        while (drivingRef.current) {
          const res = await api.syncStep(jobId, { promote })
          setJob(res.job)
          if (res.done || TERMINAL.has(res.job?.status)) break
          // Another driver holds the lease, a manual sync is running, or a soft
          // backoff was requested.
          if (res.busy || res.backoff || res.deferred) await sleep(1500)
        }
      } catch (err) {
        if (err.status !== 401) setError(err.message || 'Sync step failed')
      } finally {
        drivingRef.current = false
        setDriving(false)
        loadJobs()
      }
    },
    [loadJobs]
  )

  // Admin runs a deferred (too-long) auto-recovery deliberately.
  const runDeferred = (deferred) => {
    setJob(deferred)
    drive(deferred.id, true)
  }

  const clearHalt = async () => {
    try {
      await api.clearAutoHalt()
      channel.recheck?.()
      loadJobs()
    } catch (err) {
      setError(err.message || 'Could not clear the halt')
    }
  }

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

        {channel.autoHalted ? (
          <div className="alert alert-error sync-halt">
            <AlertTriangle size={15} />
            <span>
              Automatic recovery is paused after an account-level error:{' '}
              <strong>{channel.autoHalted}</strong>. Resolve it with Whapi, then clear this.
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={clearHalt}>
              Clear
            </button>
          </div>
        ) : null}

        {channel.autoRecovering ? (
          <div className="sync-auto-note" role="status">
            <span className="spinner" />
            Auto-recovering messages missed during a disconnection…
          </div>
        ) : null}

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

        {jobs.length ? (
          <section className="card">
            <div className="card-head">
              <RefreshCw size={16} style={{ color: 'var(--text-2)' }} />
              <h2 className="card-title">Recent syncs</h2>
            </div>
            <div className="sync-history">
              {jobs.map((j) => {
                const auto = isAuto(j)
                const deferred = j.status === 'deferred'
                return (
                  <div className="sync-history-row" key={j.id}>
                    <span className={`sync-tag${auto ? ' is-auto' : ''}`}>
                      {auto ? <Zap size={11} /> : null}
                      {auto ? 'Auto' : 'Manual'}
                    </span>
                    <span className="sync-history-scope">{scopeLabel(j, conversations)}</span>
                    <span className={`sync-history-status is-${j.status}`}>
                      {deferred ? 'Needs manual run' : j.status}
                    </span>
                    <span className="sync-history-counts">
                      {TERMINAL.has(j.status) || j.status === 'running'
                        ? `+${j.messages_added ?? 0} msgs`
                        : ''}
                    </span>
                    {deferred ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => runDeferred(j)}
                        disabled={driving}
                      >
                        <Play size={12} />
                        Run
                      </button>
                    ) : (
                      <span className="sync-history-spacer" />
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
