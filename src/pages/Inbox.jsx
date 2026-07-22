import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, MessagesSquare, Plus, Users } from 'lucide-react'
import { api } from '../lib/api.js'
import { displayName, formatNumber, mediaLabel } from '../lib/format.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useInbox } from '../context/InboxContext.jsx'
import { useToast } from '../context/ToastContext.jsx'
import ConversationList from '../components/ConversationList.jsx'
import Thread from '../components/Thread.jsx'
import ReplyBox from '../components/ReplyBox.jsx'
import AssignControl from '../components/AssignControl.jsx'
import NewMessageModal from '../components/NewMessageModal.jsx'
import ContactAvatar from '../components/ContactAvatar.jsx'
import GroupMembers from '../components/GroupMembers.jsx'
import { useSwipeBack } from '../lib/useSwipeBack.js'
import { mergeMessages } from '../lib/thread.js'

const THREAD_POLL_MS = 4000

const EMPTY_THREAD = {
  conversationId: null,
  messages: [],
  hasMoreBefore: false,
  hasMoreAfter: false,
}

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
    mobileView,
    setMobileView,
    refresh,
  } = useInbox()

  // Messages are stored WITH the conversation they belong to. Clearing them in
  // an effect is not enough: effects run after paint, so a switch from A to B
  // would still render one frame of A's messages under B's header.
  const [thread, setThread] = useState(EMPTY_THREAD)
  const [threadLoading, setThreadLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(null)
  // The message a search result asked us to jump to. Null for a normal open,
  // which is what keeps the default path byte-for-byte the behaviour it was.
  const [anchor, setAnchor] = useState(null)
  const [users, setUsers] = useState([])
  const [composing, setComposing] = useState(false)
  const [showMembers, setShowMembers] = useState(false)

  const openIdRef = useRef(null)
  openIdRef.current = openId

  // Monotonic request counter: a slow poll must never overwrite the result of
  // a newer one, even within the same conversation.
  const seqRef = useRef(0)
  const threadPaneRef = useRef(null)

  // Read by the poll and by the paging callbacks without making either of them
  // depend on thread state — the polling effect must not re-subscribe every
  // time a page loads.
  const threadRef = useRef(thread)
  threadRef.current = thread
  const loadingMoreRef = useRef(null)
  loadingMoreRef.current = loadingMore

  /**
   * Render-time guard. If the stored messages belong to a different
   * conversation than the one selected, they simply do not exist as far as
   * this render is concerned — no stale frame is possible.
   */
  // The paging flags are guarded by the same test: a stale `hasMoreBefore`
  // would otherwise render "scroll up for earlier messages" over the loading
  // skeleton of a thread that has not arrived yet.
  const threadIsCurrent = String(thread.conversationId) === String(openId)
  const messages = threadIsCurrent ? thread.messages : []

  const open = useCallback(
    (conversationId, anchorMessageId = null) => {
      setOpenId(conversationId)
      setAnchor(anchorMessageId ?? null)
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

  // Load and then poll the open thread every ~4s.
  //
  // Re-runs when the anchor changes as well as the conversation, because
  // jumping to a different message is a different window of the same thread.
  useEffect(() => {
    if (!openId) {
      setThread(EMPTY_THREAD)
      setThreadLoading(false)
      setLoadingMore(null)
      return undefined
    }

    const controller = new AbortController()
    let cancelled = false
    setThreadLoading(true)
    setLoadingMore(null)

    /** Guards shared by every request in this effect, cheapest first. */
    const stale = (seq) =>
      cancelled ||
      // ...the user left this thread while the request was in flight,
      String(openIdRef.current) !== String(openId) ||
      // ...or a newer request has already answered and this one is obsolete.
      seq !== seqRef.current

    const initial = async () => {
      const seq = ++seqRef.current
      try {
        const data = await api.messages(openId, {
          anchorId: anchor ?? undefined,
          signal: controller.signal,
        })
        if (stale(seq)) return

        setThread({
          conversationId: openId,
          messages: data.messages || [],
          hasMoreBefore: Boolean(data.has_more_before),
          hasMoreAfter: Boolean(data.has_more_after),
        })
      } catch (err) {
        if (cancelled || err.name === 'AbortError' || err.status === 401) return
        toast.error('Could not load messages', err.message)
      } finally {
        if (!cancelled) setThreadLoading(false)
      }
    }

    const poll = async () => {
      // While the reader is somewhere in the middle of history there is no
      // live edge to poll towards, and appending would be wrong. The poll
      // resumes by itself the moment they scroll down far enough for
      // has_more_after to clear.
      if (threadRef.current.hasMoreAfter) return
      // A page request is already in flight; let it settle first.
      if (loadingMoreRef.current) return

      const seq = ++seqRef.current
      try {
        const data = await api.messages(openId, { signal: controller.signal })
        if (stale(seq)) return

        setThread((current) =>
          String(current.conversationId) !== String(openId)
            ? current
            : {
                ...current,
                messages: mergeMessages(current.messages, data.messages || []),
                // has_more_before describes the TAIL page, not the window the
                // reader has built by scrolling up, so it must not overwrite
                // what is already known about the top of that window.
                hasMoreAfter: false,
              }
        )
      } catch (err) {
        if (cancelled || err.name === 'AbortError' || err.status === 401) return
        toast.error('Could not load messages', err.message)
      }
    }

    initial()
    const interval = setInterval(poll, THREAD_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
      controller.abort()
    }
  }, [openId, anchor, toast])

  /** Load one page in either direction from the edge of the loaded window. */
  const loadPage = useCallback(
    async (direction) => {
      const current = threadRef.current
      if (loadingMoreRef.current || !current.messages.length) return
      if (direction === 'before' ? !current.hasMoreBefore : !current.hasMoreAfter) return

      const conversationId = current.conversationId
      const edge =
        direction === 'before'
          ? current.messages[0]
          : current.messages[current.messages.length - 1]

      // Set synchronously via the ref too, so two scroll events in the same
      // frame cannot both get through the guard above.
      loadingMoreRef.current = direction
      setLoadingMore(direction)

      try {
        const data = await api.messages(conversationId, {
          [direction === 'before' ? 'beforeId' : 'afterId']: edge.id,
        })
        const rows = data.messages || []

        setThread((state) => {
          if (String(state.conversationId) !== String(conversationId)) return state
          return {
            ...state,
            messages: mergeMessages(state.messages, rows),
            ...(direction === 'before'
              ? { hasMoreBefore: Boolean(data.has_more_before) }
              : { hasMoreAfter: Boolean(data.has_more_after) }),
          }
        })
      } catch (err) {
        if (err.name === 'AbortError' || err.status === 401) return
        toast.error('Could not load more messages', err.message)
      } finally {
        loadingMoreRef.current = null
        setLoadingMore(null)
      }
    },
    [toast]
  )

  const loadOlder = useCallback(() => loadPage('before'), [loadPage])
  const loadNewer = useCallback(() => loadPage('after'), [loadPage])

  const conversation = conversations.find((c) => String(c.id) === String(openId)) || null

  // If an agent loses access to the open conversation mid-poll, drop back.
  useEffect(() => {
    if (openId && !loading && !conversation) {
      setOpenId(null)
      setMobileView('list')
    }
  }, [openId, conversation, loading, setOpenId])

  // Edge-swipe right to go back. Only armed on a phone with a thread open —
  // the hook itself no-ops above 720px.
  useSwipeBack(threadPaneRef, mobileView === 'thread' && Boolean(conversation), () =>
    setMobileView('list')
  )

  const send = async (body, media = null) => {
    if (!conversation) return
    try {
      const data = await api.send(conversation.id, body, media)

      if (threadRef.current.hasMoreAfter) {
        // Sending while reading history would drop the new message below the
        // "scroll down for newer messages" marker, with a gap in between.
        // Clearing the anchor reloads the tail, which is where the reader now
        // wants to be anyway.
        setAnchor(null)
      } else {
        // Only append if that conversation is still the one on screen.
        setThread((current) =>
          String(current.conversationId) === String(conversation.id)
            ? { ...current, messages: [...current.messages, data.message] }
            : current
        )
      }
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
        {/* Desktop affordance; the mobile one is the FAB inside the list. */}
        <div className="list-actions desktop-only">
          <button
            type="button"
            className="icon-btn"
            aria-label="New message"
            title="New message"
            onClick={() => setComposing(true)}
          >
            <Plus size={18} />
          </button>
        </div>

        <ConversationList
          conversations={conversations}
          openId={openId}
          onOpen={open}
          loading={loading}
          onNewMessage={() => setComposing(true)}
          users={users}
        />
        {error ? (
          <div style={{ padding: '10px 12px' }}>
            <div className="alert alert-error">{error}</div>
          </div>
        ) : null}
      </aside>

      <section className="pane-thread" ref={threadPaneRef}>
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

              <ContactAvatar conversation={conversation} size={36} className="thread-avatar" />

              {conversation.is_group ? (
                // Tapping the name opens the member list.
                <button
                  type="button"
                  className="thread-id thread-id-button"
                  onClick={() => setShowMembers(true)}
                >
                  <div className="thread-name">{displayName(conversation)}</div>
                  <div className="thread-number">
                    <Users size={11} />
                    <span className="thread-sub-label">
                      {conversation.member_count
                        ? `${conversation.member_count} member${conversation.member_count === 1 ? '' : 's'}`
                        : 'Group'}
                    </span>
                  </div>
                </button>
              ) : (
                <div className="thread-id">
                  <div className="thread-name">{displayName(conversation)}</div>
                  <div className="thread-number">
                    {formatNumber(conversation.customer_number)}
                  </div>
                </div>
              )}

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
              hasMoreBefore={threadIsCurrent && thread.hasMoreBefore}
              hasMoreAfter={threadIsCurrent && thread.hasMoreAfter}
              loadingMore={loadingMore}
              onLoadOlder={loadOlder}
              onLoadNewer={loadNewer}
              anchorMessageId={anchor}
            />

            <ReplyBox
              conversationId={conversation.id}
              onSend={send}
              disabled={!isAdmin && !conversation.assigned_user_id}
              isGroup={conversation.is_group}
            />
          </>
        )}
      </section>

      {showMembers && conversation?.is_group ? (
        <GroupMembers conversation={conversation} onClose={() => setShowMembers(false)} />
      ) : null}

      {composing ? (
        <NewMessageModal
          onClose={() => setComposing(false)}
          onCreated={(conversationId) => {
            // refresh() picks the new row up on the next poll; opening it now
            // means the thread is already loading when the sheet closes.
            refresh()
            open(conversationId)
          }}
        />
      ) : null}
    </div>
  )
}
