/**
 * Compatibilidade estimada por palavras-chave do currículo. É uma estimativa para ordenar a lista, não uma avaliação humana.
 * As listas vêm do perfil (padrão: o currículo do Leo; ou o currículo enviado na aba Filtros, lido pelo professor).
 */
export interface SkillPattern { name: string; pattern: string; weight: number }
export interface ScoreProfile {
  /** Stack principal: pelo menos uma precisa aparecer para a nota passar de 60. */
  core: SkillPattern[];
  /** O que soma. */
  skills: SkillPattern[];
  /** Exigências fora do currículo: descontam. */
  gaps: SkillPattern[];
}

export const DEFAULT_SCORE: ScoreProfile = {
  core: [
    { name: 'C#', pattern: '\\bC#', weight: 22 },
    { name: '.NET', pattern: '\\.NET\\b|\\bdotnet\\b|ASP\\.NET', weight: 22 },
  ],
  skills: [
    { name: 'AWS', pattern: '\\bAWS\\b|Amazon Web Services', weight: 6 },
    { name: 'Mensageria e eventos', pattern: '\\b(SQS|SNS|EventBridge|Kafka|RabbitMQ|event[- ]driven|message queue|pub\\/sub)\\b', weight: 6 },
    { name: 'Microsserviços', pattern: '\\bmicroservices?\\b|distributed systems?', weight: 6 },
    { name: 'SQL e PostgreSQL', pattern: '\\b(SQL|PostgreSQL|Postgres|SQL Server|relational)\\b', weight: 6 },
    { name: 'APIs REST', pattern: '\\b(REST|RESTful|APIs?)\\b', weight: 5 },
    { name: 'Pagamentos e fintech', pattern: '\\b(payments?|fintech|billing|ledger|financial)\\b', weight: 5 },
    { name: 'Docker e CI/CD', pattern: '\\b(Docker|CI\\/CD|GitHub Actions|containers?)\\b', weight: 4 },
    { name: 'React', pattern: '\\bReact\\b', weight: 4 },
    { name: 'Serverless', pattern: '\\b(Lambda|serverless)\\b', weight: 3 },
    { name: 'Liderança técnica', pattern: '\\b(mentor|tech(nical)? lead|lead a team)\\b', weight: 3 },
  ],
  gaps: [
    { name: 'Kubernetes', pattern: '\\b(Kubernetes|K8s)\\b', weight: 3 },
    { name: 'Java', pattern: '\\bJava\\b(?!Script)', weight: 5 },
    { name: 'Go', pattern: '\\b(Golang|Go)\\b(?=[,.;/) ]|$)', weight: 5 },
    { name: 'Python', pattern: '\\bPython\\b', weight: 4 },
    { name: 'Ruby', pattern: '\\b(Ruby|Rails)\\b', weight: 5 },
    { name: 'Rust', pattern: '\\bRust\\b', weight: 5 },
    { name: 'Scala ou Kotlin', pattern: '\\b(Scala|Kotlin)\\b', weight: 4 },
    { name: 'C++', pattern: '\\bC\\+\\+', weight: 4 },
    { name: 'Observabilidade', pattern: '\\b(observability|Prometheus|Grafana|OpenTelemetry|Datadog)\\b', weight: 2 },
  ],
};

const cache = new Map<string, RegExp | null>();
/** Regex a partir do padrão salvo. Padrão inválido nunca casa (e nunca derruba o radar). "Go" é sensível a caixa de propósito. */
export function skillRegex(pattern: string): RegExp | null {
  if (!cache.has(pattern)) {
    try { cache.set(pattern, new RegExp(pattern, /\\b\(Golang\|Go\)/.test(pattern) ? '' : 'i')); } catch { cache.set(pattern, null); }
  }
  return cache.get(pattern)!;
}
const hits = (list: SkillPattern[], hay: string) => list.filter((s) => skillRegex(s.pattern)?.test(hay));

export interface Fit { fit: number; matched: string[]; gaps: string[] }

export function scoreFit(title: string, text: string, profile: ScoreProfile = DEFAULT_SCORE): Fit {
  const hay = `${title}\n${text}`;
  const core = hits(profile.core, hay);
  const matched = hits(profile.skills, hay);
  const gaps = hits(profile.gaps, hay);

  let score = 20;
  score += core.reduce((a, s) => a + s.weight, 0);
  score += matched.reduce((a, s) => a + s.weight, 0);
  // Sem a stack principal, cada linguagem exigida fora do currículo pesa mais.
  const gapFactor = core.length > 0 ? 0.5 : 1;
  score -= gaps.reduce((a, s) => a + s.weight, 0) * gapFactor;
  if (profile.core.length > 0 && core.length === 0) score = Math.min(score, 60);

  return {
    fit: Math.max(5, Math.min(95, Math.round(score))),
    matched: [...core, ...matched].map((s) => s.name),
    gaps: gaps.map((s) => s.name),
  };
}
