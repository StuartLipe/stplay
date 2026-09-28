import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  clearVodInfoCache,
  coalesceVodInfoLoad,
  peekVodInfoCache,
  setVodInfoCache,
  vodInfoCacheKey,
} from './vod-info-cache.ts'
import { playSrc } from './proxy.ts'

afterEach(() => {
  clearVodInfoCache()
  delete (globalThis as { window?: unknown }).window
})

test('vod info cache key is per playlist and vod id', () => {
  assert.notEqual(vodInfoCacheKey('p1', '10'), vodInfoCacheKey('p2', '10'))
  assert.notEqual(vodInfoCacheKey('p1', '10'), vodInfoCacheKey('p1', '11'))
})

test('coalesce in-flight vod info loads', async () => {
  let started = 0
  const key = vodInfoCacheKey('acc', '7')
  const slow = () => {
    started += 1
    return new Promise((resolve) => setTimeout(() => resolve({ name: 'Film' }), 30))
  }
  const [a, b] = await Promise.all([coalesceVodInfoLoad(key, slow), coalesceVodInfoLoad(key, slow)])
  assert.equal(started, 1)
  assert.equal(a, b)
})

test('peek returns stored vod info', () => {
  const key = vodInfoCacheKey('acc', '42')
  const info = { name: 'Test' }
  setVodInfoCache(key, info)
  assert.equal(peekVodInfoCache(key), info)
})

test('playSrc uses /proxy for hls manifests in electron', () => {
  ;(globalThis as { window?: { sturplay?: { proxyBase: string } } }).window = {
    sturplay: { proxyBase: 'http://127.0.0.1:54321/proxy' },
  }
  const url = 'http://cdn.example/live/123.m3u8'
  assert.equal(playSrc(url), `http://127.0.0.1:54321/proxy?url=${encodeURIComponent(url)}`)
})

test('playSrc uses /stream endpoint in electron for media urls', () => {
  ;(globalThis as { window?: { sturplay?: { proxyBase: string } } }).window = {
    sturplay: { proxyBase: 'http://127.0.0.1:54321/proxy' },
  }
  const url = 'http://cdn.example/movie/123.mp4'
  assert.equal(playSrc(url), `http://127.0.0.1:54321/stream?u=${encodeURIComponent(url)}`)
})

test('playSrc keeps /proxy for panel api urls in electron', () => {
  ;(globalThis as { window?: { sturplay?: { proxyBase: string } } }).window = {
    sturplay: { proxyBase: 'http://127.0.0.1:54321/proxy' },
  }
  const url = 'http://panel.example/player_api.php?action=get_vod_info&vod_id=1'
  assert.equal(playSrc(url), `http://127.0.0.1:54321/proxy?url=${encodeURIComponent(url)}`)
})

test('playSrc uses vite proxy in browser dev', () => {
  delete (globalThis as { window?: unknown }).window
  const url = 'http://cdn.example/movie/123.mp4'
  assert.equal(playSrc(url), `/api/proxy?url=${encodeURIComponent(url)}`)
})
