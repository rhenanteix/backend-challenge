<p align="center">
  <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSsX_LICuvCuBGhFpeM7s2e4cCSpHWCwJlQGHdFNEwuZw&amp;s=10" alt="Jungle Gaming" width="250" />
</p>

# Jungle Gaming — Wagering & Wallet Backend

Backend de desafio técnico para processamento de movimentações financeiras de carteiras de jogadores. O foco é **consistência financeira, idempotência, concorrência, rastreabilidade e processamento assíncrono resiliente**.

> **Escopo:** implementação e validação em ambiente local. As credenciais demonstrativas e a infraestrutura LocalStack **não** representam uma configuração de produção.

## Visão geral

- API HTTP com NestJS para criação e consulta de carteiras, transações e Ledger.
- Processamento financeiro transacional em PostgreSQL, com MikroORM.
- Operações de aposta e ciclo financeiro com proteção contra duplicação.
- Recepção assíncrona via AWS SQS FIFO (LocalStack no ambiente de desenvolvimento).
- **Inbox** para controle de reentregas e conflitos de mensagens.
- **Transactional Outbox** para persistir eventos junto à transação financeira e publicá-los posteriormente.
- Retry, tratamento de falhas e dead-letter queue (DLQ).
- Testes unitários, integração, E2E e carga.

## Stack

| Área | Tecnologia |
| --- | --- |
| Linguagem | TypeScript |
| Framework | NestJS |
| Banco de dados | PostgreSQL |
| ORM e migrations | MikroORM |
| Mensageria | AWS SQS FIFO, emulada por LocalStack |
| Infraestrutura local | Docker Compose |
| Testes | Vitest, Supertest e k6 |
| Scripts e dependências | Bun |

## Pré-requisitos

- Docker com suporte a Compose.
- Bun e Node.js compatíveis com as versões declaradas pelo projeto.
- AWS CLI opcional, para inspeção manual das filas.
- Portas locais necessárias disponíveis, em especial `3000`, `5432` e `4566` quando utilizadas pelo Compose.

## Início rápido

### 1. Instalar e configurar

```bash
bun install
cp .env.example .env
```

Revise o `.env` de acordo com o `docker-compose.yml`/`compose.yml` utilizado. Os valores abaixo são **exemplos de desenvolvimento local**, não segredos de produção:

```dotenv
NODE_ENV=development
PORT=3000

DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=jungle_wagering
DATABASE_USER=jungle
DATABASE_PASSWORD=jungle_dev_password

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SQS_ENDPOINT=http://localhost:4566
SQS_QUEUE_NAME=wager-transactions.fifo
SQS_DLQ_NAME=wager-transactions-dlq.fifo
SQS_CONSUMER_ENABLED=true
```

> `SQS_CONSUMER_ENABLED` é utilizado no worker. **Confira se essa variável está presente no `.env.example` do repositório**; caso não esteja, inclua-a na configuração local. A configuração exata de execução do consumer deve ser conferida no módulo de mensageria.

### 2. Iniciar dependências e migrar o banco

```bash
docker compose up -d
bun run db:migrate
```

A inicialização das filas locais está associada ao script `docker/localstack/init-sqs.sh`. Confira os logs do LocalStack se as filas não forem provisionadas:

```bash
docker compose ps
docker compose logs localstack
```

O nome do serviço no comando de logs deve corresponder ao declarado no arquivo Compose.

### 3. Iniciar a API

```bash
bun run start:dev
```

A aplicação usa `PORT` (padrão `3000`) e **não define prefixo global** de rotas no `main.ts` analisado.

Verifique a disponibilidade:

```bash
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
```

`/health/live` retorna `{ "status": "ok" }`; `/health/ready` consulta o PostgreSQL e retorna `{ "status": "ready", "database": "up" }` quando disponível, ou HTTP 503 quando a verificação falha.

## Endpoints HTTP

| Método | Rota | Finalidade |
| --- | --- | --- |
| `GET` | `/health/live` | Liveness |
| `GET` | `/health/ready` | Readiness do PostgreSQL |
| `POST` | `/wallets` | Criar carteira |
| `GET` | `/wallets/:walletId` | Consultar carteira |
| `GET` | `/wallets/:walletId/ledger` | Consultar lançamentos |
| `POST` | `/wallets/:walletId/reconciliation` | Solicitar reconciliação |
| `POST` | `/wagering/transactions` | Processar transação |
| `GET` | `/wagering/transactions/:transactionId` | Consultar transação |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar por referência externa |

Os DTOs e controllers são a referência para validações, formatos de resposta, paginação e códigos de erro.

### Exemplo: criar carteira

```bash
curl -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "8c2578d1-9bc8-4f38-98f8-0f7e90d5422a",
    "currency": "BRL",
    "initialBalance": "100.00"
  }'
```

Guarde o identificador retornado e substitua `WALLET_UUID` no exemplo seguinte.

### Exemplo: processar uma aposta (`BET`)

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-bet-001' \
  -d '{
    "providerId": "jungle-provider",
    "externalTransactionId": "example-bet-001",
    "playerId": "8c2578d1-9bc8-4f38-98f8-0f7e90d5422a",
    "walletId": "WALLET_UUID",
    "roundId": "round-001",
    "gameId": "slot-001",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }'
