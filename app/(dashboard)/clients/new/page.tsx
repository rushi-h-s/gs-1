'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function NewClientPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [gstin, setGstin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, gstin: gstin.trim().toUpperCase() }),
    })
    if (res.ok) {
      router.push('/')
      router.refresh()
    } else {
      const data = await res.json()
      setError(data.error || 'Failed to create client')
      setLoading(false)
    }
  }

  return (
    <div className="max-w-md">
      <div className="mb-7">
        <Link href="/" className="inline-flex items-center gap-1.5 text-xs font-medium mb-3 transition-colors hover:opacity-70" style={{ color: 'var(--text-3)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
          All Clients
        </Link>
        <h1 className="text-2xl font-bold font-display" style={{ color: 'var(--text-1)' }}>Add Client</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-3)' }}>Register a business to start reconciling their GST data.</p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-2xl border p-6 space-y-5" style={{ borderColor: 'var(--border)' }}>
        <div>
          <label className="block text-sm font-semibold font-display mb-1.5" style={{ color: 'var(--text-2)' }}>
            Business Name
          </label>
          <input
            className="w-full border rounded-lg px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 transition"
            style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            value={name}
            onChange={e => setName(e.target.value)}
            required
            placeholder="Acme Pvt Ltd"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold font-display mb-1.5" style={{ color: 'var(--text-2)' }}>
            GSTIN
          </label>
          <input
            className="w-full border rounded-lg px-3.5 py-2.5 text-sm font-mono tracking-wider focus:outline-none focus:ring-2 transition"
            style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            value={gstin}
            onChange={e => setGstin(e.target.value.toUpperCase())}
            required
            placeholder="27AABCU9603R1ZX"
            maxLength={15}
          />
          <p className="text-xs mt-1.5" style={{ color: 'var(--text-3)' }}>15-character alphanumeric GST Identification Number</p>
        </div>

        {error && (
          <div className="text-sm px-3.5 py-2.5 rounded-lg border" style={{ background: '#FEF2F2', borderColor: '#FECACA', color: '#DC2626' }}>
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white font-display transition-opacity disabled:opacity-60"
            style={{ background: 'var(--navy)' }}
          >
            {loading ? 'Creating…' : 'Add Client'}
          </button>
          <Link
            href="/"
            className="px-5 py-2.5 rounded-lg text-sm font-semibold font-display border transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-2)' }}
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
