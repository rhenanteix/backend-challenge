
import {
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @Matches(/^(0|[1-9]\d*)(\.\d{1,2})?$/)
  initialBalance!: string;
}
