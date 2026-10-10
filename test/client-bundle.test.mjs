import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

test('generated client keeps the factory contract', () => {
  assert.match(src, /Do not edit by hand/)
  assert.match(src, /id: 'dsh-claw-gate'/)
  assert.match(src, /inject = \['slots', 'locale'\]/)
  assert.match(src, /return module\.exports/)
  assert.match(src, /settings\.section/)
  assert.match(src, /nav: '审计'/)
  assert.match(src, /exportJson: '导出 JSONL'/)
  assert.match(src, /emptyFilter: '没有符合筛选的记录'/)
  assert.match(src, /function filterAudit/)
  assert.match(src, /data-dag-pick/)
})
