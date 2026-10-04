import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Channel } from './types'
import type { HiddenItems } from './lib/storage'
import {
  alvosMarcaveis,
  alternar,
  alternarTudo,
  rotuloMarcarTudo,
  rotuloRestaurar,
  subtituloDoCabecalho,
  totalOculto,
  type Alvo,
} from './lib/ocultos'

/**
 * FOLHA DE RESTAURAR OCULTOS.
 *
 * POR QUE ELA ABRE UMA LISTA E NAO RESTAURA TUDO DIRETO: esconder um cartao por
 * engano e levar outros junto nao tem como corrigir, porque o que sumiu nao tem
 * mais nome em lugar nenhum. O botao abre a lista; a pessoa escolhe.
 *
 * TRES ARMADILHAS QUE ESTA ESTRUTURA JA EVITA, e que estão comentadas onde
 * elas acontecem:
 *
 *  1. A linha tem CHECKBOX VISIVEL a esquerda. O estado so no fundo, ou num
 *     glifo que so aparece quando marcado, faz a linha parecer texto e nada
 *     indica que ela e tocavel. O quadrado vazio com borda e a peca que
 *     reconhece o padrao "isto se marca".
 *
 *  2. A instrucao fica no SUBTITULO do cabecalho, nunca dentro do botao
 *     principal desabilitado. Texto de instrucao dentro de um botao desabilitado
 *     le como uma terceira acao.
 *
 *  3. O rodape e FIXO, fora da area rolavel, e a folha tem teto de altura. Se o
 *     rodape rolasse junto, o botao de confirmar saía da tela justamente na
 *     hora de confirmar.
 *
 * A folha cuida so do contexto que abriu (playlist + tipo). O que foi ocultado
 * em outro tipo fica em Configuracoes.
 */

type Props = {
  ocultos: HiddenItems
  /**
   * Catalogo carregado do contexto atual.
   *
   * E por isso que a ocultacao nao e um filtro de tela: os itens continuam em
   * memoria, e e daqui que sai a CATEGORIA DE ORIGEM do titulo. Um nome solto sem
   * contexto nao ajuda quando ha vinte itens ocultos.
   */
  catalogo: Channel[]
  onClose: () => void
  onRestaurar: (grupos: string[], ids: string[]) => void
}

