# Jarvis Professor

Radar de vagas, dossiê de entrevista e professor de treino para entrevistas técnicas.

## Rodar

Precisa do Node 22.18 ou mais novo.

```
npm install
npm start
```

Abra http://localhost:4317.

## Ligar o professor (qualquer provedor de IA)

O professor (dossiê, entrevista, correção, aulas, exercícios) é um modelo de linguagem. Funciona com:

| Provedor | Chave no `.env` | Observação |
| --- | --- | --- |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | Único com busca na internet no dossiê: fontes e perguntas relatadas com link. |
| OpenAI (ChatGPT) | `OPENAI_API_KEY` | |
| DeepSeek | `DEEPSEEK_API_KEY` | |
| Groq | `GROQ_API_KEY` | |
| Mistral | `MISTRAL_API_KEY` | |
| OpenRouter | `OPENROUTER_API_KEY` | Muitos modelos com uma chave só. |
| Ollama (local) | nenhuma | `JARVIS_PROVIDER=ollama`, depois de `ollama pull <modelo>`. |
| Compatível com OpenAI | `JARVIS_API_KEY` | `JARVIS_PROVIDER=custom` e `JARVIS_BASE_URL=...` (LM Studio, vLLM, LiteLLM...). |

1. Copie `.env.example` para `.env` e preencha a chave do provedor que você usa. O `.env` fica fora do git.
2. Opcional: `JARVIS_PROVIDER` força um provedor; sem ele, vale o primeiro com chave preenchida. `JARVIS_MODEL` fixa um modelo.
3. `npm start`. O terminal mostra o provedor e o modelo em uso.

Sem `JARVIS_MODEL`, o app pergunta ao provedor quais modelos a sua chave acessa e escolhe um. A aba **Filtros** mostra o
provedor, a lista de modelos disponíveis e deixa trocar o modelo sem reiniciar (a escolha fica salva por provedor).

Fora do Anthropic não há busca na internet: o dossiê sai sem fontes e com confiança baixa, e nenhuma pergunta é rotulada
como relatada por candidato. Todo o resto funciona igual. Modelos pequenos ou locais podem falhar em devolver o JSON que
os prompts pedem; prefira modelos de ponta para o dossiê e os exercícios.

## Treino e simulado

- Em qualquer vaga do radar: "Abrir dossiê e treinar".
- O professor monta as etapas da entrevista da empresa e os conceitos de cada etapa.
- "Treinar esta etapa" abre a entrevista: o entrevistador pergunta em inglês, não dá a resposta e espera você.
- "Encerrar e avaliar" dá nota de 0 a 4 em correção, complexidade, casos de borda, comunicação e tempo, e explica o fundamento do que você errou.
- Um conceito fecha com dois acertos seguidos em dias diferentes; um erro reabre. A prontidão é a parte dos conceitos fechados.
- Com 70% de prontidão libera o simulado completo da empresa.

## Radar

- Lista de vagas com compatibilidade, salário, data, local e link de candidatura.
- Botão "Atualizar radar": lê as vagas direto das fontes públicas de cada empresa (Greenhouse, Lever, Ashby).
- Filtros que você muda na tela: Obrigatório, Preferência ou Desligado, com piso salarial, recência e palavras que eliminam.
- Lista de empresas: adicionar, ignorar, marcar sede nos EUA e processo conhecido.
- Status da candidatura por vaga.

Os dados ficam em `data/jarvis.db` (SQLite), só na sua máquina.

## Comandos

- `npm test`: testes do servidor.
- `npm run typecheck`: checagem de tipos.
- `npm run dev`: interface com recarga automática (rode `npm run server` em outro terminal).

## Estrutura

- `server/`: API, banco, coletores, filtros e compatibilidade.
- `web/`: interface em React.
