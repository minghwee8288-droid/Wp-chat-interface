import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'

const ChannelContext = createContext(null)

// Deliberately slow — this is infrastructure state, not message data. It must
// never join the 4s/5s message polling cycle.
const CHANNEL_POLL_MS = 60000

export function ChannelProvider({ children }) {
  const [state, setState] = useState({
    connected: true, // optimistic: never flash a disconnect banner on cold start
    status: null,
    uptime: null,
    checkedAt: null,
    known: false,
  })

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    const check = async () => {
      try {
        const data = await api.channelStatus(controller.signal)
        if (cancelled) return
        setState({
          connected: data.connected !== false,
          status: data.status ?? null,
          uptime: data.uptime ?? null,
          checkedAt: data.checked_at ?? null,
          known: true,
        })
      } catch (err) {
        if (cancelled || err.name === 'AbortError' || err.status === 401) return
        // Our own API being unreachable says nothing about the Whapi channel,
        // so leave the last known state rather than crying disconnected.
      }
    }

    check()
    const interval = setInterval(check, CHANNEL_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
      controller.abort()
    }
  }, [])

  const value = useMemo(
    () => ({ ...state, disconnected: state.known && !state.connected }),
    [state]
  )

  return <ChannelContext.Provider value={value}>{children}</ChannelContext.Provider>
}

export function useChannel() {
  const ctx = useContext(ChannelContext)
  // Optional: components outside the provider simply see a healthy channel.
  return ctx || { connected: true, disconnected: false, known: false, uptime: null, status: null }
}

/** 93899 -> "1d 2h" */
export function formatUptime(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return null
  const d = Math.floor(n / 86400)
  const h = Math.floor((n % 86400) / 3600)
  const m = Math.floor((n % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}
