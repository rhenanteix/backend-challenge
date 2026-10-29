
import { Controller, Get, Param } from '@nestjs/common';
import { WagerQueries } from '../../../application/queries/wager.queries.js';

@Controller('providers')
export class ProvidersController {
  constructor(private readonly queries: WagerQueries) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.findByExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
