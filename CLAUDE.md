# Jarvis Professor

Sistema pessoal do Leo (Leonardo Miceli, canadense, Toronto, dev .NET sênior) para conseguir vaga 100% remota em
empresa dos EUA: radar de vagas, dossiê da entrevista, professor que treina e avalia, simulado completo por vaga.
Leo tem dislexia e TDAH. O treino só começa com o sistema pronto.

## Regras de trabalho

- Responder ao Leo em português. Conteúdo de entrevista (perguntas, respostas, código) em inglês.
- Ser propositivo: escolher uma proposta e seguir, sem cardápio de opções.
- Nunca colocar atribuição ou propaganda de ferramenta de IA em commits, PRs, documentos ou arquivos. Só a marca GBK17.com é permitida.
- Não enviar candidaturas, mensagens nem e-mails pelo Leo, e não criar contas. Rascunhar, sim.
- Não digitar nem imprimir chaves. A chave do Claude fica em `.env` (fora do git), colada pelo Leo.
- O Claude é o único cérebro (pergunta, ensina, avalia). Modelos de voz são só ouvido e boca.
- Cada fase só é entregue com testes passando e com o que não foi verificado dito claramente.

## Rodar

Node 22.18+. `npm install`, `npm start`, abrir http://localhost:4317. Depois de mudar código do servidor, reiniciar.
Voz local (opcional, Apple Silicon): instalar uma vez conforme `voice/README.md`; o `npm start` sobe a voz junto.
`npm test` (79 testes, fuso fixo America/Toronto; um deles roda `dotnet test` de verdade), `npm run typecheck`, `npm run dev` (interface com recarga; `npm run server` em outro terminal).

## Arquitetura

- Um único pacote TypeScript. Servidor em `server/` rodando direto no Node (type stripping, por isso imports com `.ts`,
  sem enums nem parameter properties). Sem framework: `node:http` e `node:sqlite`. Banco em `data/jarvis.db`.
- Interface React + Vite em `web/`, servida pelo próprio servidor a partir de `web/dist`.
- `server/collectors/`: Greenhouse, Lever, Ashby e Workday (APIs públicas, sem chave). `radar.ts` grava e deduplica.
  Workday: identificador `tenant|wdN|site` (Omnissa `omnissa|wd501|Omnissa_External_Career_Site`, DraftKings
  `draftkings|wd1|DraftKings`); lista por POST paginado, detalhe só das vagas com título de engenharia. A data é o
  `startDate` do Workday (bate com o "Posted N Days Ago"), que pode ser bem anterior à data de republicação no LinkedIn.
- `server/classify.ts`, `salary.ts`, `score.ts`: remoto, Canadá, senioridade, salário e compatibilidade por palavras-chave.
- `server/filters.ts`: cada filtro é obrigatorio, preferencia ou desligado. Obrigatório esconde; preferência só ordena.
- `server/training.ts` + `prompts.ts` + `llm.ts`: dossiê, sessão de entrevista, avaliação, prontidão, simulado completo.
  O dossiê usa a busca na internet do Claude (`web_search_20260209`, até 8 buscas). Pergunta "relatada" só fica com esse
  rótulo se a URL estiver entre as páginas que a busca devolveu; senão vira "gerada". Sem fonte real, confiança baixa.
  Dossiê com mais de 90 dias aparece como vencido.
  Aula pós-entrevista (`debrief`, `DEBRIEF_SYSTEM`, coluna `sessions.debrief`): só depois da avaliação, o professor repassa
  cada pergunta (o que o Leo disse, o que faltou, resposta modelo em inglês) e escreve uma aula falada em português de 450 a
  750 palavras. Gera uma vez por sessão. Não mexe em conceitos nem notas. Botões "Ouvir a avaliação", "Ouvir a resposta
  modelo" e "Ouvir a aula" na tela da sessão. O entrevistador continua sem dar resposta durante a entrevista.
