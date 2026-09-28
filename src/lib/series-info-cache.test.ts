import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  clearSeriesInfoCache,
  coalesceSeriesInfoLoad,
  peekSeriesInfoCache,
  seriesInfoCacheKey,
  setSeriesInfoCache,
} from './series-info-cache.ts'
import { usesPanelQueue } from './panel-queue.ts'

afterEach(() => {
  clearSeriesInfoCache()
})

test('cache key is per playlist and series', () => {
  assert.notEqual(seriesInfoCacheKey('p1', '10'), seriesInfoCacheKey('p2', '10'))
  assert.notEqual(seriesInfoCacheKey('p1', '10'), seriesInfoCacheKey('p1', '11'))
})

test('peek returns what was stored for that series', () => {
  const key = seriesInfoCacheKey('acc', '42')
  const info = { seasons: [{ season: 1, episodes: [] }] }
  setSeriesInfoCache(key, info)
  assert.equal(peekSeriesInfoCache(key), info)
})

test('peek misses another series', () => {
  setSeriesInfoCache(seriesInfoCacheKey('acc', '1'), { seasons: [] })
  assert.equal(peekSeriesInfoCache(seriesInfoCacheKey('acc', '2')), undefined)
})

test('coalesce in-flight loads so two clicks share one fetch', async () => {
  let started = 0
  const key = seriesInfoCacheKey('acc', '7')
  const slow = () => {
    started += 1
    return new Promise((resolve) => setTimeout(() => resolve({ seasons: [{ season: 1, episodes: [] }] }), 30))
  }
  const [a, b] = await Promise.all([coalesceSeriesInfoLoad(key, slow), coalesceSeriesInfoLoad(key, slow)])
  assert.equal(started, 1)
  assert.equal(a, b)
})

test('get_vod_info and get_series_info skip the catalog panel queue', () => {
  const vod = 'http://panel.example/player_api.php?action=get_vod_info&vod_id=1'
  const series = 'http://panel.example/player_api.php?action=get_series_info&series_id=1'
  assert.equal(usesPanelQueue(vod), false)
  assert.equal(usesPanelQueue(series), false)
})

test('priority also skips the catalog panel queue', () => {
  const url = 'http://panel.example/player_api.php?action=get_series_info&series_id=1'
  assert.equal(usesPanelQueue(url, { priority: true }), false)
})

test('catalog dumps still use the panel queue', () => {
  assert.equal(usesPanelQueue('http://panel.example/player_api.php?action=get_series'), true)
})
