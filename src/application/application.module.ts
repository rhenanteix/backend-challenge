
import { Module } from '@nestjs/common';
import { ProcessWagerTransaction } from './use-cases/process-wager.js';
import { CreateWallet } from './use-cases/create-wallet.js';
import { WagerQueries } from './queries/wager.queries.js';
import { WalletQueries } from './queries/wallet.queries.js';
import { RetryPendingReferences } from './use-cases/retry-pending-references.js';

@Module({
  providers: [
    ProcessWagerTransaction,
    CreateWallet,
    WagerQueries,
    WalletQueries,
    RetryPendingReferences
  ],
  exports: [
    ProcessWagerTransaction,
    CreateWallet,
    WagerQueries,
    WalletQueries
  ],
})
export class ApplicationModule { }
