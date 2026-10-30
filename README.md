
<p align="center">
  <img
    src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSsX_LICuvCuBGhFpeM7s2e4cCSpHWCwJlQGHdFNEwuZw&s=10"
    alt="Jungle Gaming"
    width="250"
  />
</p>

# Jungle Gaming — Wagering & Wallet Backend

Backend para processamento de transações financeiras de jogos, com foco em consistência de saldo, idempotência, rastreabilidade e processamento assíncrono confiável.

## Stack

- TypeScript
- NestJS
- PostgreSQL
- MikroORM
- AWS SQS FIFO (LocalStack para desenvolvimento)
- Docker Compose
- Vitest
- Bun

## Arquitetura

O projeto organiza suas responsabilidades em camadas:

- **Domain:** regras de negócio, Money, Wallet, transações e Ledger.
- **Application:** casos de uso, consultas e orquestração.
- **Infrastructure:** persistência, mensageria, workers e integrações.
- **Interfaces:** controllers HTTP, DTOs e validação.

O processamento financeiro é realizado dentro de transações de banco de dados para manter a consistência entre saldo, transação e lançamentos contábeis.

## Funcionalidades

- Criação e consulta de carteiras
- Consulta de lançamentos financeiros
- Processamento de BET e demais operações suportadas pelo domínio
- Idempotência por chave de requisição
- Controle de concorrência sobre carteiras
- Ledger financeiro
- Processamento assíncrono com SQS FIFO
- Inbox para controle de mensagens processadas
- Outbox para eventos de integração
- Retry para falhas transitórias
- Dead Letter Queue para mensagens não processáveis
- Reconciliação financeira
- Health checks

## Pré-requisitos

- Docker e Docker Compose
- Node.js compatível com o projeto
- Bun
- AWS CLI para testes manuais com LocalStack

## Configuração

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

Configure as variáveis de ambiente:

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

As credenciais apresentadas são destinadas exclusivamente ao ambiente local de desenvolvimento.

## Inicialização

### 1. Subir a infraestrutura

```bash
docker compose up -d
```

A infraestrutura disponibiliza PostgreSQL e LocalStack.

O script `docker/localstack/init-sqs.sh` provisiona:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`

A fila principal utiliza:

- FIFO habilitado
- Visibility timeout de 60 segundos
- Redrive policy com `maxReceiveCount=5`

### 2. Instalar dependências

```bash
bun install
```

### 3. Executar migrations

```bash
bun run db:migrate
```

Para consultar as migrations:

```bash
bun run db:status
```

### 4. Iniciar a aplicação

```bash
bun run start:dev
```

A aplicação estará disponível em:

`http://localhost:3000`

## Endpoints HTTP

| Método | Endpoint | Finalidade |
|---|---|---|
| GET | `/health/live` | Verificar disponibilidade do processo |
| GET | `/health/ready` | Verificar prontidão |
| POST | `/wallets` | Criar carteira |
| GET | `/wallets/:walletId` | Consultar carteira |
| GET | `/wallets/:walletId/ledger` | Consultar Ledger |
| POST | `/wallets/:walletId/reconciliation` | Executar reconciliação |
| POST | `/wagering/transactions` | Processar transação |
| GET | `/wagering/transactions/:transactionId` | Consultar transação |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar transação por referência externa |

## Exemplo de criação de carteira

```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "8c2578d1-9bc8-4f38-98f8-0f7e90d5422a",
    "currency": "BRL",
    "initialBalance": "100.00"
  }'
```

Utilize o identificador da carteira retornado na resposta para realizar transações.

## Exemplo de BET

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: bet-example-001" \
  -d '{
    "providerId": "jungle-provider",
    "externalTransactionId": "bet-example-001",
    "playerId": "8c2578d1-9bc8-4f38-98f8-0f7e90d5422a",
    "walletId": "SUBSTITUA_PELO_WALLET_ID",
    "roundId": "round-example-001",
    "gameId": "slot-example",
    "kind": "BET",
    "money": {
      "amount": "10.00",
      "currency": "BRL"
    }
  }'
