import { ExternalLink } from 'lucide-react'

/**
 * Tela "Sobre": o que e o app, quem fez, e onde achar o autor.
 *
 * Fica em arquivo proprio em vez de dentro do `App.tsx` pelo mesmo motivo que a
 * `NovidadesPage` esta la: sao telas de leitura, sem estado proprio, e o
 * `App.tsx` ja e grande demais para carregar mais um bloco de JSX.
 */

/*
  Autoria. Mesmo par que o `package.json` grava em `author` e `homepage`, e que
  o electron-builder joga em `build.win.publisherName`.

  Sao duas copias em vez de importacao porque o `package.json` nao e um modulo
  que o renderer possa ler — ele vive no build, nao no bundle — e o valor e
  fixo. Se um dia mudar, sao estes dois que mudam junto. Divergencia entre
  "quem fez" no Windows e "quem fez" no app e exatamente o tipo de coisa que
  ninguem percebe ate ser tarde.
*/
const AUTOR_NOME = 'Sturt'
const AUTOR_LINK = 'https://github.com/StuartLipe'
/*
  LINK DE DOWNLOAD, e NAO de codigo-fonte.

  O dono pediu para nao expor o codigo. O codigo do repo publico esta no GitHub
  de qualquer jeito: os arquivos-fonte sao anexos gerados pela tag e nao existem
  como asset, entao nao ha endpoint para apagar (ja verificado — DELETE devolve
  404). O que da para fazer e NAO apontar para ele daqui, e e o que esta feito.
  Nada no app leva ao repositorio.

  O que NAO resolve, e vale registrar: deixar o repo PRIVADO quebra o
  atualizador. O `electron-updater` baixa o instalador da release sem token; com
  repo privado essa chamada deixa de ser anonima e a atualizacao para de
  funcionar em qualquer maquina sem conta. Repo publico + link de download, e o
  arranjo que funciona.

  O destino e a PAGINA da release, nao o arquivo direto. A URL do arquivo tem a
  versao no nome (`ST-PLAY-Setup-1.0.4.exe`), entao um link direto aqui
  envelhece a cada publicacao: quem tiver a 1.0.5 instalada clicaria num 404
  procurando a 1.0.4, e o conserto so viria na build seguinte. A pagina da
  release nao tem versao e nunca quebra.
*/
const DOWNLOAD_LINK = 'https://github.com/StuartLipe/stplay/releases/latest'

type Props = {
  /** `updaterStatus.current`, ou `null` em dev sem status carregado. */
  versaoAtual: string | null
}

/*
  Botão, e não `<a href target="_blank">`.

  O renderer roda com `contextIsolation` e `sandbox`, e o app não registra
  `setWindowOpenHandler`: um `_blank` pediria uma BrowserWindow nova, ninguém
  responderia, e o clique não produziria efeito visível. Foi o que aconteceu —
  o link estava no DOM, clicável, e não abria nada.

  O clique vai para o main, que abre no navegador de fora e no ÚLTIMO navegador
  usado pela pessoa (lê o registro do Windows), e não no que o Windows escolher
  por conta própria — no Windows sem navegador padrão definido, `openExternal`
  sozinho nem sempre acerta.
*/
function LinkExterno({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="sobre-link"
      onClick={() => {
        void window.sturplay?.openExternal?.(href)
      }}
      title={href}
    >
      {children}
      <ExternalLink size={12} strokeWidth={2.4} aria-hidden />
    </button>
  )
}

export function SobrePage({ versaoAtual }: Props) {
  return (
    <div className="settings-card settings-card-spaced sobre-card">
      <div className="sobre-topo">
        <span className="sobre-marca">ST PLAY</span>
        {versaoAtual && <span className="sobre-versao">versão {versaoAtual}</span>}
      </div>

      <p className="sobre-texto">
        Player de vídeo para IPTV no desktop. Serve catálogo, filmes, séries e canais ao vivo,
        com o vídeo tocando dentro do app — em tela cheia de verdade, com o mouse e a barra
        escondendo sozinhos.
      </p>

      {/* O PARÁGRAFO DA LISTA.

        Este texto é proposital e não é cadastro do app: o ST PLAY não distribui
        lista de canais, nem filmes, nem séries. Quem tem uma lista usa o app para
        rodar; quem não tem, não tem o que rodar. Colocar isso na tela "Sobre"
        é o lugar honesto para dizer — na instalação, na página inicial e no
        primeiro clique seria um obstáculo, e aqui é uma informação.

        Daqui a pouco o texto também serve de resposta para quem pergunta por que
        o app "não tem nada para assistir" logo depois de instalar.

        A segunda frase é a que importa na prática: quem vem de outro player já
        sabe o que é uma linha `playlist.m3u` ou um `xtream` e não precisa de
        explicação, mas precisa saber que tem de trazer a dele.
      */}
      <p className="sobre-texto">
        <strong>O app não fornece lista de playlist.</strong> Ele não vem com canais, filmes nem
        séries — quem for usar traz a própria lista, no formato{' '}
        <span className="sobre-code">playlist.m3u</span> ou um painel{' '}
        <span className="sobre-code">xtream</span>, e o app serve para rodar o que está nela.
      </p>

      {/*
        A autoria vem depois de dizer o que o app e, e nao antes: um nome no
        topo de uma tela de leitura parece cartao de visita, e nesta posicao ele
        parece assinatura — que e o que e.
      */}
      <div className="sobre-rodape">
        <div className="sobre-autor">
          <span className="sobre-autor-nome">{AUTOR_NOME}</span>
          <LinkExterno href={AUTOR_LINK}>{AUTOR_LINK.replace(/^https:\/\/github\.com\//, '@')}</LinkExterno>
        </div>
        <LinkExterno href={DOWNLOAD_LINK}>Baixar</LinkExterno>
      </div>
    </div>
  )
}