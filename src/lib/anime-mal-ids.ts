/*
 * MyAnimeList ID das séries do catálogo, para a API AniSkip (abertura e
 * encerramento).
 *
 * ---------------------------------------------------- DADOS GERADOS ------
 *
 * O bloco MAL_ID_POR_NOME abaixo é GERADO — não editar à mão.
 *
 * Como foi feito:
 *   1. ler as séries das categorias de anime do servidor Xtream;
 *   2. resolver cada título na AniList, que é pública e devolve o `idMal`;
 *   3. conferir o ano de estreia e a posição no resultado para não trocar um
 *      anime por outro de nome parecido;
 *   4. gravar com a chave já normalizada (sem ano, sem `[L]`).
 *
 *   5. acréscimos manuais verificados um a um em 30/10/2026: 25 títulos
 *      que a busca automática não cobriu, resolvidos na AniList com a
 *      mesma regra de ano + similaridade (nenhum ID chutado).
 * Série que não entrou no mapa é série que não ganhou dado de pular. É o
 * comportamento pedido: sem dado, o botão simplesmente não aparece.
 *
 * Só o id trafega. Nenhum nome é enviado para fora.
 *
 * -------------------------------------------------------------------------
 *
 * Resolve o MyAnimeList ID de uma série pelo título, para a AniSkip.
 *
 * O servidor Xtream nomeia em inglês e polui o título com ano e etiquetas:
 *   "Naruto Shippuden [L] (2007)" -> "naruto shippuden"
 *   "One Piece [L] (1999)"        -> "one piece"
 *
 * Estratégia em três degraus, do mais barato ao mais caro:
 *
 *   1. Mapa embutido acima. Cobre o catálogo inteiro sem nenhuma chamada de
 *      rede — é o caminho normal.
 *   2. Se o servidor ganhar uma série nova, o mapa não tem. Aí sim sai para a
 *      AniList.
 *   3. O resultado do degrau 2 fica em `localStorage`, então cada série é
 *      resolvida uma vez só por máquina.
 *
 * Nada aqui bloqueia o player: qualquer falha (rede, 429, JSON inesperado)
 * resolve em `null`, que é o mesmo resultado de "não temos dado" e apenas faz
 * o botão não aparecer.
 */

