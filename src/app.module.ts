
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './infrastructure/database/mikro-orm.config.js';
import { HttpModule } from './interfaces/http/http.module.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MikroOrmModule.forRoot(mikroOrmConfig),
    HttpModule,
    MessagingModule,
  ],
})
export class AppModule {}
