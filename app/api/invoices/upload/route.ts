import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'
import { normalizeGstin, normalizeInvNo, validateGstin } from '@/lib/normalize'
import crypto from 'crypto'

const MONTH_MAP: Record<string, string> = {
  jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
}

function toIsoDate(s: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const named = s.match(/(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{2,4})/)
  if (named) {
    const [, d, mon, y] = named
    const m = MONTH_MAP[mon.toLowerCase().slice(0, 3)]
    if (m) return `${y.length === 2 ? '20' + y : y}-${m}-${d.padStart(2, '0')}`
  }
  const dmy = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
  if (dmy) {
    const [, d, m, y] = dmy
    // Indian GST invoices are dd/mm/yyyy — but if the first group can't be a day
    // or the second can't be a month, it's some other layout (e.g. mm/dd/yyyy).
    // Don't guess; let the caller fall back to a safe default.
    if (Number(d) > 31 || Number(m) > 12) return null
    return `${y.length === 2 ? '20' + y : y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

interface ExtractionResult {
  gstin?: string
  invoice_number?: string
  invoice_date?: string
  taxable_value?: number
  cgst?: number
  sgst?: number
  igst?: number
}

function parseAmount(s: string): number { return parseFloat(s.replace(/,/g, '')) }

function parseText(text: string): ExtractionResult {
  const gstinMatch = text.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}/g)
  const invMatch = text.match(/(?:invoice\s*(?:no|number|#)\s*[:\-]?\s*)([A-Z0-9\/\-]+)/i)

  const namedDateMatch = text.match(/(\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]\d{4})/i)
  let numericDateMatch = null
  if (!namedDateMatch) {
    const m = text.match(/(?:date)[^\n]{0,20}?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i) ?? text.match(/(\d{4}-\d{2}-\d{2})/)
    if (m) {
      const [a, b] = m[1].split(/[\/\-]/).map(Number)
      if (!(Math.min(a, b) > 31 || Math.max(a, b) > 12)) numericDateMatch = m
    }
  }

  const rsAmt = (label: string) => {
    const m = text.match(new RegExp(`${label}[^\\n]*?Rs\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'))
    return m ? parseAmount(m[1]) : undefined
  }

  const taxableRaw = text.match(/taxable\s+value[^\n]*?([\d,]+\.\d{2})/i)?.[1]
  const taxableRs = rsAmt('Taxable\\s+Value') ?? (taxableRaw ? parseAmount(taxableRaw) : undefined)

  return {
    gstin: gstinMatch?.[0],
    invoice_number: invMatch?.[1],
    invoice_date: (dm => dm?.[1] ?? dm?.[0])(namedDateMatch ?? numericDateMatch),
    taxable_value: taxableRs,
    cgst: rsAmt('CGST'),
    sgst: rsAmt('SGST'),
    igst: rsAmt('IGST'),
  }
}

function confidence(result: ExtractionResult): number {
  const present = [result.gstin, result.invoice_number, result.invoice_date, result.taxable_value ?? result.igst].filter(Boolean).length
  const score = [0, 0, 0.5, 0.75, 1.0][present] ?? 0
  return Math.max(0, result.gstin && !validateGstin(result.gstin) ? score - 0.2 : score)
}

function isImage(filename: string): boolean {
  return /\.(jpg|jpeg|png|tiff)$/i.test(filename)
}

const EXTRACT_PROMPT = `You are a GST invoice parser. Extract the following fields from this Indian GST invoice and return ONLY a JSON object (no markdown, no explanation):
{
  "gstin": "supplier GSTIN (15-char)",
  "invoice_number": "invoice number",
  "invoice_date": "date in YYYY-MM-DD format",
  "taxable_value": number,
  "cgst": number,
  "sgst": number,
  "igst": number
}
Use null for any field not found.`

