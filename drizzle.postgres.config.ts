import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/core/adapters/db/postgres/schema.ts',
  out: 'migrations/postgres',
});
