import { useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'

// Pull-down-to-refresh for the conversation list, TOUCH ONLY. Desktop keeps the
// existing 5s poll and never sees this — mouse wheel over-scroll is not a pull.
//
// This component BECOMES the scroll container (it takes the caller's className,
// e.g. "conv-list", and renders the rows as its children), so it can read
// scrollTop directly and only arm the gesture when the list is at the very top.
// The touch handlers are native, non-passive (matching useSwipeBack) so we can
// preventDefault the rubber-band while we own the drag.

const THRESHOLD = 60 // px pulled before a release triggers a refresh
const MAX_PULL = 90 // clamp so the indicator can't be dragged arbitrarily far
const RESISTANCE = 0.5 // the indicator moves at half the finger's distance

const isTouch =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0)

export default function PullToRefresh({ onRefresh, className = '', children }) {
  const scrollRef = useRef(null)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Native listeners close over their first render, so mirror the live values
  // (and the current onRefresh) into refs they can read.
  const pullRef = useRef(0)
  const refreshingRef = useRef(false)
  const startY = useRef(null)
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  }, [onRefresh])

  useEffect(() => {
    if (!isTouch) return undefined
    const el = scrollRef.current
    if (!el) return undefined

    const setDist = (d) => {
      pullRef.current = d
      setPull(d)
    }

    const onStart = (e) => {
      if (refreshingRef.current) return
      // Only arm when already scrolled to the top; otherwise this is a scroll.
      startY.current = el.scrollTop <= 0 ? e.touches[0].clientY : null
    }

    const onMove = (e) => {
      if (startY.current == null || refreshingRef.current) return
      if (el.scrollTop > 0) {
        // The user scrolled up into content — abandon the pull.
        startY.current = null
        if (pullRef.current) setDist(0)
        setDragging(false)
        return
      }
      const dy = e.touches[0].clientY - startY.current
      if (dy <= 0) {
        if (pullRef.current) setDist(0)
        return
      }
      // We own the gesture now: stop the native overscroll/bounce so the
      // indicator tracks the finger instead of the page rubber-banding.
      e.preventDefault()
      setDragging(true)
      setDist(Math.min(MAX_PULL, dy * RESISTANCE))
    }

    const onEnd = async () => {
      if (startY.current == null) return
      startY.current = null
      setDragging(false)
      if (pullRef.current >= THRESHOLD && !refreshingRef.current) {
        refreshingRef.current = true
        setRefreshing(true)
        setDist(THRESHOLD) // hold the indicator open under the spinner
        try {
          await onRefreshRef.current?.()
        } catch {
          /* refresh() swallows its own errors; nothing to surface here */
        }
        refreshingRef.current = false
        setRefreshing(false)
        setDist(0)
      } else {
        setDist(0)
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  const armed = pull >= THRESHOLD

  return (
    <div ref={scrollRef} className={className}>
      {isTouch ? (
        <div
          className="ptr-indicator"
          // No transition while dragging (track the finger 1:1); animate the
          // settle back to 0 on release.
          style={{ height: `${pull}px`, transitionDuration: dragging ? '0ms' : '200ms' }}
          aria-hidden={pull === 0 && !refreshing}
        >
          {refreshing ? (
            <span className="spinner" role="status" aria-label="Refreshing" />
          ) : pull > 0 ? (
            <span className={`ptr-hint${armed ? ' is-armed' : ''}`}>
              <ArrowDown size={15} className="ptr-arrow" aria-hidden="true" />
              {armed ? 'Release to refresh' : 'Pull to refresh'}
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  )
}
