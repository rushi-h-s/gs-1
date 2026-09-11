import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'
import { extractBankStatement } from '@/lib/bank-extractor'
import crypto from 'crypto'

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { text } = await require('pdf-parse/lib/pdf-parse')(buffer)
    return text as string
  } catch (e) {
    console.error('[bank-upload] pdf-parse error:', e)
    return ''
  }
}

export async function POST(req: Request) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const formData = await req.formData()
  const files    = formData.getAll('files') as File[]
  const clientId = formData.get('client_id') as string
  const period   = formData.get('period') as string

  if (!files.length || !clientId || !period) {
    return NextResponse.json({ error: 'files, client_id, period required' }, { status: 400 })
  }

  const results = []

  for (const file of files) {
    const buffer   = Buffer.from(await file.arrayBuffer())
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')

    // Dedup
    const { data: existing } = await db
      .from('bank_statement_files')
      .select('id')
      .eq('org_id', orgId)
      .eq('file_hash', fileHash)
      .single()
    if (existing) {
      results.push({ filename: file.name, skipped: true, statement_id: existing.id })
      continue
    }

    // Extract text (PDF only for now; add OCR path when needed)
    const text = file.name.toLowerCase().endsWith('.pdf')
      ? await extractPdfText(buffer)
      : await file.text()

    const statement = extractBankStatement(text)

    // Insert file record
    const { data: fileRow, error: fileErr } = await db
      .from('bank_statement_files')
      .insert({
        org_id:          orgId,
        client_id:       clientId,
        period,
        file_name:       file.name,
        file_hash:       fileHash,
        bank_name:       statement.bank_name,
        account_number:  statement.account_number,
        ifsc:            statement.ifsc,
        opening_balance: statement.opening_balance,
        closing_balance: statement.closing_balance,
        txn_count:       statement.txn_count,
        balance_ok:      statement.balance_ok,
        quarantine_reason: statement.quarantine_reason,
      })
      .select('id')
      .single()

    if (fileErr || !fileRow) {
      results.push({ filename: file.name, error: fileErr?.message ?? 'insert failed' })
      continue
    }

    // Bulk-insert transactions
    if (statement.transactions.length > 0) {
      const txnRows = statement.transactions.map(t => ({
        org_id:       orgId,
        statement_id: fileRow.id,
        client_id:    clientId,
        period,
        txn_date:     t.txn_date,
        value_date:   t.value_date,
        narration:    t.narration,
        ref_no:       t.ref_no,
        debit:        t.debit,
        credit:       t.credit,
        balance:      t.balance,
        counterparty: t.counterparty,
        reference:    t.reference,
        mode:         t.mode,
      }))
      const { error: txnErr } = await db.from('bank_transactions').insert(txnRows)
      if (txnErr) console.error('[bank-upload] txn insert error:', txnErr.message)
    }

    results.push({
      filename:    file.name,
      statement_id: fileRow.id,
      bank_name:   statement.bank_name,
      txn_count:   statement.txn_count,
      balance_ok:  statement.balance_ok,
      quarantine:  !statement.balance_ok,
    })
  }

  return NextResponse.json(results)
}