export const MAL_ID_POR_NOME: Record<string, string> = {
  "100 coisas para fazer antes de virar zumbi": "54112",
  "100 namoradas que te amam muuuuuito": "54714",
  "365 days to the wedding": "55887",
  "86": "41457",
  "86 eighty six": "41457",
  "a condition called love": "55597",
  "a couple of cuckoos": "48675",
  "a ilha das sombras": "47194",
  "a journey through another world raising kids while adventuring": "57380",
  "a noiva do antigo mago o menino do oeste e o cavaleiro da tempestade azul": "48438",
  "a veterana pitica da firma": "53379",
  "agents of the four seasons dance of spring": "61443",
  "akudama drive": "41433",
  "akuyaku reijou nanode last boss wo kattemimashita": "49979",
  "alma chan wants to be a family": "60781",
  "anne shirley": "60334",
  "aoashi": "49052",
  "aria the animation": "477",
  "arifureta shokugyou de sekai saikyou": "36882",
  "assassination classroom": "24833",
  "ataque dos titas": "16498",
  "banished from the hero s party i decided to live a quiet life in the countryside": "44037",
  "beyblade x": "56566",
  "black clover": "34572",
  "black torch": "61169",
  "blood blockade battlefront": "24439",
  "blue exorcist": "9919",
  "blue lock": "49596",
  "boku no hero academia": "31964",
  "boruto naruto next generations": "34566",
  "brave 10": "11241",
  "bucchigiri": "55358",
  "bungo stray dogs": "31478",
  "bye bye earth": "53626",
  "campfire cooking in another world with my absurd skill": "53446",
  "chainsaw man": "44511",
  "chillin in another world with level 2 super cheat powers": "56923",
  "classroom of the elite": "35507",
  "clevatess": "59205",
  "combatants will be dispatched": "41456",
  "como raeliana foi parar na mans o do duque": "52308",
  "cr nicas de um aristocrata em outro mundo": "55265",
  "daemons do reino das sombras": "62001",
  "danmachi e errado tentar pegar garotas em uma masmorra": "28121",
  "dark moon the blood altar": "59853",
  "darling in the franxx": "35849",
  "demon lord 2099": "54853",
  "di rios de uma apotec ria": "54492",
  "digimon adventure": "41074",
  "digimon beatbreak": "61269",
  "digimon frontier": "1132",
  "dorohedoro": "38668",
  "dr stone": "38691",
  "dragon ball daima": "56894",
  "dragon ball gt": "225",
  "dragon ball super": "30694",
  "dragon ball z": "813",
  "eizouken ni wa te wo dasu na": "39792",
  "eyeshield 21": "15",
  "fate grand carnival": "44248",
  "fire force": "38671",
  "frieren e a jornada para o alem": "52991",
  "full dive this ultimate next gen full dive rpg is even shittier than real life": "44276",
  "fullmetal alchemist brotherhood": "5114",
  "fuufu ijou koibito miman": "50425",
  "fuuto tantei": "48649",
  "gachiakuta": "59062",
  "ganhei um poder apel o em outro mundo e agora sou imbat vel no mundo real": "52830",
  "garotas marionetes j": "573",
  "genjitsu shugi yuusha no oukoku saikenki": "41710",
  "girlfriend girlfriend": "43969",
  "gleipnir": "39463",
  "gnosia": "60427",
  "go for it nakamura kun": "59551",
  "goblin slayer": "37349",
  "gods game we play": "50869",
  "hana kimi": "58861",
  "hanako kun e os misterios do colegio kamome": "39534",
  "hanaori san still wants to fight in the next life": "62535",
  "hells paradise": "46569",
  "hikaru no go": "135",
  "horimiya piece": "54856",
  "how a realist hero rebuilt the kingdom": "41710",
  "i m the villainess so i m taming the final boss": "49979",
  "i want to end this love game": "61839",
  "ijiranaide nagatoro san": "42361",
  "in the land of leadale": "48239",
  "jaadugar a witch in mongolia": "61483",
  "jigokuraku": "46569",
  "jujutsu kaisen": "40748",
  "kaiju girl caramelise": "63150",
  "kaiju no 8": "52588",
  "kakkou no iinazuke": "48675",
  "kakushite makina san": "58833",
  "keep your hands off eizouken": "39792",
  "konosuba uma explosao neste mundo maravilhoso": "30831",
  "kumo desu ga nani ka": "37984",
  "kyuukyoku shinka shita full dive rpg ga genjitsu yori mo kusogee dattara": "44276",
  "laid back camp": "34798",
  "leadale no daichi nite": "48239",
  "legend of xianwu": "52522",
  "lets play": "61773",
  "level e": "9834",
  "link click": "44074",
  "lord of mysteries": "49818",
  "love all play": "49556",
  "lupin iii": "1412",
  "lv2 kara cheat datta motoyuusha kouho no mattari isekai life": "56923",
  "lycoris recoil": "50709",
  "magic maker how to make magic in another world": "59265",
  "mahoutsukai reimeiki": "48842",
  "marriagetoxin": "62601",
  "masamune kun no revenge": "33487",
  "mashle magia e m sculos": "52211",
  "mashle magia e musculos": "52211",
  "may i ask for one final thing": "59846",
  "me apaixonei pela vila": "53833",
  "megalo box": "36563",
  "meikyuu black company": "42340",
  "metallic rouge": "54794",
  "meu casamento feliz": "51552",
  "meu trabalho no caf yuri": "51817",
  "mieruko chan": "48483",
  "minha habilidade nica me deixa invenc vel no n vel 1": "51764",
  "minha mana apelona": "51219",
  "mob psycho 100": "32182",
  "mobile suit gundam the witch from mercury": "49828",
  "mono": "58492",
  "more than a married couple but not lovers": "50425",
  "mushoku tensei jobless reincarnation": "39535",
  "muteking the dancing hero": "39893",
  "muv luv alternative total eclipse": "11021",
  "my dress up darling": "48736",
  "my hero academia vigilantes": "60593",
  "my home hero": "52092",
  "naruto cl ssico": "20",
  "naruto classico": "20",
  "naruto shippuden": "1735",
  "needy girl overdose": "62913",
  "new saga": "53397",
  "nina the starry bride": "57362",
  "ningen fushin adventurers who don t believe in humanity will save the world": "49612",
  "nyaight of the living cat": "58197",
  "o exterminador do futuro zero": "59390",
  "o tio de outro mundo": "49220",
  "odd taxi": "46102",
  "oku por dentro do castelo": "54850",
  "one piece": "21",
  "one piece log fish man island saga": "60108",
  "orange": "32729",
  "ore dake haireru kakushi dungeon": "41899",
  "orient": "45560",
  "os cavaleiros do zodiaco alma de ouro": "28215",
  "os cavaleiros do zodiaco omega": "12929",
  "oshi no ko": "52034",
  "our last crusade or the rise of a new world": "40595",
  "ousama ranking": "40834",
  "ousama ranking yuuki no takarabako": "52657",
  "overgeared": "64340",
  "overlord": "29803",
  "pass the monster meat milady": "60162",
  "platinum end": "44961",
  "possibly the greatest alchemist of all time": "58822",
  "re monster": "56690",
  "reborn": "1604",
  "reborn as a space mercenary i woke up piloting the strongest starship": "60948",
  "reencarnado numa m quina de vendas agora exploro a masmorra": "52619",
  "rent a girlfriend": "40839",
  "rezero starting life in another world": "31240",
  "rikei ga koi ni ochita no de shoumei shitemita": "38992",
  "rilakkuma": "60153",
  "ririsa uma garota em 2 5d": "53802",
  "roll over and die i will fight for an ordinary life with my love and cursed sword": "61587",
  "rougo ni sonaete isekai de 8 manmai no kinka wo tamemasu": "52461",
  "rumble garanndoll": "48644",
  "rurouni kenshin": "50613",
  "saber marionette j": "573",
  "sabikui bisco": "48414",
  "saga of tanya the evil": "32615",
  "saihate no paladin": "48761",
  "sakugan": "38192",
  "sala de aula dos her is": "49894",
  "science fell in love so i tried to prove it": "38992",
  "seirei gensouki spirit chronicles": "44203",
  "sekai saikou no ansatsusha isekai kizoku ni tensei suru": "47790",
  "sentenced to be a hero": "56009",
  "sentouin hakenshimasu": "41456",
  "shadows house": "43439",
  "shaman king flowers": "51673",
  "shijou saikyou no daimaou murabito a ni tensei suru": "48415",
  "shikkakumon no saikyou kenja": "47161",
  "shin no nakama ja nai to yuusha no party wo oidasareta node henkyou de slow life suru koto ni shimashita": "44037",
  "shinobi no ittoki": "51098",
  "shurato": "2113",
  "shy": "53237",
  "sk8 the infinity": "42923",
  "sket dance": "9863",
  "skip and loafer": "50416",
  "skip beat": "4722",
  "slime taoshite 300 nen shiranai uchi ni level max ni nattemashita": "40586",
  "smoking behind the supermarket with you": "62076",
  "snowball earth": "62068",
  "so i m a spider so what": "37984",
  "solo camping for two": "60665",
  "solo leveling": "52299",
  "sono bisque doll wa koi wo suru": "48736",
  "soul eater": "3588",
  "spy family": "50265",
  "squid girl": "8557",
  "stand my heroes piece of truth": "38331",
  "super cubo": "40685",
  "super dragon ball heroes": "37885",
  "sword art online": "11757",
  "tamon s b side": "59047",
  "tegami bachi": "6444",
  "tenchi muyo": "696",
  "tengoku daimakyo ilus o celestial": "53393",
  "tensai ouji no akaji kokka saisei jutsu": "47159",
  "tensei kizoku no isekai boukenroku jichou wo shiranai kamigami no shito": "52608",
  "that time i got reincarnated as a slime": "37430",
  "the ancient magus bride": "35062",
  "the beginning after the end": "60146",
  "the brilliant healers new life in the shadows": "58359",
  "the dawn of the witch": "48842",
  "the defective": "40885",
  "the duke of death and his maid": "47257",
  "the file of young kindaichi returns": "22817",
  "the gorilla gods go to girl": "59935",
  "the greatest demon lord is reborn as a typical nobody": "48415",
  "the hidden dungeon only i can enter": "41899",
  "the iceblade sorcerer shall rule the world": "51711",
  "the misfit of demon king academy": "40496",
  "the shiunji family children": "58131",
  "the slime diaries": "41488",
  "the strongest sage with the weakest crest": "47161",
  "the unaware atelier meister": "60140",
  "the weakest tamer began a journey to pick up trash": "53590",
  "the world ends with you the animation": "42307",
  "the world s finest assassin gets reincarnated in another world as an aristocrat": "47790",
  "the wrong way to use healing magic": "49613",
  "though i am an inept villainess": "61240",
  "to be hero x": "53447",
  "to your eternity": "41025",
  "tojima wants to be a kamen rider": "61159",
  "tokyo ghoul": "22319",
  "tomb raider king": "63316",
  "tonikawa over the moon for you": "41389",
  "tower of god": "40221",
  "trapped in a dating sim the world of otome games is tough for mobs": "50461",
  "trigun stampede": "52093",
  "true beauty": "57192",
  "tsukimichi moonlit fantasy": "43523",
  "tying the knot with an amagami sister": "55071",
  "uma vizinha de outro mundo": "51705",
  "undead unluck": "52741",
  "uzaki chan wa asobitai": "41226",
  "vanitas no carte": "48580",
  "vinland saga": "37521",
  "watashi no yuri wa oshigoto desu": "51817",
  "welcome to demon school iruma kun": "39196",
  "wind breaker": "54900",
  "wistoria wand and sword": "58059",
  "witch hat atelier": "51553",
  "with you our love will make it through": "60765",
  "yamishibai japanese ghost stories": "19383",
  "you and i are polar opposites": "60371",
  "you are ms servant": "57611",
  "yu gi oh gx": "482",
  "yuri on ice": "32995",
  "yuusha party wo tsuihou sareta beast tamer saikyoushu no nekomimi shoujo to deau": "52046",
  "zenshu": "58502",
}