// OpenAI-compatible call — works for both OpenRouter and Ollama
async function callOpenAICompat(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  imageBase64?: string,
  imageMime?: string,
): Promise<string> {
  const content: unknown[] = [{ type: 'text', text: prompt }]
  if (imageBase64 && imageMime) {
    content.push({ type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageBase64}` } })
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 512 }),
  })
  if (!res.ok) throw new Error(`${baseUrl} ${res.status}: ${await res.text()}`)
  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  return data.choices?.[0]?.message?.content ?? ''
}

function parseJsonResult(raw: string): ExtractionResult {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim()) as Record<string, unknown>
    return {
      gstin: json.gstin ? String(json.gstin) : undefined,
      invoice_number: json.invoice_number ? String(json.invoice_number) : undefined,
      invoice_date: json.invoice_date ? String(json.invoice_date) : undefined,
      taxable_value: json.taxable_value != null ? Number(json.taxable_value) : undefined,
      cgst: json.cgst != null ? Number(json.cgst) : undefined,
      sgst: json.sgst != null ? Number(json.sgst) : undefined,
      igst: json.igst != null ? Number(json.igst) : undefined,
    }
  } catch {
    return {}
  }
}

// Provider cascade: OpenRouter → Ollama → Gemini
async function extractWithAI(prompt: string, imageBase64?: string, imageMime?: string): Promise<ExtractionResult> {
  // 1. OpenRouter
  const orKey = process.env.OPENROUTER_API_KEY
  const orModel = imageBase64
    ? (process.env.OPENROUTER_VISION_MODEL ?? 'google/gemini-2.5-flash')
    : (process.env.OPENROUTER_MODEL ?? 'meta-llama/llama-3.3-70b-instruct')
  if (orKey) {
    try {
      const raw = await callOpenAICompat('https://openrouter.ai/api/v1', orKey, orModel, prompt, imageBase64, imageMime)
      const result = parseJsonResult(raw)
      if (result.gstin || result.invoice_number) return result
    } catch (e) { console.error('[openrouter] error:', e) }
  }

  // 2. Ollama (local)
  const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1'
  const ollamaModel = imageBase64
    ? (process.env.OLLAMA_VISION_MODEL ?? 'llava')
    : (process.env.OLLAMA_MODEL ?? 'llama3')
  try {
    const raw = await callOpenAICompat(ollamaBase, 'ollama', ollamaModel, prompt, imageBase64, imageMime)
    const result = parseJsonResult(raw)
    if (result.gstin || result.invoice_number) return result
  } catch (e) { console.error('[ollama] error:', e) }

  // 3. Gemini fallback
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_VISION_API_KEY
  if (geminiKey && imageBase64 && imageMime) {
    try {
      const { GoogleGenAI } = await import('@google/genai')
      const ai = new GoogleGenAI({ apiKey: geminiKey })
      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inlineData: { mimeType: imageMime, data: imageBase64 } },
        ]}],
      })
      return parseJsonResult(result.text ?? '')
    } catch (e) { console.error('[gemini] error:', e) }
  }

  return {}
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // ponytail: import lib directly to avoid pdf-parse loading its own test file on Windows
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { text } = await require('pdf-parse/lib/pdf-parse')(buffer)
    return text as string
  } catch (e) {
    console.error('[extractPdfText] error:', e)
    return ''
  }
}

const TEXT_THRESHOLD = 80
const CONCURRENCY   = 5

interface ExtractedFile {
  filename: string
  fileHash: string
  parsed: ExtractionResult
  skipped?: boolean
  extractError?: string
}

async function extractFile(file: File): Promise<ExtractedFile> {
  const buffer = Buffer.from(await file.arrayBuffer())
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')
  let parsed: ExtractionResult = {}

  try {
    if (file.name.toLowerCase().endsWith('.pdf')) {
      const rawText = await extractPdfText(buffer)
      if (rawText.length >= TEXT_THRESHOLD) {
        // Text PDF: LLM extracts structured JSON directly (better than regex)
        parsed = await extractWithAI(`${EXTRACT_PROMPT}\n\nInvoice text:\n${rawText.slice(0, 4000)}`)
        // Fall back to regex if LLM returned nothing useful
        if (!parsed.gstin && !parsed.invoice_number) parsed = parseText(rawText)
      } else {
        // Scanned/bad PDF: vision model
        parsed = await extractWithAI(EXTRACT_PROMPT, buffer.toString('base64'), 'application/pdf')
      }
    } else if (isImage(file.name)) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpeg'
      const mime = ext === 'png' ? 'image/png' : ext === 'tiff' ? 'image/tiff' : 'image/jpeg'
      parsed = await extractWithAI(EXTRACT_PROMPT, buffer.toString('base64'), mime)
    }
  } catch (e) {
    return { filename: file.name, fileHash, parsed, extractError: (e as Error).message }
  }

  return { filename: file.name, fileHash, parsed }
}

export async function POST(req: Request) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const formData = await req.formData()
  const files = formData.getAll('files') as File[]
  const clientId = formData.get('client_id') as string
  const period = formData.get('period') as string

  if (!files.length || !clientId || !period) {
    return NextResponse.json({ error: 'files, client_id, period required' }, { status: 400 })
  }

  // 1. Insert extraction job rows for each file (processing status).
  // Best-effort: job tracking must never break the upload itself.
  const jobIds: Map<string, string> = new Map()
  for (const file of files) {
    try {
      const { data: job, error: jobError } = await db.from('extraction_jobs').insert({
        org_id: orgId,
        client_id: clientId,
        period,
        status: 'processing',
        attempt_count: 0,
        last_error: null,
        file_name: file.name,
        file_hash: crypto.createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex')
      }).select('id').single()
      if (jobError) {
        console.error('[extraction_jobs] insert failed:', jobError.message)
      } else if (job) {
        jobIds.set(file.name, job.id)
      }
    } catch (e) {
      console.error('[extraction_jobs] insert threw:', (e as Error).message)
    }
  }

  const allResults: { filename: string; extraction_id?: string; confidence?: number; skipped?: boolean; error?: string }[] = []

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY)

    // 1. Extract all files in chunk concurrently — allSettled isolates per-file failures
    const settled = await Promise.allSettled(chunk.map(extractFile))
    const extracted: ExtractedFile[] = settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { filename: chunk[i].name, fileHash: '', parsed: {}, extractError: (r.reason as Error)?.message ?? 'unknown error' }
    )

    // 2. Bulk dedup check — one query for all hashes in this chunk
    const hashes = extracted.map(e => e.fileHash)
    const { data: existingRows } = await db
      .from('purchase_register_entries')
      .select('id, file_hash, supplier_gstin, inv_no')
      .eq('org_id', orgId)
      .eq('client_id', clientId)
      .in('file_hash', hashes)
    type ExistingRow = { id: string; file_hash: string; supplier_gstin: string | null; inv_no: string | null }
    const existingMap = new Map<string, ExistingRow>((existingRows ?? []).map((r: ExistingRow) => [r.file_hash, r]))

    // 3. Separate duplicates from new records
    //    Re-extract if the existing entry has no GSTIN and no invoice number (prior extraction failed)
    const toInsert: typeof extracted = []
    const toReplace: { e: typeof extracted[0]; existingId: string }[] = []
    for (const e of extracted) {
      if (e.extractError) {
        allResults.push({ filename: e.filename, error: e.extractError })
      } else if (existingMap.has(e.fileHash)) {
        const existing = existingMap.get(e.fileHash)!
        const extractionFailed = !existing.supplier_gstin && !existing.inv_no
        if (extractionFailed) {
          toReplace.push({ e, existingId: existing.id })
        } else {
          allResults.push({ filename: e.filename, extraction_id: existing.id, skipped: true })
        }
      } else if (!e.parsed.gstin && !e.parsed.invoice_number) {
        // Extraction yielded nothing useful — skip rather than pollute with zero rows
        allResults.push({ filename: e.filename, error: 'extraction failed: no GSTIN or invoice number found' })
      } else {
        toInsert.push(e)
      }
    }

    // Update entries where previous extraction produced no fields
    for (const { e, existingId } of toReplace) {
      const conf = confidence(e.parsed)
      const gstin = e.parsed.gstin ?? ''
      const invNo = e.parsed.invoice_number ?? ''
      await db.from('purchase_register_entries').update({
        supplier_gstin: gstin,
        norm_supplier_gstin: gstin ? normalizeGstin(gstin) : null,
        inv_no: invNo,
        norm_inv_no: invNo ? normalizeInvNo(invNo) : null,
        inv_date: (e.parsed.invoice_date ? toIsoDate(e.parsed.invoice_date) : null) ?? new Date().toISOString().slice(0, 10),
        taxable_value: e.parsed.taxable_value ?? 0,
        cgst: e.parsed.cgst ?? 0,
        sgst: e.parsed.sgst ?? 0,
        igst: e.parsed.igst ?? 0,
        extraction_confidence: conf,
      }).eq('id', existingId)
      const jobId = jobIds.get(e.filename)
      if (jobId) {
        const newStatus = conf < 0.6 ? 'low_confidence' : 'done'
        await db.from('extraction_jobs').update({
          status: newStatus,
          result_entry_id: existingId,
          extraction_confidence: conf,
          attempt_count: 1,
        }).eq('id', jobId)
        // If low confidence, mark the PR entry for confirmation
        if (newStatus === 'low_confidence') {
          await db.from('purchase_register_entries').update({
            needs_confirmation: true,
          }).eq('id', existingId)
        }
      }
      allResults.push({ filename: e.filename, extraction_id: existingId, confidence: conf })
    }

    if (!toInsert.length) continue

    // 4a. Dedup by (norm_supplier_gstin, norm_inv_no) — catches same invoice from two different files
    const normKeys = toInsert.map(e => `${normalizeGstin(e.parsed.gstin ?? '')}|${normalizeInvNo(e.parsed.invoice_number ?? '')}`)
    const { data: normDups } = await db
      .from('purchase_register_entries')
      .select('id, norm_supplier_gstin, norm_inv_no')
      .eq('org_id', orgId)
      .eq('client_id', clientId)
      .eq('period', period)
      .in('norm_supplier_gstin', toInsert.map(e => normalizeGstin(e.parsed.gstin ?? '')))
    type NormDup = { id: string; norm_supplier_gstin: string; norm_inv_no: string }
    const normDupSet = new Set((normDups ?? []).map((r: NormDup) => `${r.norm_supplier_gstin}|${r.norm_inv_no}`))
    const dedupedInsert = toInsert.filter((_, i) => !normDupSet.has(normKeys[i]))
    for (const e of toInsert.filter((_, i) => normDupSet.has(normKeys[i]))) {
      allResults.push({ filename: e.filename, skipped: true })
    }

    if (!dedupedInsert.length) continue

    // 4. ONE bulk insert for the whole chunk
    const rows = dedupedInsert.map(e => {
      const conf = confidence(e.parsed)
      const gstin = e.parsed.gstin ?? ''
      const invNo = e.parsed.invoice_number ?? ''
      return {
        org_id: orgId,
        client_id: clientId,
        period,
        supplier_gstin: gstin,
        norm_supplier_gstin: gstin ? normalizeGstin(gstin) : null,
        inv_no: invNo,
        inv_date: (e.parsed.invoice_date ? toIsoDate(e.parsed.invoice_date) : null) ?? new Date().toISOString().slice(0, 10),
        norm_inv_no: invNo ? normalizeInvNo(invNo) : null,
        taxable_value: e.parsed.taxable_value ?? 0,
        cgst: e.parsed.cgst ?? 0,
        sgst: e.parsed.sgst ?? 0,
        igst: e.parsed.igst ?? 0,
        is_rcm: false,
        doc_type: 'invoice',
        extraction_confidence: conf,
        source: 'upload',
        file_hash: e.fileHash,
        _meta: { filename: e.filename, conf },  // stripped below
      }
    })

    const cleanRows = rows.map(({ _meta: _, ...r }) => r)
    const { data: inserted, error: insertError } = await db
      .from('purchase_register_entries')
      .insert(cleanRows)
      .select('id, file_hash')

    if (insertError) {
      dedupedInsert.forEach(e => allResults.push({ filename: e.filename, error: insertError.message }))
      // Also mark jobs as failed
      for (const e of dedupedInsert) {
        const jobId = jobIds.get(e.filename)
        if (jobId) {
          await db.from('extraction_jobs').update({
            status: 'failed',
            last_error: insertError.message,
            attempt_count: 1,
          }).eq('id', jobId)
        }
      }
      continue
    }

    const insertedMap = new Map<string, string>((inserted ?? []).map((r: { id: string; file_hash: string }) => [r.file_hash, r.id]))
    for (const e of dedupedInsert) {
      const conf = confidence(e.parsed)
      const jobId = jobIds.get(e.filename)
      if (jobId) {
        const newStatus = conf < 0.6 ? 'low_confidence' : 'done'
        await db.from('extraction_jobs').update({
          status: newStatus,
          result_entry_id: insertedMap.get(e.fileHash),
          extraction_confidence: conf,
          attempt_count: 1,
        }).eq('id', jobId)
        // If low confidence, mark the PR entry for confirmation
        if (newStatus === 'low_confidence') {
          await db.from('purchase_register_entries').update({
            needs_confirmation: true,
          }).eq('id', insertedMap.get(e.fileHash))
        }
      }
      allResults.push({ filename: e.filename, extraction_id: insertedMap.get(e.fileHash), confidence: conf })
    }
  }

  return NextResponse.json(allResults)
}
