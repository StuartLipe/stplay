const assert = require('node:assert/strict')
const { test } = require('node:test')
const { shouldPreResolveRedirect, shouldTryHttpFallback, liveEdgeSeekArgs, liveStopWaitMs, liveConnReleaseMs, liveStreamLavfO } = require('./live-load-policy.cjs')

test('live never pre-resolves redirects (One loadfile portal URL)', () => {
  assert.equal(shouldPreResolveRedirect('https://panel.example/live/u/p/1.m3u8', true), false)
  assert.equal(shouldPreResolveRedirect('https://panel.example/live/u/p/1.ts', true), false)
})

test('VOD mp4 still pre-resolves (CDN 302 + token)', () => {
  assert.equal(shouldPreResolveRedirect('https://panel.example/movie/u/p/1.mp4', false), true)
})

test('HLS playlist is never pre-resolved', () => {
  assert.equal(shouldPreResolveRedirect('https://panel.example/movie/u/p/1.m3u8', false), false)
})

test('live skips http proxy fallback', () => {
  assert.equal(shouldTryHttpFallback(true), false)
  assert.equal(shouldTryHttpFallback(false), true)
})

test('live edge seek is 100% not 1s from window start', () => {
  assert.deepEqual(liveEdgeSeekArgs(), [100, 'absolute-percent'])
})

test('1-tela zap waits for stop then a short release', () => {
  assert.equal(liveStopWaitMs() > 0, true)
  assert.equal(liveConnReleaseMs() > 0, true)
})

test('live stream lavf disables reconnect during slot release', () => {
  assert.match(liveStreamLavfO(true), /reconnect=1/)
  assert.match(liveStreamLavfO(false), /reconnect=0/)
  assert.doesNotMatch(liveStreamLavfO(false), /reconnect_streamed=1/)
})