export function RestaurarOcultosSheet({ ocultos, catalogo, onClose, onRestaurar }: Props) {
  const [selecao, setSelecao] = useState<Set<string>>(() => new Set())
  const rolarRef = useRef<HTMLDivElement>(null)
  const primeiroMarcavelRef = useRef<HTMLButtonElement>(null)

  /** O grupo de cada id guardado, para a segunda linha de cada titulo. */
  const grupoPorId = useMemo(() => {
    const mapa = new Map<string, string>()
    for (const c of catalogo) mapa.set(c.id, c.group)
    return mapa
  }, [catalogo])

  const nomes = ocultos.names ?? {}
  const grupos = ocultos.groups ?? []
  const ids = ocultos.channels ?? []

  /**
   * Tudo que pode ser marcado, na ordem em que aparece.
   *
   * As LINHAS e o alvo do "Marcar tudo" saem desta MESMA lista. Derivar as duas
   * coisas de fontes diferentes ja deu bug: a linha usava `chaveCategoria()` e o
   * "Marcar tudo" usava o nome cru, entao o clique marcava uma chave que
   * nenhuma linha consultava — medido no app como "Restaurar 2" com uma linha na
   * tela. Uma lista, uma chave, nenhuma chance de divergir.
   */
  const alvos = useMemo(
    () => alvosMarcaveis(grupos, ids, (id) => grupoPorId.get(id)),
    [grupos, ids, grupoPorId],
  )
  const marcavel = useMemo(() => alvos.map((a) => a.chave), [alvos])
  const total = totalOculto(ocultos)
  const restoreDesabilitado = selecao.size === 0

  /** Foca a primeira linha quando abre: a folha e uma tarefa de marcar. */
  useEffect(() => {
    const t = window.setTimeout(() => primeiroMarcavelRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [])

  /** Volta para Todos quando a categoria restaurada era a selecionada. */
  const confirmar = () => {
    if (restoreDesabilitado) return
    const marcadasGrupo: string[] = []
    const marcadosId: string[] = []
    for (const a of alvos) {
      if (!selecao.has(a.chave)) continue
      if (a.tipo === 'categoria') marcadasGrupo.push(a.nome)
      else marcadosId.push(a.nome)
    }
    onRestaurar(marcadasGrupo, marcadosId)
  }

  const linha = (alvo: Alvo, primeiro: boolean) => {
    const marcado = selecao.has(alvo.chave)
    const titulo = alvo.tipo === 'categoria' ? alvo.nome : (nomes[alvo.nome] ?? alvo.nome)
    const sub = alvo.tipo === 'categoria' ? '' : (alvo.origem ?? '')
    return (
      <button
        type="button"
        ref={primeiro ? primeiroMarcavelRef : undefined}
        className={`restaurar-linha${marcado ? ' is-marcado' : ''}`}
        aria-pressed={marcado}
        onClick={() => setSelecao((atual) => alternar(atual, alvo.chave))}
        title={titulo}
      >
        {/*
          CHECKBOX VISIVEL. Quadrado vazio com borda quando desmarcado, e
          preenchido no acento com "OK" quando marcado. E a peca que diz "isto se
          marca" — sem ela a linha parece texto e nada indica que e tocavel.

          O "OK" e TEXTO, e nao um glifo de check: um tracinho fino dentro de um
          quadrado de 22px se le como um ruido, e some no tema escuro. A
          especificacao pede "OK" e e o que cumpre a funcao de dizer "isto esta
          marcado" a distancia.
        */}
        <span className="restaurar-check" aria-hidden>
          {marcado ? 'OK' : null}
        </span>
        <span className="restaurar-texto">
          <span className="restaurar-titulo">{titulo}</span>
          {sub ? <span className="restaurar-sub">{sub}</span> : null}
        </span>
      </button>
    )
  }

  return (
    <div className="restaurar-backdrop" onClick={onClose}>
      <div
        className="restaurar-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Restaurar ocultos"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabecalho FIXO. */}
        <div className="restaurar-header">
          <div className="restaurar-header-texto">
            <h3>Restaurar ocultos</h3>
            {/* A instrucao mora AQUI, e nao no botao desabilitado. */}
            <p className="muted">{subtituloDoCabecalho(total)}</p>
          </div>
          <button type="button" className="restaurar-fechar" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        {/* So esta parte rola. */}
        <div className="restaurar-corpo" ref={rolarRef}>
          {/*
            Cada secao so aparece se TEM linhas. Uma secao so com o titulo, sem
            nada embaixo, parece que a lista carregou pela metade.
          */}
          {alvos.some((a) => a.tipo === 'categoria') && (
            <section className="restaurar-secao">
              <h4>Categorias ocultas</h4>
              {alvos.map((a, i) => (a.tipo === 'categoria' ? linha(a, i === 0) : null))}
            </section>
          )}

          {alvos.some((a) => a.tipo === 'titulo') && (
            <section className="restaurar-secao">
              <h4>Títulos ocultos</h4>
              {alvos.map((a, i) => (a.tipo === 'titulo' ? linha(a, i === 0) : null))}
            </section>
          )}
        </div>

        {/* Rodape FIXO, fora da area rolavel. */}
        <div className="restaurar-rodape">
          <button
            type="button"
            className="restaurar-marcar"
            onClick={() => setSelecao((atual) => alternarTudo(atual, marcavel))}
            disabled={marcavel.length === 0}
          >
            {rotuloMarcarTudo(selecao, marcavel)}
          </button>
          <button
            type="button"
            className="restaurar-confirmar"
            onClick={confirmar}
            disabled={restoreDesabilitado}
          >
            {rotuloRestaurar(selecao.size)}
          </button>
        </div>
      </div>
    </div>
  )
}