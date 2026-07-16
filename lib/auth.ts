/**
 * better-auth server instance (SaaS, feat/saas).
 * Uses our Drizzle/Postgres tables (single migration system) via the drizzle
 * adapter. OAuth providers are enabled only when their credentials are set, so
 * email/password works out of the box.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { db } from '@/db/client';
import { user, session, account, verification, subscription } from '@/db/schema';

function buildSocialProviders() {
  const social: Record<string, { clientId: string; clientSecret: string }> = {};
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    social.github = {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    };
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    social.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  return social;
}

export const auth = betterAuth({
  secret: process.env.AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user, session, account, verification },
  }),
  emailAndPassword: { enabled: true, autoSignIn: true },
  socialProviders: buildSocialProviders(),
  databaseHooks: {
    user: {
      create: {
        after: async (newUser) => {
          // Default new sign-ups to the Free plan (run `pnpm db:seed` once first).
          const now = new Date();
          await db
            .insert(subscription)
            .values({
              id: `sub_${newUser.id}`,
              userId: newUser.id,
              planId: 'free',
              status: 'active',
              currentPeriodStart: now,
              currentPeriodEnd: new Date(now.getFullYear() + 100, now.getMonth(), now.getDate()),
            })
            .onConflictDoNothing({ target: subscription.userId });
        },
      },
    },
  },
});
