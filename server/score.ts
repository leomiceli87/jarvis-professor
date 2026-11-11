/**
 * Compatibilidade estimada por palavras-chave do currículo do Leo.
 * É uma estimativa para ordenar a lista, não uma avaliação humana.
 */
interface Skill { name: string; re: RegExp; weight: number }

const CORE: Skill[] = [
  { name: 'C#', re: /\bC#/i, weight: 22 },
  { name: '.NET', re: /\.NET\b|\bdotnet\b|ASP\.NET/i, weight: 22 },
];

const SKILLS: Skill[] = [
  { name: 'AWS', re: /\bAWS\b|Amazon Web Services/i, weight: 6 },
  { name: 'Mensageria e eventos', re: /\b(SQS|SNS|EventBridge|Kafka|RabbitMQ|event[- ]driven|message queue|pub\/sub)\b/i, weight: 6 },
  { name: 'Microsserviços', re: /\bmicroservices?\b|distributed systems?/i, weight: 6 },
  { name: 'SQL e PostgreSQL', re: /\b(SQL|PostgreSQL|Postgres|SQL Server|relational)\b/i, weight: 6 },
  { name: 'APIs REST', re: /\b(REST|RESTful|APIs?)\b/i, weight: 5 },
  { name: 'Pagamentos e fintech', re: /\b(payments?|fintech|billing|ledger|financial)\b/i, weight: 5 },
  { name: 'Docker e CI/CD', re: /\b(Docker|CI\/CD|GitHub Actions|containers?)\b/i, weight: 4 },
  { name: 'React', re: /\bReact\b/i, weight: 4 },
  { name: 'Serverless', re: /\b(Lambda|serverless)\b/i, weight: 3 },
  { name: 'Liderança técnica', re: /\b(mentor|tech(nical)? lead|lead a team)\b/i, weight: 3 },
];

const GAPS: Skill[] = [
  { name: 'Kubernetes', re: /\b(Kubernetes|K8s)\b/i, weight: 3 },
  { name: 'Java', re: /\bJava\b(?!Script)/i, weight: 5 },
  { name: 'Go', re: /\b(Golang|Go)\b(?=[,.;/) ]|$)/, weight: 5 },
  { name: 'Python', re: /\bPython\b/i, weight: 4 },
  { name: 'Ruby', re: /\b(Ruby|Rails)\b/i, weight: 5 },
  { name: 'Rust', re: /\bRust\b/i, weight: 5 },
  { name: 'Scala ou Kotlin', re: /\b(Scala|Kotlin)\b/i, weight: 4 },
  { name: 'C++', re: /\bC\+\+/i, weight: 4 },
  { name: 'Observabilidade', re: /\b(observability|Prometheus|Grafana|OpenTelemetry|Datadog)\b/i, weight: 2 },
];

export interface Fit { fit: number; matched: string[]; gaps: string[] }

export function scoreFit(title: string, text: string): Fit {
  const hay = `${title}\n${text}`;
  const core = CORE.filter((s) => s.re.test(hay));
  const matched = SKILLS.filter((s) => s.re.test(hay));
  const gaps = GAPS.filter((s) => s.re.test(hay));

  let score = 20;
  score += core.reduce((a, s) => a + s.weight, 0);
  score += matched.reduce((a, s) => a + s.weight, 0);
  // Sem C#/.NET, cada linguagem exigida fora do currículo pesa mais.
  const gapFactor = core.length > 0 ? 0.5 : 1;
  score -= gaps.reduce((a, s) => a + s.weight, 0) * gapFactor;
  if (core.length === 0) score = Math.min(score, 60);

  return {
    fit: Math.max(5, Math.min(95, Math.round(score))),
    matched: [...core, ...matched].map((s) => s.name),
    gaps: gaps.map((s) => s.name),
  };
}
