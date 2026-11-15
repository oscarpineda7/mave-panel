const { chromium, devices } = require('playwright');
const WEB = 'http://127.0.0.1:8080';
(async () => {
  const b = await chromium.launch(); const out = [];
  // A. Supabase caído, sin copia guardada → catálogo de respaldo
  let ctx = await b.newContext({ ...devices['Pixel 7'] });
  await ctx.route(/127\.0\.0\.1:54321/, r => r.abort()); await ctx.route(/fonts\./, r => r.fulfill({ body: '' }));
  let p = await ctx.newPage(); await p.goto(WEB); await p.waitForSelector('.card');
  out.push(`Supabase caído y sin copia: muestra ${await p.locator('.card').count()} productos de respaldo`);
  await ctx.close();
  // B. Con copia guardada de una visita anterior → usa la copia (precios más recientes)
  ctx = await b.newContext({ ...devices['Pixel 7'] }); await ctx.route(/fonts\./, r => r.fulfill({ body: '' }));
  p = await ctx.newPage(); await p.goto(WEB); await p.waitForSelector('.card');
  const live = await p.locator('.card[class] .price').first().textContent();
  await ctx.route(/127\.0\.0\.1:54321/, r => r.abort());
  await p.reload(); await p.waitForSelector('.card');
  out.push(`Supabase caído con copia guardada: muestra ${await p.locator('.card').count()} productos, termoprotector ${await p.locator('.card', { hasText: 'Termoprotector' }).locator('.price').textContent()} (copia de la última visita)`);
  await ctx.close();
  // C. Capturas del panel en el celular
  ctx = await b.newContext({ ...devices['Pixel 7'] });
  p = await ctx.newPage(); await p.goto(WEB + '/admin.html'); await p.waitForSelector('#login:not([hidden])');
  await p.screenshot({ path: 'adm-login.png' });
  await p.fill('#l-email', 'duena@mave.test'); await p.fill('#l-pass', 'ClaveSegura123'); await p.tap('#l-submit');
  await p.waitForSelector('.row'); await p.waitForTimeout(300); await p.screenshot({ path: 'adm-list.png' });
  await p.tap('#fab'); await p.waitForSelector('#editor[open]'); await p.waitForTimeout(300); await p.screenshot({ path: 'adm-editor.png' });
  await b.close(); console.log(out.join('\n'));
})();
