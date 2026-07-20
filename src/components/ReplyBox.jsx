import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'

export default function ReplyBox({ onSend, disabled }) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef(null)

  // Grow with the content, up to the CSS max-height.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
  }, [value])

  const submit = async () => {
    const text = value.trim()
    if (!text || sending || disabled) return

    setSending(true)
    try {
      await onSend(text)
      setValue('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="reply">
      <div className="reply-inner">
        <textarea
          ref={textareaRef}
          className="reply-input"
          rows={1}
          placeholder="Write a reply…"
          aria-label="Reply message"
          value={value}
          disabled={disabled || sending}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter makes a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className="reply-send"
          aria-label="Send message"
          disabled={disabled || sending || !value.trim()}
          onClick={submit}
        >
          {sending ? <span className="spinner" /> : <Send size={16} />}
        </button>
      </div>
      <div className="reply-hint desktop-only">Enter to send · Shift + Enter for a new line</div>
    </div>
  )
}
