// Cloudflare Pages middleware: gateway por token HMAC.
// Mismo patrón que visor-stl. Bloquea /viewer sin ?t=<expires>.<hmac>
// firmado con VIEWER_SHARED_SECRET. Failsafe si el secret no está seteado.

const PROTECTED = /^\/(viewer(\.html)?)$/i;

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (!PROTECTED.test(url.pathname)) return next();
  if (!env.VIEWER_SHARED_SECRET) return next();

  const t = url.searchParams.get('t');
  const ok = await verifyToken(t, env.VIEWER_SHARED_SECRET);
  if (!ok) {
    return new Response(forbiddenHtml(), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return next();
}

async function verifyToken(token, secret) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiresStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expires = parseInt(expiresStr, 10);
  if (!expires || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(secret, expiresStr);
  return timingSafeEqual(expected, sig);
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function forbiddenHtml() {
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acceso restringido</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f9fafb;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; padding: 1rem; }
  .card { background: white; border-radius: 16px; padding: 2rem; max-width: 24rem;
          text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
  .emoji { font-size: 2.5rem; }
  h1 { color: #111827; font-size: 1.1rem; margin: 0.5rem 0; }
  p { color: #6b7280; font-size: 0.875rem; }
  a { display: inline-block; background: #1e40af; color: white;
      text-decoration: none; padding: 0.5rem 1rem; border-radius: 8px;
      font-size: 0.875rem; margin-top: 0.5rem; }
</style></head><body>
<div class="card">
  <div class="emoji">🔒</div>
  <h1>Link expirado o inválido</h1>
  <p>Este visor solo se accede desde el dashboard de planificación.
  Si tenés permisos, pedí un link nuevo al administrador.</p>
  <a href="https://paciente-dashboard.vercel.app/dashboard">Ir al dashboard</a>
</div></body></html>`;
}
