// Turns a JSON array of invoice data (e.g. from ChatGPT) into real PDF files
// for testing the upload/extraction pipeline.
//
// Setup:   npm install pdfkit --save-dev
// Usage:   node scripts/gen-invoices.js invoices.json ./test-invoices

const fs = require('fs')
const path = require('path')
const PDFDocument = require('pdfkit')

const [, , inputPath = 'invoices.json', outDir = './test-invoices'] = process.argv
const invoices = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
fs.mkdirSync(outDir, { recursive: true })

for (const inv of invoices) {
  const safeName = String(inv.invoice_number).replace(/[\/\\]/g, '_')
  const doc = new PDFDocument({ margin: 50 })
  doc.pipe(fs.createWriteStream(path.join(outDir, `${safeName}.pdf`)))

  doc.fontSize(16).text(inv.supplier_name ?? 'Supplier')
  doc.fontSize(10).text(inv.supplier_address ?? '')
  doc.moveDown()
  doc.fontSize(12).text('TAX INVOICE', { align: 'center', underline: true })
  doc.moveDown()

  doc.fontSize(10)
  doc.text(`Invoice No: ${inv.invoice_number}`)
  doc.text(`Date: ${inv.invoice_date}`)
  doc.text(`GSTIN: ${inv.supplier_gstin}`)
  doc.moveDown()

  for (const item of inv.items ?? []) {
    doc.text(`${item.description}  x${item.qty}  @ Rs ${Number(item.rate).toFixed(2)} = Rs ${Number(item.amount).toFixed(2)}`)
  }
  doc.moveDown()

  // These exact labels match both the LLM prompt and the regex fallback extractor —
  // keep this format so extraction works even if the AI providers are unavailable.
  doc.text(`Taxable Value: Rs ${Number(inv.taxable_value).toFixed(2)}`)
  if (inv.cgst) doc.text(`CGST: Rs ${Number(inv.cgst).toFixed(2)}`)
  if (inv.sgst) doc.text(`SGST: Rs ${Number(inv.sgst).toFixed(2)}`)
  if (inv.igst) doc.text(`IGST: Rs ${Number(inv.igst).toFixed(2)}`)

  const total = Number(inv.taxable_value) + Number(inv.cgst ?? 0) + Number(inv.sgst ?? 0) + Number(inv.igst ?? 0)
  doc.moveDown(0.5).fontSize(11).text(`Total: Rs ${total.toFixed(2)}`, { underline: true })

  doc.end()
  console.log('wrote', `${safeName}.pdf`)
}
