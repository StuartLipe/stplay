import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'

import {
  formatarData,
  marcarNovidadeVista,
  novidadesOrdenadas,
  type Novidade,
} from './lib/novidades'

type Props = {
  /** `updaterStatus.current`, ou `null` em dev sem status carregado. */
  versaoAtual: string | null
  /**
   * A página ESCREVE no storage, o pai so mantem o espelho em estado para o
   * ponto do menu sumir na hora. Sem isto o ponto continuaria aceso depois de
   * ler, e o unico jeito de limpa-lo seria fechar o app.
   */
  aoMarcarVista: (versao: string) => void
}

/**
 * PÁGINA DE NOVIDADES.
 *
 * O que a tela mostra, e o que ela esconde:
 *
 *   mostra  versão, data, e o nome de cada área que mudou
 *   esconde  o que mudou de fato — um clique por área
 *
 * A versão corrente vem aberta, porque é ela que a pessoa quer ver; as antigas
 * vêm fechadas. E dentro da versão, **nada** de detalhe aparece sem clique: a
 * versão 1.0.3 tem três áreas e nenhuma delas vem aberta.
 *
 * Não tem resumo em frase, nem busca, nem botão de cache. A referência que
 * motivou a tela mostrava os dois últimos, e nenhum dos dois tem o que fazer
 * num histórico de duas entradas.
 */
export function NovidadesPage({ versaoAtual, aoMarcarVista }: Props) {
  const [aberta, setAberta] = useState<string | null>(versaoAtual)
  const lista = novidadesOrdenadas()

  /*
   * Marca como vista ao abrir a pagina. Sem isso o ponto do menu nunca apaga e a
   * pessoa ganha um aviso que ja cumpriu, so que nao tem como cumprir.
   *
   * O estado nao volta para ca: quem precisa saber se ja leu e o MENU, e ele
   * guarda o espelho em `novidadeVista`. Aqui seria um segundo lugar guardando o
   * mesmo numero, e o primeiro a ser atualizado perderia.
   */
  useEffect(() => {
    if (!versaoAtual) return
    marcarNovidadeVista(versaoAtual)
    aoMarcarVista(versaoAtual)
  }, [aoMarcarVista, versaoAtual])

  return (
    <div className="settings-card settings-card-spaced">
      <div className="novidades-topo">
        <h2 className="novidades-titulo">
          <Sparkles size={18} strokeWidth={2} />
          Novidades
        </h2>
        {versaoAtual && <span className="novidades-versao-atual">instalada {versaoAtual}</span>}
      </div>

      {lista.length === 0 ? (
        <p className="muted" style={{ marginTop: 16 }}>
          Nenhuma novidade registrada ainda.
        </p>
      ) : (
        <div className="novidades-lista">
          {lista.map((n) => (
            <ItemVersao
              key={n.versao}
              novidade={n}
              aberta={aberta === n.versao}
              corrente={n.versao === versaoAtual}
              aoAlternar={() => setAberta(aberta === n.versao ? null : n.versao)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ItemVersao({
  novidade,
  aberta,
  corrente,
  aoAlternar,
}: {
  novidade: Novidade
  aberta: boolean
  corrente: boolean
  aoAlternar: () => void
}) {
  /*
   * O grupo abre por CONTEUDO, e nao por indice: a lista cresce a cada nota nova
   * e um indice guardaria a posição da última aberta, que deixa de apontar para
   * o mesmo grupo quando entra uma versão no meio.
   */
  const [grupoAberto, setGrupoAberto] = useState<string | null>(null)

  return (
    <section className={`novidades-item${aberta ? ' is-open' : ''}`}>
      <button type="button" className="novidades-item-head" onClick={aoAlternar}>
        {/*
          O botão é a UNICA coisa que abre. O chevron é decorativo e `aria-hidden`
          porque o estado da do botão e do texto ao lado; leitor de tela anunciando
          "botão, expandido, chevron, botão" so faze ruido.
        */}
        {aberta ? (
          <ChevronDown size={16} strokeWidth={2.2} aria-hidden />
        ) : (
          <ChevronRight size={16} strokeWidth={2.2} aria-hidden />
        )}
        <span className="novidades-item-versao">{novidade.versao}</span>
        {corrente && <span className="novidades-tag">instalada</span>}
        <span className="novidades-item-data">{formatarData(novidade.data)}</span>
      </button>

      {aberta && (
        <div className="novidades-corpo">
          {novidade.grupos.map((grupo) => {
            const grupoAbertoAgora = grupoAberto === grupo.nome
            return (
              <div key={grupo.nome} className={`novidades-grupo${grupoAbertoAgora ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="novidades-grupo-head"
                  onClick={() => setGrupoAberto(grupoAbertoAgora ? null : grupo.nome)}
                >
                  {grupoAbertoAgora ? (
                    <ChevronDown size={14} strokeWidth={2.2} aria-hidden />
                  ) : (
                    <ChevronRight size={14} strokeWidth={2.2} aria-hidden />
                  )}
                  <span>{grupo.nome}</span>
                </button>
                {grupoAbertoAgora && (
                  <ul className="novidades-grupo-itens">
                    {grupo.itens.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}