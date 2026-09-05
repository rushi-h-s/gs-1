import * as XLSX from 'xlsx'
import { normalizeGstin, normalizeInvNo } from './normalize'

export interface Gstr2bEntry {
  supplier_gstin: string
  norm_supplier_gstin: string
  inv_no: string
  inv_date: string
  norm_inv_no: string
  taxable_value: number
  cgst: number
  sgst: number
  igst: number
  doc_type: 'invoice' | 'credit_note' | 'debit_note'
}

export function parseGstr2bJson(json: Record<string, unknown>): Gstr2bEntry[] {
  // Format A: flat array at json.gstr_2b (test/synthetic datasets)
  if (Array.isArray(json.gstr_2b)) {
    return (json.gstr_2b as Array<Record<string, unknown>>).map(row => {
      const gstin = String(row.supplier_gstin ?? '')
      const invNo = String(row.invoice_number ?? '')
      const docType = String(row.document_type ?? 'invoice').toLowerCase()
      return {
        supplier_gstin: gstin,
        norm_supplier_gstin: normalizeGstin(gstin),
        inv_no: invNo,
        inv_date: String(row.invoice_date ?? new Date().toISOString().slice(0, 10)),
        norm_inv_no: normalizeInvNo(invNo),
        taxable_value: Number(row.taxable_value ?? 0),
        cgst: Number(row.cgst ?? 0),
        sgst: Number(row.sgst ?? 0),
        igst: Number(row.igst ?? 0),
        doc_type: (docType.includes('credit')) ? 'credit_note'
          : (docType.includes('debit')) ? 'debit_note'
          : 'invoice',
      }
    })
  }

  // Format B: GST portal JSON — data.docdata.b2b[].inv[]
  const entries: Gstr2bEntry[] = []
  const docdata = (
    (json?.data as Record<string, unknown>)?.docdata ??
    (json?.docdata as Record<string, unknown>) ??
    json
  ) as Record<string, unknown>

  for (const key of ['b2b', 'b2ba']) {
    const records = (docdata[key] ?? []) as Array<Record<string, unknown>>
    for (const record of records) {
      const supplierGstin = String(record.ctin ?? record.gstin ?? '')
      const invoices = (record.inv ?? []) as Array<Record<string, unknown>>
      for (const inv of invoices) {
        const items = (inv.itms ?? [inv]) as Array<Record<string, unknown>>
        let cgst = 0, sgst = 0, igst = 0, taxable = 0
        for (const item of items) {
          const detail = (item.itm_det ?? item) as Record<string, unknown>
          cgst += Number(detail.camt ?? 0)
          sgst += Number(detail.samt ?? 0)
          igst += Number(detail.iamt ?? 0)
          taxable += Number(detail.txval ?? 0)
        }
        const invNo = String(inv.inum ?? inv.invoice_number ?? '')
        const invDate = String(inv.dt ?? inv.inv_date ?? new Date().toISOString().slice(0, 10))
        const docType = String(inv.typ ?? 'invoice').toLowerCase()
        entries.push({
          supplier_gstin: supplierGstin,
          norm_supplier_gstin: normalizeGstin(supplierGstin),
          inv_no: invNo,
          inv_date: invDate,
          norm_inv_no: normalizeInvNo(invNo),
          taxable_value: taxable,
          cgst, sgst, igst,
          doc_type: (docType === 'cr' || docType === 'credit_note') ? 'credit_note'
            : (docType === 'dr' || docType === 'debit_note') ? 'debit_note'
            : 'invoice',
        })
      }
    }
  }

  return entries
}

export interface PurchaseRegisterEntry {
  supplier_gstin: string
  inv_no: string
  inv_date: string
  taxable_value: number
  cgst: number
  sgst: number
  igst: number
  is_rcm?: boolean
  doc_type?: string
}

export function parsePurchaseRegisterJson(json: Record<string, unknown>): PurchaseRegisterEntry[] {
  const rows = json.purchase_register
  if (!Array.isArray(rows)) return []
  return (rows as Array<Record<string, unknown>>).map(row => ({
    supplier_gstin: String(row.supplier_gstin ?? row.gstin ?? ''),
    inv_no: String(row.invoice_number ?? row.inv_no ?? ''),
    inv_date: String(row.invoice_date ?? row.inv_date ?? new Date().toISOString().slice(0, 10)),
    taxable_value: Number(row.taxable_value ?? 0),
    cgst: Number(row.cgst ?? 0),
    sgst: Number(row.sgst ?? 0),
    igst: Number(row.igst ?? 0),
    is_rcm: Boolean(row.is_rcm ?? false),
    doc_type: String(row.document_type ?? row.doc_type ?? 'invoice'),
  }))
}

export function parseGstr2bExcel(buffer: Buffer): Gstr2bEntry[] {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })

  return rows
    .filter(row => row['GSTIN of Supplier'] || row['Supplier GSTIN'])
    .map(row => {
      const gstin = String(row['GSTIN of Supplier'] ?? row['Supplier GSTIN'] ?? '')
      const invNo = String(row['Invoice Number'] ?? row['Invoice No'] ?? '')
      const invDate = String(row['Invoice Date'] ?? row['Inv Date'] ?? new Date().toISOString().slice(0, 10))
      return {
        supplier_gstin: gstin,
        norm_supplier_gstin: normalizeGstin(gstin),
        inv_no: invNo,
        inv_date: invDate,
        norm_inv_no: normalizeInvNo(invNo),
        taxable_value: Number(row['Taxable Value'] ?? row['Taxable Amount'] ?? 0),
        cgst: Number(row['Central Tax Amount'] ?? row['CGST'] ?? 0),
        sgst: Number(row['State/UT Tax Amount'] ?? row['SGST'] ?? 0),
        igst: Number(row['Integrated Tax Amount'] ?? row['IGST'] ?? 0),
        doc_type: 'invoice' as const,
      }
    })
}
