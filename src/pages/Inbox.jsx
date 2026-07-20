import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, MessagesSquare } from 'lucide-react'
import { api } from '../lib/api.js'
import { displayName, formatNumber, mediaLabel } from '../lib/format.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useInbox } from '../context/InboxContext.jsx'
import { useToast } from '../context/ToastContext.jsx'
import ConversationList from '../components/ConversationList.jsx'
import Thread from '../components/Thread.jsx'
import ReplyBox from '../components/ReplyBox.jsx'
import AssignControl from '../components/AssignControl.jsx'

const THREAD_POLL_MS = 4000

export default function Inbox() {
  const { isAdmin } = useAuth()
  const toast = useToast()
  const {
    conversations,
    loading,
    error,
    openId,
    setOpenId,
    clearUnread,
    applyOutbound,
    patchConversation,
    registerOpenHandler,
  } = useInbox()

  // Messages are stored WITH the conversation they belong to. Clearing them in
  // an effect is not enough: effects run after paint, so a switch from A to B
  // would still render one frame of A's messages under B's header.
  const [thread, setThread] = useState({ conversationId: null, messages: [] })
  const [threadLoading, setThreadLoading] = useState(false)
  const [users, setUsers] = useState([])
  // On phones only one pane is visible at a time.
  const [mobileView, setMobileView] = useState('list')

  const openIdRef = useRef(null)
  openIdRef.current = openId

  // Monotonic request counter: a slow poll must never overwrite the result of
  // a newer one, even within the same conversation.
  const seqRef = useRef(0)

  /**
   * Render-time guard. If the stored messages belong to a different
   * conversation than the one selected, they simply do not exist as far as
   * this render is concerned — no stale frame is possible.
   */
  const messages = String(thread.conversationId) === String(openId) ? thread.messages : []

  const open = useCallback(
    (conversationId) => {
      setOpenId(conversationId)
      // Optimistic — the GET /messages side effect clears it server-side.
      clearUnread(conversationId)
      setMobileView('thread')
    },
    [setOpenId, clearUnread]
  )

  // Lets a toast click jump straight into the conversation.
  useEffect(() => {
    registerOpenHandler(open)
  }, [registerOpenHandler, open])

  // The assign dropdown needs the roster; agents get it for the read-only label.
  useEffect(() => {
    const controller = new AbortController()
    api
      .users(controller.signal)
      .then((data) => setUsers(data.users || []))
      .catch(() => {
        /* assign control degrades to an empty list */
      })
    return () => controller.abort()
  }, [])

  // Poll the open thread every ~4s.
  useEffect(() => {
    if (!openId) {
      setThread({ conversationId: null, messages: [] })
      setThreadLoading(false)
      return undefined
    }

    const controller = new AbortController()
    let cancelled = false
    setThreadLoading(true)

    const load = async () => {
      const seq = ++seqRef.current
      try {
        const data = await api.messages(openId, controller.signal)
        // Three independent guards, cheapest first:
        if (cancelled) return
        // ...the user left this thread while the request was in flight,
        if (String(openIdRef.current) !== String(openId)) return
        // ...or a newer poll has already answered and this one is stale.
        if (seq !== seqRef.current) return

        setThread({ conversationId: openId, messages: data.messages || [] })
      } catch (err) {
        if (cancelled || err.name === 'AbortError' || err.status === 401) return
        toast.error('Could not load messages', err.message)
      } finally {
        if (!cancelled) setThreadLoading(false)
      }
    }

    load()
    const interval = setInterval(load, THREAD_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
      controller.abort()
    }
  }, [openId, toast])

  const conversation = conversations.find((c) => String(c.id) === String(openId)) || null

  // If an agent loses access to the open conversation mid-poll, drop back.
  useEffect(() => {
    if (openId && !loading && !conversation) {
      setOpenId(null)
      setMobileView('list')
    }
  }, [openId, conversation, loading, setOpenId])

  const send = async (body, media = null) => {
    if (!conversation) return
    try {
      const data = await api.send(conversation.id, body, media)
      // Only append if that conversation is still the one on screen.
      setThread((current) =>
        String(current.conversationId) === String(conversation.id)
          ? { ...current, messages: [...current.messages, data.message] }
          : current
      )
      applyOutbound(conversation.id, body || (media ? mediaLabel(media.media_type) : ''))

      if (data.message.status === 'send_failed') {
        toast.error('Message not delivered', 'Whapi did not accept it.')
      }
    } catch (err) {
      // Rethrown so the composer can surface it inline as well.
      toast.error('Could not send', err.message)
      throw err
    }
  }

  return (
    <div className="inbox" data-view={mobileView}>
      <aside className="pane-list">
        <ConversationList
          conversations={conversations}
          openId={openId}
          onOpen={open}
          loading={loading}
        />
        {error ? (
          <div style={{ padding: '10px 12px' }}>
            <div className="alert alert-error">{error}</div>
          </div>
        ) : null}
      </aside>

      <section className="pane-thread">
        {!conversation ? (
          <div className="empty">
            <MessagesSquare size={30} />
            <div className="empty-title">Select a conversation</div>
            <div className="empty-sub">
              Pick a conversation on the left to read the thread and reply.
            </div>
          </div>
        ) : (
          <>
            <header className="thread-head">
              <button
                type="button"
                className="icon-btn back-btn"
                aria-label="Back to conversations"
                onClick={() => setMobileView('list')}
              >
                <ArrowLeft size={18} />
              </button>

              <div className="thread-id">
                <div className="thread-name">{displayName(conversation)}</div>
                <div className="thread-number">
                  {formatNumber(conversation.customer_number)}
                </div>
              </div>

              <AssignControl
                conversation={conversation}
                users={users}
                onAssigned={(updated) =>
                  patchConversation(updated.id, {
                    assigned_user_id: updated.assigned_user_id,
                    assigned_to: updated.assigned_to,
                  })
                }
              />
            </header>

            <Thread
              messages={messages}
              loading={threadLoading}
              conversation={conversation}
            />

            <ReplyBox
              conversationId={conversation.id}
              onSend={send}
              disabled={!isAdmin && !conversation.assigned_user_id}
            />
          </>
        )}
      </section>
    </div>
  )
}
