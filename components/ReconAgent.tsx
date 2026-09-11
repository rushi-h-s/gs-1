'use client'

import { useState, useRef, useEffect } from 'react'

interface Message { role: 'user' | 'assistant'; content: string }

export default function ReconAgent({ clientId, period }: { clientId: string; period: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    const updated: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(updated)
    setInput('')
    setLoading(true)
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updated, client_id: clientId, period }),
      })
      const data = await res.json()
      setMessages([...updated, { role: 'assistant', content: data.reply ?? `Error: ${data.error ?? 'unknown'}` }])
    } catch (e) {
      setMessages([...updated, { role: 'assistant', content: `Error: ${String(e)}` }])
    }
    setLoading(false)
  }

  return (
    <div className="bg-white border overflow-hidden flex flex-col" style={{ borderColor: 'var(--border)', height: 480 }}>
      <div className="px-5 py-3.5 font-semibold text-sm font-display" style={{ background: 'var(--bg)', color: 'var(--text-2)' }}>
        Recon assistant — grounded in this run
      </div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {messages.length === 0 && (
          <p className="text-sm text-center mt-8" style={{ color: 'var(--text-3)' }}>
            Ask about a mismatch, request a vendor email, or get a period summary.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className="text-sm px-3 py-2 whitespace-pre-wrap"
            style={m.role === 'user'
              ? { background: '#ffe0d9', color: '#7c1405', alignSelf: 'flex-end', maxWidth: '80%' }
              : { background: 'var(--bg)', color: 'var(--text-1)', alignSelf: 'flex-start', maxWidth: '80%' }}
          >
            {m.content}
          </div>
        ))}
        {loading && <div className="text-xs self-start px-3 py-2" style={{ color: 'var(--text-3)' }}>Thinking…</div>}
        <div ref={bottomRef} />
      </div>
      <div className="border-t p-3 flex gap-2" style={{ borderColor: 'var(--border)' }}>
        <input
          className="input flex-1"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) send() }}
          placeholder="e.g. Why is INV-042 mismatched?"
        />
        <button onClick={send} disabled={loading || !input.trim()} className="btn btn-primary">
          Send
        </button>
      </div>
    </div>
  )
}
