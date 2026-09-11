// 5-bucket GST reconciliation engine with variance + evidence

export interface Entry {
  id: string
  norm_supplier_gstin: string
  norm_inv_no: string
  taxable_value: number
  cgst: number
  sgst: number
  igst: number
  extraction_confidence?: number
  supplier_gstin?: string
}

export type MatchStatus = 'MATCHED' | 'PROBABLE' | 'MISMATCH' | 'BOOKS_ONLY' | 'TWOB_ONLY'

export interface MatchResult {
  pr_entry_id: string | null
  gstr2b_entry_id: string | null
  status: MatchStatus
  confidence: number
  mismatched_fields: string[]
  taxable_variance: number
  tax_variance: number
  itc_at_risk: number
  evidence: Record<string, unknown>
}

const AMOUNT_TOLERANCE = 0.05 // 5%
const MAX_INV_NO_EDIT_DISTANCE = 2 // OCR/typo tolerance for the fuzzy fallback pass

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[a.length][b.length]
}

function amountDiff(a: number, b: number): number {
  if (a === 0 && b === 0) return 0
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b))
}

function matchAmounts(pr: Entry, tb: Entry): { status: MatchStatus; mismatched: string[] } {
  const fields = ['taxable_value', 'cgst', 'sgst', 'igst'] as const
  const mismatched: string[] = []

  for (const field of fields) {
    const diff = amountDiff(pr[field], tb[field])
    if (diff > AMOUNT_TOLERANCE) mismatched.push(field)
  }

  if (mismatched.length === 0) return { status: 'MATCHED', mismatched: [] }

  const allSmall = fields.every(f => amountDiff(pr[f], tb[f]) <= 0.2)
  return {
    status: allSmall ? 'PROBABLE' : 'MISMATCH',
    mismatched,
  }
}

function computeVariance(pr: Entry, tb: Entry): { taxable_variance: number; tax_variance: number } {
  const taxable_variance = (pr.taxable_value ?? 0) - (tb.taxable_value ?? 0)
  const prTax = (pr.cgst ?? 0) + (pr.sgst ?? 0) + (pr.igst ?? 0)
  const tbTax = (tb.cgst ?? 0) + (tb.sgst ?? 0) + (tb.igst ?? 0)
  const tax_variance = prTax - tbTax
  return { taxable_variance, tax_variance }
}

function buildEvidence(pr: Entry | null, tb: Entry | null, status: MatchStatus): Record<string, unknown> {
  const evidence: Record<string, unknown> = {}
  if (pr?.extraction_confidence != null) {
    evidence.extraction_confidence = pr.extraction_confidence
  }
  if (status === 'MATCHED' || status === 'PROBABLE') {
    evidence.alias_hit = true
  }
  return evidence
}

