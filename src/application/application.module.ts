
import { Module } from '@nestjs/common';
import { ProcessWagerTransaction } from './use-cases/process-wager.js';
import { CreateWallet } from './use-cases/create-wallet.js';
import { WagerQueries } from './queries/wager.queries.js';
import { WalletQueries } from './queries/wallet.queries.js';

@Module({
  providers: [
    ProcessWagerTransaction,
    CreateWallet,
    WagerQueries,
    WalletQueries,
  ],
  exports: [
    ProcessWagerTransaction,
    CreateWallet,
    WagerQueries,
    WalletQueries,
  ],
})
export class ApplicationModule {}
