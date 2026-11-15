// Prueba del botón "Deshacer" del historial, contra el simulador local.
const { chromium, devices } = require('playwright');
const API = 'http://127.0.0.1:54321', WEB = 'http://127.0.0.1:8080';
const SHOTS = process.argv[2] || '/tmp';
const results = []; let failed = 0;
function check(name, ok, extra) { results.push(`${ok ? 'OK   ' : 'FALLA'} ${name}${extra !== undefined ? ' — ' + extra : ''}`); if (!ok) failed++; }

(async () => {
  const anon = await fetch(API + '/rest/v1/rpc/undo_movement', { method: 'POST', body: JSON.stringify({ p_movement: 1 }) });
  check('Seguridad: un visitante no puede deshacer', anon.status >= 400, anon.status);
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['Pixel 7'] });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '' }));
  const errors = [];
  ctx.on('page', pg => { pg.on('pageerror', e => errors.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); });
  const adm = await ctx.newPage();
  await adm.goto(WEB + '/admin.html'); await adm.waitForSelector('#login:not([hidden])');
  await adm.fill('#l-email', 'duena@mave.test'); await adm.fill('#l-pass', 'ClaveSegura123'); await adm.tap('#l-submit');
  await adm.waitForSelector('#app:not([hidden]) .row');
  const row = () => adm.locator('.row[data-id="masmelo"]');
  const num = () => adm.textContent('#sd-num');
  const nHist = () => adm.locator('#sd-history li [data-undo]').count();
  const waitHist = n => adm.waitForFunction(n => document.querySelectorAll('#sd-history li [data-undo]').length === n, n);

  await row().locator('[data-stock]').tap(); await adm.waitForSelector('#stock-dlg[open]');
  await adm.fill('#sd-count', '5'); await adm.tap('#sd-count-form button'); await waitHist(1);
  await adm.fill('#sd-in', '3'); await adm.tap('#sd-in-form button'); await waitHist(2);
  await adm.fill('#sd-sale-n', '8'); await adm.tap('#sd-sale-form button'); await waitHist(3);
  check('Preparación: 5 + 3 − 8 = 0 y Agotado', (await num()) === '0');

  // Deshacer la entrada de 3 no se puede: esas unidades ya se vendieron
  const btn = i => adm.locator('#sd-history li [data-undo]').nth(i);
  await btn(1).tap();
  check('Primer toque pide confirmación', (await btn(1).textContent()) === '¿Seguro?');
  await adm.screenshot({ path: SHOTS + '/d1-seguro.png' });
  await btn(1).tap();
  await adm.waitForFunction(() => /vendieron/.test(document.querySelector('#toast').textContent));
  check('No deja deshacer una entrada ya vendida', (await adm.textContent('#toast')).includes('ya se vendieron'), await adm.textContent('#toast'));
  check('El stock no cambió', (await num()) === '0');

  // Deshacer la venta de 8 → vuelve a 8 y disponible
  await adm.waitForTimeout(300); await waitHist(3);
  await btn(0).tap(); await btn(0).tap(); await waitHist(2);
  await adm.waitForFunction(() => document.querySelector('#sd-num').textContent === '8');
  check('Deshacer venta: vuelve a 8 unidades', (await num()) === '8');
  check('Deshacer venta: mensaje', (await adm.textContent('#toast')).includes('Deshecho'), await adm.textContent('#toast'));
  const pub = (await (await fetch(API + '/rest/v1/products?select=available&id=eq.masmelo')).json())[0];
  check('Tienda: vuelve a estar disponible', pub.available === true);
  await adm.screenshot({ path: SHOTS + '/d2-deshecho.png' });

  // Deshacer entrada y stock inicial → queda "sin contar" y sin historial
  await btn(0).tap(); await btn(0).tap(); await waitHist(1);
  await adm.waitForFunction(() => document.querySelector('#sd-num').textContent === '5');
  await btn(0).tap(); await btn(0).tap();
  await adm.waitForFunction(() => document.querySelector('#sd-unit').textContent === 'sin contar');
  check('Deshacer todo: queda "sin contar"', true);
  await adm.waitForFunction(() => document.querySelector('#sd-history').textContent.includes('Todavía no hay movimientos'));
  check('Deshacer todo: historial vacío', true);
  await adm.locator('#stock-dlg [data-close]').tap();
  check('Lista: vuelve a "Contar stock"', await row().locator('[data-stock].btn').count() === 1);
  const bad = errors.filter(e => !/status of 400/.test(e)); // el 400 es el "no se puede deshacer" esperado
  check('Sin errores en consola', bad.length === 0, bad.join(' | '));
  await b.close();
  console.log(results.join('\n')); console.log(failed ? `\n${failed} FALLAS` : `\nTodo OK (${results.length})`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
