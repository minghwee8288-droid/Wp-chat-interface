import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, Clock } from 'lucide-react'
import { clockTime, dayKey, dayLabel, displayName, initials } from '../lib/format.js'
import MediaAttachment from './MediaAttachment.jsx'
import Lightbox from './Lightbox.jsx'

/**
 * Consecutive messages from the same sender form a "run": they get tight
 * spacing, and only the last one shows an avatar.
 */
const runKey = (message) =>
  message.direction === 'inbound' ? 'in' : `out:${message.sent_by || ''}`

export default function Thread({ messages, loading, conversation }) {
  const [lightbox, setLightbox] = useState(null)
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

  const contactName = displayName(conversation)
  let previousDay = null

  return (
    <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="msg-list">
        {messages.map((message, index) => {
          const isOut = message.direction === 'outbound'
          const failed = message.status === 'send_failed'
          const queued = message.status === 'queued'

          const hasMedia = Boolean(
            message.media_path || message.media_error || message.media_type
          )
          const caption = message.body || message.media_caption || ''
          const mediaOnly = hasMedia && !caption
          const isImage = hasMedia && message.media_type === 'image' && !message.media_error

          const key = dayKey(message.created_at)
          const showDay = key && key !== previousDay
          previousDay = key

          // A day separator also starts a fresh run.
          const previous = messages[index - 1]
          const next = messages[index + 1]
          const isRunStart = showDay || !previous || runKey(previous) !== runKey(message)
          const isRunEnd =
            !next ||
            runKey(next) !== runKey(message) ||
            (dayKey(next.created_at) && dayKey(next.created_at) !== key)

          const who = isOut ? message.sent_by || 'You' : contactName

          const meta = (
            <span className="bubble-meta">
              {clockTime(message.created_at)}
              {queued ? <Clock size={11} aria-label="Queued" /> : null}
              {failed ? <AlertCircle size={11} aria-label="Failed to send" /> : null}
            </span>
          )

          const avatar = isRunEnd ? (
            <span className="msg-avatar" title={who} aria-label={who}>
              {initials(who)}
            </span>
          ) : (
            <span className="msg-spacer" aria-hidden="true" />
          )

          return (
            <div key={message.id}>
              {showDay ? (
                <div className="day-sep">
                  <span>{dayLabel(message.created_at)}</span>
                </div>
              ) : null}

              <div
                className={`msg-row ${isOut ? 'out' : 'in'}${isRunStart ? ' run-start' : ''}`}
              >
                {!isOut ? avatar : null}

                <div
                  className={`bubble ${isOut ? 'bubble-out' : 'bubble-in'}${
                    failed ? ' bubble-failed' : ''
                  }${hasMedia ? ' has-media' : ''}${mediaOnly ? ' is-media-only' : ''}`}
                >
                  {hasMedia ? (
                    <MediaAttachment
                      message={message}
                      onOpenImage={setLightbox}
                      /* An uncaptioned image carries its stamp as an overlay
                         instead of costing a whole text line. */
                      stamp={mediaOnly && isImage ? meta : null}
                    />
                  ) : null}

                  {caption ? (
                    <div className="bubble-text">
                      {caption}
                      {meta}
                    </div>
                  ) : null}

                  {/* Chips (and failed media) have nothing to overlay onto. */}
                  {mediaOnly && !isImage ? <div className="bubble-meta-row">{meta}</div> : null}
                </div>

                {isOut ? avatar : null}
              </div>
            </div>
          )
        })}
      </div>

      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
