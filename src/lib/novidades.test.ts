import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'

import {
  NOVIDADES,
  VERSAO_APP,
  compararVersoes,
  formatarData,
  lerNovidadeVista,
  marcarNovidadeVista,
  novidadeDaVersao,
  novidadesOrdenadas,
  temNovidadeNaoVista,
  type Novidade,
} from './novidades.ts'

const notas: Novidade[] = [
  { versao: '1.0.9', data: '2026-01-09', grupos: [{ nome: 'a', itens: ['nove'] }] },
  { versao: '1.0.10', data: '2026-01-10', grupos: [{ nome: 'a', itens: ['dez'] }] },
  { versao: '1.0.2', data: '2026-01-02', grupos: [{ nome: 'a', itens: ['dois'] }] },
]

describe('compararVersoes', () => {
  test('ordena por segmento numerico, nao por alfabeto', () => {
    // A razao de o helper existir: em string, "1.0.10" < "1.0.9".
    assert.equal(compararVersoes('1.0.10', '1.0.9'), 1)
    assert.equal(compararVersoes('1.0.9', '1.0.10'), -1)
    assert.equal(compararVersoes('1.0.3', '1.0.3'), 0)
  })

  test('segmento ausente conta como zero', () => {
    assert.equal(compararVersoes('1.0', '1.0.0'), 0)
    assert.equal(compararVersoes('1.1', '1.0.9'), 1)
  })

  test('sufixo nao numerico vira zero em vez de NaN', () => {
    assert.equal(compararVersoes('1.0.3-beta', '1.0.3'), 0)
    assert.equal(Number.isNaN(compararVersoes('1.0.3-beta', '1.0.3')), false)
  })
})

describe('novidadesOrdenadas', () => {
  test('mais nova primeiro e sem mutar a entrada', () => {
    const original = notas.map((n) => n.versao)
    assert.deepEqual(
      novidadesOrdenadas(notas).map((n) => n.versao),
      ['1.0.10', '1.0.9', '1.0.2'],
    )
    assert.deepEqual(
      notas.map((n) => n.versao),
      original,
    )
  })
})

describe('novidadeDaVersao', () => {
  test('acha a nota da versao e devolve null quando nao ha', () => {
    assert.equal(novidadeDaVersao('1.0.2', notas)?.grupos[0].itens[0], 'dois')
    assert.equal(novidadeDaVersao('9.9.9', notas), null)
  })
})

// A NOTA TEM QUE SER A VERSAO DO APP. Este teste existe porque a primeira versao
// desta lista foi escrita a mao como '1.0.3' com o app em '1.0.2', e a tela
// mostrou "1.0.3" no topo enquanto marcava "instalada" na nota antiga. Ler o
// numero de um lugar so e comparar contra o package.json fecha a porta.
describe('a nota mais recente e a versao do app', () => {
  test('bate com o package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'))
    assert.equal(VERSAO_APP, pkg.version)
    assert.equal(novidadesOrdenadas()[0].versao, pkg.version)
  })

  // A politica e uma versao so, substituivel a cada build. Duas notas da mesma
  // versao fariam a pagina mostrar a mesma versao duas vezes, e a pessoa nao saberia
  // qual delas e a desta instalacao.
  test('nao ha duas notas da mesma versao', () => {
    const vistas = new Set<string>()
    for (const n of NOVIDADES) {
      assert.equal(vistas.has(n.versao), false, `nota repetida: ${n.versao}`)
      vistas.add(n.versao)
    }
  })

  test('toda nota tem area com rotulo e itens', () => {
    for (const n of NOVIDADES) {
      assert.ok(n.grupos.length > 0, `${n.versao} sem nenhuma area`)
      for (const g of n.grupos) {
        assert.ok(g.nome.trim().length > 0, `${n.versao} com area sem rotulo`)
        assert.ok(g.itens.length > 0, `${n.versao} / ${g.nome} sem itens`)
      }
    }
  })

  test('o rotulo e uma frase, nao um titulo solto', () => {
    // O dono pediu o rotulo por extenso ("Mudanças no player"). Um "Player" seco
    // obrigaria a pessoa a adivinhar o que ali tem.
    for (const n of NOVIDADES) {
      for (const g of n.grupos) assert.ok(g.nome.split(' ').length >= 2, `"${g.nome}" esta solto`)
    }
  })
})

