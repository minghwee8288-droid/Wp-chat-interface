import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, AlertTriangle, RefreshCw, Smartphone } from 'lucide-react'
import Modal from './Modal.jsx'
import { api } from '../lib/api.js'
import { useChannel } from '../context/ChannelContext.jsx'

// After a relaunch, poll health a few times before falling back to the QR —
// a relaunch that works usually does so within a few seconds.
const RELAUNCH_POLL_MS = 2000
const RELAUNCH_ATTEMPTS = 5

// While a QR is on screen: poll health to notice a scan, and refetch the code
// before WhatsApp rotates it (~20s) so nobody scans a dead one.
const HEALTH_POLL_MS = 3000
const QR_REFRESH_SECONDS = 20

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Admin channel-reconnect flow.
 *
 *   relaunching → connected            — recovered from the relaunch alone
 *              → qr → connected        — needed a device link (QR scan)
 *   error at any point offers a retry.
 *
 * A monotonic `run` guards every async completion: a poll from a superseded
 * attempt checks it is still current before touching state. QR-phase timers
 * live in an effect keyed on the phase, so they are always torn down on close.
 */
export default function ReconnectModal({ onClose }) {
  const channel = useChannel()
  const [phase, setPhase] = useState('relaunching') // relaunching | qr | connected | error
  const [qr, setQr] = useState(null)
  const [secondsLeft, setSecondsLeft] = useState(QR_REFRESH_SECONDS)
  const [error, setError] = useState(null)

  const runRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const alive = useCallback((runId) => runId === runRef.current && mountedRef.current, [])

  const succeed = useCallback(() => {
    runRef.current++ // invalidate every in-flight loop
    setPhase('connected')
    // Clear the banner now, not on the next 60s poll.
    channel.recheck?.()
  }, [channel])

  const loadQr = useCallback(async () => {
    const runId = runRef.current
    try {
      const data = await api.channelQr()
      if (!alive(runId)) return
      if (data.connected) return succeed()
      if (!data.qr) {
        setError('Could not load a QR code. Try again in a moment.')
        return
      }
      setError(null)
      setQr(data.qr)
      setSecondsLeft(Number(data.expires_in) > 0 ? Number(data.expires_in) : QR_REFRESH_SECONDS)
    } catch (err) {
      if (!alive(runId)) return
      if (err.status === 403) {
        setError('Only an admin can reconnect the channel.')
        setPhase('error')
      } else {
        setError(err.message || 'Could not load a QR code.')
      }
    }
  }, [alive, succeed])

  // The relaunch attempt — also the entry point.
  const startRelaunch = useCallback(async () => {
    const runId = ++runRef.current
    setPhase('relaunching')
    setError(null)
    setQr(null)

    try {
      const data = await api.channelRelaunch()
      if (!alive(runId)) return
      if (data.connected) return succeed()
    } catch (err) {
      if (!alive(runId)) return
      if (err.status === 403) {
        setError('Only an admin can reconnect the channel.')
        setPhase('error')
        return
      }
      // A failed relaunch call is not fatal — fall through to the QR.
    }

    for (let i = 0; i < RELAUNCH_ATTEMPTS; i++) {
      await sleep(RELAUNCH_POLL_MS)
      if (!alive(runId)) return
      try {
        const data = await api.channelStatus()
        if (data.connected && alive(runId)) return succeed()
      } catch {
        /* transient */
      }
    }

    if (!alive(runId)) return
    setQr(null)
    setSecondsLeft(QR_REFRESH_SECONDS)
    setPhase('qr') // the effect below fetches the code and starts the timers
  }, [alive, succeed])

  // Fetch the QR as soon as we enter the QR phase.
  useEffect(() => {
    if (phase === 'qr') loadQr()
  }, [phase, loadQr])

  // QR-phase timers: notice a scan, and refresh the code before it expires.
  useEffect(() => {
    if (phase !== 'qr') return undefined
    const runId = runRef.current

    const health = setInterval(async () => {
      try {
        const data = await api.channelStatus()
        if (data.connected && alive(runId)) succeed()
      } catch {
        /* keep polling */
      }
    }, HEALTH_POLL_MS)

    const tick = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          loadQr() // fetch a fresh code, reset the countdown from its response
          return QR_REFRESH_SECONDS
        }
        return s - 1
      })
    }, 1000)

    return () => {
      clearInterval(health)
      clearInterval(tick)
    }
  }, [phase, alive, succeed, loadQr])

  // Kick off on open. A channel that is already healthy shows a confirmation,
  // never a QR.
  useEffect(() => {
    if (channel.connected && channel.known) {
      setPhase('connected')
    } else {
      startRelaunch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Modal
      title="Reconnect WhatsApp"
      subtitle={
        phase === 'connected'
          ? 'Connected'
          : phase === 'qr'
            ? 'Scan to link this device'
            : phase === 'error'
              ? 'Something went wrong'
              : 'Trying to reconnect…'
      }
      onClose={onClose}
    >
      <div className="reconnect">
        {phase === 'relaunching' ? (
          <div className="reconnect-status">
            <span className="spinner" />
            <p>Asking WhatsApp to relaunch the channel. This usually takes a few seconds…</p>
          </div>
        ) : null}

        {phase === 'qr' ? (
          <div className="reconnect-qr">
            {qr ? (
              <img
                className="reconnect-qr-img"
                src={qr}
                alt="WhatsApp login QR code"
                width={256}
                height={256}
              />
            ) : (
              <div className="reconnect-qr-img is-loading">
                <span className="spinner" />
              </div>
            )}

            <ol className="reconnect-steps">
              <li>Open WhatsApp on the phone that runs this number</li>
              <li>
                Tap <strong>Settings → Linked Devices</strong>
              </li>
              <li>
                Tap <strong>Link a Device</strong> and scan this code
              </li>
            </ol>

            <div className="reconnect-qr-foot">
              <span className="reconnect-expiry" role="status" aria-live="polite">
                {secondsLeft > 0 ? `Code refreshes in ${secondsLeft}s` : 'Refreshing…'}
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={loadQr}>
                <RefreshCw size={13} />
                New code
              </button>
            </div>

            {error ? <div className="alert alert-error">{error}</div> : null}

            <div className="reconnect-hint">
              <Smartphone size={14} />
              Waiting for the scan — this updates the moment it connects.
            </div>
          </div>
        ) : null}

        {phase === 'connected' ? (
          <div className="reconnect-status is-ok">
            <CheckCircle2 size={40} />
            <p>WhatsApp is connected. Messages are flowing again.</p>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="reconnect-status is-error">
            <AlertTriangle size={34} />
            <p>{error || 'The channel could not be reconnected.'}</p>
            <button type="button" className="btn btn-primary" onClick={startRelaunch}>
              <RefreshCw size={14} />
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
