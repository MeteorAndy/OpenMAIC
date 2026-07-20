// Probe both halves of the split with the captured session.
import fs from 'node:fs';
const auth = JSON.parse(fs.readFileSync(new URL('./.auth-out.json', import.meta.url), 'utf8'));
const cookie = auth.cookieHeader;
const bearer = auth.access_token;

async function probe(label, url, init = {}) {
  try {
    const r = await fetch(url, { ...init, redirect: 'manual' });
    const text = await r.text();
    let body = text;
    try { body = JSON.stringify(JSON.parse(text)); } catch {}
    console.log(`\n### ${label}\n${r.status} ${r.statusText}\n${body.slice(0, 600)}`);
    return r.status;
  } catch (e) {
    console.log(`\n### ${label}\nERROR ${e.message}`);
    return -1;
  }
}

// 4a. PROXY: Next :3000 /api/quota with the Supabase cookie (what a browser sends)
await probe('PROXY  :3000/api/quota  (Cookie sb-127-auth-token)', 'http://127.0.0.1:3000/api/quota', {
  headers: { cookie },
});
// 4b. isolation: raw access_token as the cookie value (task's literal guess) — expect FAIL
await probe('PROXY  :3000/api/quota  (Cookie = raw access_token only)', 'http://127.0.0.1:3000/api/quota', {
  headers: { cookie: `sb-127-auth-token=${bearer}` },
});
// 4c. isolation: Bearer on the proxied URL (cookie-less)
await probe('PROXY  :3000/api/quota  (Authorization Bearer)', 'http://127.0.0.1:3000/api/quota', {
  headers: { authorization: `Bearer ${bearer}` },
});
// 5. BACKEND direct :8787 /api/quota with Bearer (JWKS path)
await probe('BACKEND:8787/api/quota (Authorization Bearer)', 'http://127.0.0.1:8787/api/quota', {
  headers: { authorization: `Bearer ${bearer}` },
});
// 6. public proxied health
await probe('PROXY  :3000/api/health', 'http://127.0.0.1:3000/api/health');
// 7. backend public health
await probe('BACKEND:8787/api/health', 'http://127.0.0.1:8787/api/health');
// 8. control: proxied quota with NO auth — expect 401
await probe('PROXY  :3000/api/quota  (no auth, control)', 'http://127.0.0.1:3000/api/quota');
