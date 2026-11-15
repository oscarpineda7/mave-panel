// Prueba de punta a punta del inventario (stock, − / +, Agotado automático, historial, QR), contra el simulador local.
const { chromium, devices } = require('playwright');
const API = 'http://127.0.0.1:54321', WEB = 'http://127.0.0.1:8080';
const SHOTS = process.argv[2] || '/tmp';
const results = []; let failed = 0;
function check(name, ok, extra) { results.push(`${ok ? 'OK   ' : 'FALLA'} ${name}${extra !== undefined ? ' — ' + extra : ''}`); if (!ok) failed++; }
const api = async p => (await fetch(API + p)).json();

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['Pixel 7'] });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '' }));
  const errors = [];
  ctx.on('page', pg => { pg.on('pageerror', e => errors.push(pg.url() + ' ' + e.message)); pg.on('console', m => { if (m.type() === 'error') errors.push(pg.url() + ' ' + m.text()); }); });

  // La tienda pública no ve el stock
  const anonStock = await fetch(API + '/rest/v1/products?select=stock&id=eq.masmelo');
  check('Seguridad: un visitante no puede leer el stock', anonStock.status >= 400, anonStock.status);
  const anonMov = await fetch(API + '/rest/v1/stock_movements?select=*');
  check('Seguridad: un visitante no puede leer el historial', anonMov.status >= 400, anonMov.status);
  const anonRpc = await fetch(API + '/rest/v1/rpc/adjust_stock', { method: 'POST', body: JSON.stringify({ p_id: 'masmelo', p_delta: 5 }) });
  check('Seguridad: un visitante no puede cambiar el stock', anonRpc.status >= 400, anonRpc.status);

  const adm = await ctx.newPage();
  await adm.goto(WEB + '/admin.html');
  await adm.waitForSelector('#login:not([hidden])');
  await adm.fill('#l-email', 'duena@mave.test'); await adm.fill('#l-pass', 'ClaveSegura123'); await adm.tap('#l-submit');
  await adm.waitForSelector('#app:not([hidden]) .row');
  check('Panel: todos empiezan "Sin contar"', await adm.locator('.row [data-stock].btn').count() === 16);
  check('Panel: sin aviso de poco stock al inicio', await adm.isHidden('#low-banner'));
  await adm.screenshot({ path: SHOTS + '/1-lista-inicial.png' });

  // Contar stock de Masmelo: 2 unidades (mínimo 3 → poco stock)
  const row = () => adm.locator('.row[data-id="masmelo"]');
  await row().locator('[data-stock]').tap();
  await adm.waitForSelector('#stock-dlg[open]');
  check('Inventario: diálogo dice "sin contar"', (await adm.textContent('#sd-unit')) === 'sin contar');
  await adm.fill('#sd-count', '2'); await adm.tap('#sd-count-form button');
  await adm.waitForFunction(() => document.querySelector('#sd-num').textContent === '2');
  await adm.waitForFunction(() => document.querySelectorAll('#sd-history li .d').length === 1);
  check('Inventario: historial muestra "Stock inicial"', (await adm.textContent('#sd-history')).includes('Stock inicial'));
  await adm.screenshot({ path: SHOTS + '/2-dialogo-stock.png' });
  await adm.locator('#stock-dlg [data-close]').tap();
  check('Lista: Masmelo muestra 2 en rojo', (await row().locator('.qty').getAttribute('class')).includes('low') && (await row().locator('.qty b').textContent()) === '2');
  check('Lista: aviso "1 producto con poco stock"', await adm.isVisible('#low-banner') && (await adm.textContent('#low-text')).includes('Masmelo'.slice(0, 3)) , await adm.textContent('#low-text'));

  // Restar hasta 0 → Agotado automático
  await row().locator('[data-dec]').tap();
  await adm.waitForFunction(() => document.querySelector('.row[data-id="masmelo"] .qty b').textContent === '1');
  await row().locator('[data-dec]').tap();
  await adm.waitForFunction(() => document.querySelector('.row[data-id="masmelo"] .qty b').textContent === '0');
  check('Lista: en 0 aparece "Agotado"', await row().locator('.pill.sold').count() === 1);
  check('Lista: en 0 el botón − se desactiva', await row().locator('[data-dec]').isDisabled());
  check('Lista: en 0 se apaga "Disponible"', !(await row().locator('[data-toggle="available"]').isChecked()));
  check('Aviso al llegar a 0', (await adm.textContent('#toast')).includes('Agotado'), await adm.textContent('#toast'));
  let pub = (await api('/rest/v1/products?select=available&id=eq.masmelo'))[0];
  check('Tienda (API pública): Masmelo agotado', pub.available === false);
  const shop = await ctx.newPage(); await shop.goto(WEB + '/'); await shop.waitForSelector('.card');
  check('Tienda: la tarjeta muestra Agotado', (await shop.locator('.card', { hasText: 'Masmelo' }).first().textContent()).includes('Agotado'));
  await adm.screenshot({ path: SHOTS + '/3-agotado.png' });

  // Llega mercancía: +6 → vuelve a estar disponible
  await row().locator('[data-stock]').tap(); await adm.waitForSelector('#stock-dlg[open]');
  await adm.fill('#sd-in', '6'); await adm.tap('#sd-in-form button');
  await adm.waitForFunction(() => document.querySelector('#sd-num').textContent === '6');
  await adm.tap('#sd-inc'); await adm.waitForFunction(() => document.querySelector('#sd-num').textContent === '7');
  await adm.waitForFunction(() => document.querySelectorAll('#sd-history li .d').length === 5);
  const hist = await adm.locator('#sd-history li').allTextContents();
  check('Historial: 5 movimientos en orden', hist[0].startsWith('+1') && hist[1].startsWith('+6') && hist[2].startsWith('-1') && hist[4].startsWith('+2'), hist.join(' | '));
  // Mínimo de aviso
  await adm.fill('#sd-min', '8'); await adm.tap('#sd-min-form button');
  await adm.waitForFunction(() => document.querySelector('#sd-state').textContent.includes('Poco stock'));
  check('Mínimo: con 7 y aviso en 8 queda en poco stock', true);
  await adm.locator('#stock-dlg [data-close]').tap();
  pub = (await api('/rest/v1/products?select=available&id=eq.masmelo'))[0];
  check('Tienda (API pública): Masmelo disponible otra vez', pub.available === true);

  // Filtro "Poco stock"
  await adm.tap('#low-show');
  check('Filtro "Poco stock" deja solo Masmelo', await adm.locator('.row').count() === 1);
  await adm.selectOption('#f-state', 'uncounted');
  check('Filtro "Sin contar" → 15', await adm.locator('.row').count() === 15);
  await adm.selectOption('#f-state', 'all');

  // Editor: cambiar el stock desde Editar producto
  await adm.locator('.row[data-id="lpp-termo"] [data-edit]').tap(); await adm.waitForSelector('#editor[open]');
  check('Editor: stock vacío y mínimo 3', (await adm.inputValue('#ed-stock')) === '' && (await adm.inputValue('#ed-min')) === '3');
  await adm.fill('#ed-stock', '10'); await adm.tap('#ed-submit');
  await adm.waitForSelector('#editor', { state: 'hidden' });
  check('Editor: Lpp Termo queda con 10', (await adm.locator('.row[data-id="lpp-termo"] .qty b').textContent()) === '10');
  // Editar sin tocar el stock no pisa una venta hecha mientras el formulario estaba abierto
  await adm.locator('.row[data-id="lpp-termo"] [data-edit]').tap(); await adm.waitForSelector('#editor[open]');
  await adm.evaluate(async () => { }); // formulario abierto con 10
  const tok = await adm.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes('auth-token')))).access_token);
  await fetch(API + '/rest/v1/rpc/adjust_stock', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_id: 'lpp-termo', p_delta: -1 }) });
  await adm.fill('#ed-size', '250 ml'); await adm.tap('#ed-submit');
  await adm.waitForSelector('#editor', { state: 'hidden' });
  check('Editor: no pisa la venta hecha en paralelo (queda 9)', (await adm.locator('.row[data-id="lpp-termo"] .qty b').textContent()) === '9', await adm.locator('.row[data-id="lpp-termo"] .qty b').textContent());

  // Restar más de lo que hay
  const over = await fetch(API + '/rest/v1/rpc/adjust_stock', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_id: 'lpp-termo', p_delta: -50 }) });
  check('No deja quedar en negativo', over.status >= 400);

  // Etiquetas QR
  await adm.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  await adm.tap('#labels-btn'); await adm.waitForSelector('#labels-dlg[open]');
  await adm.selectOption('#lb-which', 'all'); await adm.fill('#lb-copies', '2'); await adm.tap('#lb-print');
  await adm.waitForFunction(() => window.__printed === 1);
  check('QR: 16 productos × 2 copias = 32 etiquetas', await adm.locator('#labels .label svg').count() === 32);
  await adm.emulateMedia({ media: 'print' });
  await adm.screenshot({ path: SHOTS + '/4-etiquetas.png' });
  await adm.emulateMedia({ media: 'screen' });

  // Abrir desde el QR (misma URL que trae la etiqueta)
  const p2 = await ctx.newPage();
  await p2.goto(WEB + '/admin.html#p=lpp-termo');
  await p2.waitForSelector('#stock-dlg[open]');
  check('QR: al escanear se abre el producto', (await p2.textContent('#sd-title')).length > 0 && (await p2.textContent('#sd-num')) === '9', await p2.textContent('#sd-title'));
  await p2.tap('#sd-dec'); await p2.waitForFunction(() => document.querySelector('#sd-num').textContent === '8');
  check('QR: − desde el celular resta', true);
  await p2.screenshot({ path: SHOTS + '/5-desde-qr.png' });

  check('Sin errores en consola', errors.length === 0, errors.join(' | '));
  console.log(results.join('\n')); console.log(`\n${results.length - failed}/${results.length} pruebas correctas`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('ERROR', e.message); process.exit(1); });
