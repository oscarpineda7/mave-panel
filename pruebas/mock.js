// Simulador local de Supabase para pruebas: API REST (subconjunto de PostgREST), Auth y Storage.
// Todas las lecturas/escrituras se ejecutan en Postgres con el rol del usuario (anon/authenticated) y sus claims,
// así que las políticas RLS de 01_esquema.sql se aplican de verdad.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const SECRET = 'test-secret-solo-local';
const SITE = process.argv[2];
const API_PORT = 54321, WEB_PORT = 8080;
const USERS = [
  { id: '11111111-1111-1111-1111-111111111111', email: 'duena@mave.test', password: 'ClaveSegura123' },
  { id: '22222222-2222-2222-2222-222222222222', email: 'intruso@mave.test', password: 'OtraClave123' }
];
const files = new Map(); // "bucket/path" -> {type, data}
const log = [];

const b64u = b => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function sign(payload) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${b64u(crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest())}`;
}
function verify(tok) {
  const [h, p, s] = String(tok).split('.'); if (!s) return null;
  if (b64u(crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest()) !== s) return null;
  const c = JSON.parse(Buffer.from(p, 'base64').toString()); return c.exp * 1000 > Date.now() ? c : null;
}
function session(u) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  return { access_token: sign({ sub: u.id, role: 'authenticated', email: u.email, aud: 'authenticated', exp }), token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'rt-' + u.id, user };
}
function who(req) {
  const a = req.headers.authorization || '';
  const c = a.startsWith('Bearer ') ? verify(a.slice(7)) : null;
  return c ? { role: 'authenticated', sub: c.sub } : { role: 'anon', sub: null };
}
function sql(who, query) {
  const tag = '$c' + crypto.randomBytes(4).toString('hex') + '$';
  const claims = JSON.stringify(who.sub ? { sub: who.sub, role: who.role } : { role: who.role });
  const script = `\\set VERBOSITY verbose\nbegin;\nset local role ${who.role};\nselect set_config('request.jwt.claims', ${tag}${claims}${tag}, true) \\g /dev/null\n${query};\ncommit;\n`;
  const r = spawnSync('psql', ['-At', '-q', '-v', 'ON_ERROR_STOP=1'], { input: script, env: { ...process.env, PGHOST: '/var/run/postgresql', PGDATABASE: 'mave' } });
  const err = r.stderr.toString();
  if (r.status !== 0) { const m = err.match(/ERROR:\s+([0-9A-Z]{5}):\s+(.*)/); return { error: { code: m ? m[1] : 'XX000', message: m ? m[2] : err } }; }
  return { out: r.stdout.toString().trim() };
}
const lit = v => { const t = '$v' + crypto.randomBytes(4).toString('hex') + '$'; return t + v + t; };
const ident = s => { if (!/^[a-z_]+$/.test(s)) throw new Error('bad ident ' + s); return s; };

function cors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Expose-Headers', 'content-range');
}
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); }
function readBody(req) { return new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }); }
function pgErr(res, e) {
  const status = e.code === '42501' ? 403 : e.code === '23505' ? 409 : 400;
  json(res, status, { code: e.code, message: e.message, details: null, hint: null });
}

async function rpc(req, res, url) {
  const fn = ident(url.pathname.split('/')[4]), w = who(req);
  const body = JSON.parse((await readBody(req)).toString() || '{}');
  const args = Object.entries(body).map(([k, v]) => `${ident(k)} => ${v === null ? 'null' : lit(String(v))}`).join(', ');
  const r = sql(w, `select row_to_json(t) from public.${fn}(${args}) t`);
  log.push(`${w.role} POST /rest/v1/rpc/${fn} -> ${r.error ? r.error.code : 'ok'}`);
  if (r.error) return pgErr(res, r.error);
  json(res, 200, JSON.parse(r.out));
}
async function rest(req, res, url) {
  if (url.pathname.startsWith('/rest/v1/rpc/')) return rpc(req, res, url);
  const table = ident(url.pathname.split('/')[3]);
  const w = who(req), p = url.searchParams;
  const filters = [];
  for (const [k, v] of p) {
    if (['select', 'order', 'limit', 'columns', 'on_conflict'].includes(k)) continue;
    const m = v.match(/^eq\.(.*)$/); if (!m) throw new Error('filtro no soportado ' + k + '=' + v);
    filters.push(`x.${ident(k)}::text = ${lit(m[1])}`);
  }
  const where = filters.length ? 'where ' + filters.join(' and ') : '';
  const sel = (p.get('select') || '*').split(',').map(c => c === '*' ? 'x.*' : 'x.' + ident(c)).join(',');
  const orders = p.getAll('order').join(',');
  const orderBy = orders ? 'order by ' + orders.split(',').map(o => { const [c, dir] = o.split('.'); return `${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}`; }).join(',') : '';
  let q;
  if (req.method === 'GET') q = `select coalesce(json_agg(t),'[]') from (select ${sel} from public.${table} x ${where} ${orderBy}) t`;
  else {
    const body = JSON.parse((await readBody(req)).toString() || 'null');
    const row = Array.isArray(body) ? body[0] : body;
    if (req.method === 'POST') {
      const cols = Object.keys(row).map(ident);
      q = `with x as (insert into public.${table} (${cols.join(',')}) select ${cols.join(',')} from json_populate_record(null::public.${table}, ${lit(JSON.stringify(row))}::json) returning *) select coalesce(json_agg(t),'[]') from (select ${sel} from x) t`;
    } else if (req.method === 'PATCH') {
      const cols = Object.keys(row).map(ident);
      q = `with x as (update public.${table} x set ${cols.map(c => `${c} = r.${c}`).join(',')} from json_populate_record(null::public.${table}, ${lit(JSON.stringify(row))}::json) r ${where} returning x.*) select coalesce(json_agg(t),'[]') from (select ${sel} from x) t`;
    } else if (req.method === 'DELETE') {
      q = `with x as (delete from public.${table} x ${where} returning x.*) select coalesce(json_agg(t),'[]') from (select ${sel} from x) t`;
    }
  }
  const r = sql(w, q);
  log.push(`${w.role} ${req.method} /rest/v1/${table}${url.search} -> ${r.error ? r.error.code : 'ok'}`);
  if (r.error) return pgErr(res, r.error);
  const rows = JSON.parse(r.out || '[]');
  if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
    if (rows.length !== 1) return json(res, 406, { code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
    return json(res, 200, rows[0]);
  }
  const prefer = req.headers.prefer || '';
  if (req.method !== 'GET' && !prefer.includes('return=representation')) return json(res, 204);
  json(res, req.method === 'POST' ? 201 : 200, rows);
}

function parseMultipart(buf, ctype) {
  const boundary = '--' + ctype.match(/boundary=(.+)$/)[1];
  const parts = []; let i = buf.indexOf(boundary);
  while (i !== -1) {
    const start = i + boundary.length + 2, next = buf.indexOf(boundary, start); if (next === -1) break;
    const part = buf.slice(start, next - 2), he = part.indexOf('\r\n\r\n');
    parts.push({ headers: part.slice(0, he).toString(), data: part.slice(he + 4) }); i = next;
  }
  return parts;
}

async function storage(req, res, url) {
  const segs = decodeURIComponent(url.pathname).split('/').slice(3); // object/...
  if (req.method === 'GET' && segs[1] === 'public') {
    const key = segs.slice(2).join('/'), f = files.get(key);
    if (!f) return json(res, 404, { message: 'Object not found' });
    res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'public, max-age=60' }); return res.end(f.data);
  }
  const w = who(req), bucket = segs[1];
  if (req.method === 'POST') {
    const name = segs.slice(2).join('/');
    const buf = await readBody(req); let data = buf, type = req.headers['content-type'];
    if (/multipart\/form-data/.test(type)) { const f = parseMultipart(buf, type).find(p => /filename=|name=""/.test(p.headers)); data = f.data; type = (f.headers.match(/Content-Type:\s*(\S+)/i) || [])[1] || 'application/octet-stream'; }
    const b = sql({ role: 'anon', sub: null }, `select json_build_object('lim', file_size_limit, 'mimes', allowed_mime_types) from storage.buckets where id = ${lit(bucket)}`);
    const conf = JSON.parse(b.out || 'null');
    if (!conf) return json(res, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    if (conf.mimes && !conf.mimes.includes(type)) return json(res, 400, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` });
    if (conf.lim && data.length > conf.lim) return json(res, 400, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
    const r = sql(w, `insert into storage.objects (bucket_id, name, owner) values (${lit(bucket)}, ${lit(name)}, ${w.sub ? lit(w.sub) + '::uuid' : 'null'})`);
    log.push(`${w.role} SUBIR ${bucket}/${name} (${type}, ${data.length} bytes) -> ${r.error ? r.error.code : 'ok'}`);
    if (r.error) return json(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    files.set(`${bucket}/${name}`, { type, data });
    return json(res, 200, { Key: `${bucket}/${name}`, Id: crypto.randomUUID() });
  }
  if (req.method === 'DELETE') {
    const { prefixes } = JSON.parse((await readBody(req)).toString());
    const r = sql(w, `with d as (delete from storage.objects where bucket_id = ${lit(bucket)} and name in (select json_array_elements_text(${lit(JSON.stringify(prefixes))}::json)) returning name) select coalesce(json_agg(name),'[]') from d`);
    if (r.error) return json(res, 400, { statusCode: '403', error: 'Unauthorized', message: r.error.message });
    const names = JSON.parse(r.out);
    names.forEach(n => files.delete(`${bucket}/${n}`));
    log.push(`${w.role} BORRAR FOTO ${prefixes.join(',')} -> borradas ${names.length}`);
    return json(res, 200, names.map(n => ({ name: n, bucket_id: bucket })));
  }
  json(res, 404, { message: 'not found' });
}

