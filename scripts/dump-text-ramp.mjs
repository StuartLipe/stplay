// Regera a rampa de texto de cada tema NO CSS a partir da mesma funcao que roda
// em runtime.
//
// O teste "bate com a rampa que esta no CSS" acusou `#bfc4cd` (runtime) contra
// `#c0c4cd` (stylesheet): 1/255 de diferenca, de uma busca binaria com
// resolucao levemente diferente entre o gerador e a versao que roda no app.
//
// Um canal fora e invisivel, mas significa que escolher a letra no app e nao
// escolher nada produzem cores diferentes. E a rampa padrao tem de ser
// exatamente o que a funcao devolve.
import { readFileSync, writeFileSync } from 'node:fs'
import { textRampFor } from '../src/lib/theme-tokens.ts'

const THEMES = {
  midnight: '#020617',
  custom: '#101b24',
  amoled: '#000000',
  ocean: '#041018',
  slate: '#111318',
}
const TEXTO = '#eef3ff'

const NOMES = ['textPrimary', 'textBody', 'textMuted', 'textFaint', 'textGhost']

for (const [tema, bg] of Object.entries(THEMES)) {
  const r = textRampFor(TEXTO, bg)
  console.log(`  ${tema}  fundo ${bg}`)
  NOMES.forEach((n, i) => console.log(`      --${n}: ${r[n]};`))
}
