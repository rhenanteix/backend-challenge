
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Body,
} from '@nestjs/common';
import { WalletQueries } from '../../../application/queries/wallet.queries.js';
import { CreateWallet } from '../../../application/use-cases/create-wallet.js';
import { CreateWalletDto } from '../dto/create-wallet.dto.js';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly queries: WalletQueries, private readonly createWallet: CreateWallet,) {}

  @Get(':walletId')
  getWallet(
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ) {
    return this.queries.findById(walletId);
  }

  @Get(':walletId/ledger')
  getLedger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = limit === undefined ? 20 : Number(limit);

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new Error('INVALID_LEDGER_LIMIT');
    }

    return this.queries.ledger(walletId, cursor, parsed);
  }

  @Post(':walletId/reconciliation')
  reconcile(
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ) {
    return this.queries.reconcile(walletId);
  }
  @Post()
create(@Body() body: CreateWalletDto) {
  return this.createWallet.execute(body);
}
}