async function auth(req, res, url) {
  const route = url.pathname.replace('/auth/v1/', '');
  if (route === 'token') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    let u;
    if (url.searchParams.get('grant_type') === 'password') u = USERS.find(x => x.email === body.email && x.password === body.password);
    else u = USERS.find(x => 'rt-' + x.id === body.refresh_token);
    log.push(`AUTH ${url.searchParams.get('grant_type')} ${body.email || ''} -> ${u ? 'ok' : 'rechazado'}`);
    if (!u) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
    return json(res, 200, session(u));
  }
  const c = who(req); const u = USERS.find(x => x.id === c.sub);
  if (route === 'user') {
    if (!u) return json(res, 401, { msg: 'invalid JWT', code: 'bad_jwt' });
    if (req.method === 'PUT') { const b = JSON.parse((await readBody(req)).toString()); if (b.password) u.password = b.password; }
    return json(res, 200, session(u).user);
  }
  if (route === 'logout') return json(res, 204);
  if (route === 'recover') { await readBody(req); return json(res, 200, {}); }
  json(res, 404, { msg: 'not found' });
}

http.createServer(async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url);
    if (url.pathname.startsWith('/storage/v1/')) return await storage(req, res, url);
    if (url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url);
    if (url.pathname === '/__log') return json(res, 200, log);
    if (url.pathname === '/__files') return json(res, 200, [...files.keys()]);
    if (url.pathname === '/__reset') { files.clear(); log.length = 0; return json(res, 200, {}); }
    json(res, 404, {});
  } catch (e) { json(res, 500, { message: String(e) }); }
}).listen(API_PORT, '127.0.0.1');

