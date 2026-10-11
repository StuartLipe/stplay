import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  NOVIDADES,
  compararVersoes,
  formatarData,
  lerNovidadeVista,
  marcarNovidadeVista,
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

/*
 * A ENTRADA MAIS RECENTE NAO CARREGA VERSAO.
 *
 * Duas tentativas anteriores quebraram por causa desse campo, e as duas foram
 * minhas: `versao: '1.0.3'` digitado com o app em 1.0.2, e depois
 * `createRequire` lendo o `package.json` — que estoura no browser com
 * "Module node:module has been externalized".
 *
 * O rótulo da linha vem do app, por prop. Aqui o que se garante é que o dado NÃO
 * tem número para divergir, e que nenhuma entrada antiga duplica a data da
 * corrente.
 */
describe('a entrada mais recente nao tem versao propria', () => {
  test('a primeira entrada nao declara versao', () => {
    assert.equal(
      novidadesOrdenadas()[0].versao,
      undefined,
      'a entrada mais recente tem que usar a versao que o app informou',
    )
  })

  // Duas entradas com a mesma data (ou a mesma versão) fariam a página mostrar
  // duas linhas que a pessoa não consegue distinguir.
  test('nenhuma entrada se repete por data', () => {
    const vistas = new Set<string>()
    for (const n of NOVIDADES) {
      assert.equal(vistas.has(n.data), false, `entrada repetida: ${n.data}`)
      vistas.add(n.data)
    }
  })

  test('toda entrada tem area com rotulo e itens', () => {
    for (const n of NOVIDADES) {
      assert.ok(n.grupos.length > 0, `${n.data} sem nenhuma area`)
      for (const g of n.grupos) {
        assert.ok(g.nome.trim().length > 0, `${n.data} com area sem rotulo`)
        assert.ok(g.itens.length > 0, `${n.data} / ${g.nome} sem itens`)
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

  // A entrada mais recente descreve a versao instalada, entao o que decide e se a
  // versao do app e mais nova que a ultima lida. Sem lista nao ha o que avisar.
  test('lista vazia nao avisa', () => {
    assert.equal(temNovidadeNaoVista('1.0.2', null, []), false)
  })

  // Dev sem status carregado: sem numero nao ha o que comparar, e `false` e a
  // resposta honesta. Com `true` o ponto ficaria aceso para sempre.
  test('versao desconhecida nao avisa', () => {
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