- `server/bank.ts`: banco de perguntas (tabela `questions`), carregado de `data/perguntas.json` a cada início, sem duplicar.
  Cada pergunta tem matéria, tópico, origem (relatada ou comum), empresa, fonte com link e data. Duplicata: mesma empresa
  a partir de 0,4 de semelhança de palavras, entre fontes a partir de 0,65; nomes canônicos diferentes nunca se juntam.
  `scripts/build-bank.ts <pasta>` junta arquivos de pesquisa, confere os links e regrava `data/perguntas.json`.
- `server/review.ts`: repetição espaçada (FSRS-4.5, pesos padrão, retenção 90%, intervalo máximo 180 dias) sobre o banco.
  Bloco do dia de até 12 perguntas: revisões vencidas primeiro, depois até 8 novas por dia, priorizando relatadas de
  empresas onde o Leo está com status "enviada" ou "entrevista", depois pontos fracos e algoritmos. Errou: volta em 10 min.
  O Claude corrige cada resposta de 0 a 4 (`REVIEW_SYSTEM`); só 3 ou 4 contam como acerto. Tabelas `cards` e `review_log`.
- `voice/server.py`: voz local com mlx-audio 0.6.4 em `voice/.venv` (Python 3.12). Whisper large-v3-turbo ouve
  (tokenizador vem de `openai/whisper-large-v3-turbo`), Kokoro-82M fala (`af_heart` em inglês, `pf_dora` em português,
  precisa do pacote `misaki`). Só em 127.0.0.1:4319. Fala frase a frase; a legenda divide o tempo da frase pelas palavras.
  `server/voice.ts` sobe o processo e repassa `/api/voice`, `/api/voice/stt`, `/api/voice/tts`. A ferramenta Aikido
  safe-chain do Mac bloqueia pacotes publicados há poucos dias; não desligar, usar a versão que ela libera.
- `server/exercise.ts`: exercícios de código. O Claude escreve enunciado, esqueleto (`namespace Exercise`, métodos com
  NotImplementedException) e testes xUnit (`EXERCISE_SYSTEM`); só é aceito se compilar junto, falhar no esqueleto e não usar
  disco, rede, processos ou ambiente (uma nova chance com o erro do compilador). O código do Leo roda com `dotnet test`
  (net8.0, xUnit 2.9.3, runner 2.8.2, Test SDK 17.14.1, já no cache do NuGet: restaura sem rede) em `data/exercicio/`,
  um por vez, 60 s de limite. Tudo passando entra no FSRS: 1 tentativa = fácil, até 3 = bom, mais = difícil; desistir = erro.
  "Compilar" só faz `dotnet build` (não conta tentativa) e devolve a linha do erro, que o editor marca. Editor: CodeMirror 6
  com o modo C# legado (`web/src/Editor.tsx`). O exercício abre dentro do Treino do dia (`web/src/Exercicio.tsx`), com os
  testes em palavras ("Add · two positives · returns sum"); a tela "Código" usa o mesmo componente.
- `server/help.ts`: "Estou confuso" em três degraus (`HELP_SYSTEM`), para exercício e pergunta aberta. 1 entender a pergunta
  (grátis); 2 dica de abordagem (acerto vale no máximo "bom"); 3 resolução guiada (no exercício, tudo passando vale "difícil";
  na pergunta aberta, já conta como erro e mostra a resposta modelo). Cada degrau é gerado uma vez por exercício (`exercises.ajudas`);
  "Refazer do zero" volta ao esqueleto e zera tentativas e ajudas.
- `server/quiz.ts`: múltipla escolha gerada pelo professor (`QUIZ_SYSTEM`) só para perguntas conceituais, tabela `quizzes`,
  uma por pergunta, alternativas embaralhadas e a certa nunca vai para a tela antes da escolha. Acerto vale 3 ("bom"), erro 1.
  Na tela, "Modo rápido" (lembrado no navegador), teclas 1 a 4, explicação de cada alternativa depois. Rotulada como gerada.