/*
 * Resolve o MyAnimeList ID de uma série pelo título, para a AniSkip.
 *
 * O servidor Xtream nomeia em inglês e polui o título com ano e etiquetas:
 *   "Naruto Shippuden [L] (2007)" -> "naruto shippuden"
 *   "One Piece [L] (1999)"        -> "one piece"
 *
 * Estratégia em três degraus, do mais barato ao mais caro:
 *
 *   1. Mapa embutido, gerado do catálogo real do servidor. Cobre o catálogo
 *      inteiro sem nenhuma chamada de rede — é o caminho normal.
 *   2. Se o servidor ganhar uma série nova, o mapa não tem. Aí sim sai para a
 *      AniList, que é pública e devolve o `idMal` direto.
 *   3. O resultado do degrau 2 fica em `localStorage`, então cada série é
 *      resolvida uma vez só por máquina.
 *
 * Nada aqui bloqueia o player: qualquer falha (rede, 429, JSON inesperado)
 * resolve em `null`, que é o mesmo resultado de "não temos dado" e apenas faz
 * o botão não aparecer.
 */

/**
 * Remove etiquetas entre colchetes, ano entre parênteses e marcadores de
 * episódio, e reduz a minúsculas.
 *
 * O marcador de episódio importa porque a chave do mapa é o nome da SÉRIE
 * ("naruto shippuden"), e o que chega do servidor num episódio é o nome do
 * episódio ("Naruto Shippuden S01E01"). Sem tirar o "E01", as duas strings não
 * são iguais e a busca falha em silêncio.
 */
