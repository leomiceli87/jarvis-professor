# Jarvis Professor

Radar de vagas, dossiê de entrevista e professor de treino para entrevistas técnicas.

## Rodar

Precisa do Node 22.18 ou mais novo.

```
npm install
npm start
```

Abra http://localhost:4317.

## Ligar o professor

O treino e o simulado são conduzidos pelo Claude. Copie `.env.example` para `.env`, cole a sua chave em
`ANTHROPIC_API_KEY=` e rode `npm start` de novo. O arquivo `.env` fica fora do git.

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
