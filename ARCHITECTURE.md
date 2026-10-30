Arquitetura — Jungle Gaming Wagering & Wallet Backend
1. Objetivos e princípios
A solução prioriza integridade de saldos, rastreabilidade de movimentações e processamento idempotente de eventos financeiros. O PostgreSQL é a fonte de verdade para estado de carteiras e lançamentos; a fila SQS desacopla a recepção assíncrona da execução transacional.

Os objetivos principais são:
- Evitar lançamentos duplicados em requisições repetidas ou mensagens reentregues.
- Manter carteira, transação e Ledger consistentes na mesma operação de banco.
- Serializar modificações concorrentes sobre a mesma carteira.
- Registrar e recuperar falhas de integração sem perder a rastreabilidade.
- Permitir testes locais reprodutíveis com PostgreSQL e LocalStack.
2. Organização em camadas
Camada	Responsabilidade	Exemplos
Domain	Invariantes financeiras e entidades	Money, Wallet, WalletLedgerEntry, WagerTransaction
Application	Casos de uso e consultas	ProcessWagerTransaction, WagerQueries
Infrastructure	Persistência, mensageria e integração	MikroORM, consumidor SQS, Inbox/Outbox
Interfaces	Entrada e validação HTTP	Controllers, DTOs, pipes


A separação reduz o acoplamento entre regras financeiras e transporte HTTP/SQS. A infraestrutura ainda é uma implementação específica; não se pressupõe que todos os adaptadores possam ser substituídos sem trabalho adicional.
3. Fluxo de processamento
Requisição HTTP
Cliente
  -> Controller + validação
  -> Caso de uso ProcessWagerTransaction
  -> Transação PostgreSQL
      -> verificação de idempotência
      -> bloqueio/controle de concorrência
      -> validações de domínio
      -> atualização da carteira
      -> transação financeira + Ledger + registro de Outbox
  -> commit
  -> resposta
Evento SQS
SQS FIFO
  -> Consumer
  -> validação do envelope
  -> transação PostgreSQL
      -> Inbox (detecção de reentrega/conflito)
      -> processamento financeiro
      -> Inbox marcado como processado
  -> commit
  -> delete/ACK da mensagem
Em falhas transitórias, a mensagem não é confirmada e pode voltar a ficar visível. Em falhas classificadas como permanentes, o consumidor tenta encaminhar a mensagem para a DLQ antes de removê-la da fila principal.
4. Decisões e justificativas
4.1 PostgreSQL como fonte de verdade
Decisão: manter saldo, transações e lançamentos financeiros em um banco relacional transacional.

Benefício: operações atômicas e mecanismos explícitos de bloqueio e unicidade.

Trade-off: contenção de locks em carteiras muito disputadas; disponibilidade do banco torna-se crítica para a operação financeira.
4.2 Dinheiro com Decimal.js
Decisão: encapsular valores monetários em Money e usar aritmética decimal.

Benefício: evita erros típicos de ponto flutuante binário e centraliza validações de moeda e precisão.

Trade-off: conversão explícita nas bordas e necessidade de preservar escala/representação ao persistir e serializar.

Invariante relevante: movimentações exigem valor estritamente maior que zero; Decimal.isPositive() considera zero não negativo, portanto a comparação correta é greaterThan(0).
4.3 Ledger e saldo materializado
Decisão: registrar lançamentos de débito/crédito com saldos anterior e posterior, além do saldo atual na carteira.

Benefício: consultas rápidas ao saldo e trilha de auditoria para reconciliação.

Trade-off: a aplicação deve manter os dois modelos consistentes na mesma transação; o saldo materializado não deve ser tratado como substituto do histórico.
4.4 Idempotência no banco
Decisão: validar chaves de idempotência e referências externas na aplicação/persistência, independentemente da deduplicação do SQS.

Benefício: proteção contra reenvios HTTP e reentregas assíncronas além da janela de deduplicação do transporte.

Trade-off: armazenamento e consulta adicionais; conflitos de mesma chave com payload diferente exigem política explícita.
4.5 Controle de concorrência
Decisão: utilizar transações e bloqueios de banco no processamento financeiro; o caso de uso também usa mecanismos de serialização por chave.

Benefício: reduz o risco de dupla utilização do mesmo saldo sob concorrência.

Trade-off: espera por locks, possibilidade de deadlocks e necessidade de políticas de timeout/retry em carga elevada.
4.6 SQS FIFO e MessageGroupId
Decisão: receber transações por fila FIFO com grupos de mensagens.