export function reconcile(prEntries: Entry[], twoBEntries: Entry[]): MatchResult[] {
  const results: MatchResult[] = []
  const usedTwoB = new Set<string>()
  const usedPR = new Set<string>()

  const twoBMap = new Map<string, Entry[]>()
  for (const tb of twoBEntries) {
    const key = `${tb.norm_supplier_gstin}::${tb.norm_inv_no}`
    if (!twoBMap.has(key)) twoBMap.set(key, [])
    twoBMap.get(key)!.push(tb)
  }

  for (const pr of prEntries) {
    const key = `${pr.norm_supplier_gstin}::${pr.norm_inv_no}`
    const candidates = twoBMap.get(key)?.filter(tb => !usedTwoB.has(tb.id))

    if (!candidates?.length) continue

    let best = candidates[0]
    let bestResult = matchAmounts(pr, best)
    for (const candidate of candidates.slice(1)) {
      const r = matchAmounts(pr, candidate)
      if (r.mismatched.length < bestResult.mismatched.length) {
        best = candidate
        bestResult = r
      }
    }

    const { taxable_variance, tax_variance } = computeVariance(pr, best)
    const totalTax = (best.cgst ?? 0) + (best.sgst ?? 0) + (best.igst ?? 0)
    const itc_at_risk = bestResult.status === 'MATCHED' ? 0
      : bestResult.status === 'PROBABLE' ? Math.abs(tax_variance)
      : Math.abs(tax_variance) || totalTax

    usedPR.add(pr.id)
    usedTwoB.add(best.id)
    results.push({
      pr_entry_id: pr.id,
      gstr2b_entry_id: best.id,
      status: bestResult.status,
      confidence: ({ MATCHED: 1.0, PROBABLE: 0.7, MISMATCH: 0.3 } as Record<MatchStatus, number>)[bestResult.status] ?? 0.3,
      mismatched_fields: bestResult.mismatched,
      taxable_variance,
      tax_variance,
      itc_at_risk,
      evidence: buildEvidence(pr, best, bestResult.status),
    })
  }

  // Fuzzy fallback: same GSTIN, invoice number differs by a couple of characters
  // (OCR misread or a typo in either source) and the taxable value is in the same ballpark.
  // Exact-key matching above would otherwise split these into a BOOKS_ONLY + TWOB_ONLY pair.
  for (const pr of prEntries) {
    if (usedPR.has(pr.id) || !pr.norm_supplier_gstin || !pr.norm_inv_no) continue

    let best: Entry | null = null
    let bestDist = Infinity
    for (const tb of twoBEntries) {
      if (usedTwoB.has(tb.id) || tb.norm_supplier_gstin !== pr.norm_supplier_gstin || !tb.norm_inv_no) continue
      if (amountDiff(pr.taxable_value, tb.taxable_value) > 0.2) continue
      const dist = levenshtein(pr.norm_inv_no, tb.norm_inv_no)
      if (dist <= MAX_INV_NO_EDIT_DISTANCE && dist < bestDist) { best = tb; bestDist = dist }
    }
    if (!best) continue

    const { taxable_variance, tax_variance } = computeVariance(pr, best)
    const amounts = matchAmounts(pr, best)
    const totalTax = (best.cgst ?? 0) + (best.sgst ?? 0) + (best.igst ?? 0)
    const itc_at_risk = amounts.status === 'MATCHED' ? 0 : Math.abs(tax_variance) || totalTax

    usedPR.add(pr.id)
    usedTwoB.add(best.id)
    results.push({
      pr_entry_id: pr.id,
      gstr2b_entry_id: best.id,
      status: 'PROBABLE',
      confidence: 0.6,
      mismatched_fields: [...amounts.mismatched, 'inv_no'],
      taxable_variance,
      tax_variance,
      itc_at_risk,
      evidence: { ...buildEvidence(pr, best, 'PROBABLE'), fuzzy_inv_no_match: true, edit_distance: bestDist },
    })
  }

  // BOOKS_ONLY: PR entries with no match
  for (const pr of prEntries) {
    if (!usedPR.has(pr.id)) {
      const totalTax = (pr.cgst ?? 0) + (pr.sgst ?? 0) + (pr.igst ?? 0)
      results.push({
        pr_entry_id: pr.id,
        gstr2b_entry_id: null,
        status: 'BOOKS_ONLY',
        confidence: 1.0,
        mismatched_fields: [],
        taxable_variance: 0,
        tax_variance: 0,
        itc_at_risk: totalTax,
        evidence: buildEvidence(pr, null, 'BOOKS_ONLY'),
      })
    }
  }

  // TWOB_ONLY: 2B entries with no match
  for (const tb of twoBEntries) {
    if (!usedTwoB.has(tb.id)) {
      const totalTax = (tb.cgst ?? 0) + (tb.sgst ?? 0) + (tb.igst ?? 0)
      results.push({
        pr_entry_id: null,
        gstr2b_entry_id: tb.id,
        status: 'TWOB_ONLY',
        confidence: 1.0,
        mismatched_fields: [],
        taxable_variance: 0,
        tax_variance: 0,
        itc_at_risk: totalTax,
        evidence: buildEvidence(null, tb, 'TWOB_ONLY'),
      })
    }
  }

  return results
}
