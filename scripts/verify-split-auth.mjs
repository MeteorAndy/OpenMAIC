// Verify split: simulate browser auth and capture the EXACT cookie name+value
// that @supabase/ssr writeClient would set, using createServerClient (same code
// path as lib/supabase/server.ts) backed by a captured cookie store.
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const tag = process.env.E2E_TAG || 'verify';
const email = `e2e-${tag}-${Date.now()}@openmaic.test`;
const password = 'TestPass!2026';

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false } });
const anon = createClient(URL, ANON, { auth: { autoRefreshToken: false } });

// captured cookie jar mirroring a browser's cookie store
const jar = new Map();
const ssr = createServerClient(URL, ANON, {
  cookies: {
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    setAll: (toSet) => {
      for (const { name, value } of toSet) jar.set(name, value);
    },
  },
});

const out = { email };
const t0 = Date.now();

// 1. signUp (anon) — mirrors a real user signing up
const { data: signUpData, error: signUpErr } = await anon.auth.signUp({ email, password });
if (signUpErr) { console.error('signUp failed:', signUpErr); process.exit(2); }
out.userId = signUpData.user?.id;

// 2. admin-confirm email (mirrors operator confirming)
const { error: confirmErr } = await admin.auth.admin.updateUserById(out.userId, { email_confirm: true });
if (confirmErr) { console.error('confirm failed:', confirmErr); process.exit(3); }

// 3. signInWithPassword via the SSR client (writes cookies into `jar`)
const { data: signInData, error: signInErr } = await ssr.auth.signInWithPassword({ email, password });
if (signInErr) { console.error('signIn failed:', signInErr); process.exit(4); }

out.access_token = signInData.session?.access_token;
out.expires_at = signInData.session?.expires_at;

// 4. read out what cookies a browser would now hold
out.cookies = [...jar.entries()].map(([name, value]) => ({ name, valueLen: value.length }));

// build the exact Cookie header a browser would send for same-origin /api/*
out.cookieHeader = [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; ');

console.log(JSON.stringify(out, null, 2));
process.exit(0);
