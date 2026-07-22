import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, Clock } from 'lucide-react'
import {
  clockTime,
  dayKey,
  dayLabel,
  displayName,
  initials,
  avatarIndex,
} from '../lib/format.js'
import MediaAttachment from './MediaAttachment.jsx'
import Lightbox from './Lightbox.jsx'

/**
 * Consecutive messages from the same sender form a "run": they get tight
 * spacing, and only the last one shows an avatar.
 */
const runKey = (message) =>
  message.direction === 'inbound'
    // In a group, each participant is their own run — otherwise two people in
    // a row would share one avatar and one sender label.
    ? `in:${message.sender_number || ''}`
    : `out:${message.sent_by || ''}`

/** Distance from either end at which the next page starts loading. */
const LOAD_THRESHOLD_PX = 300

/** How long a jumped-to message stays highlighted. Matches the CSS animation. */
const FLASH_MS = 2200

export default function Thread({
  messages,
  loading,
  conversation,
  hasMoreBefore = false,
  hasMoreAfter = false,
  loadingMore = null,
  onLoadOlder,
  onLoadNewer,
  anchorMessageId = null,
}) {
  const isGroup = Boolean(conversation?.is_group)
  const [lightbox, setLightbox] = useState(null)
  const [flashId, setFlashId] = useState(null)
  const scrollRef = useRef(null)
  const lastIdRef = useRef(null)
  const pinnedRef = useRef(true)

  // Set just before an older page is requested; consumed once by the layout
  // effect below to keep the reader's viewport still while content is
  // inserted ABOVE them.
  const prependRef = useRef(null)

  // The anchor we have not yet scrolled to. Held in a ref rather than compared
  // in the effect body because the message only exists in the DOM once the
  // window that contains it has rendered.
  const pendingAnchorRef = useRef(null)

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return

    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight

    // "Pinned" now requires being at the live edge as well as at the bottom of
    // the loaded window. Without the hasMoreAfter test, opening an old search
    // result whose window happens to be short would look pinned, and the next
    // poll would scroll the reader away from the message they jumped to.
    pinnedRef.current = !hasMoreAfter && fromBottom < 90

    if (loadingMore) return

    if (hasMoreBefore && el.scrollTop < LOAD_THRESHOLD_PX && onLoadOlder) {
      prependRef.current = { height: el.scrollHeight, top: el.scrollTop }
      onLoadOlder()
    } else if (hasMoreAfter && fromBottom < LOAD_THRESHOLD_PX && onLoadNewer) {
      onLoadNewer()
    }
  }

  // A new anchor is a fresh jump request, even if it is in the window already.
  useEffect(() => {
    pendingAnchorRef.current = anchorMessageId
    // Clear any previous flash immediately so two jumps in a row can't leave
    // two messages lit at once.
    setFlashId(null)
  }, [anchorMessageId])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !messages.length) return

    // 1. Older page just landed: hold the viewport still. Must come first —
    //    it is the only case where scrollTop must NOT move.
    const prepend = prependRef.current
    if (prepend) {
      prependRef.current = null
      el.scrollTop = el.scrollHeight - prepend.height + prepend.top
      lastIdRef.current = messages[messages.length - 1].id
      return
    }

    // 2. A jump target is present in the DOM: centre it.
    const anchor = pendingAnchorRef.current
    if (anchor != null) {
      const node = el.querySelector(`[data-message-id="${anchor}"]`)
      if (node) {
        pendingAnchorRef.current = null
        // Centred rather than scrollIntoView's default, so the messages either
        // side of the hit are visible — the context is the reason for jumping.
        const target = node.offsetTop - el.clientHeight / 2 + node.offsetHeight / 2
        el.scrollTop = Math.max(0, target)
        lastIdRef.current = messages[messages.length - 1].id
        setFlashId(anchor)
        return
      }
      // Not rendered yet — leave it pending and fall through, so a normal
      // bottom-anchor does not fight the jump on the next render.
      return
    }

    // 3. Ordinary behaviour, unchanged: stick to the bottom on first paint and
    //    on new messages, but only if the reader was already there.
    const newestId = messages[messages.length - 1].id
    const changed = newestId !== lastIdRef.current
    const firstRender = lastIdRef.current === null
    lastIdRef.current = newestId

    if (firstRender || (changed && pinnedRef.current)) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  // The flash is a brief cue, not a marker — it clears itself.
  useEffect(() => {
    if (flashId == null) return undefined
    const timer = setTimeout(() => setFlashId(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flashId])

  // Reset the pin whenever we switch to a different thread.
  useEffect(() => {
    pinnedRef.current = true
    lastIdRef.current = null
    prependRef.current = null
  }, [conversation?.id])

  // Shown while a thread loads. Because Inbox only hands over messages that
  // belong to the selected conversation, this can never be masked by stale
  // content from the previous one.
  if (loading && !messages.length) {
    return (
      <div className="thread-scroll" aria-busy="true" aria-label="Loading messages">
        <div className="msg-list">
          {[
            { out: false, w: 42 },
            { out: false, w: 68 },
            { out: true, w: 55 },
            { out: false, w: 34 },
            { out: true, w: 62 },
            { out: true, w: 40 },
          ].map((row, i) => (
            <div className={`msg-row ${row.out ? 'out' : 'in'}`} key={i}>
              {!row.out ? <span className="msg-spacer" /> : null}
              <div className="bubble-skeleton" style={{ width: `${row.w}%` }} />
              {row.out ? <span className="msg-spacer" /> : null}
            </div>
          ))}
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
        {/* Sits inside .msg-list so it participates in the same flex-end
            packing — an absolutely positioned spinner would overlap the first
            bubble on a short thread. */}
        {hasMoreBefore ? (
          <div className="page-status" role="status">
            {loadingMore === 'before' ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Loading earlier messages…
              </>
            ) : (
              'Scroll up for earlier messages'
            )}
          </div>
        ) : null}

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

          // In a group the inbound party is the individual sender, not the chat.
          const senderLabel = message.sender_name || (message.sender_number ? `+${message.sender_number}` : null)
          const who = isOut ? message.sent_by || 'You' : (isGroup && senderLabel) || contactName

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
            <div
              key={message.id}
              data-message-id={message.id}
              className={message.id === flashId ? 'msg-flash' : undefined}
            >
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
                  }${hasMedia ? ' has-media' : ''}${mediaOnly ? ' is-media-only' : ''}${
                    isRunStart ? ' has-tail' : ''
                  }`}
                >
                  {/* Sender label: groups only, inbound only, and only on the
                      first message of a run — the same rule the avatars use.
                      Inside the bubble so it cannot disturb the row's flex
                      layout or the 65% bubble measure. */}
                  {isGroup && !isOut && isRunStart && senderLabel ? (
                    <span
                      className="msg-sender"
                      data-agent={avatarIndex(message.sender_number)}
                    >
                      {senderLabel}
                    </span>
                  ) : null}

                  {hasMedia ? (
                    <MediaAttachment
                      message={message}
                      onOpenImage={setLightbox}
                      /* Uncaptioned media carries the stamp itself — overlaid
                         on an image, inline on a chip — so it never costs a
                         whole extra row. */
                      stamp={mediaOnly ? meta : null}
                    />
                  ) : null}

                  {caption ? (
                    <div className="bubble-text">
                      {caption}
                      {meta}
                    </div>
                  ) : null}


                </div>

                {isOut ? avatar : null}
              </div>
            </div>
          )
        })}

        {/* Only ever visible after a jump into history. Once this clears, the
            window has reached the newest message and polling resumes. */}
        {hasMoreAfter ? (
          <div className="page-status" role="status">
            {loadingMore === 'after' ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Loading newer messages…
              </>
            ) : (
              'Scroll down for newer messages'
            )}
          </div>
        ) : null}
      </div>

      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
