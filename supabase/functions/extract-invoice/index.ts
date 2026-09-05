import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ponytail: pdfjs loaded dynamically to keep cold-start small
const VISION_API_URL = 'https://vision.googleapis.com/v1/images:annotate'

interface Metadata {
  client_id: string
  period: string
  org_id: string
  file_hash: string | null
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

function normalizeGstin(s: string) { return s.replace(/\s+/g, '').toUpperCase() }
function normalizeInvNo(s: string) { return s.replace(/\s+/g, '').toUpperCase().replace(/^0+/, '') }
function validateGstin(s: string) { return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(s) }

// Normalizes extracted date string to ISO yyyy-mm-dd, assuming dd/mm/yyyy (Indian GST standard).
// Rejects ambiguous formats where day > 12 is the only disambiguator; returns null for unparseable.
function normalizeDate(raw: string): string | null {
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const parts = raw.split(/[\/-]/)
  if (parts.length !== 3) return null

  let [a, b, c] = parts.map(Number)

  // yy/dd/mm or yyyy/dd/mm — year first
  if (parts[0].length >= 4 || a > 31) {
    const yyyy = a < 100 ? 2000 + a : a
    // c is month, b is day — uncommon, but handle yy-dd-mm
    if (b > 12) return null // truly ambiguous, skip
    return `${yyyy}-${String(c).padStart(2, '0')}-${String(b).padStart(2, '0')}`
  }

  // dd/mm/yyyy (standard Indian GST) or dd/mm/yy
  const yyyy = c < 100 ? 2000 + c : c
  if (a > 31 || b > 12) return null // invalid
  return `${yyyy}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`
}

function parseText(text: string): ExtractionResult {
  const gstinMatch = text.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}/g)
  const invMatch = text.match(/(?:invoice\s*(?:no|number|#)\s*[:\-]?\s*)([A-Z0-9\/\-]+)/i)
  const dateMatch = text.match(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})/)
  const amountMatches = [...text.matchAll(/(?:taxable|igst|cgst|sgst)[^\d]*(\d+(?:[,\d]*\.\d+)?)/gi)]

  const amounts: Record<string, number> = {}
  for (const m of amountMatches) {
    const label = m[0].toLowerCase()
    const val = parseFloat(m[1].replace(/,/g, ''))
    if (label.includes('taxable')) amounts.taxable = val
    else if (label.includes('igst')) amounts.igst = val
    else if (label.includes('cgst')) amounts.cgst = val
    else if (label.includes('sgst')) amounts.sgst = val
  }

  return {
    gstin: gstinMatch?.[0],
    invoice_number: invMatch?.[1],
    invoice_date: dateMatch ? normalizeDate(dateMatch[0]) ?? dateMatch[0] : undefined,
    taxable_value: amounts.taxable,
    cgst: amounts.cgst,
    sgst: amounts.sgst,
    igst: amounts.igst,
  }
}

function confidence(result: ExtractionResult): number {
  const required = [result.gstin, result.invoice_number, result.invoice_date, result.taxable_value ?? result.igst]
  const present = required.filter(Boolean).length
  let score = [0, 0, 0.5, 0.75, 1.0][present]
  if (result.gstin && !validateGstin(result.gstin)) score -= 0.2
  return Math.max(0, score)
}

async function extractWithVision(base64: string, apiKey: string): Promise<string> {
  const res = await fetch(`${VISION_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ image: { content: base64 }, features: [{ type: 'TEXT_DETECTION' }] }],
    }),
  })
  const data = await res.json()
  return data.responses?.[0]?.fullTextAnnotation?.text ?? ''
}

async function extractWithPdfjs(base64: string): Promise<string> {
  try {
    // @ts-ignore — deno esm import
    const pdfjsLib = await import('https://esm.sh/pdfjs-dist@4.4.168/build/pdf.mjs')
    pdfjsLib.GlobalWorkerOptions.workerSrc = ''
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise
    let text = ''
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      text += content.items.map((item: { str: string }) => item.str).join(' ') + '\n'
    }
    return text
  } catch {
    return ''
  }
}

Deno.serve(async (req) => {
  const { fileBytes, filename, metadata }: { fileBytes: string; filename: string; metadata: Metadata } = await req.json()

  const isPdf = filename.toLowerCase().endsWith('.pdf')
  const googleApiKey = Deno.env.get('GOOGLE_VISION_API_KEY') ?? ''

  let text = ''
  let usedOcr = false

  if (isPdf) {
    text = await extractWithPdfjs(fileBytes)
  }

  const parsed = parseText(text)
  const conf = confidence(parsed)

  if (!isPdf || conf < 0.7) {
    text = await extractWithVision(fileBytes, googleApiKey)
    usedOcr = true
    Object.assign(parsed, parseText(text))
  }

  const finalConf = confidence(parsed)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { data, error } = await supabase.from('purchase_register_entries').insert({
    org_id: metadata.org_id,
    client_id: metadata.client_id,
    period: metadata.period,
    supplier_gstin: parsed.gstin,
    norm_supplier_gstin: parsed.gstin ? normalizeGstin(parsed.gstin) : null,
    invoice_number: parsed.invoice_number,
    norm_inv_no: parsed.invoice_number ? normalizeInvNo(parsed.invoice_number) : null,
    invoice_date: parsed.invoice_date ?? null,
    taxable_value: parsed.taxable_value ?? null,
    cgst: parsed.cgst ?? null,
    sgst: parsed.sgst ?? null,
    igst: parsed.igst ?? null,
    extraction_confidence: finalConf,
    source: 'upload',
    file_hash: metadata.file_hash,
  }).select().single()

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ extraction_id: data.id, confidence: finalConf, used_ocr: usedOcr })
})
