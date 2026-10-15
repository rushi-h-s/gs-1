import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFiles, rateLimit, safeEqual, MAX_FILE_BYTES, MAX_FILES } from '../../lib/limits.ts'

const pdf = (name = 'a.pdf') => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name)

test('checkFiles accepts a real pdf', async () => {
  assert.equal(await checkFiles([pdf()], ['pdf']), null)
})

test('checkFiles rejects wrong extension, spoofed content, oversize, too many', async () => {
  assert.match((await checkFiles([pdf('a.exe')], ['pdf']))!, /unsupported/)
  assert.match((await checkFiles([new File(['hello'], 'a.pdf')], ['pdf']))!, /does not match/)
  assert.match((await checkFiles([new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'a.json')], ['json']))!, /larger/)
  assert.match((await checkFiles(Array.from({ length: MAX_FILES + 1 }, () => pdf()), ['pdf']))!, /Too many/)
})

test('rateLimit blocks after max within the window', () => {
  const k = `t-${Math.random()}`
  assert.deepEqual([1, 2, 3, 4].map(() => rateLimit(k, 3)), [true, true, true, false])
})

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('', 'abc'), false)
})
