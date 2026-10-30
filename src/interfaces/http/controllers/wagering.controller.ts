
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ProcessWagerTransaction } from '../../../application/use-cases/process-wager.js';
import { ProcessWagerDto } from '../dto/process-wager.dto.js';
import { WagerQueries } from '../../../application/queries/wager.queries.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WagerQueries,
  ) { }

  @Post()
  async process(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: ProcessWagerDto,
  ) {
    const normalizedKey = idempotencyKey?.trim();

    if (!normalizedKey) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      });
    }

    if (normalizedKey.length > 255) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_TOO_LONG',
      });
    }

    return this.processWager.execute({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: {
        amount: body.money.amount,
        currency: body.money.currency,
      },
      referenceExternalTransactionId:
        body.referenceExternalTransactionId,
      idempotencyKey: normalizedKey,
    });
  }

  @Get(':transactionId')
  async getById(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ) {
    return this.queries.findById(transactionId);
  }
}
