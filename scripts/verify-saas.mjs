// Tier-2 SaaS data-layer verification against the running self-hosted Supabase.
// Exercises: GoTrue signup, on_auth_user_created -> free subscription, RLS
// (owner CRUD; other user cannot), set_updated_at trigger, CASCADE delete.
// Run: set -a; . ./.env.local; set +a; node scripts/verify-saas.mjs
import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SVC) { console.error('Missing Supabase env'); process.exit(1); }

const admin = createClient(URL, SVC, { auth: { persistSession: false } });
const now = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 10);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

// One client instance carries its signed-in session (RLS sees auth.uid()).
async function makeUser(tag) {
  const email = `verify-${tag}-${rid()}@test.local`;
  const password = 'Verifypass123!';
  const c = createClient(URL, ANON);
  const up = await c.auth.signUp({ email, password });
  if (up.error || !up.data.user) throw up.error ?? new Error('signUp returned no user');
  const userId = up.data.user.id;
  await admin.auth.admin.updateUserById(userId, { email_confirm: true });
  const si = await c.auth.signInWithPassword({ email, password });
  if (si.error) throw si.error;
  return { id: userId, client: c };
}

async function main() {
  console.log('SaaS data-layer verification ->', URL);

  console.log('1. signup + on_auth_user_created trigger');
  const A = await makeUser('A');
  const sub = await admin.from('subscription').select('*').eq('user_id', A.id);
  ok('signup created a user', !!A.id);
  ok('trigger auto-created a Free subscription',
    sub.data?.length === 1 && sub.data[0].plan_id === 'free', JSON.stringify(sub.data));

  console.log('2. RLS: owner can write + read own course');
  const courseId = `c-${rid()}`;
  const w = await A.client.from('course').upsert(
    { id: courseId, user_id: A.id, name: 'Verify Course', created_at: now(), updated_at: now() });
  ok('owner upsert course', !w.error, w.error?.message);
  const r = await A.client.from('course').select('*').eq('id', courseId).maybeSingle();
  ok('owner read own course', !!r.data, r.error?.message);

  console.log('3. scene write + set_updated_at trigger');
  const before = r.data?.updated_at;
  const s = await A.client.from('scene').upsert(
    { id: `${courseId}:s1`, user_id: A.id, course_id: courseId, type: 'slide', title: 'S1', order: 0,
      content: { type: 'slide' }, created_at: now(), updated_at: now() });
  ok('owner upsert scene', !s.error, s.error?.message);
  const u = await A.client.from('course').update({ name: 'Verify Course (renamed)' })
    .eq('id', courseId).select('updated_at').maybeSingle();
  ok('set_updated_at advanced updated_at', u.data && u.data.updated_at !== before,
    `${before} -> ${u.data?.updated_at}`);

  console.log("4. RLS: other user cannot read/write A's course");
  const B = await makeUser('B');
  const xb = await B.client.from('course').select('*').eq('id', courseId).maybeSingle();
  ok("B cannot read A's course", !xb.data && !xb.error, JSON.stringify(xb));
  const xbWrite = await B.client.from('course').upsert(
    { id: courseId, user_id: A.id, name: 'hijack', created_at: now(), updated_at: now() });
  ok("RLS with-check blocks B writing A's user_id", !!xbWrite.error, xbWrite.error?.message);

  console.log('5. CASCADE: delete course clears scenes');
  const sc = await A.client.from('scene').select('*').eq('course_id', courseId);
  ok('scene exists before delete', sc.data?.length === 1, String(sc.data?.length));
  const d = await A.client.from('course').delete().eq('id', courseId);
  ok('delete course', !d.error, d.error?.message);
  const sc2 = await admin.from('scene').select('*').eq('course_id', courseId);
  ok('CASCADE cleared scenes', sc2.data?.length === 0, String(sc2.data?.length));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
