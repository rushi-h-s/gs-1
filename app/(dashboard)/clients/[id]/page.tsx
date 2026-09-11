'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useInvoiceBatchUpload } from '@/hooks/useInvoiceBatchUpload'

interface Client { id: string; name: string; gstin: string }

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [client, setClient] = useState<Client | null>(null)
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7))
  const [gstr2bFile, setGstr2bFile] = useState<File | null>(null)
  const [invoiceFiles, setInvoiceFiles] = useState<FileList | null>(null)
  const [bankFiles, setBankFiles] = useState<FileList | null>(null)
  const [bankUploading, setBankUploading] = useState(false)
  const [bankSummary, setBankSummary] = useState('')
  const [status, setStatus] = useState('')
  const [statusType, setStatusType] = useState<'info' | 'success' | 'error'>('info')
  const [reconciling, setReconciling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [gstr2bReady, setGstr2bReady] = useState<boolean | null>(null)  // null = unchecked
  const [unconfirmedCount, setUnconfirmedCount] = useState(0)

  const { files: batchFiles, counts, running: uploading, start: startUpload } = useInvoiceBatchUpload(id, period)

  useEffect(() => {
    fetch('/api/clients').then(r => r.json()).then((clients: Client[]) => {
      setClient(clients.find(c => c.id === id) ?? null)
    })
    fetch(`/api/clients/${id}`).then(r => r.json()).then((d: { count?: number }) => {
      if (typeof d.count === 'number') setUnconfirmedCount(d.count)
    }).catch(() => {})
  }, [id])

  function setMsg(msg: string, type: 'info' | 'success' | 'error' = 'info') {
    setStatus(msg); setStatusType(type)
  }

  async function uploadGstr2b() {
    if (!gstr2bFile) return
    setMsg('Uploading GSTR-2B…')
    const fd = new FormData()
    fd.append('file', gstr2bFile)
    fd.append('client_id', id)
    fd.append('period', period)
    const res = await fetch('/api/gstr2b/upload', { method: 'POST', body: fd })
    const data = await res.json()
    res.ok
      ? setMsg(`GSTR-2B uploaded — ${data.inserted} entries`, 'success')
      : setMsg(`Error: ${data.error}`, 'error')
  }

  async function uploadInvoices() {
    if (!invoiceFiles?.length) return
    setGstr2bReady(null)
    await startUpload(Array.from(invoiceFiles))

    // Refresh unconfirmed count — low-confidence entries may have been added
    fetch(`/api/clients/${id}`).then(r => r.json()).then((d: { count?: number }) => {
      if (typeof d.count === 'number') setUnconfirmedCount(d.count)
    }).catch(() => {})

    // Check if GSTR-2B is already uploaded for this period
    const check = await fetch(`/api/gstr2b/check?client_id=${encodeURIComponent(id)}&period=${period}`)
    if (check.ok) {
      const { exists } = await check.json()
      setGstr2bReady(exists)
    }
  }

  async function uploadBankStatements() {
    if (!bankFiles?.length) return
    setBankUploading(true)
    setBankSummary('')
    const fd = new FormData()
    Array.from(bankFiles).forEach(f => fd.append('files', f))
    fd.append('client_id', id)
    fd.append('period', period)
    const res = await fetch('/api/bank-statements/upload', { method: 'POST', body: fd })
    const data = await res.json() as { filename: string; skipped?: boolean; error?: string; txn_count?: number; quarantine?: boolean }[]
    setBankUploading(false)
    if (!res.ok) { setBankSummary('Upload failed'); return }
    const ok = data.filter(r => !r.error && !r.skipped).length
    const dup = data.filter(r => r.skipped).length
    const err = data.filter(r => r.error).length
    const flagged = data.filter(r => r.quarantine).length
    setBankSummary([
      ok && `${ok} processed`,
      flagged && `${flagged} flagged for balance mismatch`,
      dup && `${dup} duplicate`,
      err && `${err} failed`,
    ].filter(Boolean).join(' · '))
  }

  async function runReconciliation() {
    setReconciling(true)
    setMsg('Running reconciliation…')
    const res = await fetch('/api/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: id, period }),
    })
    const data = await res.json()
    setReconciling(false)
    if (res.ok) {
      const skipped = data.unconfirmed_skipped ?? 0
      setMsg(`Done — ${data.total} entries processed`, 'success')
      const dest = `/clients/${id}/reconciliation?period=${period}${skipped > 0 ? `&unconfirmed=${skipped}` : ''}`
      router.push(dest)
    } else {
      setMsg(`Error: ${data.error}`, 'error')
    }
  }

  async function deleteClient() {
    if (!confirm(`Delete "${client?.name}"? This cannot be undone.`)) return
    setDeleting(true)
    await fetch(`/api/clients/${id}`, { method: 'DELETE' })
    router.push('/')
    router.refresh()
  }

  if (!client) return (
    <div className="flex items-center gap-3 py-8" style={{ color: 'var(--text-3)' }}>
      <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--primary)' }} />
      <span className="text-sm">Loading…</span>
    </div>
  )

  const statusColors = {
    info: { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8' },
    success: { bg: 'var(--emerald-light)', border: '#6EE7B7', text: 'var(--emerald)' },
    error: { bg: '#FEF2F2', border: '#FECACA', text: '#DC2626' },
  }

  return (
    <div className="max-w-2xl">
      {/* Back + header */}
      <div className="mb-7">
        <Link href="/" className="inline-flex items-center gap-1.5 text-xs font-medium mb-3 transition-colors hover:opacity-70" style={{ color: 'var(--text-3)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
          All Clients
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold font-display" style={{ color: 'var(--text-1)' }}>{client.name}</h1>
            <p className="font-mono text-xs mt-1 tracking-widest" style={{ color: 'var(--text-3)' }}>{client.gstin}</p>
          </div>
          {unconfirmedCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold font-display transition-opacity hover:opacity-80"
              style={{ background: '#FEE2E2', color: '#DC2626', border: '1px solid #DC262622' }}
            >
              <Link href={`/clients/${id}/confirm`} className="underline underline-offset-2 hover:opacity-100">
                <span className="w-2 h-2 rounded-full" style={{ background: '#DC2626' }} />
                {unconfirmedCount} invoices need confirmation
              </Link>
            </div>
          )}
          <button
            onClick={deleteClient}
            disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold font-display transition-opacity hover:opacity-80 disabled:opacity-40"
            style={{ background: '#FEE2E2', color: '#DC2626' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>

      {/* Period selector */}
      <div className="bg-white rounded-xl border px-5 py-4 flex items-center gap-4 mb-4" style={{ borderColor: 'var(--border)' }}>
        <span className="text-sm font-semibold font-display" style={{ color: 'var(--text-2)' }}>Period</span>
        <input
          type="month"
          value={period}
          onChange={e => setPeriod(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 transition"
          style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
        />
        <p className="text-xs ml-auto" style={{ color: 'var(--text-3)' }}>All uploads apply to this period</p>
      </div>

      {/* Upload cards */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        {/* GSTR-2B */}
        <div className="bg-white rounded-xl border p-5" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: '#EFF6FF' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <h2 className="font-semibold text-sm font-display" style={{ color: 'var(--text-1)' }}>GSTR-2B</h2>
          </div>
          <p className="text-xs mb-4" style={{ color: 'var(--text-3)' }}>JSON or Excel from the GST portal</p>

          <label className="block w-full border-2 border-dashed rounded-lg px-3 py-3 text-center cursor-pointer text-xs transition-colors mb-3 hover:border-blue-300"
            style={{ borderColor: 'var(--border)', color: 'var(--text-3)' }}>
            <input type="file" accept=".json,.xlsx,.xls" onChange={e => setGstr2bFile(e.target.files?.[0] ?? null)} className="hidden" />
            {gstr2bFile ? (
              <span style={{ color: 'var(--text-1)' }} className="font-medium">{gstr2bFile.name}</span>
            ) : (
              <>Choose file</>
            )}
          </label>
          <button
            onClick={uploadGstr2b}
            disabled={!gstr2bFile}
            className="w-full py-2 rounded-lg text-sm font-semibold font-display transition-colors"
            style={{ background: gstr2bFile ? '#1D4ED8' : 'var(--bg)', color: gstr2bFile ? 'white' : 'var(--text-3)', cursor: gstr2bFile ? 'pointer' : 'default' }}
          >
            Upload GSTR-2B
          </button>
        </div>

        {/* Invoices */}
        <div className="bg-white rounded-xl border p-5" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: 'var(--emerald-light)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--emerald)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <path d="M3 9h18M9 21V9"/>
              </svg>
            </div>
            <h2 className="font-semibold text-sm font-display" style={{ color: 'var(--text-1)' }}>Purchase Invoices</h2>
          </div>
          <p className="text-xs mb-4" style={{ color: 'var(--text-3)' }}>PDF files — text extracted automatically</p>

          <label className="block w-full border-2 border-dashed rounded-lg px-3 py-3 text-center cursor-pointer text-xs transition-colors mb-3 hover:border-green-300"
            style={{ borderColor: 'var(--border)', color: 'var(--text-3)' }}>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.tiff" multiple onChange={e => setInvoiceFiles(e.target.files)} className="hidden" />
            {invoiceFiles?.length ? (
              <span style={{ color: 'var(--text-1)' }} className="font-medium">{invoiceFiles.length} file{invoiceFiles.length !== 1 ? 's' : ''} selected</span>
            ) : (
              <>Choose files</>
            )}
          </label>
          <button
            onClick={uploadInvoices}
            disabled={!invoiceFiles?.length || uploading}
            className="w-full py-2 rounded-lg text-sm font-semibold font-display transition-colors"
            style={{ background: invoiceFiles?.length && !uploading ? 'var(--emerald)' : 'var(--bg)', color: invoiceFiles?.length && !uploading ? 'white' : 'var(--text-3)', cursor: invoiceFiles?.length && !uploading ? 'pointer' : 'default' }}
          >
            {uploading
              ? `${(counts.done ?? 0) + (counts.duplicate ?? 0) + (counts.error ?? 0)} / ${batchFiles.length} files…`
              : 'Extract Invoices'}
          </button>
          {uploading && (
            <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${(((counts.done ?? 0) + (counts.duplicate ?? 0) + (counts.error ?? 0)) / batchFiles.length) * 100}%`, background: 'var(--emerald)' }} />
            </div>
          )}
          {!uploading && batchFiles.length > 0 && (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-3)' }}>
              {[
                counts.done && `${counts.done} extracted`,
                counts.low_confidence && `${counts.low_confidence} needs review`,
                counts.duplicate && `${counts.duplicate} duplicate`,
                counts.error && `${counts.error} failed`,
              ].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>

        {/* Bank Statements */}
        <div className="bg-white rounded-xl border p-5" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: '#FEF3C7' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="12" rx="2"/><path d="M2 10h20"/>
              </svg>
            </div>
            <h2 className="font-semibold text-sm font-display" style={{ color: 'var(--text-1)' }}>Bank Statements</h2>
          </div>
          <p className="text-xs mb-4" style={{ color: 'var(--text-3)' }}>PDF or CSV — transactions extracted automatically</p>

          <label className="block w-full border-2 border-dashed rounded-lg px-3 py-3 text-center cursor-pointer text-xs transition-colors mb-3 hover:border-amber-300"
            style={{ borderColor: 'var(--border)', color: 'var(--text-3)' }}>
            <input type="file" accept=".pdf,.csv" multiple onChange={e => setBankFiles(e.target.files)} className="hidden" />
            {bankFiles?.length ? (
              <span style={{ color: 'var(--text-1)' }} className="font-medium">{bankFiles.length} file{bankFiles.length !== 1 ? 's' : ''} selected</span>
            ) : (
              <>Choose files</>
            )}
          </label>
          <button
            onClick={uploadBankStatements}
            disabled={!bankFiles?.length || bankUploading}
            className="w-full py-2 rounded-lg text-sm font-semibold font-display transition-colors"
            style={{ background: bankFiles?.length && !bankUploading ? '#D97706' : 'var(--bg)', color: bankFiles?.length && !bankUploading ? 'white' : 'var(--text-3)', cursor: bankFiles?.length && !bankUploading ? 'pointer' : 'default' }}
          >
            {bankUploading ? 'Extracting…' : 'Extract Statements'}
          </button>
          {bankSummary && (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-3)' }}>{bankSummary}</p>
          )}
        </div>
      </div>

      {/* Status message */}
      {status && (
        <div className="rounded-xl border px-4 py-3 mb-4 text-sm" style={{
          background: statusColors[statusType].bg,
          borderColor: statusColors[statusType].border,
          color: statusColors[statusType].text,
        }}>
          {status}
        </div>
      )}

      {/* Per-file result breakdown after upload */}
      {!uploading && batchFiles.some(f => f.status === 'error' || f.status === 'low_confidence') && (
        <div className="rounded-xl border px-4 py-3 mb-4 space-y-3" style={{ background: '#FEF2F2', borderColor: '#FECACA' }}>
          {batchFiles.filter(f => f.status === 'error').length > 0 && (
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: '#DC2626' }}>Failed extraction — re-select to retry</p>
              <ul className="space-y-0.5">
                {batchFiles.filter(f => f.status === 'error').map(f => (
                  <li key={f.file.name} className="text-xs font-mono" style={{ color: '#991B1B' }}>
                    {f.file.name}
                    {f.error && <span className="ml-2 font-sans" style={{ color: '#DC2626' }}>— {f.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {batchFiles.filter(f => f.status === 'low_confidence').length > 0 && (
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: '#D97706' }}>Low confidence — confirm extracted fields</p>
              <ul className="space-y-0.5">
                {batchFiles.filter(f => f.status === 'low_confidence').map(f => (
                  <li key={f.file.name} className="text-xs font-mono" style={{ color: '#92400E' }}>{f.file.name}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* GSTR-2B readiness banner after upload */}
      {gstr2bReady === true && !uploading && (
        <div className="rounded-xl border px-4 py-3 mb-4 flex items-center justify-between" style={{ background: '#D1FAE5', borderColor: '#6EE7B7' }}>
          <span className="text-sm" style={{ color: '#065F46' }}>GSTR-2B is available for {period} — ready to reconcile</span>
          <button
            onClick={runReconciliation}
            disabled={reconciling}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold font-display disabled:opacity-60"
            style={{ background: 'var(--emerald)', color: 'white' }}
          >
            {reconciling ? 'Running…' : 'Reconcile Now'}
          </button>
        </div>
      )}
      {gstr2bReady === false && !uploading && (
        <div className="rounded-xl border px-4 py-3 mb-4 text-sm" style={{ background: '#FFF7ED', borderColor: '#FED7AA', color: '#92400E' }}>
          No GSTR-2B found for {period} — upload it above, then run reconciliation.
        </div>
      )}

      {/* Reconcile row */}
      <div className="bg-white rounded-xl border px-5 py-4 flex items-center gap-4" style={{ borderColor: 'var(--border)' }}>
        <button
          onClick={runReconciliation}
          disabled={reconciling}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white font-display transition-opacity disabled:opacity-60"
          style={{ background: 'var(--navy)' }}
        >
          {reconciling ? (
            <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          )}
          {reconciling ? 'Running…' : 'Run Reconciliation'}
        </button>

        <Link
          href={`/clients/${id}/data?period=${period}`}
          className="text-sm font-medium flex items-center gap-1.5 transition-colors hover:opacity-70 font-display"
          style={{ color: 'var(--text-2)' }}
        >
          Check Extracted Data
        </Link>

        <Link
          href={`/clients/${id}/reconciliation?period=${period}`}
          className="text-sm font-medium flex items-center gap-1.5 transition-colors hover:opacity-70 font-display"
          style={{ color: 'var(--primary)' }}
        >
          View Results
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </Link>
      </div>
    </div>
  )
}
