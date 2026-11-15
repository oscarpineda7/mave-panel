// Prueba de punta a punta de ventas: canal local/online, venta con descuento, compra con costo,
// pestaña Resumen y descarga en Excel. Contra el simulador local.
const { chromium, devices } = require('playwright');
const XLSX = require(process.env.XLSX_PATH || 'xlsx');
const WEB = 'http://127.0.0.1:8080';
const SHOTS = process.argv[2] || '/tmp';
const results = []; let failed = 0;
function check(name, ok, extra) { results.push(`${ok ? 'OK   ' : 'FALLA'} ${name}${extra !== undefined ? ' — ' + extra : ''}`); if (!ok) failed++; }
const money = n => '$' + n.toLocaleString('es-CO');

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '' }));
  const errors = [];
  ctx.on('page', pg => { pg.on('pageerror', e => errors.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); });
  const a = await ctx.newPage();
  await a.goto(WEB + '/admin.html');
  await a.waitForSelector('#login:not([hidden])');
  await a.fill('#l-email', 'duena@mave.test'); await a.fill('#l-pass', 'ClaveSegura123'); await a.tap('#l-submit');
  await a.waitForSelector('#app:not([hidden]) .row');
  const row = id => a.locator(`.row[data-id="${id}"]`);
  const num = () => a.textContent('#sd-num');
  const waitNum = v => a.waitForFunction(v => document.querySelector('#sd-num').textContent === v, v);
  const close = () => a.locator('#stock-dlg [data-close]').tap();

  // Masmelo ($33.000): stock 10 y costo 20.000
  await row('masmelo').locator('[data-stock]').tap(); await a.waitForSelector('#stock-dlg[open]');
  await a.fill('#sd-count', '10'); await a.tap('#sd-count-form button'); await waitNum('10'); await close();
  await row('masmelo').locator('[data-edit]').tap(); await a.waitForSelector('#editor[open]');
  await a.fill('#ed-cost', '20.000'); await a.tap('#ed-submit'); await a.waitForSelector('#editor', { state: 'hidden' });

  // − en Local, luego − en Online
  check('Canal por defecto: Local', (await a.getAttribute('[data-ch="fisica"]', 'aria-pressed')) === 'true');
  await row('masmelo').locator('[data-dec]').tap();
  await a.waitForFunction(() => document.querySelector('.row[data-id="masmelo"] .qty b').textContent === '9');
  check('Aviso dice "Venta local"', (await a.textContent('#toast')).includes('Venta local'), await a.textContent('#toast'));
  await a.tap('[data-ch="online"]');
  await row('masmelo').locator('[data-dec]').tap();
  await a.waitForFunction(() => document.querySelector('.row[data-id="masmelo"] .qty b').textContent === '8');
  check('Aviso dice "Venta online"', (await a.textContent('#toast')).includes('Venta online'));
  await a.reload(); await a.waitForSelector('.row');
  check('El canal elegido se recuerda', (await a.getAttribute('[data-ch="online"]', 'aria-pressed')) === 'true');
  await a.tap('[data-ch="fisica"]');

  // Lpp Termo ($30.000): stock 5, vendí 2 a 25.000 en local (sin costo)
  await row('lpp-termo').locator('[data-stock]').tap(); await a.waitForSelector('#stock-dlg[open]');
  await a.fill('#sd-count', '5'); await a.tap('#sd-count-form button'); await waitNum('5');
  check('Vendí: precio sugerido = precio de la tienda', (await a.inputValue('#sd-sale-price')) === '30000');
  await a.fill('#sd-sale-n', '2'); await a.fill('#sd-sale-price', '25.000'); await a.selectOption('#sd-sale-ch', 'fisica');
  await a.tap('#sd-sale-form button'); await waitNum('3');
  await a.waitForFunction(() => document.querySelector('#sd-history').textContent.includes('$50.000'));
  check('Historial muestra la venta con su valor', (await a.textContent('#sd-history')).includes('Venta local · $50.000'), (await a.locator('#sd-history li').first().textContent()));
  await close();

  // Masmelo: llegó mercancía 6 a 18.000 c/u, luego vendí 1 online
  await row('masmelo').locator('[data-stock]').tap(); await a.waitForSelector('#stock-dlg[open]');
  check('Llegó mercancía: costo sugerido 20000', (await a.inputValue('#sd-in-cost')) === '20000');
  await a.fill('#sd-in', '6'); await a.fill('#sd-in-cost', '18000'); await a.tap('#sd-in-form button'); await waitNum('14');
  await a.selectOption('#sd-sale-ch', 'online'); await a.tap('#sd-sale-form button'); await waitNum('13');
  await a.screenshot({ path: SHOTS + '/v1-dialogo.png' });
  await close();
  await row('masmelo').locator('[data-edit]').tap(); await a.waitForSelector('#editor[open]');
  check('El costo del producto se actualizó a 18000', (await a.inputValue('#ed-cost')) === '18000');
  await a.locator('#editor [data-close]').first().tap();

  // Resumen
  await a.tap('#tab-r');
  await a.waitForFunction(() => document.querySelectorAll('#rp-tiles .tile b').length === 4);
  const tiles = await a.locator('#rp-tiles .tile').allTextContents();
  const t = i => tiles[i].replace(/\s+/g, ' ');
  check('Vendido $149.000 · 5 unidades', t(0).includes(money(149000)) && t(0).includes('5 unidades'), t(0));
  check('Vendido por canal: Local $83.000 · Online $66.000', t(0).includes('Local ' + money(83000)) && t(0).includes('Online ' + money(66000)), t(0));
  check('Ganancia $41.000 (2 unidades sin costo)', t(1).includes(money(41000)) && t(1).includes('2 unidades sin costo'), t(1));
  check('Gastado en mercancía $108.000 · 6 entraron', t(2).includes(money(108000)) && t(2).includes('6 unidades'), t(2));
  check('Inventario hoy $519.000 · costo $234.000', t(3).includes(money(519000)) && t(3).includes(money(234000)), t(3));
  const top = await a.locator('#rp-top tbody tr').allTextContents();
  check('Más vendido: Masmelo primero', top[0].includes('Masmelo') && top[0].includes(money(99000)), top.join(' | '));
  check('Barras: un día con ventas', await a.locator('#rp-chart .bar i[style*="100%"]').count() === 1);
  await a.locator('#rp-chart .bar i[style*="100%"]').first().hover().catch(() => {});
  await a.screenshot({ path: SHOTS + '/v2-resumen.png', fullPage: true });
  await a.selectOption('#rp-period', 'prev');
  await a.waitForFunction(() => document.querySelector('#rp-tiles').textContent.includes('0 unidades'));
  check('Mes pasado: sin ventas', true);
  await a.selectOption('#rp-period', 'month');
  await a.waitForFunction(() => document.querySelector('#rp-tiles').textContent.includes('149.000'));

  // Excel
  const [dl] = await Promise.all([a.waitForEvent('download'), a.tap('#rp-xlsx')]);
  const file = SHOTS + '/ventas.xlsx'; await dl.saveAs(file);
  const wb = XLSX.readFile(file);
  check('Excel: 5 hojas', wb.SheetNames.join(',') === 'Resumen,Ventas por día,Por producto,Movimientos,Inventario', wb.SheetNames.join(','));
  const res = XLSX.utils.sheet_to_json(wb.Sheets['Resumen'], { header: 1 });
  const val = k => (res.find(r => r[0] === k) || [])[1];
  check('Excel: total vendido 149000', val('Total vendido ($)') === 149000, val('Total vendido ($)'));
  check('Excel: ganancia 41000', val('Ganancia ($)') === 41000);
  const mov = XLSX.utils.sheet_to_json(wb.Sheets['Movimientos']);
  check('Excel: 7 movimientos', mov.length === 7, mov.length);
  check('Excel: venta con descuento 2 × 25000 = 50000 local', mov.some(m => m['Total venta ($)'] === 50000 && m.Canal === 'Local'));
  const inv = XLSX.utils.sheet_to_json(wb.Sheets['Inventario']);
  check('Excel: inventario con los 16 productos', inv.length === 16);

  check('Sin errores en consola', errors.length === 0, errors.join(' | '));
  console.log(results.join('\n')); console.log(`\n${results.length - failed}/${results.length} pruebas correctas`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('ERROR', e.message); process.exit(1); });
