import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Chat markdown renderer. No typography plugin in this project, so each element
// is styled explicitly to match the builder's design tokens. Inline vs. block
// code is distinguished by a language class or a newline in the content.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="break-words text-sm leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: (p: any) => <p className="my-1.5" {...p} />,
          a: (p: any) => <a className="font-medium text-signal underline underline-offset-2 hover:opacity-80" target="_blank" rel="noreferrer" {...p} />,
          ul: (p: any) => <ul className="my-1.5 list-disc space-y-0.5 pl-5" {...p} />,
          ol: (p: any) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5" {...p} />,
          li: (p: any) => <li className="marker:text-muted-foreground" {...p} />,
          h1: (p: any) => <h1 className="mb-1.5 mt-3 text-base font-semibold" {...p} />,
          h2: (p: any) => <h2 className="mb-1.5 mt-3 text-sm font-semibold" {...p} />,
          h3: (p: any) => <h3 className="mb-1 mt-2.5 text-sm font-semibold" {...p} />,
          strong: (p: any) => <strong className="font-semibold" {...p} />,
          em: (p: any) => <em className="italic" {...p} />,
          hr: () => <hr className="my-2.5 border-border" />,
          blockquote: (p: any) => <blockquote className="my-1.5 border-l-2 border-signal/40 pl-3 text-muted-foreground" {...p} />,
          pre: (p: any) => <pre className="my-2 overflow-auto rounded-lg border bg-surface-2 p-2.5 font-mono text-[12px] leading-relaxed" {...p} />,
          code: ({ className, children, ...rest }: any) => {
            const text = String(children ?? '')
            const block = /language-/.test(className || '') || text.includes('\n')
            return block
              ? <code className="font-mono text-[12px]" {...rest}>{children}</code>
              : <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]" {...rest}>{children}</code>
          },
          table: (p: any) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-xs" {...p} /></div>,
          th: (p: any) => <th className="border px-2 py-1 text-left font-semibold" {...p} />,
          td: (p: any) => <td className="border px-2 py-1" {...p} />,
          img: (p: any) => <img className="my-1.5 max-w-full rounded-md border" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