Benefício: ordenação por grupo e deduplicação no transporte.

Trade-off: mensagens com falha podem bloquear as seguintes no mesmo grupo; FIFO não substitui idempotência de negócio nem transação de banco.
4.7 Inbox
Decisão: persistir o identificador da mensagem e seu hash de payload no contexto do processamento transacional.

Benefício: identificar reentregas, evitar reaplicação e detectar reutilização conflitante de identificadores.

Trade-off: crescimento de armazenamento e necessidade de política futura de retenção, limpeza e observabilidade.
4.8 Outbox
Decisão: persistir registros de eventos de integração associados às operações de negócio.

Benefício: base para publicação confiável após o commit, evitando publicação antecipada de eventos de transações revertidas.

Limitação de evidência: a existência de persistência Outbox não comprova, por si só, que um dispatcher com retry, confirmação de publicação e monitoramento esteja operacional. Essa capacidade deve ser verificada no código antes de ser declarada pronta.
4.9 Retry e DLQ
Decisão: distinguir falhas transitórias de permanentes e usar reentrega/encaminhamento à DLQ.

Benefício: dependências temporariamente indisponíveis podem se recuperar sem perda imediata do evento; payloads inválidos não precisam ser repetidos indefinidamente.

Trade-off: a classificação de erros exige manutenção; falhas não classificadas podem gerar tentativas desnecessárias. A política da fila local usa VisibilityTimeout=60 e maxReceiveCount=5.
5. Garantias e limites
Aspecto	Abordagem	Limite
Atomicidade financeira	Transação PostgreSQL	Não engloba automaticamente sistemas externos
Idempotência	Chaves e registros persistidos	Depende de constraints e semântica de conflitos corretas
Ordem	SQS FIFO por grupo	Não há ordenação global entre grupos
Entrega	SQS com reentrega	Consumidor deve tolerar entrega repetida
Auditoria	Ledger e transações	Requer políticas de acesso e retenção
Recuperação	Retry e DLQ	Necessita monitoramento e operação da DLQ


A expressão exactly-once não deve ser aplicada ao sistema inteiro: o transporte pode entregar mensagens mais de uma vez. A meta é efeito financeiro idempotente com processamento transacional.
6. Testes e verificações
A suíte relatada durante o desenvolvimento cobriu testes unitários e cenários de integração de ciclo financeiro, concorrência, idempotência, resiliência e recuperação após disponibilização tardia de uma carteira.
bunx vitest run src tests/unit
bunx vitest run --config vitest.config.integration.ts
bunx tsc --noEmit
bun run lint
bun run build
O teste de recuperação SQS depende do timeout de visibilidade e foi observado com execução de aproximadamente 61 segundos. A métrica ApproximateNumberOfMessagesNotVisible é aproximada e referente à fila inteira, não prova de recebimento de uma mensagem específica.
7. Limitações conhecidas e melhorias propostas
1. Isolamento dos testes SQS: testes concorrentes sobre a mesma fila podem interferir na observação de métricas e no tempo de processamento. Preferir filas/grupos isolados e asserts baseados no identificador do evento.
2. Fixture de recuperação: a criação da carteira e o lançamento de abertura devem ocorrer numa única transação de teste, eliminando o intervalo em que a carteira existe sem o saldo e o Ledger correspondentes.
3. Publicação Outbox: confirmar a existência de dispatcher e adicionar monitoramento, retry e testes de publicação antes de anunciar entrega de eventos ponta a ponta.
4. Observabilidade: métricas de latência, idade de mensagens, profundidade de fila, DLQ, conflitos de idempotência e tempo de espera por locks.
5. Operação de DLQ: estabelecer inspeção, correção de causa e replay controlado, com prevenção de efeitos duplicados.
6. Segurança: autenticação/autorização, gestão de segredos, TLS, políticas de acesso e rate limiting devem ser avaliados antes de uso em produção.
7. Carga e resiliência: testes de throughput, contenção de carteira, falha de banco e reinício do worker para validar os limites operacionais.
8. Contratos de API: publicar especificação OpenAPI/Swagger e exemplos reais de respostas/erros, se ainda não disponíveis.
9. Deploy: credenciais de desenvolvimento, LocalStack e configurações locais não representam configuração de produção.
8. Referências
- MikroORM — Transactions
- PostgreSQL — Explicit Locking
- AWS SQS — FIFO
- AWS SQS — Visibility Timeout
- Transactional Outbox
- Idempotent Consumer