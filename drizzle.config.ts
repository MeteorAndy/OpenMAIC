import { defineConfig } from 'drizzle-kit';

// Drizzle-kit config for the SaaS Postgres schema.
// Run migrations with: DATABASE_URL=... pnpm db:migrate
// Generate SQL with:  pnpm db:generate
export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
