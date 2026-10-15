import crypto from 'crypto'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILES = 50
export const MAX_JSON_INVOICES = 500   // rows a single .json upload may expand into

// First bytes of each allowed type. JSON/CSV have no magic number; they're size-capped only.
const MAGIC: Record<string, number[][]> = {
  pdf:  [[0x25, 0x50, 0x44, 0x46]],
  png:  [[0x89, 0x50, 0x4e, 0x47]],
  jpg:  [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  tiff: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]],
  json: [],
  csv:  [],
}

/** Returns an error message, or null if every file is acceptable. `allowed` = extensions. */
export async function checkFiles(files: File[], allowed: string[]): Promise<string | null> {
  if (files.length > MAX_FILES) return `Too many files (max ${MAX_FILES})`
  for (const f of files) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    if (!allowed.includes(ext)) return `${f.name}: unsupported type (allowed: ${allowed.join(', ')})`
    if (f.size > MAX_FILE_BYTES) return `${f.name}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`
    const sigs = MAGIC[ext] ?? []
    if (sigs.length) {
      const head = new Uint8Array(await f.slice(0, 4).arrayBuffer())
      if (!sigs.some(s => s.every((b, i) => head[i] === b))) return `${f.name}: content does not match .${ext}`
    }
  }
  return null
}

// ponytail: in-process fixed window — correct for the single-replica deploy only;
// move to Postgres/Redis when running >1 replica.
const hits = new Map<string, { n: number; reset: number }>()

/** True if the call is allowed. */
export function rateLimit(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now()
  const h = hits.get(key)
  if (!h || now > h.reset) {
    if (hits.size > 10_000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k)
    hits.set(key, { n: 1, reset: now + windowMs })
    return true
  }
  return ++h.n <= max
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}
