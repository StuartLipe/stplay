const assert = require('node:assert/strict')
const { test } = require('node:test')
const { vodUrlVariants } = require('./vod-url-variants.cjs')

test('keeps current extension first and adds common vod fallbacks', () => {
  assert.deepEqual(vodUrlVariants('http://cdn.example/movie/u/p/10.mp4'), [
    'http://cdn.example/movie/u/p/10.mp4',
    'http://cdn.example/movie/u/p/10.mkv',
    'http://cdn.example/movie/u/p/10.avi',
    'http://cdn.example/movie/u/p/10.ts',
  ])
})

test('works for series urls on any host', () => {
  const variants = vodUrlVariants('https://any.panel:443/series/u/p/99.mkv')
  assert.equal(variants[0], 'https://any.panel:443/series/u/p/99.mkv')
  assert.ok(variants.includes('https://any.panel:443/series/u/p/99.mp4'))
})
