export function normalizeGstin(gstin: string): string {
  return (gstin ?? '').replace(/\s+/g, '').toUpperCase()
}

/**
 * Canonical invoice key: uppercase, drop every separator, strip leading zeros
 * at the start and after letters. INV-0042 / INV/0042 / INV.42 / inv0042 all -> INV42.
 */
export function normalizeInvNo(invNo: string): string {
  return (invNo ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/(^|(?<=[A-Z]))0+(?=\d)/g, '')
}

// Basic GSTIN checksum validation (15-char format check)
export function validateGstin(gstin: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin)
}

/** '₹1,234.50' / '(500)' / 12 / '' -> number. Non-numeric -> 0 (callers validate rows separately). */
export function parseNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  let s = String(v ?? '').replace(/[₹,\s]|rs\.?/gi, '')
  const neg = /^\(.*\)$/.test(s)
  s = s.replace(/[()]/g, '')
  const n = Number(s)
  return Number.isFinite(n) && s !== '' ? (neg ? -n : n) : 0
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * Any date a GST file throws at us -> 'YYYY-MM-DD', or null if unparseable.
 * Handles ISO, dd-mm-yyyy, dd/mm/yyyy, dd-Mon-yyyy and Excel serial numbers.
 * Day-first is assumed for dd/mm/yyyy (Indian convention).
 */
export function parseDate(v: unknown): string | null {
  const iso = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
      ? dt.toISOString().slice(0, 10)
      : null
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10) // Excel serial
  }
  const s = String(v ?? '').trim()
  let m
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return iso(+m[1], +m[2], +m[3])
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) return iso(+m[3], +m[2], +m[1])
  if ((m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ,]*(\d{4})/))) {
    const mi = MONTHS.indexOf(m[2].toLowerCase())
    return mi >= 0 ? iso(+m[3], mi + 1, +m[1]) : null
  }
  return null
}