- `server/progress.ts` + `server/day.ts`: o jogo. Dia é sempre o dia local (`localDay`), nunca UTC. Semana de segunda a
  domingo, meta de 4 dias com treino (resposta no Treino do dia, exercício ou sessão avaliada); sequência = semanas seguidas
  com a meta batida (a atual só conta depois de bater). Módulos = as 8 matérias, 4 níveis por parte de perguntas firmes
  (FSRS espaça 7+ dias e o último resultado foi acerto): 5%, 15%, 35%, 60%. Vagas: etapa acende quando todos os conceitos
  fecham. Tela de acerto (`web/src/Acerto.tsx`) no fim do bloco do dia, quando todos os testes passam, quando um conceito
  fecha ou a etapa é aprovada, e mostra o que acendeu (módulo, etapa, meta da semana, simulado liberado).
- `server/followup.ts`: candidaturas. A data (`jobs.applied_at`) é gravada na primeira vez que a vaga vira "enviada".
  Lembretes no dia 0, 5 e 12 (dia local); param quando vira "entrevista" ou "descartada". O Claude escreve nota de LinkedIn
  (até 300 caracteres) e e-mail com assunto (`FOLLOWUP_SYSTEM`), só com fatos do perfil. O app nunca envia nada:
  o Leo copia, manda e marca "Enviei".
- `server/llm.ts`: o pedido à API tem piso de 16.000 `max_tokens`. O modelo raciocina antes de responder e, com limite
  baixo, pode gastar tudo pensando e voltar vazio (parada `max_tokens`). O tamanho da resposta é controlado pelos prompts.
- `server/app.ts`: rotas da API. `server/seed.ts`: 16 empresas e as 21 vagas levantadas à mão em 9 nov 2026.

## Regras do treino (não mudar sem o Leo pedir)

- O entrevistador nunca dá a resposta. Uma pergunta por vez, em inglês, no formato real da empresa.
- Nota de 0 a 4 em correção, complexidade, casos de borda, comunicação e tempo.
- Conceito fecha com dois acertos seguidos em dias diferentes. Qualquer erro reabre.
- Prontidão = conceitos fechados / total. Simulado completo libera com 70%.
- Pergunta relatada por candidato e pergunta gerada no formato precisam ficar rotuladas como tal.

## Visual

Painel escuro em duas cores. Tokens em `web/src/styles.css`: fundo #070B0F, painel #0E151B, texto #D9E6EC,
apagado #8AA0AE, ciano #45D0E6 (único destaque, usado com escassez), erro #F2A65A, acerto #5FD39A.
Fontes: Atkinson Hyperlegible (texto), Lexend (títulos), JetBrains Mono (rótulos). Espaçamento 8/16/24/32/48.
Sem decoração perto do conteúdo, um destaque por tela, frases curtas, blocos de 25 a 40 minutos.

## Estado em 11 nov 2026

Feito e testado: Radar, Filtros, Empresas, status de candidatura, Treino por etapa, avaliação, simulado completo (texto),
dossiê com pesquisa na internet (fonte, data e confiança por pergunta; refazer após 90 dias), banco de perguntas
(tela "Perguntas").

Banco de perguntas em 11 nov: 1.140 perguntas pesquisadas na internet (GitHub, PracHub, Hello Interview, LeetCode, Blind,
DataLemur, blogs, páginas de valores das empresas), 206 relatadas por candidatos, 203 links conferidos no ar.
Por matéria: algoritmos 213, nuvem e operação 204, APIs e sistemas distribuídos 157, C# e .NET 143, dados 135,
arquitetura 120, comportamental 100, testes 68. Sem relatos encontrados: Tilt, OPENLANE, BeyondTrust; Greenhouse e Muck Rack
têm 1. Glassdoor, LeetCode Discuss e Reddit bloqueiam leitura automática, então relatos só de lá ficaram de fora.
Treino do dia (tela "Treino do dia") verificado ao vivo em 11 nov: fila coerente e correção real do Claude em cerca de 6 s.
O registro de teste foi apagado. A regra dos conceitos do dossiê (dois acertos em dias diferentes) não mudou e é separada.

