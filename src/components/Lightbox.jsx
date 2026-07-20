import { useEffect } from 'react'
import { X } from 'lucide-react'

export default function Lightbox({ image, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Stop the thread scrolling behind the overlay.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  if (!image) return null

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={image.name || 'Image'}
      onMouseDown={(e) => {
        // Click outside the image closes.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <button type="button" className="lightbox-close" aria-label="Close image" onClick={onClose}>
        <X size={20} />
      </button>
      <img className="lightbox-img" src={image.url} alt={image.name || ''} />
    </div>
  )
}