describe('temNovidadeNaoVista', () => {
  // A lista entra pelo parametro: a constante `NOVIDADES` so tem 1.0.3 e 1.0.2, e
  // o caso que importa aqui e 1.0.10 contra 1.0.9 — que nao existe na vida real.
  test('sem nada visto, avisa', () => {
    assert.equal(temNovidadeNaoVista('1.0.2', null, notas), true)
  })

  test('versao vista nao avisa de novo', () => {
    assert.equal(temNovidadeNaoVista('1.0.2', '1.0.2', notas), false)
  })

  test('pulou de 1.0.2 para 1.0.10: avisa, e o segmento numerico decide', () => {
    assert.equal(temNovidadeNaoVista('1.0.10', '1.0.2', notas), true)
    assert.equal(temNovidadeNaoVista('1.0.9', '1.0.10', notas), false)
  })

  // Sem isto o ponto fica aceso para sempre em dev: o app de desenvolvimento
  // roda a versao do package.json, que nem sempre tem nota escrita.
  test('versao sem nota nao avisa', () => {
    assert.equal(temNovidadeNaoVista('9.9.9', null, notas), false)
    assert.equal(temNovidadeNaoVista(null, null, notas), false)
  })
})

/**
 * `localStorage` nao existe no node. O codigo de produto trata a ausencia (devolve
 * `null` em vez de estourar), e estes testes montam um duble para cobrir o resto.
 * A property e trocada e devolvida porque os testes do arquivo correm no mesmo
 * processo, e um duble vazado deixaria o resto mentindo.
 */
function comStorage<T>(fn: () => T, armadilha?: 'leitura' | 'escrita'): T {
  const alvo = globalThis as unknown as { localStorage?: unknown }
  const antes = alvo.localStorage
  const mapa = new Map<string, string>()
  alvo.localStorage = {
    getItem: (k: string) => {
      if (armadilha === 'leitura') throw new Error('storage bloqueado')
      return mapa.get(k) ?? null
    },
    setItem: (k: string, v: string) => {
      if (armadilha === 'escrita') throw new Error('storage bloqueado')
      mapa.set(k, v)
    },
    removeItem: (k: string) => mapa.delete(k),
    clear: () => mapa.clear(),
  }
  try {
    return fn()
  } finally {
    if (antes === undefined) delete alvo.localStorage
    else alvo.localStorage = antes
  }
}

describe('estado do "ja li ate aqui"', () => {
  test('marcar e ler fazem ida e volta', () => {
    comStorage(() => {
      marcarNovidadeVista('1.0.3')
      assert.equal(lerNovidadeVista(), '1.0.3')
      assert.equal(temNovidadeNaoVista('1.0.3', lerNovidadeVista()), false)
    })
  })

  // A chave e uma string, nao um numero: `Number("1.0.10")` e NaN e
  // `Number("9")`/`Number("10")` comparam como inteiro. O estado tem de
  // sobreviver a um ciclo de boot com a versao em 1.0.10.
  test('guarda como string para nao perder o patch', () => {
    comStorage(() => {
      marcarNovidadeVista('1.0.10')
      assert.equal(lerNovidadeVista(), '1.0.10')
      assert.equal(Number.isNaN(Number(lerNovidadeVista())), true)
    })
  })

  // Sem isto a pagina inteira quebra em modo privado / storage bloqueado, que e
  // justo a configuracao em que a pessoa menos pode perder o app.
  test('storage bloqueado nao derruba nem a leitura nem a escrita', () => {
    assert.equal(comStorage(() => lerNovidadeVista(), 'leitura'), null)
    comStorage(
      () => marcarNovidadeVista('1.0.3'),
      'escrita',
    )
  })

  // E o caso de verdade no node: `globalThis.localStorage` nem existe. O `?.`
  // no acesso e o que evita `TypeError` e devolve `null`.
  test('sem localStorage no ambiente, ler devolve null e marcar nao lanca', () => {
    assert.equal(lerNovidadeVista(), null)
    marcarNovidadeVista('1.0.3')
  })
})

describe('formatarData', () => {
  test('formata ISO em portugues', () => {
    assert.equal(formatarData('2026-10-04'), '4 de outubro de 2026')
    assert.equal(formatarData('2026-01-01'), '1 de janeiro de 2026')
  })

  test('entrada invalida volta como veio, sem estourar', () => {
    assert.equal(formatarData('lixo'), 'lixo')
  })
})
