
# Arquitetura — Jungle Gaming Wagering & Wallet Backend

**Estado da documentação:** revisão de entrega, 30/10/2026. Este documento descreve decisões e evidências relatadas no desenvolvimento local; métricas observadas não constituem garantias de produção.

## 1. Objetivos e princípios

O sistema processa movimentações financeiras de carteiras de jogadores com ênfase em:

1. **Integridade financeira:** saldo, transação, Ledger e eventos persistidos de forma consistente.
2. **Idempotência:** reenvios HTTP e reentregas SQS não devem reaplicar o mesmo efeito financeiro.
3. **Concorrência segura:** modificações na mesma carteira precisam respeitar bloqueios e invariantes.
4. **Rastreabilidade:** registrar movimentações, referências externas e eventos de integração.
5. **Recuperação:** distinguir falhas transitórias e permanentes, com retry e DLQ.
6. **Reprodutibilidade local:** PostgreSQL, LocalStack, Docker Compose e suítes automatizadas.

O **PostgreSQL é a fonte de verdade**. SQS desacopla recepção e publicação de mensagens, mas não substitui transações, constraints ou idempotência de negócio.

## 2. Componentes e camadas

| Camada | Responsabilidade | Exemplos |
| --- | --- | --- |
| Domain | Invariantes, entidades e valores monetários | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction` |
| Application | Casos de uso, coordenação transacional e consultas | `ProcessWagerTransaction`, consultas financeiras |
| Infrastructure | Persistência, filas, workers e integração | MikroORM, PostgreSQL, SQS, Inbox, Outbox |
| Interfaces | Entrada HTTP, validação e tratamento de erros | Controllers, DTOs, pipes e filtros |

### Visão lógica

```text
                         +----------------------+
                         |      Cliente HTTP    |
                         +----------+-----------+
                                    |
                                    v
                         +----------------------+
                         | NestJS / Controllers |
                         | DTOs / Validation   |
                         +----------+-----------+
                                    |
                                    v
+------------------+     +----------------------+     +------------------+
| SQS FIFO entrada | --> | Consumer / Use Case  | --> | PostgreSQL       |
| wager-transactions|    | ProcessWagerTransaction |   | Wallet / Ledger  |
+------------------+     +----------------------+     | Transactions     |
                                                     | Inbox / Outbox   |
                                                     +---------+--------+
                                                               |
                                                               v
                                                     +------------------+
                                                     | Outbox Publisher |
                                                     +---------+--------+
                                                               |
                                                               v
                                                     +------------------+
                                                     | SQS eventos FIFO |
                                                     +------------------+
```

O desenho é conceitual: API e consumer reutilizam o processamento de negócio; o publisher trabalha de forma assíncrona sobre registros Outbox persistidos.

## 3. Fluxos transacionais

### 3.1 Requisição HTTP

```text
POST /wagering/transactions
  -> validação do DTO e cabeçalho Idempotency-Key
  -> caso de uso de processamento
  -> transação PostgreSQL
       -> verificar chave/referência e eventual conflito
       -> serializar acesso concorrente à carteira
       -> validar invariantes monetárias e de negócio
       -> atualizar saldo e gravar transação + Ledger
       -> persistir eventos Outbox relacionados
  -> commit
  -> resposta HTTP
```

Uma falha antes do commit deve impedir a persistência parcial dos efeitos financeiros associados à transação.

### 3.2 Mensagem SQS de entrada

```text
SQS FIFO (wager-transactions.fifo)
  -> consumer / polling
  -> parse e validação do envelope
  -> transação PostgreSQL
       -> Inbox: eventId, deduplicação e conflito de payload
       -> processamento financeiro
       -> marcação do evento como processado
  -> commit
  -> confirmação / remoção da mensagem
