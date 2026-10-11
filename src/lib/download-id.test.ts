import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  capDownloads,
  downloadIdFor,
  downloadIdScope,
  isLegacyDownloadId,
  reconcileDownloads,
  sameDownloadTarget,
  withoutDownloadTarget,
} from './download-id.ts'
import type { DownloadedItem } from '../types.ts'

function item(patch: Partial<DownloadedItem>): DownloadedItem {
  return {
    id: 'x',
    name: 'n',
    kind: 'movie',
    url: 'http://p/movie/1.mp4',
    date: '01/01/2026',
    ...patch,
  }
}

describe('downloadIdFor', () => {
  it('namespaca pelo painel: o mesmo id em dois paineis da ids diferentes', () => {
    const a = downloadIdFor('panelA', 'movie', 'vod-5000')
    const b = downloadIdFor('panelB', 'movie', 'vod-5000')
    assert.notEqual(a, b)
  })

  it('mantem o id estavel para o mesmo painel e o mesmo conteudo', () => {
    assert.equal(downloadIdFor('p', 'movie', 'vod-1'), downloadIdFor('p', 'movie', 'vod-1'))
  })

  it('separa filme de serie com o mesmo numero', () => {
    // `vod-5000` e `ep-5000` nao colidiam ja, mas o namespace do tipo impede
    // que o id passe a ser so o numero cru.
    assert.notEqual(downloadIdFor('p', 'movie', '5000'), downloadIdFor('p', 'series', '5000'))
  })

  it('recusa sem playlistId em vez de inventar um namespace', () => {
    assert.equal(downloadIdFor(undefined, 'movie', 'vod-1'), null)
    assert.equal(downloadIdFor('', 'movie', 'vod-1'), null)
    assert.equal(downloadIdFor('   ', 'movie', 'vod-1'), null)
  })

  it('recusa sem rawId', () => {
    assert.equal(downloadIdFor('p', 'movie', undefined), null)
    assert.equal(downloadIdFor('p', 'movie', ''), null)
  })

  it('ignora espacos nas pontas', () => {
    assert.equal(downloadIdFor(' p ', 'movie', ' vod-1 '), 'dl:p:movie:vod-1')
  })
})

describe('downloadIdScope', () => {
  it('faz o caminho completo pela volta', () => {
    assert.deepEqual(downloadIdScope('dl:panelA:movie:vod-5000'), {
      playlistId: 'panelA',
      kind: 'movie',
      rawId: 'vod-5000',
    })
  })

  it('aceita um rawId que contenha dois-pontos', () => {
    assert.equal(downloadIdScope('dl:p:movie:a:b')?.rawId, 'a:b')
  })

  it('devolve null para o id legado do 1.0.6', () => {
    assert.equal(downloadIdScope('vod-5000'), null)
    assert.equal(downloadIdScope('ep-456'), null)
  })

  it('devolve null para nao-canonicos', () => {
    assert.equal(downloadIdScope(undefined), null)
    assert.equal(downloadIdScope(''), null)
    assert.equal(downloadIdScope('dl:p:filme:1'), null)
  })
})

describe('isLegacyDownloadId', () => {
  it('separa o legado do canonico', () => {
    assert.equal(isLegacyDownloadId('vod-5000'), true)
    assert.equal(isLegacyDownloadId('dl:p:movie:vod-5000'), false)
  })
})

