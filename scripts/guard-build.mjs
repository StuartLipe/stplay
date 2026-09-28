// Recusa o build antes de escrever qualquer byte se o estado for incoerente.
// Roda via `npm run prepack` (executado automaticamente antes de `npm run pack`).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// O BOM aparece quando alguém salva com `Set-Content -Encoding utf8` no Windows
// PowerShell 5.1, e o JSON.parse morre com "Unexpected token". Ler o arquivo e
// tirar o BOM na mão evita que uma edição acidental tranque o build inteiro.
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8').replace(/^\uFEFF/, ''))
const problems = []
const fail = (msg) => problems.push(msg)

const pkg = readJson('package.json')
const lock = readJson('package-lock.json')
const version = pkg.version
const outputDir = pkg.build?.directories?.output ?? ''

// 1. package.json e package-lock.json precisam concordar, senao `npm ci` falha.
if (lock.version !== version) {
  fail(`package.json esta em ${version} mas package-lock.json esta em ${lock.version} — rode: npm install --package-only`)
}
if (lock.packages?.['']?.version !== version) {
  fail(`package-lock.json packages[""] esta em ${lock.packages?.['']?.version}, esperava ${version}`)
}

// 2. A saida e a RAIZ de release/, e a separacao entre versoes vem do NOME do
//    artefato, nao de uma pasta por versao.
//
// Politica do dono: existe um unico 1.0.6 e ele e substituivel a cada build.
// So uma versao antiga e preservada quando ele pedir explicitamente. Entao a
// pasta `release/1.0.6/` e a regra "a pasta precisa estar vazia" foram invertidas:
// os artefatos ficam ao lado de 1.0.4 e 1.0.5, e o que impede a sobrescrita de
// uma versao DIFFERENTE e o `${version}` no nome do artefato — verificado aqui.
if (outputDir !== 'release') {
  fail(`build.directories.output e "${outputDir}" mas a politica e a raiz de "release" — os artefatos ficam ao lado das versoes publicadas`)
}

// 2b. Todo artefato que o build vai escrever precisa carregar a versao no nome.
//     E isto que garante que compilar 1.0.6 nao encoste em ST PLAY 1.0.5.exe.
//     Com o `artifactName` implicito isso vinha de um default do
//     electron-builder; agora esta no config e e conferido.
for (const [key, label] of [['nsis', 'instalador'], ['portable', 'portatil']]) {
  const name = pkg.build?.[key]?.artifactName ?? ''
  if (!name) {
    fail(`build.${key}.artifactName ausente — sem ele o nome do ${label} sai de um default e a separacao entre versoes deixa de ser garantida`)
  } else if (!name.includes('${version}')) {
    fail(`build.${key}.artifactName e "${name}" e nao contem \${version} — o build sobrescreveria o .exe de outra versao`)
  }
}

// 3. Nomes de instalador precisam carregar a versao (1.0.4/1.0.5 sao indistinguiveis hoje).
for (const key of ['shortcutName', 'uninstallDisplayName']) {
  const value = pkg.build?.nsis?.[key] ?? ''
  if (!value.includes(version)) {
    fail(`build.nsis.${key} e "${value}" e nao contem a versao ${version}`)
  }
}

// 4. Os artefatos publicados precisam continuar intactos.
//
// A distincao que importa aqui e AUSENTE vs ADULTERADO.
//
// O manifesto e versionado, entao num clone novo ele chega claiming artefatos
// que nao existem no disco — o `release/` e gitignored. Reprovava aqui
// bloqueava o primeiro `npm run pack` de qualquer maquina nova com:
//
//   x  artefato publicado ausente: release/ST-PLAY-Setup-1.0.0.exe
//
// Ausente nao e adulterado: nao ha byte para comparar, e o proprio build vai
// gerar o arquivo. Reprovar so faria o dono apagar o manifesto na mao —
// justamente o arquivo que existe para nao mexer a mao.
//
// O que reprova e o arquivo PRESENTE com conteudo diferente. Esse e o caso que
// o manifesto existe para pegar: um build anterior sobrescreveu um artefato ja
// publicado, e ninguem reparou ate os usuarios começarem a receber bytes
// diferentes com o mesmo numero de versao.
const manifestPath = join(root, 'release-exe-manifest.txt')
if (existsSync(manifestPath)) {
  const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const manifest = readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')
  const ausentes = []
  for (const line of manifest.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [name, hash, size] = line.split('|')
    const file = join(root, 'release', name)
    if (!existsSync(file)) {
      ausentes.push(name)
      continue
    }
    const actualSize = statSync(file).size
    if (actualSize !== Number(size)) {
      fail(`release/${name} mudou de tamanho (${size} -> ${actualSize})`)
    } else if (sha256(file) !== hash) {
      fail(`release/${name} mudou de conteudo (SHA256 divergente)`)
    }
  }
  if (ausentes.length) {
    console.log(
      `  ${ausentes.length} artefato(s) do manifesto ainda nao buildados nesta maquina (normal num clone novo): ${ausentes.join(', ')}`,
    )
  }
} else {
  fail('release-exe-manifest.txt ausente — sem ele nao da para provar que os .exe antigos seguem intactos')
}

