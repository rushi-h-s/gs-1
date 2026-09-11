/**
 * Bank statement extraction pipeline:
 * Identify bank → Select adapter → Row extraction → Narration parse → Balance check → Canonical transactions
 */

export interface BankTransaction {
  txn_date: string          // YYYY-MM-DD
  value_date: string | null
  narration: string
  ref_no: string | null
  debit: number
  credit: number
  balance: number
  // parsed from narration
  counterparty: string | null
  reference: string | null
  mode: string | null       // UPI | NEFT | RTGS | IMPS | CHQ | ATM | ...
}

export interface BankStatement {
  bank_name: string
  account_number: string | null
  ifsc: string | null
  opening_balance: number
  closing_balance: number
  txn_count: number
  balance_ok: boolean       // opening + net = closing (within ₹1)
  transactions: BankTransaction[]
  quarantine_reason: string | null
}

// ── Bank fingerprinting ────────────────────────────────────────────────────

const BANK_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'SBI',   pattern: /state bank of india|SBI|SBIN\d{7}/i },
  { name: 'HDFC',  pattern: /hdfc bank|HDFC\d{7}/i },
  { name: 'ICICI', pattern: /icici bank|ICIC\d{7}/i },
  { name: 'AXIS',  pattern: /axis bank|UTIB\d{7}/i },
  { name: 'KOTAK', pattern: /kotak mahindra|KKBK\d{7}/i },
  { name: 'PNB',   pattern: /punjab national|PUNB\d{7}/i },
  { name: 'BOB',   pattern: /bank of baroda|BARB\d{7}/i },
  { name: 'UNION', pattern: /union bank|UBIN\d{7}/i },
  { name: 'CANARA',pattern: /canara bank|CNRB\d{7}/i },
  { name: 'IDBI',  pattern: /idbi bank|IBKL\d{7}/i },
]

function identifyBank(text: string): string {
  for (const { name, pattern } of BANK_PATTERNS) {
    if (pattern.test(text)) return name
  }
  return 'UNKNOWN'
}

function extractIfsc(text: string): string | null {
  return text.match(/[A-Z]{4}0[A-Z0-9]{6}/)?.[0] ?? null
}

