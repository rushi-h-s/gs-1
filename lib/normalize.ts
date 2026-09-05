export function normalizeGstin(gstin: string): string {
  return gstin.replace(/\s+/g, '').toUpperCase()
}

export function normalizeInvNo(invNo: string): string {
  // strip spaces, uppercase, remove leading zeros from numeric parts
  return invNo.replace(/\s+/g, '').toUpperCase().replace(/^0+/, '')
}

// Basic GSTIN checksum validation (15-char format check)
export function validateGstin(gstin: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin)
}
