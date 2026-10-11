import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveLastPlaylistId, shouldRestoreLastSession } from './last-playlist.ts'

test('keeps last used playlist instead of the first one', () => {
  assert.equal(resolveLastPlaylistId(['ff', 'felipe'], 'felipe'), 'felipe')
})

test('falls back to first playlist when saved id is missing', () => {
  assert.equal(resolveLastPlaylistId(['ff', 'felipe'], null), 'ff')
})

test('prefers profile lastPlaylistId', () => {
  assert.equal(resolveLastPlaylistId(['ff', 'felipe'], 'ff', 'felipe'), 'felipe')
})

test('ignores ids that are not in the profile', () => {
  assert.equal(resolveLastPlaylistId(['ff'], 'felipe', 'gone'), 'ff')
})

test('restores session when last profile still exists', () => {
  assert.equal(shouldRestoreLastSession('p1', ['p1', 'p2']), true)
  assert.equal(shouldRestoreLastSession('gone', ['p1']), false)
  assert.equal(shouldRestoreLastSession(null, ['p1']), false)
})
