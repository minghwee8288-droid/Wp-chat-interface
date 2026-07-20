import { useEffect, useLayoutEffect, useRef } from 'react'
import { AlertCircle, Clock } from 'lucide-react'
import { clockTime, dayKey, dayLabel } from '../lib/format.js'

export default function Thread({ messages, loading }) {
  const scrollRef = useRef(null)
  const lastIdRef = useRef(null)
  const pinnedRef = useRef(true)

  // Only auto-scroll when the reader is already at the bottom, so polling
  // doesn't yank them out of older history they're reading.
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !messages.length) return

    const newestId = messages[messages.length - 1].id
    const changed = newestId !== lastIdRef.current
    const firstRender = lastIdRef.current === null
    lastIdRef.current = newestId

    if (firstRender || (changed && pinnedRef.current)) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  // Reset the pin whenever we switch to a different thread.
  useEffect(() => {
    pinnedRef.current = true
    lastIdRef.current = null
  }, [messages[0]?.conversation_id])

  if (loading && !messages.length) {
    return (
      <div className="thread-scroll">
        <div className="empty">
          <span className="spinner" />
        </div>
      </div>
    )
  }

  if (!messages.length) {
    return (
      <div className="thread-scroll">
        <div className="empty">
          <div className="empty-title">No messages yet</div>
          <div className="empty-sub">Send the first message to start this conversation.</div>
        </div>
      </div>
    )
  }

  let previousDay = null

  return (
    <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="msg-list">
        {messages.map((message) => {
          const isOut = message.direction === 'outbound'
          const failed = message.status === 'send_failed'
          const queued = message.status === 'queued'

          const key = dayKey(message.created_at)
          const showDay = key && key !== previousDay
          previousDay = key

          return (
            <div key={message.id}>
              {showDay ? (
                <div className="day-sep">
                  <span>{dayLabel(message.created_at)}</span>
                </div>
              ) : null}

              <div className={`msg-row ${isOut ? 'out' : 'in'}`}>
                <div
                  className={`bubble ${isOut ? 'bubble-out' : 'bubble-in'}${
                    failed ? ' bubble-failed' : ''
                  }`}
                >
                  <div className="bubble-text">{message.body}</div>
                  <div className="bubble-foot">
                    {isOut && message.sent_by ? <span>{message.sent_by}</span> : null}
                    <span>{clockTime(message.created_at)}</span>
                    {queued ? <Clock size={11} aria-label="Queued" /> : null}
                    {failed ? <AlertCircle size={11} aria-label="Failed to send" /> : null}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