```

- **Falha transitória:** a mensagem pode permanecer sem ACK e voltar após o timeout de visibilidade.
- **Falha permanente:** o consumer pode encaminhar para a DLQ conforme a classificação de erros.
- **Reentrega:** o controle persistido de Inbox/idempotência deve evitar reaplicação financeira.

O SQS oferece entrega com possibilidade de repetição; a aplicação não presume entrega única.

### 3.3 Publicação de eventos pelo Outbox

```text
Transação financeira
  -> INSERT de eventos Outbox na mesma transação
  -> COMMIT
  -> publisher periódico (~5 segundos)
  -> SELECT de pendentes com FOR UPDATE SKIP LOCKED
  -> lote de até 100 registros
  -> publicação na fila SQS de eventos
  -> marcação de published_at / controle de tentativas
```

Na implementação examinada durante o desenvolvimento, o publisher utiliza transação e bloqueio de registros com `FOR UPDATE SKIP LOCKED`, faz envios SQS sequenciais dentro do lote e registra publicação após sucesso. O controle de tentativas prevê recuperação de falhas e backoff.

**Garantia e ressalva:** o padrão evita publicar antecipadamente eventos de uma transação financeira revertida. Uma falha entre o envio ao SQS e a confirmação local pode causar republicação; consumidores de eventos também precisam ser idempotentes. Não há transação distribuída entre PostgreSQL e SQS.

## 4. Decisões arquiteturais

### 4.1 PostgreSQL e atomicidade

**Decisão:** manter saldo, Ledger, transações, Inbox e Outbox no armazenamento relacional transacional.

**Motivo:** commits atômicos, unicidade e mecanismos de lock adequados à consistência financeira.

**Trade-off:** dependência da disponibilidade do banco, contenção em carteiras concorridas e possível necessidade de retries por conflito/deadlock.

### 4.2 Valores monetários decimais

**Decisão:** encapsular valores em `Money`, utilizando Decimal.js.

**Motivo:** evitar arredondamentos típicos de ponto flutuante binário e centralizar regras de moeda/precisão.

**Invariante:** valores de movimentação devem ser estritamente positivos (`greaterThan(0)`); `isPositive()` isoladamente não é substituto adequado para essa regra.

**Trade-off:** conversão explícita nas fronteiras de API, banco e serialização.

### 4.3 Ledger e saldo materializado

**Decisão:** manter saldo corrente na carteira e trilha de lançamentos com saldos anterior/posterior.

**Motivo:** leitura eficiente do saldo sem perder rastreabilidade e base de reconciliação.

**Trade-off:** a consistência entre saldo e Ledger deve ser garantida na mesma transação. O saldo materializado não substitui o histórico.

### 4.4 Idempotência de negócio

**Decisão:** usar chaves de idempotência, referências externas e registros persistidos, independentemente da deduplicação FIFO.

**Motivo:** a deduplicação do transporte tem escopo e janela próprios; reenvios podem ocorrer fora dessa janela.

**Trade-off:** armazenamento adicional e necessidade de distinguir replay legítimo de reutilização da mesma chave com payload diferente.

### 4.5 Controle de concorrência

**Decisão:** coordenar operações por chave e utilizar transações/bloqueios no PostgreSQL para proteger a carteira.

**Motivo:** impedir efeitos simultâneos incompatíveis com o mesmo saldo.

**Trade-off:** maior latência sob contenção, espera por locks e possibilidade de deadlock. O throughput de uma carteira muito disputada não equivale ao throughput agregado de várias carteiras.

### 4.6 SQS FIFO

**Decisão:** usar grupos de mensagens para ordenar operações relacionadas.

**Motivo:** preservar ordenação dentro do `MessageGroupId` e oferecer deduplicação de transporte.

**Trade-off:** mensagens problemáticas podem atrasar as posteriores do mesmo grupo; não existe ordenação global entre grupos.

### 4.7 Transactional Inbox

**Decisão:** registrar identificador e hash do payload durante o processamento transacional.

**Motivo:** detectar reentregas e conflitos sem depender da memória do worker.

**Trade-off:** crescimento da tabela, necessidade de índices e política de retenção/limpeza.

### 4.8 Transactional Outbox

**Decisão:** persistir eventos de integração junto ao efeito financeiro e publicar posteriormente por worker.

**Implementado e observado:** publisher periódico, lotes, seleção com `FOR UPDATE SKIP LOCKED`, publicação SQS, controle de publicação e tentativas. Foi observado escoamento do backlog até zero em uma das verificações locais.

**Limitação:** a taxa de publicação observada (~20 eventos/s) não acompanha a geração de eventos em algumas cargas sustentadas. Melhorias de paralelismo, batching de envio e observabilidade permanecem futuras.

### 4.9 Retry e DLQ

**Decisão:** classificar erros e permitir reentrega ou encaminhamento à DLQ.

**Configuração local relatada:** `VisibilityTimeout=60s`, `maxReceiveCount=5` para a fila de entrada.

**Trade-off:** retries podem atrasar o grupo FIFO; DLQ exige monitoramento e replay cuidadoso. Testes devem considerar o tempo real de visibilidade da fila.

## 5. Contratos e endpoints

| Método | Caminho | Responsabilidade |
| --- | --- | --- |
| GET | `/health/live` | Liveness sem dependência do banco |
| GET | `/health/ready` | Readiness com `SELECT 1` no PostgreSQL |
| POST | `/wallets` | Criação de carteira |
| GET | `/wallets/:walletId` | Consulta de carteira |
| GET | `/wallets/:walletId/ledger` | Consulta do Ledger |
| POST | `/wallets/:walletId/reconciliation` | Solicitação de reconciliação |
| POST | `/wagering/transactions` | Processamento de transação |
| GET | `/wagering/transactions/:transactionId` | Consulta por ID |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por referência externa |

No `main.ts` analisado, a aplicação configura `ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`, além de um filtro global de exceções de domínio. Não foi observado prefixo global `/api`. Os detalhes dos DTOs devem ser considerados a fonte primária dos contratos.

## 6. Garantias e fronteiras

| Propriedade | Mecanismo | Limitação |
| --- | --- | --- |
| Atomicidade financeira | Transação PostgreSQL | Não inclui automaticamente sistemas externos |
| Idempotência | Chaves, referências, Inbox e constraints | Depende de conflitos corretamente identificados |
| Consistência do Ledger | Mesma transação do saldo | Requer invariantes e reconciliação |
| Ordem de mensagens | FIFO por `MessageGroupId` | Sem ordem global |
| Entrega | SQS com retry/reentrega | Pode entregar mais de uma vez |
| Publicação de eventos | Transactional Outbox | Pode republicar após falha parcial de confirmação |
| Recuperação | Retry e DLQ | Exige operação e monitoramento |
| Disponibilidade | Health checks separados | Liveness não garante dependências saudáveis |

**Não declarar *exactly-once* para o sistema inteiro.** A garantia pretendida é **efeito financeiro idempotente** sobre uma infraestrutura de entrega potencialmente repetida.

## 7. Estratégia de testes

### 7.1 Comandos

```bash
bun run test
bun run test:integration
bun run test:e2e
bun run test:load
bun run lint
bun run typecheck
bun run build
```

### 7.2 Validação observada em 30/10/2026

| Suíte | Resultado | Exemplos de cobertura |
| --- | ---: | --- |
| Unitários | 26 aprovados (4 arquivos) | Regras e classificações isoladas |
| Integração | 10 aprovados (6 arquivos) | Ciclo financeiro, concorrência, SQS, idempotência, retry, DLQ |
| E2E | 2 aprovados | `GET /health/live`, `GET /health/ready` |
| **Total** | **38 aprovados** | — |
| Lint | 0 erros / 0 avisos | 53 arquivos |
| Typecheck | Sem erros | 57 arquivos |
| Build | Concluído | NestJS |

A recuperação por timeout de visibilidade pode levar aproximadamente 60 segundos. Métricas `ApproximateNumberOfMessages*` do SQS são aproximadas e globais à fila; não devem ser usadas isoladamente como prova de processamento de um evento específico.

### 7.3 Carga HTTP — k6

A última execução relatada utilizou **2 VUs durante 15 segundos**:

| Métrica | Valor observado |
| --- | ---: |
| Requisições | 1.162 |
| Vazão | 77,37 req/s |
| Erros HTTP | 0% |
| p50 | 16,72 ms |
| p95 | 50,56 ms |
| p99 | 112,70 ms |
| Máximo | 1,67 s |

Uma execução anterior registrou **3.118 requisições em 15 segundos (207,77 req/s)**, p50 de **7,37 ms**, p95 de **18,82 ms** e 0% de erros HTTP. Como as condições não foram padronizadas para comparação controlada, não se deve concluir que uma alteração específica provocou a diferença.

Os resultados representam o cenário local testado, não capacidade garantida de produção nem medida de escalabilidade horizontal.

### 7.4 Throughput e atraso do Outbox

O publisher passou de lotes de **20 para 100 registros**, mantendo execução periódica de aproximadamente **5 segundos**. Na observação local, o escoamento aumentou de cerca de **4 para 20 eventos/s** (5×). Os envios dentro do lote eram sequenciais.

A carga de `BET` observada gerou **dois eventos por requisição bem-sucedida**. Assim, 77,37 requisições/s podem representar aproximadamente **154,74 eventos/s** de entrada no Outbox, muito acima da vazão medida do publisher. A diferença provoca crescimento de backlog durante carga sustentada.

Em uma verificação, o backlog foi drenado a **zero**; em outras medições parciais após carga havia eventos pendentes, e as estatísticas de latência de publicação foram calculadas apenas sobre eventos já publicados. Por isso, não se deve tratar essas amostras parciais como percentis finais de toda a carga.

A fila SQS de eventos (`wager-events.fifo`) acumulou mensagens em uma execução sem consumidor de saída; isso é distinto de registros Outbox ainda não publicados.

## 8. Riscos e melhorias priorizadas

| Prioridade | Tema | Próxima ação recomendada |
| --- | --- | --- |
| Alta | Capacidade do Outbox | Avaliar envio SQS em lote, paralelismo controlado, múltiplos publishers e medição de throughput |
| Alta | Observabilidade | Métricas de backlog/idade do Outbox, tempo de publicação, DLQ, locks e latência |
| Alta | Operação de DLQ | Criar processo de inspeção, classificação, correção e replay idempotente |
| Alta | Segurança para produção | Autenticação/autorização, segredos, TLS, rate limiting e políticas de acesso |
| Média | Isolamento de testes | Filas e grupos dedicados, fixtures independentes e assertions por ID de evento |
| Média | Testes de resiliência | Reinício de worker, indisponibilidade do banco/SQS e recuperação de publicações |
| Média | Contratos de API | OpenAPI/Swagger, exemplos de erros e documentação de paginação |
| Média | Retenção de dados | Políticas para Inbox, Outbox, Ledger e auditoria conforme requisitos |
| Média | Deploy | Configuração por ambiente, health probes, alertas e migrações controladas |

Essas melhorias não devem ser confundidas com falhas nos testes concluídos: representam limites de escala, segurança e operação além do escopo local demonstrado.

## 9. Reprodutibilidade e evidências

- Scripts de execução e dependências: `package.json`.
- Exemplo de ambiente: `.env.example` (validar a presença de `SQS_CONSUMER_ENABLED`).
- Provisionamento SQS local: `docker/localstack/init-sqs.sh`.
- Testes de integração: `tests/integration/`.
- Testes E2E: `test/app.e2e-spec.ts`.
- Teste de carga: `tests/load/wagering.load.js` e `scripts/run-load.mjs`.
- Resultados de carga, quando preservados: `tests/load/results/`.

Para reproduzir o ambiente, consulte o passo a passo do [README.md](./README.md). Recomenda-se executar as suítes de infraestrutura de forma sequencial e verificar a saúde do PostgreSQL e do LocalStack antes de iniciá-las.

## 10. Referências

- [MikroORM — Transactions](https://mikro-orm.io/docs/transactions)
- [PostgreSQL — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [AWS SQS — FIFO](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues.html)
- [AWS SQS — Visibility Timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [AWS SQS — Dead-Letter Queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [Idempotent Consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html)
