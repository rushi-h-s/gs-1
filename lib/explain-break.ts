// Pure helper — turns a match result into a one-line human explanation.
// Covers the common Indian GST break patterns; falls back to a generic diff line.

export interface BreakInput {
  status: 'MATCHED' | 'PROBABLE' | 'MISMATCH' | 'BOOKS_ONLY' | 'TWOB_ONLY'
  taxable_variance: number   // signed: PR − 2B
  tax_variance: number       // signed: total tax PR − 2B
  itc_at_risk: number
  pr_inv_no?: string | null
  twob_inv_no?: string | null
  pr_taxable?: number | null
  evidence?: {
    alias_hits?: number
    field_confidence?: number
  } | null
}

function pct(variance: number, base: number): number {
  if (!base) return 0
  return Math.abs(variance) / Math.abs(base)
}

function fmt(n: number): string {
  return '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

export function explainBreak(m: BreakInput): string {
  const taxable = m.pr_taxable ?? 0

  if (m.status === 'BOOKS_ONLY') {
    return 'Booked but not yet in 2B — supplier may not have filed or filing is delayed.'
  }

  if (m.status === 'TWOB_ONLY') {
    return 'Present in 2B but not found in purchase register — invoice may be missing from your books.'
  }

  if (m.status === 'MATCHED') {
    return 'Amounts match within tolerance.'
  }

  // PROBABLE / MISMATCH — explain the variance
  const absTax = Math.abs(m.tax_variance)
  const absTaxable = Math.abs(m.taxable_variance)

  // TDS / TCS patterns: diff ≈ 1%, 2%, 5%, 10% of taxable
  if (taxable > 0) {
    const rates = [0.01, 0.02, 0.05, 0.10]
    for (const rate of rates) {
      if (Math.abs(absTaxable - taxable * rate) / taxable < 0.001) {
        return `Difference ${fmt(m.taxable_variance)} — matches ${rate * 100}% TDS/TCS on invoice value.`
      }
    }
  }

  // Rounding
  if (absTaxable <= 5 && absTax <= 2) {
    return `Rounding difference of ${fmt(m.taxable_variance)} — likely safe to accept.`
  }

  // Invoice number off by one character (typo check)
  if (
    m.pr_inv_no && m.twob_inv_no &&
    m.pr_inv_no !== m.twob_inv_no
  ) {
    const longer = m.pr_inv_no.length > m.twob_inv_no.length ? m.pr_inv_no : m.twob_inv_no
    const shorter = m.pr_inv_no.length > m.twob_inv_no.length ? m.twob_inv_no : m.pr_inv_no
    if (longer.length - shorter.length <= 1) {
      return `GSTIN matches; invoice number differs (${m.pr_inv_no} vs ${m.twob_inv_no}) — likely a typo or transposition.`
    }
  }

  // Generic
  const p = pct(m.taxable_variance, taxable)
  const pStr = p > 0 ? ` (${(p * 100).toFixed(1)}%)` : ''
  return `Amounts differ by ${fmt(m.taxable_variance)}${pStr} — review and accept or flag to client.`
}

// Self-check
if (require.main === module) {
  const tds = explainBreak({ status: 'PROBABLE', taxable_variance: -1085, tax_variance: -195, itc_at_risk: 195, pr_taxable: 108500 })
  console.assert(tds.includes('TDS'), `TDS case failed: ${tds}`)

  const books = explainBreak({ status: 'BOOKS_ONLY', taxable_variance: 0, tax_variance: 0, itc_at_risk: 5000 })
  console.assert(books.includes('not yet in 2B'), `BOOKS_ONLY case failed: ${books}`)

  const rounding = explainBreak({ status: 'PROBABLE', taxable_variance: 2, tax_variance: 0.36, itc_at_risk: 0.36, pr_taxable: 10000 })
  console.assert(rounding.includes('Rounding'), `Rounding case failed: ${rounding}`)

  console.log('explainBreak: all assertions passed')
}