```

O endpoint HTTP exige `Idempotency-Key`; a chave é normalizada nas extremidades e valores vazios ou superiores a 255 caracteres são rejeitados. Reenvios e conflitos são tratados pela lógica de idempotência e pelas restrições de persistência.

## Mensageria local

| Recurso | Configuração observada |
| --- | --- |
| Fila de entrada | `wager-transactions.fifo` |
| DLQ de entrada | `wager-transactions-dlq.fifo` |
| Timeout de visibilidade | 60 segundos |
| `maxReceiveCount` | 5 |
| Eventos publicados pelo Outbox | Fila de eventos separada (`wager-events.fifo`, no ambiente validado) |

O consumidor valida o envelope, controla reentregas via Inbox e só confirma a mensagem após o processamento apropriado. Falhas transitórias podem resultar em nova entrega; mensagens inválidas podem ser encaminhadas à DLQ. A publicação do Outbox ocorre após o commit financeiro.

> A fila de eventos publicada pelo Outbox não deve ser confundida com a fila de entrada. Na execução de carga analisada, **não havia consumidor configurado para drenar a fila de eventos**; o acúmulo nessa fila não significa, por si só, falha na publicação do Outbox.

## Testes e qualidade

Mantenha PostgreSQL e LocalStack disponíveis para os testes que dependem de infraestrutura. Alguns cenários de integração também dependem do consumer ativo; evite executar múltiplas suítes simultaneamente contra a mesma fila.

```bash
# Testes unitários
bun run test

# Integração (PostgreSQL + SQS)
bun run test:integration

# E2E (inclui /health/live e /health/ready)
bun run test:e2e

# Carga HTTP (k6/Docker)
bun run test:load

# Verificações estáticas e compilação
bun run lint
bun run typecheck
bun run build

git diff --check
```

### Resultado da validação final — 30/10/2026

| Verificação | Resultado observado |
| --- | --- |
| Unitários | **26 aprovados** em 4 arquivos |
| Integração | **10 aprovados** em 6 arquivos |
| E2E | **2 aprovados** (`/health/live` e `/health/ready`) |
| **Total** | **38 testes aprovados** |
| Lint | 0 erros, 0 avisos (53 arquivos) |
| Typecheck | Sem erros (57 arquivos) |
| Build NestJS | Concluído |
| `git diff --check` | Sem apontamentos |

Os cenários cobrem ciclo `BET → WIN → REFUND`, `ROLLBACK`, idempotência, concorrência, recuperação por retry, tratamento de JSON inválido/DLQ, configuração de fila e disponibilidade da API. O cenário de retry pode aguardar aproximadamente um minuto devido ao timeout de visibilidade.

### Resultados de carga (k6)

Resultados **observados em execuções locais**, não metas de SLA ou benchmark de produção:

| Métrica | Última execução relatada |
| --- | ---: |
| VUs | 2 |
| Duração | 15 s |
| Requisições HTTP | 1.162 |
| Throughput | 77,37 req/s |
| Erros HTTP | 0% |
| Latência p50 | 16,72 ms |
| Latência p95 | 50,56 ms |
| Latência p99 | 112,70 ms |
| Latência máxima | 1,67 s |

Uma execução anterior observou **3.118 requisições / 15 s (207,77 req/s)**, com p95 de **18,82 ms** e 0% de erros HTTP. As condições entre execuções não foram controladas para comparação causal; portanto, **não se atribui a diferença de throughput exclusivamente à mudança do Outbox**.

No publisher do Outbox, o aumento do lote de **20 para 100** registros foi acompanhado de aumento da vazão observada de aproximadamente **4 para 20 eventos/s**. Isso ainda é inferior à taxa de geração de eventos sob carga sustentada: uma `BET` bem-sucedida gerou dois eventos nos cenários analisados. O backlog pode crescer temporariamente, exigindo monitoramento e dimensionamento para cargas superiores.

Veja [ARCHITECTURE.md](./ARCHITECTURE.md) para interpretação das garantias e limitações.

## Comandos operacionais

```bash
bun run db:status
bun run db:migrate
bun run db:rollback
bun run start:prod
```

`start:prod` requer build prévio e variáveis de ambiente apropriadas. **Não execute rollback em um banco com dados relevantes sem avaliar o efeito da migration.**

## Estrutura e decisões

A solução separa domínio, aplicação, infraestrutura e interfaces HTTP. O PostgreSQL é a fonte de verdade financeira; o SQS é um mecanismo de entrega **at-least-once** e a idempotência de negócio protege contra efeitos duplicados. O padrão Outbox reduz a janela de inconsistência entre commit financeiro e publicação assíncrona, sem transformar o sistema inteiro em *exactly-once*.

Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para fluxos, decisões, limites, evidências de testes e melhorias futuras.

## Limitações de escopo

- O ambiente apresentado utiliza credenciais de teste e LocalStack.
- Autenticação/autorização, gestão de segredos, TLS, rate limiting e observabilidade de produção requerem avaliação adicional.
- O publisher Outbox demonstrou funcionamento e escoamento de backlog, mas a vazão observada não acompanha cargas HTTP intensas de forma sustentada.
- A operação de DLQ exige procedimentos de inspeção e replay controlado.
- As métricas de carga não representam capacidade garantida em produção.

## Referências

- [NestJS — Validation](https://docs.nestjs.com/techniques/validation)
- [MikroORM — Transactions](https://mikro-orm.io/docs/transactions)
- [PostgreSQL — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [AWS SQS — FIFO](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues.html)
- [AWS SQS — Visibility Timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [AWS SQS — DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [LocalStack — SQS](https://docs.localstack.cloud/aws/services/sqs/)
- [Vitest](https://vitest.dev/guide/)
- [Decimal.js](https://mikemcl.github.io/decimal.js/)
- [Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [Idempotent Consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html)

## Licença e uso

Projeto de desafio técnico para avaliação. Consulte as condições de uso e distribuição definidas pelo responsável pelo repositório.