export function normalizarNomeSerie(nome: string): string {
  return String(nome ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    /*
     * "S01E01" primeiro, e separado: o `\b` depois de `S01` não casa aqui
     * porque o próximo caractere é "E", que é caractere de palavra — a regra de
     * temporada sozinha deixa o "s01e01" inteiro no final da string.
     */
    .replace(/\b[Ss]\d{1,2}[\s._-]*[Ee]\d{1,4}\b/g, ' ')
    // "S01", "T2" — temporada.
    .replace(/\b(?:S|T)\d{1,3}\b/gi, ' ')
    // "E01", "EP12", "EPISODIO 5" — só quando precedido por separador, para não
    // arrumar título que comece com E seguido de dígito.
    .replace(/(?:^|[\s._\-[(])EP?IS[OÓ]DIO?[\s._\-]*\d{1,4}\b/gi, ' ')
    .replace(/(?:^|[\s._\-[(])EP?[\s._\-]*\d{1,3}\b/gi, ' ')
    .replace(/\b(?:season|temporada|dublado|dublada|legendado|legendada)\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()
}

const CACHE_KEY = 'stplay:mal-id-cache:v1'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 90 // 90 dias

interface CacheEntry {
  malId: string | null
  at: number
}

const memoria = new Map<string, string | null>()

function lerCache(): Record<string, CacheEntry> {
  try {
    const bruto = localStorage.getItem(CACHE_KEY)
    if (!bruto) return {}
    const obj = JSON.parse(bruto)
    return obj && typeof obj === 'object' ? (obj as Record<string, CacheEntry>) : {}
  } catch {
    return {}
  }
}

function gravarCache(chave: string, malId: string | null) {
  try {
    const atual = lerCache()
    atual[chave] = { malId, at: Date.now() }
    localStorage.setItem(CACHE_KEY, JSON.stringify(atual))
  } catch {
    // Modo privado / cota estourada: a memória ainda cobre a sessão.
  }
}

function doCache(chave: string): string | null | undefined {
  if (memoria.has(chave)) return memoria.get(chave)
  const entrada = lerCache()[chave]
  if (!entrada) return undefined
  if (Date.now() - entrada.at > CACHE_TTL_MS) return undefined
  const valor = entrada.malId ?? null
  memoria.set(chave, valor)
  return valor
}

function bigramas(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

/** Dice sobre bigramas: 0 (nada em comum) a 1 (idêntico). */
function similaridade(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = bigramas(a)
  const B = bigramas(b)
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}

/** Ano entre parênteses no nome do servidor: "Bleach [L] (2004)" -> 2004 */
export function anoDoNomeSerie(nome: string): number | null {
  const m = String(nome ?? '').match(/\((\d{4})\)/)
  return m ? Number(m[1]) : null
}

interface AniListMedia {
  idMal: number | null
  seasonYear?: number | null
  popularity?: number | null
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
}

interface Candidato {
  m: AniListMedia
  rank: number
  s: number
  anoOk: boolean
}

/**
 * Escolhe o mesmo candidato que o gerador do mapa escolhe.
 *
 * As duas cópias precisam concordar: o mapa embutido e o fallback de runtime
 * não podem classificar o mesmo título de jeitos diferentes.
 */
function escolherCandidato(
  alvo: string,
  ano: number | null,
  media: AniListMedia[] | null | undefined
): (Candidato & { aceita: boolean }) | null {
  const avaliados: Candidato[] = []
  ;(media || []).forEach((m, rank) => {
    if (!m || typeof m.idMal !== 'number' || !m.idMal) return
    const t = m.title ?? {}
    let s = 0
    for (const c of [t.romaji, t.english, t.native]) {
      if (c) s = Math.max(s, similaridade(alvo, normalizarNomeSerie(c)))
    }
    avaliados.push({ m, rank, s, anoOk: ano === null || m.seasonYear === ano })
  })
  if (!avaliados.length) return null

  // `Number(...)` porque `true - false` é erro de tipo em TypeScript.
  avaliados.sort(
    (a, b) => Number(b.anoOk) - Number(a.anoOk) || b.s - a.s || a.rank - b.rank
  )
  const top = avaliados[0]
  const aceita = top.s >= 0.62 || (top.rank === 0 && top.anoOk) || (top.anoOk && top.s >= 0.45)
  return { ...top, aceita }
}

async function consultarAniList(titulo: string, ano: number | null): Promise<string | null> {
  const query = `query ($s: String) {
    Page(page: 1, perPage: 6) {
      media(search: $s, type: ANIME, sort: SEARCH_MATCH) {
        idMal
        seasonYear
        popularity
        title { romaji english native }
      }
    }
  }`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { s: titulo } }),
      signal: ctrl.signal,
    })
    if (!res.ok) return null

    const json = (await res.json()) as { data?: { Page?: { media?: AniListMedia[] | null } } }
    const escolhido = escolherCandidato(titulo, ano, json.data?.Page?.media)
    return escolhido && escolhido.aceita ? String(escolhido.m.idMal) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Registro por vez, para o mapa estático. Devolve null se não houver. */
export function malIdParaSerie(nome: string | null | undefined): string | null {
  if (!nome) return null
  const chave = normalizarNomeSerie(nome)
  if (!chave) return null
  return MAL_ID_POR_NOME[chave] ?? null
}

/**
 * Versão assíncrona: mapa embutido primeiro, AniList só quando o mapa não
 * conhece a série. Nunca rejeita.
 */
export async function resolverMalId(nome: string | null | undefined): Promise<string | null> {
  if (!nome) return null
  const chave = normalizarNomeSerie(nome)
  if (!chave) return null

  const doMapa = MAL_ID_POR_NOME[chave]
  if (doMapa) return doMapa

  const guardado = doCache(chave)
  if (guardado !== undefined) return guardado

  const remoto = await consultarAniList(chave, anoDoNomeSerie(nome))
  memoria.set(chave, remoto)
  gravarCache(chave, remoto)
  return remoto
}

export function totalSeriesComMalId(): number {
  return Object.keys(MAL_ID_POR_NOME).length
}