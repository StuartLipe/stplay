import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canPersistCatalog } from './catalog-owner.ts'

test('blocks persisting the previous playlist onto the new one', () => {
  assert.equal(canPersistCatalog(null, 'felipe'), false)
  assert.equal(canPersistCatalog('ff', 'felipe'), false)
  assert.equal(canPersistCatalog('felipe', 'felipe'), true)
})