describe('sameDownloadTarget', () => {
  it('trata o legado e o canonico do mesmo item como iguais', () => {
    // Sem isso, o primeiro retry depois da atualizacao duplicaria a linha.
    assert.equal(
      sameDownloadTarget({ id: 'vod-5000', url: 'http://p/movie/5000.mp4' }, {
        id: 'dl:panelA:movie:vod-5000',
        url: 'http://p/movie/5000.mp4',
      }),
      true,
    )
  })

  it('separa o mesmo id de catalogo em paineis diferentes', () => {
    const a = item({ id: downloadIdFor('panelA', 'movie', 'vod-5000')!, url: 'http://a/5000.mp4' })
    const b = item({ id: downloadIdFor('panelB', 'movie', 'vod-5000')!, url: 'http://b/5000.mp4' })
    assert.equal(sameDownloadTarget(a, b), false)
  })

  it('separa quando so o id coincide mas a url nao', () => {
    // Dois paineis podem servir o VOD 5000 com a MESMA url (host comum). O id
    // e o que define a identidade; a url sozinha nao pode unir dois downloads
    // de owners diferentes.
    const a = item({ id: downloadIdFor('panelA', 'movie', 'vod-5000')! })
    const b = item({ id: downloadIdFor('panelB', 'movie', 'vod-5000')! })
    assert.equal(sameDownloadTarget(a, b), false)
  })

  it('aceita a mesma url com o id legado de um lado', () => {
    assert.equal(
      sameDownloadTarget({ id: 'vod-1', url: 'http://p/1.mp4' }, { id: 'outro', url: 'http://p/1.mp4' }),
      true,
    )
  })

  it('devolve false para ausencias, sem estourar', () => {
    assert.equal(sameDownloadTarget(null, item({})), false)
    assert.equal(sameDownloadTarget(item({}), undefined), false)
    assert.equal(sameDownloadTarget(item({}), null), false)
  })
})

describe('withoutDownloadTarget', () => {
  it('remove so o alvo e preserva o resto', () => {
    const alvo = item({ id: downloadIdFor('p', 'movie', 'vod-1')!, url: 'http://p/1.mp4' })
    const lista = [
      alvo,
      item({ id: downloadIdFor('p', 'movie', 'vod-2')!, url: 'http://p/2.mp4' }),
      item({ id: downloadIdFor('q', 'movie', 'vod-1')!, url: 'http://q/1.mp4' }),
    ]
    const out = withoutDownloadTarget(lista, alvo)
    assert.equal(out.length, 2)
    assert.ok(out.every((d) => d.id !== alvo.id))
  })

  it('remove o legado pelo mesmo alvo', () => {
    const lista = [item({ id: 'vod-1', url: 'http://p/1.mp4' }), item({ id: 'vod-2', url: 'http://p/2.mp4' })]
    const out = withoutDownloadTarget(lista, { id: 'dl:p:movie:vod-1', url: 'http://p/1.mp4' })
    assert.equal(out.length, 1)
    assert.equal(out[0].id, 'vod-2')
  })

  it('devolve a lista intacta quando o alvo nao esta nela', () => {
    const lista = [item({ id: 'vod-1', url: 'http://p/1.mp4' })]
    assert.equal(withoutDownloadTarget(lista, { id: 'outro', url: 'http://z/9.mp4' }).length, 1)
  })
})

