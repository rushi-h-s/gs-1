// Agent tool schemas — adapted to the match_results / recon_run schema.
// The LLM never touches matching logic; it only reads rows the engine produced.

export const agentTools = [
  {
    type: 'function',
    function: {
      name: 'explain_mismatch',
      description:
        'Fetch a specific invoice break from the reconciliation results and explain why it is mismatched, probable, or missing on one side.',
      parameters: {
        type: 'object',
        properties: {
          invoice_no: { type: 'string', description: 'The invoice number to look up (normalised form ok)' },
        },
        required: ['invoice_no'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_vendor_email',
      description:
        'Fetch the break details for an invoice so a professional follow-up email to the vendor can be drafted.',
      parameters: {
        type: 'object',
        properties: {
          invoice_no: { type: 'string' },
          vendor_gstin: { type: 'string' },
          mismatch_type: {
            type: 'string',
            enum: ['MISMATCH', 'PROBABLE', 'BOOKS_ONLY', 'TWOB_ONLY'],
          },
        },
        required: ['invoice_no', 'vendor_gstin', 'mismatch_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarise_reconciliation',
      description:
        'Return bucket-level counts plus run totals (auto-matched %, open breaks, ITC at risk) for a client and period.',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', description: 'Period in YYYY-MM format' },
        },
        required: ['period'],
      },
    },
  },
]