function extractAccountNumber(text: string): string | null {
  // Most Indian banks print it as XX..XXXX or a plain 9-18 digit number near "Account"
  const m = text.match(/(?:account\s*(?:no|number|#)[:\s.]*)([\dX*\s]{9,20})/i)
  if (m) return m[1].replace(/\s/g, '')
  return null
}

// ── Amount parsing ─────────────────────────────────────────────────────────

function parseAmt(s: string): number {
  return parseFloat(s.replace(/,/g, '').trim()) || 0
}

// ── Date normalisation ─────────────────────────────────────────────────────

const MON: Record<string, string> = {
  jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
}

function toDate(s: string): string | null {
  s = s.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  let m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
  if (m) {
    const [, d, mo, y] = m
    return `${y.length === 2 ? '20' + y : y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`
  }
  m = s.match(/(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{2,4})/)
  if (m) {
    const [, d, mon, y] = m
    const mo = MON[mon.toLowerCase()]
    if (mo) return `${y.length === 2 ? '20' + y : y}-${mo}-${d.padStart(2,'0')}`
  }
  return null
}

// ── Narration parser ───────────────────────────────────────────────────────

const MODE_PATTERNS: [RegExp, string][] = [
  [/\bUPI\b/i,  'UPI'],
  [/\bNEFT\b/i, 'NEFT'],
  [/\bRTGS\b/i, 'RTGS'],
  [/\bIMPS\b/i, 'IMPS'],
  [/\bCHQ\b|\bCHEQUE\b/i, 'CHQ'],
  [/\bATM\b/i,  'ATM'],
  [/\bECS\b|\bNACH\b/i,   'ECS'],
  [/\bPOS\b/i,  'POS'],
]

function parseNarration(narration: string): Pick<BankTransaction, 'counterparty' | 'reference' | 'mode'> {
  let mode: string | null = null
  for (const [re, label] of MODE_PATTERNS) {
    if (re.test(narration)) { mode = label; break }
  }

  // UPI: "UPI/counterparty/ref" or "UPI-counterparty-ref"
  let counterparty: string | null = null
  let reference: string | null = null
  const upi = narration.match(/UPI[\/\-]([^\/\-]+)[\/\-]([^\/\-\s]+)/i)
  if (upi) { counterparty = upi[1].trim(); reference = upi[2].trim() }

  // NEFT/RTGS/IMPS: usually "NEFT/ref/counterparty"
  if (!counterparty) {
    const neft = narration.match(/(?:NEFT|RTGS|IMPS)[\/\-]([^\/\-]+)[\/\-]([^\/\-\s]+)/i)
    if (neft) { reference = neft[1].trim(); counterparty = neft[2].trim() }
  }

  // Cheque: extract cheque number
  if (!reference) {
    const chq = narration.match(/(?:CHQ|CHEQUE)[\/\-\s]*(?:NO[.\s]*)?(\d{6,})/i)
    if (chq) reference = chq[1]
  }

  return { counterparty, reference, mode }
}

// ── Row extraction ─────────────────────────────────────────────────────────
// Handles most Indian bank statement CSV/text formats.
// ponytail: simple heuristic covers ~90% of banks; add adapter subclasses when a bank drifts

function extractRows(text: string): Omit<BankTransaction, 'counterparty' | 'reference' | 'mode'>[] {
  const rows: Omit<BankTransaction, 'counterparty' | 'reference' | 'mode'>[] = []

  for (const line of text.split('\n')) {
    const col = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim())
    if (col.length < 4) continue

    // Find date column (first cell that looks like a date)
    let dateStr: string | null = null
    let dateIdx = -1
    for (let i = 0; i < Math.min(col.length, 3); i++) {
      const d = toDate(col[i])
      if (d) { dateStr = d; dateIdx = i; break }
    }
    if (!dateStr) continue

    // Amounts: scan right-to-left for balance, debit, credit (numbers ≥ 0)
    const nums: { idx: number; val: number }[] = []
    for (let i = col.length - 1; i > dateIdx; i--) {
      const v = parseFloat(col[i].replace(/,/g, ''))
      if (!isNaN(v) && col[i] !== '') nums.push({ idx: i, val: v })
      if (nums.length === 3) break
    }
    if (nums.length < 2) continue
    nums.reverse() // back to left-to-right within the number region

    // Last num = balance, second-to-last = larger of debit/credit pair, etc.
    const balance = nums[nums.length - 1].val
    const debit   = nums.length >= 3 ? nums[nums.length - 3].val : 0
    const credit  = nums.length >= 2 ? nums[nums.length - 2].val : 0

    // Narration: columns between dateIdx+1 and first amount column
    const firstAmtIdx = nums[0].idx
    const narration = col.slice(dateIdx + 1, firstAmtIdx).join(' ').trim()
    if (!narration) continue

    // Value date: if dateIdx+1 looks like a date and narration starts later
    const vd = dateIdx + 1 < firstAmtIdx ? toDate(col[dateIdx + 1]) : null

    rows.push({
      txn_date: dateStr,
      value_date: vd,
      narration,
      ref_no: null,
      debit,
      credit,
      balance,
    })
  }

  return rows
}

// ── Balance check ──────────────────────────────────────────────────────────

function checkBalance(opening: number, transactions: BankTransaction[], closing: number): boolean {
  const net = transactions.reduce((s, t) => s + t.credit - t.debit, 0)
  return Math.abs(opening + net - closing) < 1  // ₹1 tolerance for rounding
}

function extractBalances(text: string): { opening: number; closing: number } {
  const opMatch  = text.match(/opening\s+balance[:\s]*([\d,]+\.\d{2})/i)
  const clMatch  = text.match(/closing\s+balance[:\s]*([\d,]+\.\d{2})/i)
  return {
    opening: opMatch  ? parseAmt(opMatch[1])  : 0,
    closing: clMatch  ? parseAmt(clMatch[1])  : 0,
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function extractBankStatement(text: string): BankStatement {
  const bank_name      = identifyBank(text)
  const ifsc           = extractIfsc(text)
  const account_number = extractAccountNumber(text)
  const { opening, closing } = extractBalances(text)

  const rawRows = extractRows(text)
  const transactions: BankTransaction[] = rawRows.map(r => ({
    ...r,
    ...parseNarration(r.narration),
  }))

  const balance_ok = checkBalance(opening, transactions, closing)
  const quarantine_reason = !balance_ok
    ? `Balance mismatch: opening ${opening} + net ≠ closing ${closing}`
    : transactions.length === 0
    ? 'No transactions extracted'
    : null

  return {
    bank_name,
    account_number,
    ifsc,
    opening_balance: opening,
    closing_balance: closing,
    txn_count: transactions.length,
    balance_ok,
    transactions,
    quarantine_reason,
  }
}