describe('reconcileDownloads', () => {
  // O cenario do defeito: fechar o app no meio de um download deixava a linha
  // presa em `downloading` para sempre. O processo principal nao tinha o job, o
  // cabecalho contava "1 ativo" para sempre, e Pausar/Continuar resolviam
  // contra um Map vazio.
  it('converte o zumbi de downloading em item retryavel', () => {
    const antes = [
      item({ id: 'dl:p:movie:vod-1', status: 'downloading', speed: 3_000_000, received: 40_000_000, total: 100_000_000 }),
    ]
    const depois = reconcileDownloads(antes)

    assert.equal(depois[0].status, 'error')
    assert.equal(depois[0].speed, 0, 'a velocidade de um processo morto e mentira')
    assert.match(String(depois[0].error), /Tente de novo/, 'a mensagem precisa dizer o que fazer')
  })

  it('converte o zumbi de queued tambem', () => {
    const depois = reconcileDownloads([item({ id: 'a', status: 'queued' })])
    assert.equal(depois[0].status, 'error')
  })

  it('preserva os bytes ja recebidos, para o retry poder retomar a conta', () => {
    const depois = reconcileDownloads([
      item({ id: 'a', status: 'downloading', received: 40_000_000, total: 100_000_000 }),
    ])
    assert.equal(depois[0].received, 40_000_000)
    assert.equal(depois[0].total, 100_000_000)
  })

  it('nao mexe em concluido, pausado nem em erro', () => {
    const lista = [
      item({ id: 'a', status: 'completed', filePath: 'C:/x.mp4' }),
      item({ id: 'b', status: 'paused', received: 10 }),
      item({ id: 'c', status: 'error', error: 'Falha ao baixar' }),
      item({ id: 'd' }),
    ]
    assert.equal(reconcileDownloads(lista), lista, 'mesma referencia: nao ha o que gravar')
    assert.deepEqual(
      lista.map((d) => d.status),
      ['completed', 'paused', 'error', undefined],
    )
  })

  it('devolve a mesma referencia quando a lista esta limpa', () => {
    // Sem isso, o efeito de boot gravaria no localStorage a cada mount mesmo
    // sem nenhuma mudanca.
    const lista = [item({ id: 'a', status: 'completed' })]
    assert.equal(reconcileDownloads(lista), lista)
    assert.equal(reconcileDownloads([]).length, 0)
  })

  it('nao apaga a linha: o zumbi vira retryavel, nao desaparece', () => {
    const antes = [item({ id: 'a', status: 'downloading' })]
    assert.equal(reconcileDownloads(antes).length, 1)
  })

  it('depois de reconciliado, o retry substitui a linha em vez de duplicar', () => {
    // Fecha o circulo com o caminho real do App.tsx:
    //   setDownloads((prev) => [pending, ...withoutDownloadTarget(prev, pending)])
    // O prev e a lista JA reconciliada; o retry reaproveita o item dela. O
    // resultado tem de ter uma linha, nao duas com o mesmo id.
    const antes = [item({ id: 'dl:p:movie:vod-1', status: 'downloading' })]
    const prev = reconcileDownloads(antes)
    const pending = {
      ...prev[0],
      status: 'downloading' as const,
      received: 0,
      total: 0,
      error: undefined,
      filePath: undefined,
    }
    const lista = [pending, ...withoutDownloadTarget(prev, pending)]
    assert.equal(lista.length, 1)
    assert.equal(lista[0].status, 'downloading')
    assert.equal(lista[0].error, undefined, 'o erro da tentativa antiga nao sobrevive ao retry')
  })

  it('o zumbi reconciliado nao apaga o download de outro painel', () => {
    // As duas linhas so diferem no namespace do painel. A reconciliacao mexe no
    // status das duas, mas o retry de uma jamais pode remover a outra.
    const zumbi = item({ id: 'dl:panelA:movie:vod-1', status: 'downloading' })
    const outroPainel = item({ id: 'dl:panelB:movie:vod-1', status: 'downloading' })
    const prev = reconcileDownloads([zumbi, outroPainel])
    const pending = { ...prev[0], status: 'downloading' as const, error: undefined }
    const lista = [pending, ...withoutDownloadTarget(prev, pending)]
    assert.equal(lista.length, 2, 'o download do outro painel continua na lista')
    assert.equal(lista[1].id, 'dl:panelB:movie:vod-1')
  })
})

describe('capDownloads', () => {
  it('preserva os mais recentes', () => {
    const lista = Array.from({ length: 150 }, (_, i) => item({ id: `id-${i}` }))
    const out = capDownloads(lista, 100)
    assert.equal(out.length, 100)
    assert.equal(out[0].id, 'id-0', 'a lista cresce para o fim, entao o comeco e o mais antigo')
    assert.equal(out[99].id, 'id-99')
  })

  it('devolve a mesma referencia quando cabe', () => {
    const lista = [item({ id: 'a' })]
    assert.equal(capDownloads(lista, 100), lista)
  })

  it('tem 100 como padrao', () => {
    assert.equal(capDownloads(Array.from({ length: 101 }, (_, i) => item({ id: `i${i}` }))).length, 100)
    assert.equal(capDownloads(Array.from({ length: 100 }, (_, i) => item({ id: `i${i}` }))).length, 100)
  })

  it('a lista resultant cabe na cota mesmo com mensagens longas', () => {
    // O motivo do teto e cota do localStorage. Um item de download carrega nome,
    // logo (data URL) e mensagem de erro; 100 deles com capa grande estoura.
    const pesado = item({ id: 'a', logo: 'data:image/jpeg;base64,' + 'A'.repeat(40_000) })
    const lista = Array.from({ length: 140 }, (_, i) => ({ ...pesado, id: `i${i}` }))
    const json = JSON.stringify(capDownloads(lista))
    // localStorage costuma ter ~5 MB por origem.
    assert.ok(json.length < 5_000_000, `serializado ficou em ${json.length} bytes`)
  })
})