// 5. Os arquivos que o main carrega em runtime precisam existir no pacote.
// Um filtro `files` muito amplo (tipo `!**/node_modules/**/src/**`) exclui o
// codigo que o koffi faz require, e o player morre em runtime com
// "Cannot find module" — depois de um build que devolveu sucesso. Estes dois
// sao require()ados de verdade pelo processo principal.
const RUNTIME_REQUIRE = [
  'node_modules/koffi/index.cjs',
  'node_modules/koffi/src/koffi/index.cjs',
  'node_modules/ffmpeg-static/index.js',
  'node_modules/ffmpeg-static/package.json',
]
const runtimeFaltando = RUNTIME_REQUIRE.filter((rel) => !existsSync(join(root, rel)))
if (runtimeFaltando.length) {
  // A mensagem anterior era "runtime ausente do repo", que num backup restaurado
  // do Drive se lê como "a pasta veio quebrada" — e ela não veio. `node_modules`
  // é gitignored por 645 MB, então um restore limpo sempre chega sem ele, e o
  // conserto é um comando.
  fail(
    `node_modules incompleto (${runtimeFaltando.length} de ${RUNTIME_REQUIRE.length} arquivos de runtime ausentes).\n` +
      '         Rode: npm install',
  )
}

// 6. O empacotador precisa do mpv.
//
// O `package.json` faz `extraResources: { from: 'resources/mpv', to: 'mpv' }`.
// `resources/` e gitignored, entao numa maquina nova ele chega vazio, e o
// `electron-builder` nao baixa nada: sai um instalador do tamanho certo que nao
// toca um unico video. O defeito so apareceria em runtime, na maquina de quem
// instalou — o pior lugar possivel para descobrir.
//
// Ate o `download-players` ganhar um `copiarParaResources()` que populava
// esse caminho, nao havia NENHUM jeito de recria-lo depois de formatar o PC.
const mpvEmpacotado = join(root, 'resources', 'mpv', 'mpv.exe')
if (!existsSync(mpvEmpacotado)) {
  console.log(
    '\n  AVISO: resources/mpv/mpv.exe ausente — este build vai gerar um instalador SEM o player.\n' +
      '          Rode antes: npm run download-players\n',
  )
}

// 7. O que este build vai SUBSTITUIR.
//
// Antes isto era um bloqueio: a pasta de saida tinha que estar vazia. Na
// politica atual o 1.0.6 e substituivel a cada build — e e isso que se quer —
// entao o caminho virou: em vez de barrar, listar o que sera sobrescrito e
// deixar claro que as outras versoes nao estao na lista.
//
// A garantia de que 1.0.4/1.0.5 ficam intactos vem de duas linhas acima: o
// manifesto com o SHA256, conferido antes de qualquer byte ser escrito.
const substitui = []
const prefixo = `${pkg.build?.productName ?? 'ST PLAY'}`
for (const suffix of [' Setup', '']) {
  const file = `${prefixo}${suffix} ${version}.exe`
  if (existsSync(join(root, outputDir, file))) substitui.push(file)
}
const aviso = substitui.length > 0
  ? `\n  sera substituida a versao atual ${version}: ${substitui.join(', ')}\n  (as versoes anteriores nao sao tocadas — manifesto verificado acima)\n`
  : ''

if (problems.length) {
  console.error('\n  BUILD BLOQUEADO\n')
  for (const p of problems) console.error(`  x  ${p}`)
  console.error('')
  process.exit(1)
}

console.log(`  guard ok — ${version} -> ${outputDir}/, artefatos publicados verificados${aviso}`)
