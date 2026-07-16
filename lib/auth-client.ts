/**
 * Browser auth client (better-auth). Same-origin by default → /api/auth/*.
 */
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
