import { existsSync, readFileSync } from 'node:fs';
import type { Store } from './db.ts';

/** As oito matérias comuns. A ordem é a da tela. */
export const MATERIAS = {
  arquitetura: 'Arquitetura',
  csharp_dotnet: 'C# e .NET',
  dados: 'Dados',
  apis_distribuidos: 'APIs e sistemas distribuídos',
  nuvem_operacao: 'Nuvem e operação',
  testes: 'Testes',
  algoritmos: 'Algoritmos',
  comportamental: 'Comportamental',
} as const;
export type Materia = keyof typeof MATERIAS;
const NIVEIS = ['pleno', 'senior', 'staff'] as const;
const FORMATOS = ['conceitual', 'codigo', 'design', 'comportamental'] as const;

/**
 * relatada: uma página diz que um candidato ouviu esta pergunta numa entrevista real.
 * comum: aparece em listas públicas de perguntas (GitHub, blogs, plataformas).
 */
export interface BankQuestion {
  id: number; materia: Materia; topico: string; texto: string; origem: 'relatada' | 'comum';
  empresa: string | null; fonte: string; fonteData: string | null; outrasFontes: string[];
  nivel: (typeof NIVEIS)[number]; formato: (typeof FORMATOS)[number];
}
export type BankInput = Omit<BankQuestion, 'id'>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY, materia TEXT NOT NULL, topico TEXT NOT NULL, texto TEXT NOT NULL, origem TEXT NOT NULL,
  empresa TEXT, fonte TEXT NOT NULL, fonte_data TEXT, outras_fontes TEXT NOT NULL DEFAULT '[]',
  nivel TEXT NOT NULL, formato TEXT NOT NULL, chave TEXT NOT NULL UNIQUE
);
`;

const STOP = new Set(('a an and are as at be by can do does for from how i if in into is it its of on or should the this to ' +
  'what when where which while who why will with would you your we me my describe explain tell give walk through between ' +
  'difference differences versus vs about use using used').split(' '));

/** Palavras que contam numa pergunta: sem caixa, pontuação, palavras vazias nem plural simples. */
export function tokens(text: string): string[] {
  return text.toLowerCase().replace(/c#/g, 'csharp').replace(/\.net/g, 'dotnet').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !STOP.has(w)).map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}
export const questionKey = (text: string): string => [...new Set(tokens(text))].sort().join(' ');

/** Duas perguntas são a mesma quando dividem quase todas as palavras que contam (Jaccard). */
export function similar(a: string | Set<string>, b: string | Set<string>, threshold = 0.8): boolean {
  const x = typeof a === 'string' ? new Set(tokens(a)) : a;
  const y = typeof b === 'string' ? new Set(tokens(b)) : b;
  if (x.size === 0 || y.size === 0) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= threshold;
}

/** Nome canônico antes dos dois pontos, como em "Two Sum: find…". */
const title = (t: string): string | null => {
  const m = t.match(/^([A-Z0-9][^:.?]{1,60}):\s/);
  return m ? m[1].trim().toLowerCase() : null;
};
const ALL = /\b(every|all)\b/i;

/**
 * Decide se duas perguntas são a mesma. Dentro da mesma empresa a régua é mais baixa (os relatos repetem o problema
 * com outras palavras); entre fontes diferentes é mais alta. Problemas com nomes canônicos diferentes nunca se juntam,
 * e "devolva todas" não é o mesmo que "devolva uma" (Word Ladder II contra Word Ladder).
 */
export function sameQuestion(a: { texto: string; empresa: string | null; words: Set<string> },
  b: { texto: string; empresa: string | null; words: Set<string> }): boolean {
  if (a.empresa !== b.empresa && a.empresa !== null && b.empresa !== null) return false;
  const ta = title(a.texto), tb = title(b.texto);
  if (ta && tb && ta !== tb) return false;
  if (ALL.test(a.texto) !== ALL.test(b.texto)) return false;
  return similar(a.words, b.words, a.empresa !== null && a.empresa === b.empresa ? 0.4 : 0.65);
}

/** Limpa uma entrada da pesquisa. Devolve null quando falta o essencial ou a fonte não é um link. */
export function cleanInput(q: any, companies: string[]): BankInput | null {
  const texto = String(q?.texto ?? '').replace(/\s+/g, ' ').trim();
  const fonte = String(q?.fonte ?? '').trim();
  if (!(q?.materia in MATERIAS) || texto.length < 12 || !/^https?:\/\/[^\s]+$/.test(fonte)) return null;
  // "Veeva Systems" é a Veeva da lista: aceita o nome da lista seguido de sufixo de razão social.
  const given = String(q?.empresa ?? '').trim().toLowerCase();
  const empresa = companies.find((c) => c.toLowerCase() === given)
    ?? companies.find((c) => given.startsWith(c.toLowerCase() + ' ')) ?? null;
  return {
    materia: q.materia as Materia,
    topico: String(q?.topico ?? '').trim() || MATERIAS[q.materia as Materia],
    texto,
    // Relatada sem empresa ainda vale (relato geral), mas precisa ter vindo marcada assim.
    origem: q?.origem === 'relatada' ? 'relatada' : 'comum',
    empresa,
    fonte,
    fonteData: /^\d{4}-\d{2}$/.test(String(q?.fonteData ?? '')) ? String(q.fonteData) : null,
    nivel: NIVEIS.includes(q?.nivel) ? q.nivel : 'senior',
    formato: FORMATOS.includes(q?.formato) ? q.formato : 'conceitual',
    outrasFontes: (Array.isArray(q?.outrasFontes) ? q.outrasFontes : [])
      .map((u: unknown) => String(u).trim()).filter((u: string) => /^https?:\/\/[^\s]+$/.test(u) && u !== fonte),
  };
}

export interface ImportResult { lidas: number; novas: number; duplicadas: number; invalidas: number }

export class Bank {
  store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(SCHEMA);
  }

  /**
   * Importa sem duplicar. A mesma pergunta com outra fonte vira fonte extra. Pergunta da mesma empresa é comparada
   * com as da empresa; uma relatada nunca se funde com a de outra empresa.
   */
  import(raw: unknown[]): ImportResult {
    const companies = this.store.companies().map((c) => c.name);
    const res: ImportResult = { lidas: raw.length, novas: 0, duplicadas: 0, invalidas: 0 };
    const all = this.list().map((q) => ({ q, words: new Set(tokens(q.texto)) }));
    const ins = this.store.db.prepare(
      `INSERT INTO questions (materia, topico, texto, origem, empresa, fonte, fonte_data, nivel, formato, chave, outras_fontes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of raw) {
      const q = cleanInput(r, companies);
      if (!q) { res.invalidas++; continue; }
      const words = new Set(tokens(q.texto));
      const twin = all.find(({ q: e, words: w }) => sameQuestion({ texto: e.texto, empresa: e.empresa, words: w }, { texto: q.texto, empresa: q.empresa, words }));
      if (twin) {
        this.merge(twin.q, q);
        res.duplicadas++;
        continue;
      }
      const key = `${q.empresa ?? ''}|${questionKey(q.texto)}`;
      const id = Number(ins.run(q.materia, q.topico, q.texto, q.origem, q.empresa, q.fonte, q.fonteData, q.nivel, q.formato, key,
        JSON.stringify(q.outrasFontes)).lastInsertRowid);
      all.push({ q: { ...q, id }, words });
      res.novas++;
    }
    return res;
  }

  /** Junta a fonte nova na pergunta que já existe. Relato de empresa ganha de lista genérica. */
  private merge(e: BankQuestion, q: BankInput): void {
    const upgrade = q.origem === 'relatada' && q.empresa !== null && e.empresa === null;
    const sources = new Set([e.fonte, ...e.outrasFontes, q.fonte, ...q.outrasFontes]);
    if (upgrade) {
      sources.delete(q.fonte);
      e.origem = 'relatada'; e.empresa = q.empresa; e.fonte = q.fonte; e.fonteData = q.fonteData;
    } else {
      sources.delete(e.fonte);
    }
    e.outrasFontes = [...sources];
    this.store.db.prepare('UPDATE questions SET origem = ?, empresa = ?, fonte = ?, fonte_data = ?, outras_fontes = ? WHERE id = ?')
      .run(e.origem, e.empresa, e.fonte, e.fonteData, JSON.stringify(e.outrasFontes), e.id);
  }

  importFile(path: string): ImportResult | null {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return this.import(Array.isArray(data) ? data : data.questions ?? []);
  }

  list(f: { materia?: string; empresa?: string; origem?: string; busca?: string } = {}): BankQuestion[] {
    const rows = this.store.db.prepare('SELECT * FROM questions ORDER BY materia, topico, id').all() as any[];
    const busca = f.busca?.trim().toLowerCase();
    return rows.map(toQuestion).filter((q) =>
      (!f.materia || q.materia === f.materia) &&
      (!f.empresa || q.empresa === f.empresa) &&
      (!f.origem || q.origem === f.origem) &&
      (!busca || q.texto.toLowerCase().includes(busca) || q.topico.toLowerCase().includes(busca)));
  }

  summary() {
    const all = this.list();
    const count = <K extends string>(key: (q: BankQuestion) => K | null) => {
      const m: Record<string, number> = {};
      for (const q of all) { const k = key(q); if (k) m[k] = (m[k] ?? 0) + 1; }
      return m;
    };
    return {
      total: all.length, materias: MATERIAS, porMateria: count((q) => q.materia),
      porEmpresa: count((q) => q.empresa), relatadas: all.filter((q) => q.origem === 'relatada').length,
    };
  }
}

function toQuestion(r: any): BankQuestion {
  return {
    id: r.id, materia: r.materia, topico: r.topico, texto: r.texto, origem: r.origem, empresa: r.empresa,
    fonte: r.fonte, fonteData: r.fonte_data, outrasFontes: JSON.parse(r.outras_fontes), nivel: r.nivel, formato: r.formato,
  };
}
