
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('INSUFFICIENT_FUNDS');
  }
}

export class ReversalInsufficientFundsError extends DomainError {
  constructor() {
    super('REVERSAL_INSUFFICIENT_FUNDS');
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor() {
    super('INVALID_TRANSACTION_STATE');
  }
}
