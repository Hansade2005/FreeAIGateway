import { Link } from 'react-router-dom'

// The gateway glyph: two protocol streams (OpenAI + Anthropic) entering from the
// left, converging through a single signal node, exiting unified on the right —
// the product in one mark. Drawn with currentColor so it inherits context; the
// node is painted with the signal accent.
export function Logo({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      {/* two inbound streams */}
      <path d="M3 10h7c2.2 0 4 1.8 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
      <path d="M3 22h7c2.2 0 4-1.8 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
      {/* unified outbound stream */}
      <path d="M18 16h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* signal node (the gateway) */}
      <circle cx="16" cy="16" r="4.4" fill="var(--signal)" />
      <circle cx="16" cy="16" r="7.5" stroke="var(--signal)" strokeWidth="1.5" opacity="0.4" />
    </svg>
  )
}

export function Wordmark({ withGlyph = true, className = '' }: { withGlyph?: boolean; className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {withGlyph && <Logo className="size-6 text-foreground" />}
      <span className="font-display text-[15px] font-semibold tracking-tight leading-none">
        Free<span className="sheen">AI</span>Gateway
      </span>
    </div>
  )
}

export function BrandLink() {
  return (
    <Link to="/" className="flex items-center transition-opacity hover:opacity-80" aria-label="FreeAIGateway home">
      <Wordmark />
    </Link>
  )
}
