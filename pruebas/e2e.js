// Prueba de punta a punta: tienda pública + panel, contra el simulador local (Postgres real con RLS).
const { chromium, devices } = require('playwright');
const API = 'http://127.0.0.1:54321', WEB = 'http://127.0.0.1:8080';
const PHOTO_JPG = process.argv[2], PHOTO_PNG = process.argv[3];
const results = []; let failed = 0;
function check(name, ok, extra) { results.push(`${ok ? 'OK   ' : 'FALLA'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; }
const api = async p => (await fetch(API + p)).json();

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['Pixel 7'] });
  await ctx.route(/wa\.me|instagram|ig\.me/, r => r.fulfill({ status: 200, body: 'ok' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '' }));
  const errors = [];
  ctx.on('page', pg => { pg.on('pageerror', e => errors.push(pg.url() + ' ' + e.message)); pg.on('console', m => { if (m.type() === 'error') errors.push(pg.url() + ' ' + m.text()); }); });

  // 1. Tienda pública lee de la base de datos
  const shop = await ctx.newPage();
  await shop.goto(WEB + '/');
  await shop.waitForSelector('.card');
  check('Tienda: muestra los 16 productos migrados', await shop.locator('.card').count() === 16);
  check('Tienda: precio del Oro Líquido = $50.000', (await shop.locator('.card', { hasText: 'Oro Líquido' }).locator('.price').textContent()) === '$50.000');
  const imgsOk = await shop.evaluate(async () => { for (const i of document.querySelectorAll('.card img')) { i.loading = 'eager'; if (!i.complete) await new Promise(r => { i.onload = i.onerror = r; }); } return [...document.querySelectorAll('.card img')].every(i => i.naturalWidth > 0); });
  check('Tienda: cargan las 16 fotos originales', imgsOk);

  // 2. Panel: inicio de sesión
  const adm = await ctx.newPage();
  await adm.goto(WEB + '/admin.html');
  await adm.waitForSelector('#login:not([hidden])');
  await adm.fill('#l-email', 'duena@mave.test'); await adm.fill('#l-pass', 'mala'); await adm.tap('#l-submit');
  await adm.waitForSelector('#l-error:not([hidden])');
  check('Panel: contraseña equivocada muestra error', (await adm.textContent('#l-error')).includes('incorrectos'), await adm.textContent('#l-error'));
  await adm.fill('#l-email', 'intruso@mave.test'); await adm.fill('#l-pass', 'OtraClave123'); await adm.tap('#l-submit');
  await adm.waitForFunction(() => document.querySelector('#l-error').textContent.includes('permiso'));
  check('Panel: cuenta que no es admin queda fuera', await adm.isVisible('#login') && !(await adm.isVisible('#app')), await adm.textContent('#l-error'));
  await adm.fill('#l-email', 'duena@mave.test'); await adm.fill('#l-pass', 'ClaveSegura123'); await adm.tap('#l-submit');
  await adm.waitForSelector('#app:not([hidden]) .row');
  check('Panel: la dueña entra y ve 16 productos', await adm.locator('.row').count() === 16);

  // 3. Buscar y filtrar
  await adm.fill('#f-q', 'lehit'); check('Panel: buscar "lehit" → 4', await adm.locator('.row').count() === 4);
  await adm.fill('#f-q', 'oro liquido'); check('Panel: buscar sin tildes "oro liquido" → 1', await adm.locator('.row').count() === 1);
  await adm.fill('#f-q', ''); await adm.selectOption('#f-cat', 'tratamiento');
  check('Panel: filtro categoría tratamientos → 6', await adm.locator('.row').count() === 6);
  await adm.selectOption('#f-cat', 'all');

  // 4. Agregar producto con foto desde el teléfono
  await adm.tap('#fab');
  await adm.waitForSelector('#editor[open]');
  await adm.tap('#ed-submit');
  check('Agregar: sin datos pide el nombre', (await adm.textContent('#ed-error')).includes('nombre'));
  await adm.fill('#ed-name', 'Kit Rizos Definidos');
  await adm.fill('#ed-brand', 'MAVE');
  await adm.selectOption('#ed-cat', 'tratamiento');
  await adm.fill('#ed-price', '55');
  check('Agregar: precio "55" avisa ¿$55.000?', (await adm.textContent('#ed-price-hint')).includes('$55.000'));
  await adm.fill('#ed-price', '55.000');
  await adm.fill('#ed-size', '2 productos');
  await adm.fill('#ed-short', 'Rizos definidos sin frizz.');
  await adm.fill('#ed-tags', 'Rizos, Sin sal');
  await adm.tap('#ed-submit');
  check('Agregar: sin foto la pide', (await adm.textContent('#ed-error')).includes('foto'));
  await adm.setInputFiles('#ed-photo', PHOTO_JPG);
  await adm.waitForSelector('#ed-preview img');
  await adm.tap('#ed-submit');
  await adm.waitForFunction(() => !document.querySelector('#editor').open, null, { timeout: 10000 });
  check('Agregar: mensaje de publicado', (await adm.textContent('#toast')).includes('publicado'), await adm.textContent('#toast'));
  check('Agregar: aparece en la lista (17)', await adm.locator('.row').count() === 17);
  let row = (await api('/rest/v1/products?select=id,price,image_url,image_path,name,brand,available,visible&id=eq.mave-kit-rizos-definidos'))[0];
  check('Agregar: guardado en la BD con precio 55000 y foto en Storage', row && row.price === 55000 && /^products\/mave-kit-rizos-definidos-\d+\.(webp|jpg)$/.test(row.image_path), row && row.image_path);
  let stored = await api('/__files');
  check('Agregar: la foto se subió reducida', stored.length === 1);

  // 5. Se ve en la tienda sin volver a publicar
  await shop.reload(); await shop.waitForSelector('.card');
  const card = shop.locator('.card', { hasText: 'Kit Rizos Definidos' });
  check('Tienda: el producto nuevo aparece al recargar', await card.count() === 1);
  const newImg = await card.locator('img').evaluate(async i => { i.loading = 'eager'; if (!i.complete) await new Promise(r => { i.onload = i.onerror = r; }); return { w: i.naturalWidth, src: i.src }; });
  check('Tienda: su foto carga desde Storage', newImg.w > 0 && newImg.src.startsWith(API + '/storage/v1/object/public/product-images/'), newImg.w + 'px');
  check('Tienda: precio $55.000', (await card.locator('.price').textContent()) === '$55.000');

  // 6. WhatsApp identifica el producto nuevo
  await card.locator('[data-add]').tap();
  await shop.tap('#open-cart');
  const href = decodeURIComponent(await shop.getAttribute('#c-send', 'href'));
  check('WhatsApp: número 573122580334', href.startsWith('https://wa.me/573122580334?text='));
  check('WhatsApp: mensaje identifica el producto', href.includes('• 1 x MAVE Kit Rizos Definidos ($55.000)') && href.includes('Total: $55.000'), href.split('text=')[1].replace(/\n/g, ' | '));
  const [wa] = await Promise.all([ctx.waitForEvent('page', { timeout: 4000 }).catch(() => null), shop.tap('#c-send')]);
  check('WhatsApp: el botón abre el chat', !!wa && wa.url().startsWith('https://wa.me/573122580334'));
  if (wa) await wa.close();
  await shop.tap('#cart [data-close]');

  // 7. Editar precio y cambiar foto
  await adm.locator('.row', { hasText: 'Kit Rizos Definidos' }).locator('[data-edit]').tap();
  await adm.waitForSelector('#editor[open]');
  check('Editar: el formulario trae los datos', (await adm.inputValue('#ed-name')) === 'Kit Rizos Definidos' && (await adm.inputValue('#ed-price')) === '55000');
  await adm.fill('#ed-price', '58000');
  await adm.setInputFiles('#ed-photo', PHOTO_PNG);
  await adm.waitForFunction(() => document.querySelector('#ed-preview img') && document.querySelector('#ed-preview img').src.startsWith('blob:'));
  await adm.tap('#ed-submit');
  await adm.waitForFunction(() => !document.querySelector('#editor').open, null, { timeout: 10000 });
  const row2 = (await api('/rest/v1/products?select=id,price,image_url,image_path,name,brand,available,visible&id=eq.mave-kit-rizos-definidos'))[0];
  stored = await api('/__files');
  check('Editar: precio 58000 guardado', row2.price === 58000);
  check('Editar: foto nueva y la vieja se borró de Storage', row2.image_path !== row.image_path && stored.length === 1 && stored[0].endsWith(row2.image_path), stored.join(','));
  await shop.reload(); await shop.waitForSelector('.card');
  check('Tienda: muestra el precio nuevo $58.000', (await shop.locator('.card', { hasText: 'Kit Rizos Definidos' }).locator('.price').textContent()) === '$58.000');
  check('Tienda: el carrito se actualizó al precio nuevo', (await shop.textContent('#c-total')) === '$58.000');

  // 8. Editar un producto original sin cambiar la foto
  await adm.locator('.row[data-id="lpp-termo"]').locator('[data-edit]').tap();
  await adm.waitForSelector('#editor[open]');
  await adm.fill('#ed-price', '32000'); await adm.tap('#ed-submit');
  await adm.waitForFunction(() => !document.querySelector('#editor').open);
  const lpp = (await api('/rest/v1/products?select=price,image_url&id=eq.lpp-termo'))[0];
  check('Editar original: precio 32000 y conserva su foto img/lpp-termo.webp', lpp.price === 32000 && lpp.image_url === 'img/lpp-termo.webp');

  // 9. Marcar agotado
  await adm.locator('.row', { hasText: 'Kit Rizos Definidos' }).locator('[data-toggle="available"]').tap();
  await adm.waitForFunction(() => document.querySelector('#toast').textContent.includes('agotado'));
  await shop.reload(); await shop.waitForSelector('.card');
  const soldCard = shop.locator('.card', { hasText: 'Kit Rizos Definidos' });
  check('Agotado: la tienda muestra la etiqueta "Agotado"', (await soldCard.locator('.badge').textContent()) === 'Agotado');
  check('Agotado: no se puede agregar al carrito', await soldCard.locator('button.add[disabled]').count() === 1);
  check('Agotado: se quitó del carrito de la clienta', (await shop.textContent('#cart-count')) === '0');

  // 10. Ocultar
  await adm.locator('.row', { hasText: 'Kit Rizos Definidos' }).locator('[data-toggle="visible"]').tap();
  await adm.waitForFunction(() => document.querySelector('#toast').textContent.includes('Oculto'));
  await shop.reload(); await shop.waitForSelector('.card');
  check('Ocultar: ya no aparece en la tienda (16)', await shop.locator('.card').count() === 16 && await shop.locator('.card', { hasText: 'Kit Rizos Definidos' }).count() === 0);
  check('Ocultar: la API pública no lo entrega', (await api('/rest/v1/products?select=id&id=eq.mave-kit-rizos-definidos')).length === 0);
  await adm.selectOption('#f-state', 'hidden');
  check('Panel: filtro "Ocultos" lo muestra', await adm.locator('.row').count() === 1);
  await adm.selectOption('#f-state', 'all');

  // 11. Eliminar con confirmación
  await adm.locator('.row', { hasText: 'Kit Rizos Definidos' }).locator('[data-delete]').tap();
  await adm.waitForSelector('#confirm[open]');
  check('Eliminar: pide confirmación', (await adm.textContent('#cf-text')).includes('no se puede deshacer'));
  await adm.locator('#confirm [data-close]').tap();
  check('Eliminar: "Cancelar" no borra nada', await adm.locator('.row').count() === 17);
  await adm.locator('.row', { hasText: 'Kit Rizos Definidos' }).locator('[data-delete]').tap();
  await adm.waitForSelector('#confirm[open]');
  await adm.tap('#cf-delete');
  await adm.waitForFunction(() => document.querySelector('#toast').textContent.includes('eliminado'));
  const admRows = await adm.locator('.row').count();
  const dbRows = await (async () => { const r = await fetch(API + '/rest/v1/products?select=id&id=eq.mave-kit-rizos-definidos'); return r.json(); })();
  stored = await api('/__files');
  check('Eliminar: desaparece del panel (16)', admRows === 16);
  check('Eliminar: se borró la foto de Storage', stored.length === 0);
  check('Eliminar: no queda en la BD', dbRows.length === 0);

  // 12. Cerrar sesión
  await adm.tap('#logout'); await adm.waitForSelector('#login:not([hidden])');
  check('Panel: cerrar sesión vuelve al inicio de sesión', true);

  // El único 400 esperado es el intento con contraseña equivocada (paso 2), que el navegador registra como recurso fallido.
  const unexpected = errors.filter(e => !/admin\.html Failed to load resource: the server responded with a status of 400/.test(e));
  check('Sin errores de JavaScript ni de seguridad (CSP) en consola', unexpected.length === 0 && errors.length <= 1, errors.join(' | '));
  await shop.screenshot({ path: 'shop.png' });
  await b.close();
  console.log(results.join('\n')); console.log(`\n${results.length - failed}/${results.length} pruebas correctas`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.error('ERROR', e.message); process.exit(1); });
