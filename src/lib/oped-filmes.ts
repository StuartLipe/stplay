/* GERADO AUTOMATICAMENTE por oped-finder (tests/export_filmes.py).
 * NÃO editar à mão: rode o export de novo.
 * Créditos medidos e certificados (cert A) por filme.
 * Chave = título normalizado (minúsculo, sem acento/pontuação).
 */

export interface FilmeMarcas {
  credits: number
  duration: number
  /** Abertura medida (logos/abertura): pular para `end`. */
  op?: { start: number; end: number }
}

export const FILMES: Record<string, FilmeMarcas> = {
  'star wars 4': { credits: 7217.877, duration: 7484.81, op: { start: 0.0, end: 120.081 } },
  'star wars 5': { credits: 7332.992, duration: 7641.675, op: { start: 0.0, end: 140.059 } },
  'star wars episodio i a ameaca fantasma': { credits: 7793.494, duration: 8170.944, op: { start: 0.0, end: 113.033 } },
  'star wars episodio ii ataque dos clones': { credits: 8154.897, duration: 8547.861, op: { start: 0.0, end: 111.865 } },
  'star wars episodio iii a vinganca dos sith': { credits: 8027.269, duration: 8405.845, op: { start: 0.0, end: 109.612 } },
}
