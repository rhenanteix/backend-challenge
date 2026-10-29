
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from '../../../domain/shared/domain-error.js';

const HTTP_STATUS_BY_CODE: Record<string, number> = {
  WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
  TRANSACTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  IDEMPOTENCY_KEY_REQUIRED: HttpStatus.BAD_REQUEST,
  INVALID_MONEY_AMOUNT: HttpStatus.BAD_REQUEST,
  INVALID_CURRENCY: HttpStatus.BAD_REQUEST,
  REFERENCE_REQUIRED: HttpStatus.BAD_REQUEST,
  CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_FUNDS: HttpStatus.UNPROCESSABLE_ENTITY,
  REVERSAL_INSUFFICIENT_FUNDS: HttpStatus.UNPROCESSABLE_ENTITY,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  EXTERNAL_TRANSACTION_CONFLICT: HttpStatus.CONFLICT,
  WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
};

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    response
      .status(
        HTTP_STATUS_BY_CODE[exception.code] ??
          HttpStatus.UNPROCESSABLE_ENTITY,
      )
      .json({
        error: {
          code: exception.code,
          message: exception.message,
        },
      });
  }
}
