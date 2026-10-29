
import 'dotenv/config';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { databaseEntities } from './entities/schemas.js';

export const mikroOrmConfig = defineConfig({
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  dbName: process.env.DATABASE_NAME ?? 'jungle_wagering',
  user: process.env.DATABASE_USER ?? 'jungle',
  password: process.env.DATABASE_PASSWORD,
  entities: databaseEntities,
  extensions: [Migrator],
  migrations: {
    path: './dist/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
    transactional: true,
    allOrNothing: true,
  },
  debug: process.env.NODE_ENV === 'development',
});

export default mikroOrmConfig;
