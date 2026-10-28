
import { Module } from '@nestjs/common';
import { ProcessWagerTransaction } from './use-cases/process-wager.js';

@Module({
  providers: [ProcessWagerTransaction],
  exports: [ProcessWagerTransaction],
})
export class ApplicationModule {}
