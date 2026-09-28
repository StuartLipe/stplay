import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Channel } from '../types.ts'
import {
  filterGamesAreaLiveChannels,
  isGamesAreaGroup,
  isGamesHubChannel,
} from './games-area.ts'

function ch(name: string): Channel {
  return { id: name, name, url: 'http://x', kind: 'live', group: 'ÁREA DE JOGOS' }
}

describe('games-area', () => {
  test('detects games area group', () => {
    assert.equal(isGamesAreaGroup('ÁREA DE JOGOS'), true)
    assert.equal(isGamesAreaGroup('PREMIERE'), false)
  })

  test('keeps only JOGOS DE HOJE hub like Player One', () => {
    const channels = [
      ch('JOGOS DE HOJE'),
      ch('[16:00H] FLU X PAL'),
      ch('[18:30H] COR X VAS'),
    ]
    assert.equal(isGamesHubChannel(channels[0]), true)
    const filtered = filterGamesAreaLiveChannels(channels, 'ÁREA DE JOGOS')
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0]?.name, 'JOGOS DE HOJE')
  })

  test('without hub hides scheduled rows', () => {
    const channels = [ch('[16:00H] A X B'), ch('[18:00H] C X D')]
    const filtered = filterGamesAreaLiveChannels(channels, 'ÁREA DE JOGOS')
    assert.equal(filtered.length, 0)
  })
})