```

A chave `Idempotency-Key` permite reconhecer requisições repetidas, evitando a duplicação de movimentações financeiras.

## Consistência financeira

O domínio utiliza um objeto `Money` baseado em Decimal para evitar operações monetárias com ponto flutuante binário.

As movimentações seguem regras de validação de:

- Valor positivo
- Moeda compatível
- Saldo suficiente
- Identidade da carteira e do jogador
- Consistência da transação

Cada movimentação financeira registra seu efeito no Ledger, permitindo auditoria e reconciliação.

## Idempotência e concorrência

O processamento utiliza identificadores externos e chaves de idempotência para reconhecer operações repetidas.

A persistência transacional e os mecanismos de bloqueio impedem que operações concorrentes alterem o mesmo saldo de maneira inconsistente.

## Processamento SQS

O consumidor recebe eventos de transação da fila FIFO.

Fluxo resumido:

1. Receber mensagem.
2. Validar envelope e payload.
3. Registrar ou consultar a mensagem no Inbox.
4. Executar o processamento financeiro.
5. Atualizar o estado do Inbox.
6. Confirmar a transação no banco.
7. Remover a mensagem da fila após o commit.

Falhas transitórias permitem uma nova tentativa de entrega.

Mensagens classificadas como permanentemente inválidas são encaminhadas para quarentena na DLQ.

O SQS também possui redrive policy configurada para mensagens que excedam o limite de recebimentos.

## Testes

### Testes unitários

```bash
bunx vitest run src tests/unit
```

### Testes de integração

Requerem PostgreSQL, LocalStack e o consumidor da aplicação em execução.

```bash
bunx vitest run \
  --config vitest.config.integration.ts
```

Os cenários de integração incluem:

- Ciclo financeiro de transações
- Idempotência
- Concorrência
- Resiliência do consumidor
- Retry e recuperação de dependências
- Disponibilidade da API

### Verificações estáticas

```bash
bunx tsc --noEmit
bun run lint
bun run build
```

## Decisões técnicas

### PostgreSQL como fonte de verdade

O banco de dados é responsável pela persistência consistente dos saldos e das movimentações.

### Ledger financeiro

Os lançamentos permitem verificar como o saldo de uma carteira foi formado.

### SQS FIFO

A fila FIFO fornece ordenação dentro de cada grupo de mensagens e recursos de deduplicação no transporte.

A idempotência financeira permanece garantida pela aplicação e pelo banco, não apenas pela fila.

### Inbox

Controla o processamento de mensagens e reduz o risco de efeitos duplicados em reentregas.

### Outbox

Permite persistir eventos de integração junto às operações de negócio.

A publicação efetiva desses eventos depende do mecanismo de despacho configurado na aplicação.

## Referências técnicas

O desenvolvimento foi acompanhado de pesquisas em documentações oficiais e discussões da comunidade, com foco em consistência financeira, concorrência, tipagem estática e mensageria confiável.

### Documentação oficial

- [NestJS — Validation](https://docs.nestjs.com/application/validation)
- [NestJS — Exception Filters](https://docs.nestjs.com/exception-filters)
- [TypeScript — Type Assertions](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions)
- [MikroORM — Transactions and Concurrency](https://mikro-orm.io/docs/transactions)
- [MikroORM — Migrations](https://mikro-orm.io/docs/migrations)
- [PostgreSQL — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL — INSERT / ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html)
- [AWS — SQS FIFO Queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues.html)
- [AWS — Visibility Timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [AWS — Dead-Letter Queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [LocalStack — SQS](https://docs.localstack.cloud/aws/services/sqs/)
- [Vitest — Guide](https://vitest.dev/guide/)
- [Decimal.js — API](https://mikemcl.github.io/decimal.js/)

### Discussões técnicas e padrões arquiteturais

- [Stack Overflow — TypeScript Generic Record Type](https://stackoverflow.com/questions/57280207/typescript-cannot-cast-down-to-generic-recordstring-string-type)
- [GitHub — Slonik Issue #452](https://github.com/gajus/slonik/issues/452)
- [Microservices.io — Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [Microservices.io — Idempotent Consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html)

### Critérios de implementação

As referências servem como base de estudo, investigação e comparação de alternativas. As decisões técnicas do projeto são validadas por testes automatizados, verificações estáticas e testes de integração com PostgreSQL e SQS via LocalStack.

## Observações

O ambiente Docker/LocalStack é destinado ao desenvolvimento e à execução local dos testes.

Antes de utilizar a solução em produção, é necessário configurar credenciais seguras, observabilidade, políticas de acesso e infraestrutura apropriada.


## Licença

Projeto desenvolvido como desafio técnico para avaliação.