// Sitio estático (como Netlify), con config.js apuntando al simulador y las cabeceras de _headers aplicadas.
const API = `http://127.0.0.1:${API_PORT}`;
const headersFile = fs.readFileSync(path.join(SITE, '_headers'), 'utf8');
function headersFor(p) {
  const out = {}; let active = false;
  for (const line of headersFile.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) { const pat = line.trim(); active = pat === '/*' || pat === p; continue; }
    if (active) { const i = line.indexOf(':'); out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/https:\/\/\*\.supabase\.co/g, API).replace(/wss:\/\/\*\.supabase\.co/g, 'ws://127.0.0.1:54321'); }
  }
  return out;
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webp': 'image/webp', '.txt': 'text/plain' };
http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html';
  if (p === '/config.js') {
    const src = fs.readFileSync(path.join(SITE, 'config.js'), 'utf8')
      .replace(/supabaseUrl: '[^']*'/, `supabaseUrl: '${API}'`)
      .replace(/supabaseKey: '[^']*'/, "supabaseKey: 'sb_publishable_prueba_local'");
    res.writeHead(200, { 'Content-Type': 'text/javascript', ...headersFor(p) }); return res.end(src);
  }
  const f = path.join(SITE, path.normalize(p));
  if (!f.startsWith(SITE) || !fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', ...headersFor(p) });
  if (f.endsWith('.html')) return res.end(fs.readFileSync(f, 'utf8').replace(/https:\/\/\*\.supabase\.co/g, API).replace(/wss:\/\/\*\.supabase\.co/g, 'ws://127.0.0.1:54321'));
  fs.createReadStream(f).pipe(res);
}).listen(process.env.WEB_PORT || WEB_PORT, '127.0.0.1');
console.log('listo');
