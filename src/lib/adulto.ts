/**
 * ADULTO — o que conta como conteúdo adulto, em UM lugar só.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 *
 * Havia dois padrões para a mesma pergunta, e eles discordavam:
 *
 *   `App.tsx`      `/\bADULT\b|\bADULTO\b|\bADULTA\b|.../`
 *   `xtream.ts`    `/ADULTO|ADULTA|\+18|.../`
 *
 * O primeiro exige limite de palavra; o segundo não. Num painel que nomeia a
 * categoria `"CANAIS | ADULTOS"` os dois discordam do mesmo nome:
 *
 *   `\bADULTO\b`  NÃO casa  — o S final mata o limite de palavra
 *   `ADULTO`      casa      — é só substring
 *
 * E a consequência era o inverso do que o nome sugere: a categoria ficava
 * DESPROTEGIDA. Com a senha de 4 dígitos ligada, ela continuava aparecendo
 * na coluna e os canais ficavam jogados dentro de outra categoria, porque só o
 * padrão do `xtream` a reconhecia. Duas fontes para a mesma pergunta é a forma
 * garantida de divergirem; uma só mata a classe inteira do bug.
 *
 * O padrão é montado para casar `ADULT`, `ADULTO`, `ADULTA`, `ADULTOS` e
 * `ADULTAS` — e continuar casando `"ADULT SWIN"` / `"ADULT SWIN 4K"`, que é o
 * que o limite `\bADULT\b` resolvia antes.
 *
 * O termo só é aceito quando o próximo caractere NÃO é uma letra (`(?!\p{L})`),
 * que é o que impede "ADULTADO" de casar: depois de "ADULTA" vem "DO", que é
 * letra, e a tentativa com "ADULT" também falha pelo mesmo motivo.
 */

/**
 * O nome da categoria é de conteúdo adulto?
 *
 * O fim do termo é `\p{L}` NEGADO, e não `\b`: `\b` compara com `\w`
 * (`[A-Za-z0-9_]`) e acentos estão fora disso. `"ADULTAÇÃO"` terminava num `\b`
 * antes do Ç e casava como se fosse "ADULTA" — exatamente o falso positivo que
 * o limite de palavra devia impedir, com o limite meio funcionando.
 *
 * Também não é `\bADULT\w*\b`: esse casaria "ADULTADO", "ADULTADOS" e qualquer
 * nome que comece com "adult", adulto ou não.
 */
const PADRAO_ADULTO =
  /\bADULT(?:O|OS|AS|A)?(?!\p{L})|\+18|18\+|XXX|ONLY\s*FANS|PRIVACY|PORNO|PORNÔ|PORN|HENTAI|SEXTREME|EROTIC|PRIVE|PRIVÊ|CINE\s*PRIV|BRAZZER|BANG\s*BROS|BANGBROS|VIXEN|BLACKED|TUSHY|SWEET\s*SINNER|EVIL\s*ANGEL|PLAYBOY|VENUS|FETISH|FETICHE|REDLIGHT|HARDCORE|SOFTCORE/iu

/**
 * Prefixo comum em nome de canal: `[XXX]`, `(XXX)`, `XXX -`.
 *
 * Separado do padrão acima de propósito: aqui o "XXX" solto NÃO basta, porque o
 * TEXTO INTEIRO é o nome do canal e "XXX" aparece no meio de meio mundo sem que
 * aquilo seja conteudo adulto. Na categoria o termo sozinho ja e o nome.
 */
const PADRAO_XXX_NO_NOME = /(?:^|[\s\[\(\-_])XXX(?:$|[\s\]\)\-_])/i

/** `true` quando a categoria (do painel ou do app) e de conteudo adulto. */
export function ehCategoriaAdulta(nome?: string): boolean {
  if (!nome) return false
  return PADRAO_ADULTO.test(nome)
}

/**
 * `true` quando o canal e de conteudo adulto.
 *
 * Sao tres fontes: o grupo a que ele pertence, o proprio nome, e o prefixo
 * `[XXX]` que alguns painéis colocam em todo canal adulto. As tres olham o
 * mesmo padrao agora — antes o canal usava o padrao restrito e a categoria usava
 * o largo, e um canal dentro de "CANAIS | ADULTOS" passava ileso.
 *
 * Aceita qualquer objeto com `group`/`name` em vez do tipo `Channel` porque o
 * `App.tsx` tambem chama isso com itens de catalogo de filme e serie, que tem
 * outros campos.
 */
export function ehCanalAdulto(canal?: { group?: string; name?: string }): boolean {
  if (!canal) return false
  if (ehCategoriaAdulta(canal.group) || ehCategoriaAdulta(canal.name)) return true
  return PADRAO_XXX_NO_NOME.test(String(canal.name || ''))
}