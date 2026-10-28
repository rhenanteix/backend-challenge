
import 'dotenv/config';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { databaseEntities } from './src/infrastructure/database/entities/schemas.js';

export default defineConfig({
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  dbName: process.env.DATABASE_NAME ?? 'jungle_wagering',
  user: process.env.DATABASE_USER ?? 'jungle',
  password: process.env.DATABASE_PASSWORD,
  entities: databaseEntities,
  extensions: [Migrator],
  migrations: {
    path: './src/infrastructure/database/migrations',
    transactional: true,
    allOrNothing: true,
  },
  debug: process.env.NODE_ENV === 'development',
});