Voz local verificada em 11 nov: fala em inglês e português (cerca de 0,6 s por frase depois de aquecer), transcrição de ida
e volta exata em cerca de 2 s, legenda que avança com a fala. Botões "Ouvir a pergunta", "Responder falando",
"Ouvir a correção" e "Aula falada" (o Claude escreve cerca de 4 min em português; a voz lê parte por parte) no Treino do
dia; "Ouvir o entrevistador" e "Responder falando" na entrevista por etapa. Não testado: o microfone de verdade no
navegador do Leo (o teste usou áudio gerado), que pede permissão de microfone na primeira vez.

Exercícios de código (tela "Código", e botão no Treino do dia para perguntas de código) verificados em 11 nov: o Claude
gerou "Thread-Safe Counters" (3 classes, 13 testes) em cerca de 45 s; uma implementação parcial passou 8 de 13 em 1,3 s.
A tentativa de teste foi desfeita; o exercício ficou pronto para o Leo. O editor é uma caixa de texto (Tab vira 4 espaços,
Cmd+Enter roda), sem IntelliSense.

Jogo verificado em 11 nov numa cópia do banco com treino simulado (apagada depois): semana, sequência, módulos acesos por
nível e tela de acerto ao passar os 13 testes. Corrigido junto: a regra "dois acertos em dias diferentes" usava o dia UTC;
em Toronto, 18h e 20h do mesmo dia contavam como dias diferentes. Agora usa o dia local.

Candidaturas e Workday verificados em 11 nov: radar ao vivo com Omnissa (118 vagas, 41 de engenharia) e DraftKings (75 e 21);
a vaga manual da Omnissa se juntou à do Workday. Ela tem startDate 24 jun 2026 e ficou escondida pelo filtro obrigatório
de 14 dias: decisão do Leo se afrouxa a recência. Rascunho real do dia 5 gerado numa cópia do banco (apagada depois).
Corrigido junto: limite de tokens baixo fazia a API voltar vazia (piso de 16.000).

Verificado ao vivo no Mac do Leo em 11 nov: "Atualizar radar" (12 fontes OK, cerca de 865 vagas ativas). Corrigido: vaga manual
agora se junta com a vaga coletada mesmo com pontuação diferente no título, e o status passa para a versão do Canadá.
Vagas manuais com título genérico do LinkedIn (Muck Rack, Grafana, Affirm, Mercury, Stripe, Elastic) não têm par exato e ficam.

Verificado ao vivo em 11 nov com a chave do Leo: dossiê da Omnissa com busca (5 etapas, 7 perguntas relatadas com link do
PracHub e LeetCode, cerca de 2,5 min) e uma sessão de treino da etapa 2: o entrevistador usou a pergunta relatada, recusou dar
a resposta e a avaliação atualizou os conceitos. A sessão de teste foi apagada e o progresso zerado, porque quem respondeu foi
o assistente, não o Leo. Modelo padrão `claude-sonnet-5-5`, trocável por `JARVIS_MODEL` no `.env`.

Aula pós-entrevista verificada em 11 nov numa cópia do banco (apagada depois): sessão curta da etapa 1 da Omnissa, avaliação em
9 s, aula em 23 s com 1 pergunta repassada, resposta modelo de 139 palavras e aula de 7 parágrafos (605 palavras), tudo baseado
na transcrição real. Não ouvido pela voz na tela (o componente é o mesmo do Treino do dia).

Pergunta de código no Treino do dia verificada em 11 nov numa cópia do banco (apagada depois): exercício aberto na própria tela,
editor com cores e números de linha, "Compilar" marcou a linha 7 com `CS1002: ; expected`, degrau 1 da ajuda na tela, degrau 3
pela API em 15 s (7 parágrafos e solução de 51 linhas) e, com ela, os 11 testes passaram valendo "difícil" (volta em 1 dia).
Múltipla escolha gerada em 6 s para a pergunta de Kubernetes, com explicação por alternativa; não vista na tela, só pela API.

## Próximos passos

O plano original está completo. Ideias em aberto, sem ordem: Tilt e OPENLANE ainda sem fonte automática; mensagem de
agradecimento depois de cada entrevista; o treino de etapa puxar perguntas relatadas do banco além das do dossiê.
