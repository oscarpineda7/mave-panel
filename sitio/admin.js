// MAVE Mujer · panel de productos.
// Usa la clave pública de Supabase. Lo que se puede cambiar lo deciden las políticas RLS de la base de datos
// (supabase/01_esquema.sql): solo las cuentas de la tabla "admins" pueden escribir.
(function () {
  'use strict';
  const CFG = window.MAVE_CONFIG || {};
  const BUCKET = CFG.bucket || 'product-images';
  const CATS = CFG.categories || [];
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => '$' + Number(n || 0).toLocaleString('es-CO');
  const catLabel = id => (CATS.find(c => c.id === id) || { label: id || 'Sin categoría' }).label;

  if (CFG.storeUrl) { $('#store-link').href = CFG.storeUrl; $('#brand-link').href = CFG.storeUrl; }
  if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase) { $('#setup').hidden = false; return; }

  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  let products = [];
  let editing = null;      // producto que se está editando (null = nuevo)
  let photoBlob = null;    // foto nueva ya reducida, lista para subir
  let photoUrl = null;     // vista previa local
  let pendingDelete = null;

  // ── Utilidades ────────────────────────────────────────────
  let tt;
  function toast(msg, isErr) {
    const t = $('#toast'); t.textContent = msg; t.classList.toggle('err', !!isErr); t.classList.add('show');
    clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), isErr ? 4200 : 2400);
  }
  function busy(text) { $('#busy-text').textContent = text || 'Guardando…'; $('#busy').hidden = !text; }
  function friendly(err) {
    const m = String((err && (err.message || err.error_description || err.error)) || err || '');
    if (/invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/email not confirmed/i.test(m)) return 'Esta cuenta aún no está confirmada.';
    if (/row-level security|permission denied|42501|unauthorized|403/i.test(m)) return 'Tu cuenta no tiene permiso para hacer este cambio.';
    if (/failed to fetch|network|load failed/i.test(m)) return 'Sin conexión. Revisa tu internet e intenta de nuevo.';
    if (/products_stock_nonneg|23514/i.test(m)) return 'No hay suficientes unidades para restar esa cantidad.';
    if (/duplicate key|23505/i.test(m)) return 'Ya existe un producto con ese nombre y marca.';
    if (/payload too large|exceeded the maximum|413/i.test(m)) return 'La foto es demasiado pesada. Prueba con otra.';
    if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera un minuto e intenta de nuevo.';
    return m || 'Algo salió mal. Intenta de nuevo.';
  }
  function slugify(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'producto';
  }
  function uniqueId(base) {
    const ids = new Set(products.map(p => p.id)); let id = base, n = 2;
    while (ids.has(id)) id = `${base}-${n++}`;
    return id;
  }
  function parsePrice(v) { const d = String(v).replace(/[^\d]/g, ''); return d ? parseInt(d, 10) : NaN; }
  function imgSrc(p) { return p.image_url || 'img/logo.webp'; }
  const counted = p => p.stock !== null && p.stock !== undefined;
  const isLow = p => counted(p) && p.stock <= (p.min_stock || 0);
  const units = n => n === 1 ? '1 unidad' : `${n} unidades`;
  function parseCount(v) { const t = String(v).trim(); if (!t) return null; const n = parseInt(t.replace(/[^\d]/g, ''), 10); return isNaN(n) ? NaN : n; }

  function openDlg(d) {
    if (typeof d.showModal === 'function') { try { d.showModal(); return; } catch (e) { } }
    d.setAttribute('open', ''); d.classList.add('fallback');
    const bd = document.createElement('div'); bd.className = 'dlg-backdrop'; d.before(bd); d._bd = bd;
  }
  function closeDlg(d) {
    if (typeof d.close === 'function' && !d.classList.contains('fallback')) { d.close(); return; }
    d.removeAttribute('open'); d.classList.remove('fallback'); if (d._bd) { d._bd.remove(); d._bd = null; }
  }
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeDlg(b.closest('dialog'))));

  // ── Sesión ────────────────────────────────────────────────
  function show(view) {
    $('#login').hidden = view !== 'login';
    $('#reset').hidden = view !== 'reset';
    $('#app').hidden = view !== 'app';
    $('#fab').hidden = view !== 'app';
    $('#logout').hidden = view !== 'app';
  }
  let recovering = false;
  async function enter(session) {
    if (recovering) return;
    if (!session) { show('login'); return; }
    const { data, error } = await sb.from('admins').select('user_id').eq('user_id', session.user.id).maybeSingle();
    if (error || !data) {
      await sb.auth.signOut();
      show('login');
      showLoginError(error ? friendly(error) : 'Esta cuenta no tiene permiso para administrar la tienda.');
      return;
    }
    $('#who').textContent = session.user.email;
    show('app');
    await loadProducts();
    openFromHash();
  }
  function showLoginError(msg) { const e = $('#l-error'); e.textContent = msg; e.hidden = !msg; }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { recovering = true; show('reset'); }
    if (event === 'SIGNED_OUT') { products = []; show('login'); }
  });

  $('#login').addEventListener('submit', async e => {
    e.preventDefault(); showLoginError('');
    const email = $('#l-email').value.trim(), password = $('#l-pass').value;
    if (!email || !password) { showLoginError('Escribe tu correo y tu contraseña.'); return; }
    const btn = $('#l-submit'); btn.disabled = true; btn.textContent = 'Entrando…';
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = 'Entrar';
    if (error) { showLoginError(friendly(error)); return; }
    $('#l-pass').value = '';
    await enter(data.session);
  });

  $('#l-forgot').addEventListener('click', async () => {
    const email = $('#l-email').value.trim();
    if (!email) { showLoginError('Escribe tu correo arriba y vuelve a tocar “¿Olvidaste tu contraseña?”.'); return; }
    const redirectTo = location.href.split('#')[0].split('?')[0];
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) { showLoginError(friendly(error)); return; }
    showLoginError(''); toast('Si el correo es de una administradora, te llegará un enlace para cambiar la contraseña.');
  });

  $('#reset').addEventListener('submit', async e => {
    e.preventDefault();
    const pass = $('#r-pass').value, err = $('#r-error');
    if (pass.length < 8) { err.textContent = 'La contraseña debe tener al menos 8 caracteres.'; err.hidden = false; return; }
    const { error } = await sb.auth.updateUser({ password: pass });
    if (error) { err.textContent = friendly(error); err.hidden = false; return; }
    recovering = false; toast('Contraseña actualizada.');
    const { data } = await sb.auth.getSession(); await enter(data.session);
  });

  $('#logout').addEventListener('click', async () => { await sb.auth.signOut(); toast('Sesión cerrada.'); });

  // ── Lista ─────────────────────────────────────────────────
  $('#f-cat').innerHTML = '<option value="all">Todas las categorías</option>' + CATS.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  $('#ed-cat').innerHTML = '<option value="">Elige una categoría</option>' + CATS.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  ['#f-q', '#f-cat', '#f-state'].forEach(s => $(s).addEventListener('input', renderList));

  async function loadProducts() {
    const { data, error } = await sb.from('products').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true });
    if (error) { toast(friendly(error), true); return; }
    products = data || [];
    $('#brands').innerHTML = [...new Set(products.map(p => p.brand).filter(Boolean))].map(b => `<option value="${esc(b)}">`).join('');
    renderList();
  }

  let shownList = [];
  function stockCtl(p) {
    if (!counted(p)) return `<button class="btn btn-ghost btn-sm stock" type="button" data-stock>Contar stock</button>`;
    const cls = p.stock === 0 ? ' zero' : isLow(p) ? ' low' : '';
    return `<div class="stock">
            <button class="qty-btn" type="button" data-dec ${p.stock === 0 ? 'disabled' : ''} aria-label="Restar una unidad de ${esc(p.name)}">−</button>
            <button class="qty${cls}" type="button" data-stock aria-label="Inventario de ${esc(p.name)}: ${units(p.stock)}"><b>${p.stock}</b><small>${p.stock === 1 ? 'unidad' : 'unidades'}</small></button>
            <button class="qty-btn" type="button" data-inc aria-label="Sumar una unidad de ${esc(p.name)}">+</button>
          </div>`;
  }
  function renderList() {
    const q = $('#f-q').value.trim().toLowerCase(), cat = $('#f-cat').value, st = $('#f-state').value;
    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const nq = norm(q);
    const list = products.filter(p =>
      (!nq || norm(p.name + ' ' + p.brand).includes(nq)) &&
      (cat === 'all' || p.category === cat) &&
      (st === 'all' || (st === 'visible' && p.visible) || (st === 'hidden' && !p.visible) || (st === 'sold' && !p.available) ||
       (st === 'low' && isLow(p)) || (st === 'uncounted' && !counted(p))));
    shownList = list;
    const low = products.filter(isLow);
    $('#low-banner').hidden = !low.length;
    $('#low-text').innerHTML = low.length === 1
      ? `<b>1 producto con poco stock:</b> ${esc(low[0].name)} (${units(low[0].stock)}).`
      : `<b>${low.length} productos con poco stock.</b> Es momento de pedir mercancía.`;
    $('#low-show').hidden = st === 'low';
    $('#count').textContent = `${list.length} de ${products.length} productos`;
    $('#list').innerHTML = list.length ? list.map(p => `
      <li class="row" data-id="${esc(p.id)}">
        <img src="${esc(imgSrc(p))}" alt="" loading="lazy">
        <div class="meta">
          <b>${esc(p.name)}</b>
          <small>${esc(p.brand || 'Sin marca')} · ${esc(catLabel(p.category))}</small>
          <span class="price">${fmt(p.price)}</span>
          <div class="pills">${!p.available ? '<span class="pill sold">Agotado</span>' : ''}${isLow(p) && p.stock > 0 ? '<span class="pill low">Poco stock</span>' : ''}${!p.visible ? '<span class="pill hidden">Oculto</span>' : ''}${p.size ? `<span class="pill">${esc(p.size)}</span>` : ''}</div>
        </div>
        <div class="actions">
          ${stockCtl(p)}
          <div class="toggles">
            <label class="switch"><input type="checkbox" data-toggle="available" ${p.available ? 'checked' : ''} aria-label="Disponible: ${esc(p.name)}"> Disponible</label>
            <label class="switch"><input type="checkbox" data-toggle="visible" ${p.visible ? 'checked' : ''} aria-label="Visible: ${esc(p.name)}"> Visible</label>
          </div>
          <div class="btns">
            <button class="btn btn-ghost btn-sm" type="button" data-edit>Editar</button>
            <button class="btn btn-ghost btn-sm" type="button" data-delete>Eliminar</button>
          </div>
        </div>
      </li>`).join('')
      : `<li class="empty">${products.length ? 'Ningún producto coincide con la búsqueda.' : 'Todavía no hay productos. Toca “Agregar producto”.'}</li>`;
  }

  $('#list').addEventListener('change', async e => {
    const t = e.target.closest('[data-toggle]'); if (!t) return;
    const id = t.closest('[data-id]').dataset.id, field = t.dataset.toggle, value = t.checked;
    t.disabled = true;
    const { data, error } = await sb.from('products').update({ [field]: value }).eq('id', id).select().maybeSingle();
    t.disabled = false;
    if (error || !data) { t.checked = !value; toast(error ? friendly(error) : 'No se pudo guardar el cambio.', true); return; }
    Object.assign(products.find(p => p.id === id), data);
    toast(field === 'available' ? (value ? 'Marcado como disponible.' : 'Marcado como agotado.') : (value ? 'Ahora se ve en la tienda.' : 'Oculto de la tienda.'));
    renderList();
  });

  $('#low-show').addEventListener('click', () => { $('#f-state').value = 'low'; $('#f-q').value = ''; $('#f-cat').value = 'all'; renderList(); });

  $('#list').addEventListener('click', e => {
    const row = e.target.closest('[data-id]'); if (!row) return;
    const p = products.find(x => x.id === row.dataset.id); if (!p) return;
    if (e.target.closest('[data-dec]')) { changeStock(p, -1, { reason: 'salida', channel }, e.target.closest('[data-dec]')); return; }
    if (e.target.closest('[data-inc]')) { changeStock(p, 1, { reason: 'entrada' }, e.target.closest('[data-inc]')); return; }
    if (e.target.closest('[data-stock]')) { openStock(p); return; }
    if (e.target.closest('[data-edit]')) openEditor(p);
    if (e.target.closest('[data-delete]')) {
      pendingDelete = p;
      $('#cf-text').textContent = `Se borrará «${p.name}» y su foto. Esta acción no se puede deshacer. Si solo quieres que no se vea en la tienda, usa “Solo ocultar”.`;
      $('#cf-hide').hidden = !p.visible;
      openDlg($('#confirm'));
    }
  });

  // ── Eliminar / ocultar ────────────────────────────────────
  $('#cf-hide').addEventListener('click', async () => {
    const p = pendingDelete; closeDlg($('#confirm')); if (!p) return;
    const { data, error } = await sb.from('products').update({ visible: false }).eq('id', p.id).select().maybeSingle();
    if (error || !data) { toast(error ? friendly(error) : 'No se pudo ocultar.', true); return; }
    Object.assign(p, data); renderList(); toast('Oculto de la tienda.');
  });
  $('#cf-delete').addEventListener('click', async () => {
    const p = pendingDelete; closeDlg($('#confirm')); if (!p) return;
    busy('Eliminando…');
    const { data, error } = await sb.from('products').delete().eq('id', p.id).select();
    if (error || !data || !data.length) { busy(); toast(error ? friendly(error) : 'No se pudo eliminar.', true); return; }
    if (p.image_path) await sb.storage.from(BUCKET).remove([p.image_path]);
    products = products.filter(x => x.id !== p.id);
    busy(); renderList(); toast(`«${p.name}» eliminado.`);
  });

  // ── Inventario ────────────────────────────────────────────
  let stockP = null;
  function applyRow(p, data) {
    const wasAvail = p.available;
    Object.assign(p, data);
    renderList(); if (stockP === p) renderStock();
    return wasAvail;
  }
  // Suma o resta unidades. La base de datos hace la cuenta (dos toques seguidos nunca se pisan),
  // anota el movimiento y pone "Agotado" sola al llegar a 0.
  // Canal de las ventas hechas con "−" (se recuerda en este dispositivo).
  const CH_LABEL = { fisica: 'Local', online: 'Online' };
  let channel = 'fisica';
  try { if (localStorage.getItem('mave.channel') === 'online') channel = 'online'; } catch (e) { }
  function paintChannel() { document.querySelectorAll('[data-ch]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ch === channel))); }
  document.querySelectorAll('[data-ch]').forEach(b => b.addEventListener('click', () => {
    channel = b.dataset.ch; paintChannel(); try { localStorage.setItem('mave.channel', channel); } catch (e) { }
  }));
  paintChannel();

  // o = { reason, price, cost, channel }: price/cost por unidad solo si son distintos a los del producto.
  async function changeStock(p, delta, o, btn) {
    o = o || {};
    if (btn) btn.disabled = true;
    const { data, error } = await sb.rpc('adjust_stock', {
      p_id: p.id, p_delta: delta, p_reason: o.reason || null,
      p_unit_price: o.price == null ? null : o.price, p_unit_cost: o.cost == null ? null : o.cost,
      p_channel: delta < 0 && (o.reason || 'salida') === 'salida' ? (o.channel || channel) : null
    });
    if (btn) btn.disabled = false;
    if (error || !data) { toast(error ? friendly(error) : 'No se pudo guardar el cambio.', true); return false; }
    const wasAvail = applyRow(p, data);
    const sale = delta < 0 ? `Venta ${CH_LABEL[o.channel || channel].toLowerCase()} · ` : '';
    let msg = delta > 0 ? `+${delta} · ${p.name}: ${units(data.stock)}` : `${sale}${p.name}: quedan ${data.stock}`;
    if (data.stock === 0) msg = `${p.name}: se acabó. En la tienda ya sale “Agotado”.`;
    else if (!wasAvail && data.available) msg = `${p.name}: ${units(data.stock)}. Ya se puede comprar otra vez.`;
    else if (isLow(data) && delta < 0) msg += ' · Poco stock';
    toast(msg, data.stock === 0);
    if (stockP === p) loadHistory(p);
    return true;
  }
  async function setStock(p, value, reason) {
    const { data, error } = await sb.rpc('set_stock', { p_id: p.id, p_stock: value, p_reason: reason });
    if (error || !data) { toast(error ? friendly(error) : 'No se pudo guardar el cambio.', true); return false; }
    applyRow(p, data); if (stockP === p) loadHistory(p);
    toast(data.stock === 0 ? `${p.name}: 0 unidades. En la tienda sale “Agotado”.` : `${p.name}: ${units(data.stock)}.`);
    return true;
  }

  function renderStock() {
    const p = stockP; if (!p) return;
    $('#sd-img').src = imgSrc(p);
    $('#sd-title').textContent = p.name;
    $('#sd-sub').textContent = [p.brand, p.size].filter(Boolean).join(' · ') || catLabel(p.category);
    const c = counted(p);
    $('#sd-num').textContent = c ? p.stock : '—';
    $('#sd-unit').textContent = c ? (p.stock === 1 ? 'unidad' : 'unidades') : 'sin contar';
    $('#sd-dec').disabled = !c || p.stock === 0;
    $('#sd-min').value = p.min_stock;
    $('#sd-count').placeholder = c ? String(p.stock) : 'Ej.: 10';
    $('#sd-in-cost').placeholder = p.cost != null ? String(p.cost) : 'Opcional';
    $('#sd-state').textContent = !c ? 'Escribe abajo cuántas unidades hay para empezar a llevar la cuenta.'
      : p.stock === 0 ? 'Agotado en la tienda. Al sumar unidades vuelve a estar disponible.'
      : isLow(p) ? `Poco stock: avisa con ${p.min_stock} o menos.` : (p.available ? 'Disponible en la tienda.' : 'Marcado como agotado a mano.');
  }
  const REASONS = { entrada: 'Entrada', salida: 'Venta', conteo: 'Conteo', inicial: 'Stock inicial', ajuste: 'Ajuste' };
  async function loadHistory(p) {
    const ul = $('#sd-history');
    const { data, error } = await sb.from('stock_movements').select('id,delta,stock_after,reason,unit_price,channel,created_at').eq('product_id', p.id).order('id', { ascending: false }).limit(10);
    if (stockP !== p) return;
    if (error) { ul.innerHTML = '<li class="muted">No se pudo cargar el historial.</li>'; return; }
    ul.innerHTML = (data || []).length ? data.map(m => {
      const d = new Date(m.created_at);
      const when = d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
      return `<li><span class="d ${m.delta > 0 ? 'up' : 'down'}">${m.delta > 0 ? '+' : ''}${m.delta}</span><span>${esc(REASONS[m.reason] || m.reason)}${m.reason === 'salida' && m.channel ? ' ' + esc(CH_LABEL[m.channel].toLowerCase()) : ''}${m.reason === 'salida' && m.unit_price != null ? ' · ' + fmt(-m.delta * m.unit_price) : ''} · quedan ${m.stock_after}</span><time datetime="${esc(m.created_at)}">${esc(when)}</time><button class="undo" type="button" data-undo="${m.id}" aria-label="Deshacer este movimiento">Deshacer</button></li>`;
    }).join('') : '<li class="muted">Todavía no hay movimientos.</li>';
  }
  // Deshacer: primer toque pide confirmación ("¿Seguro?"), el segundo lo deshace.
  $('#sd-history').addEventListener('click', async e => {
    const b = e.target.closest('[data-undo]'); const p = stockP; if (!b || !p || b.disabled) return;
    if (!b.classList.contains('sure')) {
      $('#sd-history').querySelectorAll('.undo.sure').forEach(x => { x.classList.remove('sure'); x.textContent = 'Deshacer'; });
      b.classList.add('sure'); b.textContent = '¿Seguro?';
      setTimeout(() => { if (b.isConnected) { b.classList.remove('sure'); b.textContent = 'Deshacer'; } }, 4000);
      return;
    }
    b.disabled = true; b.textContent = '…';
    const { data, error } = await sb.rpc('undo_movement', { p_movement: Number(b.dataset.undo) });
    if (error || !data) { toast(error ? friendly(error) : 'No se pudo deshacer.', true); loadHistory(p); return; }
    applyRow(p, data); if (stockP === p) loadHistory(p);
    toast(`Deshecho. ${p.name}: ${counted(data) ? units(data.stock) : 'sin contar'}.`);
  });
  function openStock(p) {
    stockP = p; $('#sd-in').value = ''; $('#sd-count').value = ''; $('#sd-in-cost').value = p.cost != null ? String(p.cost) : '';
    $('#sd-sale-n').value = '1'; $('#sd-sale-price').value = String(p.price); $('#sd-sale-ch').value = channel;
    $('#sd-history').innerHTML = '<li class="muted">Cargando…</li>';
    renderStock(); openDlg($('#stock-dlg')); loadHistory(p);
  }
  $('#stock-dlg').addEventListener('close', () => { stockP = null; });
  $('#stock-dlg').querySelector('[data-close]').addEventListener('click', () => { stockP = null; });
  $('#sd-dec').addEventListener('click', e => stockP && changeStock(stockP, -1, { reason: 'salida', channel }, e.currentTarget));
  $('#sd-inc').addEventListener('click', e => stockP && changeStock(stockP, 1, { reason: 'entrada' }, e.currentTarget));
  $('#sd-sale-form').addEventListener('submit', async e => {
    e.preventDefault(); const p = stockP; if (!p) return;
    const n = parseCount($('#sd-sale-n').value), price = parsePrice($('#sd-sale-price').value);
    if (!n || isNaN(n)) { toast('Escribe cuántas unidades vendiste.', true); $('#sd-sale-n').focus(); return; }
    if (isNaN(price)) { toast('Escribe el precio de cada unidad. Ej.: 42000', true); $('#sd-sale-price').focus(); return; }
    if (await changeStock(p, -n, { reason: 'salida', price: price === p.price ? null : price, channel: $('#sd-sale-ch').value })) {
      $('#sd-sale-n').value = '1'; $('#sd-sale-price').value = String(p.price);
    }
  });
  $('#sd-in-form').addEventListener('submit', async e => {
    e.preventDefault(); const n = parseCount($('#sd-in').value), costTxt = $('#sd-in-cost').value.trim();
    const cost = costTxt ? parsePrice(costTxt) : null;
    if (!n || isNaN(n)) { toast('Escribe cuántas unidades llegaron. Ej.: 6', true); $('#sd-in').focus(); return; }
    if (Number.isNaN(cost)) { toast('Escribe lo que pagaste por unidad, solo números.', true); $('#sd-in-cost').focus(); return; }
    if (await changeStock(stockP, n, { reason: 'entrada', cost })) $('#sd-in').value = '';
  });
  $('#sd-count-form').addEventListener('submit', async e => {
    e.preventDefault(); const n = parseCount($('#sd-count').value);
    if (n === null || isNaN(n)) { toast('Escribe cuántas unidades hay. Ej.: 10', true); $('#sd-count').focus(); return; }
    if (await setStock(stockP, n, counted(stockP) ? 'conteo' : 'inicial')) $('#sd-count').value = '';
  });
  $('#sd-min-form').addEventListener('submit', async e => {
    e.preventDefault(); const n = parseCount($('#sd-min').value), p = stockP;
    if (n === null || isNaN(n)) { toast('Escribe un número. Ej.: 3', true); return; }
    const { data, error } = await sb.from('products').update({ min_stock: n }).eq('id', p.id).select().maybeSingle();
    if (error || !data) { toast(error ? friendly(error) : 'No se pudo guardar.', true); return; }
    applyRow(p, data); toast(`Avisará cuando queden ${n} o menos.`);
  });

  // Abrir un producto desde su etiqueta QR: admin.html#p=<id>
  function openFromHash() {
    const m = location.hash.match(/^#p=([a-z0-9-]+)$/); if (!m || $('#app').hidden) return;
    history.replaceState(null, '', location.pathname + location.search);
    const p = products.find(x => x.id === m[1]);
    if (p) openStock(p); else toast('Ese producto ya no existe en el panel.', true);
  }
  window.addEventListener('hashchange', openFromHash);

  // ── Etiquetas QR ─────────────────────────────────────────
  function qrSvg(text) {
    const q = window.qrcode(0, 'M'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }
  function printLabels(list, copies) {
    if (!window.qrcode) { toast('No se pudo cargar el generador de QR. Recarga la página.', true); return; }
    if (!list.length) { toast('No hay productos para imprimir.', true); return; }
    const base = location.origin + location.pathname;
    const one = p => `<div class="label">${qrSvg(base + '#p=' + p.id)}<b>${esc(p.name)}</b><small>${esc([p.brand, p.size].filter(Boolean).join(' · '))}</small></div>`;
    $('#labels').innerHTML = list.map(p => one(p).repeat(copies)).join('');
    setTimeout(() => window.print(), 50);
  }
  $('#labels-btn').addEventListener('click', () => openDlg($('#labels-dlg')));
  $('#lb-print').addEventListener('click', () => {
    const copies = Math.min(30, Math.max(1, parseInt($('#lb-copies').value, 10) || 1));
    const list = $('#lb-which').value === 'all' ? products : shownList;
    closeDlg($('#labels-dlg')); printLabels(list, copies);
  });
  $('#sd-label').addEventListener('click', () => { if (stockP) printLabels([stockP], 1); });

  // ── Foto ──────────────────────────────────────────────────
  function loadImageEl(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  function toBlob(canvas, type, q) { return new Promise(r => canvas.toBlob(r, type, q)); }
  async function shrinkPhoto(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { src = await loadImageEl(file); }
    const w = src.width, h = src.height, scale = Math.min(1, 1200 / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    let blob = await toBlob(c, 'image/webp', 0.82);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(c, 'image/jpeg', 0.85);
    if (!blob) throw new Error('decode');
    return blob;
  }
  function setPreview(src) {
    $('#ed-preview').innerHTML = src ? `<img src="${esc(src)}" alt="Vista previa de la foto">` : '<div class="ph">Sin foto</div>';
    $('#ed-photo-lbl').textContent = src ? 'Cambiar foto' : 'Elegir foto';
  }
  $('#ed-photo').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    edError('');
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) { edError('Ese archivo no es una foto.'); return; }
    try {
      busy('Preparando foto…');
      photoBlob = await shrinkPhoto(file);
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      photoUrl = URL.createObjectURL(photoBlob); setPreview(photoUrl);
    } catch (err) {
      photoBlob = null; edError('No se pudo leer la foto. Prueba con una foto en formato JPG o PNG.');
    } finally { busy(); e.target.value = ''; }
  });

  // ── Editor ────────────────────────────────────────────────
  function edError(msg) { const e = $('#ed-error'); e.textContent = msg; e.hidden = !msg; }
  function priceHint() {
    const v = parsePrice($('#ed-price').value), h = $('#ed-price-hint');
    if (isNaN(v)) { h.textContent = ''; h.classList.remove('warn'); return; }
    h.textContent = v > 0 && v < 1000 ? `Se verá como ${fmt(v)}. ¿Quisiste decir ${fmt(v * 1000)}?` : `Se verá como ${fmt(v)}`;
    h.classList.toggle('warn', v > 0 && v < 1000);
  }
  $('#ed-price').addEventListener('input', priceHint);

  function openEditor(p) {
    editing = p || null; photoBlob = null; edError('');
    if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = null; }
    $('#ed-title').textContent = p ? 'Editar producto' : 'Agregar producto';
    $('#ed-submit').textContent = p ? 'Guardar cambios' : 'Publicar producto';
    $('#ed-name').value = p ? p.name : '';
    $('#ed-brand').value = p ? p.brand : '';
    $('#ed-cat').value = p ? p.category : '';
    $('#ed-price').value = p ? String(p.price) : '';
    $('#ed-size').value = p ? p.size : '';
    $('#ed-short').value = p ? p.short_desc : '';
    $('#ed-desc').value = p ? p.description : '';
    $('#ed-tags').value = p ? (p.tags || []).join(', ') : '';
    $('#ed-items').value = p ? (p.items || []).join('\n') : '';
    $('#ed-badge').value = p ? p.badge : '';
    const maxOrder = products.reduce((m, x) => Math.max(m, x.sort_order || 0), 0);
    $('#ed-order').value = p ? p.sort_order : maxOrder + 10;
    $('#ed-available').checked = p ? p.available : true;
    $('#ed-visible').checked = p ? p.visible : true;
    $('#ed-stock').value = p && counted(p) ? String(p.stock) : '';
    $('#ed-min').value = p ? String(p.min_stock) : '3';
    $('#ed-cost').value = p && p.cost != null ? String(p.cost) : '';
    setPreview(p ? imgSrc(p) : null);
    priceHint();
    openDlg($('#editor'));
    if (!p) setTimeout(() => $('#ed-name').focus(), 50);
  }
  $('#add-btn').addEventListener('click', () => openEditor(null));
  $('#fab').addEventListener('click', () => openEditor(null));

  async function uploadPhoto(id) {
    const ext = photoBlob.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `products/${id}-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, photoBlob, { contentType: photoBlob.type, cacheControl: '31536000', upsert: false });
    if (error) throw error;
    return { path, url: sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
  }

  $('#ed-form').addEventListener('submit', async e => {
    e.preventDefault(); edError('');
    const name = $('#ed-name').value.trim(), brand = $('#ed-brand').value.trim(), category = $('#ed-cat').value;
    const price = parsePrice($('#ed-price').value), size = $('#ed-size').value.trim();
    if (!name) { edError('Escribe el nombre del producto.'); $('#ed-name').focus(); return; }
    if (!category) { edError('Elige una categoría.'); $('#ed-cat').focus(); return; }
    if (isNaN(price)) { edError('Escribe el precio en pesos, solo números. Ej.: 42000'); $('#ed-price').focus(); return; }
    if (!editing && !photoBlob) { edError('Elige una foto del producto.'); return; }
    const stockIn = parseCount($('#ed-stock').value), minIn = parseCount($('#ed-min').value);
    if (Number.isNaN(stockIn)) { edError('Escribe las unidades en stock solo con números, o déjalo vacío.'); $('#ed-stock').focus(); return; }
    const costTxt = $('#ed-cost').value.trim(), costIn = costTxt ? parsePrice(costTxt) : null;
    if (Number.isNaN(costIn)) { edError('Escribe el costo solo con números, o déjalo vacío.'); $('#ed-cost').focus(); return; }
    if (Number.isNaN(minIn)) { edError('Escribe en “Avisar cuando queden” solo números. Ej.: 3'); $('#ed-min').focus(); return; }
    const items = $('#ed-items').value.split('\n').map(s => s.trim()).filter(Boolean);
    const row = {
      name, brand, category, price, size,
      badge: $('#ed-badge').value.trim(),
      short_desc: $('#ed-short').value.trim(),
      description: $('#ed-desc').value.trim(),
      tags: $('#ed-tags').value.split(',').map(s => s.trim()).filter(Boolean),
      items: items.length ? items : [[name, size].filter(Boolean).join(' ')],
      sort_order: parseInt($('#ed-order').value, 10) || 0,
      available: $('#ed-available').checked,
      visible: $('#ed-visible').checked,
      min_stock: minIn === null ? 3 : minIn,
      cost: costIn
    };
    // El stock solo se envía si se cambió aquí, para no pisar ventas hechas mientras el formulario estaba abierto.
    const oldStock = editing && counted(editing) ? editing.stock : null;
    if (!editing || stockIn !== oldStock) row.stock = stockIn;
    const btn = $('#ed-submit'); btn.disabled = true;
    let uploaded = null;
    try {
      const id = editing ? editing.id : uniqueId(slugify([brand, name].filter(Boolean).join(' ')));
      if (photoBlob) { busy('Subiendo foto…'); uploaded = await uploadPhoto(id); row.image_url = uploaded.url; row.image_path = uploaded.path; }
      busy(editing ? 'Guardando cambios…' : 'Publicando…');
      let res;
      if (editing) res = await sb.from('products').update(row).eq('id', editing.id).select().maybeSingle();
      else res = await sb.from('products').insert(Object.assign({ id }, row)).select().maybeSingle();
      if (res.error || !res.data) throw res.error || new Error('permission denied');
      if (editing) {
        const old = editing.image_path;
        if (uploaded && old && old !== uploaded.path) await sb.storage.from(BUCKET).remove([old]);
        Object.assign(editing, res.data);
      } else {
        products.push(res.data);
      }
      products.sort((a, b) => (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at)));
      closeDlg($('#editor')); renderList();
      toast(editing ? 'Cambios guardados. Ya se ven en la tienda.' : `«${name}» publicado en la tienda.`);
    } catch (err) {
      if (uploaded) await sb.storage.from(BUCKET).remove([uploaded.path]);
      edError(friendly(err));
    } finally { busy(); btn.disabled = false; }
  });

  // ── Resumen de ventas ────────────────────────────────────
  // Todo se calcula con el historial de movimientos: "salida" = venta, "entrada" = compra de mercancía.
  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayLabel = (k, opts) => new Date(k + 'T12:00:00').toLocaleDateString('es-CO', opts || { day: 'numeric', month: 'short' });
  let report = null;

  function tab(which) {
    const r = which === 'report';
    $('#tab-p').setAttribute('aria-selected', String(!r)); $('#tab-r').setAttribute('aria-selected', String(r));
    $('#sec-products').hidden = r; $('#sec-report').hidden = !r;
    $('#app-title').textContent = r ? 'Resumen' : 'Productos';
    $('#fab').hidden = r || $('#app').hidden;
    if (r) loadReport();
  }
  $('#tab-p').addEventListener('click', () => tab('products'));
  $('#tab-r').addEventListener('click', () => tab('report'));

  function periodRange() {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const v = $('#rp-period').value;
    $('#rp-from-f').hidden = $('#rp-to-f').hidden = v !== 'custom';
    if (v === 'today') return [new Date(y, m, d), new Date(y, m, d + 1)];
    if (v === '7d') return [new Date(y, m, d - 6), new Date(y, m, d + 1)];
    if (v === 'prev') return [new Date(y, m - 1, 1), new Date(y, m, 1)];
    if (v === 'custom') {
      const f = $('#rp-from').value, t = $('#rp-to').value;
      if (!f || !t) { $('#rp-from').value = dayKey(new Date(y, m, 1)); $('#rp-to').value = dayKey(now); return periodRange(); }
      const a = new Date(f + 'T00:00:00'), b = new Date(t + 'T00:00:00'); b.setDate(b.getDate() + 1);
      return a < b ? [a, b] : [b, a];
    }
    return [new Date(y, m, 1), new Date(y, m, d + 1)];
  }
  ['#rp-period', '#rp-from', '#rp-to'].forEach(sel => $(sel).addEventListener('change', loadReport));

  async function fetchMovements(from, to) {
    const out = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await sb.from('stock_movements')
        .select('product_id,delta,stock_after,reason,unit_price,unit_cost,channel,created_at')
        .gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
        .order('created_at', { ascending: true }).range(i, i + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }

  function compute(movs, from, to) {
    const byId = Object.fromEntries(products.map(p => [p.id, p]));
    const r = { from, to, movs, units: 0, sold: 0, byCh: { fisica: { u: 0, v: 0 }, online: { u: 0, v: 0 }, otro: { u: 0, v: 0 } },
      costSold: 0, soldWithCost: 0, soldNoCostUnits: 0, boughtUnits: 0, spent: 0, boughtNoCostUnits: 0, days: [], prod: {} };
    const days = {};
    for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) days[dayKey(d)] = { u: 0, v: 0 };
    for (const m of movs) {
      const k = dayKey(new Date(m.created_at));
      if (m.reason === 'salida' && m.delta < 0) {
        const u = -m.delta, v = u * (m.unit_price || 0), ch = r.byCh[m.channel] || r.byCh.otro;
        r.units += u; r.sold += v; ch.u += u; ch.v += v;
        if (days[k]) { days[k].u += u; days[k].v += v; }
        const pr = r.prod[m.product_id] || (r.prod[m.product_id] = { u: 0, v: 0, c: 0, cu: 0 });
        pr.u += u; pr.v += v;
        if (m.unit_cost != null) { r.costSold += u * m.unit_cost; r.soldWithCost += v; pr.c += u * m.unit_cost; pr.cu += u; }
        else r.soldNoCostUnits += u;
      } else if (m.reason === 'entrada' && m.delta > 0) {
        r.boughtUnits += m.delta;
        if (m.unit_cost != null) r.spent += m.delta * m.unit_cost; else r.boughtNoCostUnits += m.delta;
      }
    }
    r.days = Object.entries(days).map(([k, x]) => ({ k, u: x.u, v: x.v }));
    r.profit = r.soldWithCost - r.costSold;
    r.top = Object.entries(r.prod).map(([id, x]) => ({ p: byId[id], id, ...x, profit: x.cu ? (x.v * x.cu / x.u) - x.c : null }))
      .sort((a, b) => b.v - a.v || b.u - a.u);
    const counted_ = products.filter(counted);
    r.stockUnits = counted_.reduce((a, p) => a + p.stock, 0);
    r.stockValue = counted_.reduce((a, p) => a + p.stock * p.price, 0);
    r.stockCost = counted_.filter(p => p.cost != null).reduce((a, p) => a + p.stock * p.cost, 0);
    r.stockNoCost = counted_.filter(p => p.cost == null && p.stock > 0).length;
    return r;
  }

  async function loadReport() {
    const [from, to] = periodRange();
    const last = new Date(to); last.setDate(last.getDate() - 1);
    const same = dayKey(from) === dayKey(last);
    $('#rp-range').textContent = same ? dayLabel(dayKey(from), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : `Del ${dayLabel(dayKey(from), { day: 'numeric', month: 'long' })} al ${dayLabel(dayKey(last), { day: 'numeric', month: 'long', year: 'numeric' })}`;
    $('#rp-tiles').innerHTML = '<div class="tile"><span>Cargando…</span></div>';
    let movs;
    try { movs = await fetchMovements(from, to); }
    catch (err) { $('#rp-tiles').innerHTML = `<div class="tile"><span>${esc(friendly(err))}</span></div>`; return; }
    report = compute(movs, from, to);
    renderReport(report);
  }

  function renderReport(r) {
    const chTxt = ['fisica', 'online'].filter(c => r.byCh[c].u).map(c => `${CH_LABEL[c]} ${fmt(r.byCh[c].v)}`).join(' · ');
    const profitTile = r.soldWithCost || !r.units
      ? `<div class="tile"><small>Ganancia</small><b>${r.units ? fmt(r.profit) : '$0'}</b><span>${r.soldNoCostUnits ? `Sin contar ${units(r.soldNoCostUnits)} sin costo registrado` : 'Vendido menos lo que costó'}</span></div>`
      : `<div class="tile"><small>Ganancia</small><b>—</b><span>Agrega el costo de tus productos para verla</span></div>`;
    $('#rp-tiles').innerHTML = `
      <div class="tile"><small>Vendido</small><b>${fmt(r.sold)}</b><span>${units(r.units)}${chTxt ? ' · ' + esc(chTxt) : ''}</span></div>
      ${profitTile}
      <div class="tile"><small>Gastado en mercancía</small><b>${fmt(r.spent)}</b><span>${units(r.boughtUnits)} entraron${r.boughtNoCostUnits ? ` (${r.boughtNoCostUnits} sin costo)` : ''}</span></div>
      <div class="tile"><small>Inventario hoy</small><b>${fmt(r.stockValue)}</b><span>${units(r.stockUnits)} a precio de venta${r.stockCost ? ` · costo ${fmt(r.stockCost)}` : ''}</span></div>`;

    // Barras: un día = una barra, altura = pesos vendidos.
    const max = Math.max(0, ...r.days.map(d => d.v));
    const chart = $('#rp-chart');
    chart.setAttribute('aria-label', `Ventas por día: total ${fmt(r.sold)}. La tabla de Excel trae el detalle.`);
    chart.innerHTML = r.days.map(d => {
      const h = max ? Math.round(d.v / max * 100) : 0;
      return `<div class="bar" tabindex="0" data-tip="${esc(dayLabel(d.k, { weekday: 'short', day: 'numeric', month: 'short' }))}: ${esc(fmt(d.v))} · ${esc(units(d.u))}" aria-label="${esc(dayLabel(d.k, { day: 'numeric', month: 'long' }))}: ${esc(fmt(d.v))}, ${esc(units(d.u))}"><i style="height:${h}%"></i></div>`;
    }).join('');
    const ds = r.days;
    $('#rp-chart-x').innerHTML = ds.length ? `<span>${esc(dayLabel(ds[0].k))}</span>${ds.length > 2 ? `<span>${esc(dayLabel(ds[Math.floor(ds.length / 2)].k))}</span>` : ''}${ds.length > 1 ? `<span>${esc(dayLabel(ds[ds.length - 1].k))}</span>` : ''}` : '';

    $('#rp-top').innerHTML = r.top.length
      ? `<thead><tr><th>Producto</th><th class="n">Unid.</th><th class="n">Vendido</th><th class="n">Ganancia</th></tr></thead><tbody>${r.top.slice(0, 10).map(t => `<tr><td>${esc(t.p ? t.p.name : t.id)}</td><td class="n">${t.u}</td><td class="n">${fmt(t.v)}</td><td class="n">${t.profit == null ? '—' : fmt(Math.round(t.profit))}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">No hubo ventas en este periodo.</td></tr></tbody>';

    const inv = products.filter(counted);
    $('#rp-stock').innerHTML = inv.length
      ? `<thead><tr><th>Producto</th><th class="n">Stock</th><th class="n opt">Costo c/u</th><th class="n opt">Precio c/u</th><th class="n">Valor</th></tr></thead><tbody>${inv.map(p => `<tr><td>${esc(p.name)}${isLow(p) ? ' <span class="pill low">Poco</span>' : ''}</td><td class="n">${p.stock}</td><td class="n opt">${p.cost == null ? '—' : fmt(p.cost)}</td><td class="n opt">${fmt(p.price)}</td><td class="n">${fmt(p.stock * p.price)}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">Todavía no has contado el stock de ningún producto.</td></tr></tbody>';
  }

  // Tooltip de las barras (mouse y teclado).
  const tip = document.createElement('div'); tip.className = 'chart-tip'; tip.hidden = true; document.body.appendChild(tip);
  function showTip(bar) {
    tip.textContent = bar.dataset.tip; tip.hidden = false;
    const b = bar.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, b.left + b.width / 2 - w / 2)) + 'px';
    tip.style.top = Math.max(8, b.top - tip.offsetHeight - 8) + 'px';
  }
  ['mouseover', 'focusin'].forEach(ev => $('#rp-chart').addEventListener(ev, e => { const b = e.target.closest('.bar'); if (b) showTip(b); }));
  ['mouseleave', 'focusout'].forEach(ev => $('#rp-chart').addEventListener(ev, () => { tip.hidden = true; }));
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  // ── Excel ────────────────────────────────────────────────
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'vendor/xlsx-0.18.5.mini.min.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  }
  $('#rp-xlsx').addEventListener('click', async () => {
    if (!report) { toast('Espera a que cargue el resumen.', true); return; }
    busy('Preparando Excel…');
    try { await loadXlsx(); } catch (e) { busy(); toast('No se pudo preparar el Excel. Revisa tu internet.', true); return; }
    const r = report, X = window.XLSX, byId = Object.fromEntries(products.map(p => [p.id, p]));
    const last = new Date(r.to); last.setDate(last.getDate() - 1);
    const sheet = (rows, widths) => { const ws = X.utils.aoa_to_sheet(rows); ws['!cols'] = widths.map(w => ({ wch: w })); return ws; };
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, sheet([
      ['MAVE Mujer · Resumen de ventas'], [],
      ['Desde', dayKey(r.from)], ['Hasta', dayKey(last)], [],
      ['Total vendido ($)', r.sold], ['Unidades vendidas', r.units],
      ['Vendido en local ($)', r.byCh.fisica.v], ['Vendido online ($)', r.byCh.online.v],
      ['Costo de lo vendido ($)', r.costSold], ['Ganancia ($)', r.soldWithCost ? r.profit : ''],
      ['Unidades vendidas sin costo registrado', r.soldNoCostUnits], [],
      ['Gastado en mercancía ($)', r.spent], ['Unidades que entraron', r.boughtUnits], [],
      ['Inventario hoy: unidades', r.stockUnits], ['Inventario hoy: valor a precio de venta ($)', r.stockValue], ['Inventario hoy: valor a costo ($)', r.stockCost]
    ], [42, 16]), 'Resumen');
    X.utils.book_append_sheet(wb, sheet([['Fecha', 'Unidades vendidas', 'Vendido ($)'], ...r.days.map(d => [d.k, d.u, d.v])], [12, 18, 14]), 'Ventas por día');
    X.utils.book_append_sheet(wb, sheet([['Producto', 'Marca', 'Unidades', 'Vendido ($)', 'Ganancia ($)'],
      ...r.top.map(t => [t.p ? t.p.name : t.id, t.p ? t.p.brand : '', t.u, t.v, t.profit == null ? '' : Math.round(t.profit)])], [34, 18, 10, 14, 14]), 'Por producto');
    X.utils.book_append_sheet(wb, sheet([['Fecha', 'Hora', 'Producto', 'Tipo', 'Canal', 'Unidades', 'Precio c/u ($)', 'Total venta ($)', 'Costo c/u ($)', 'Quedaron'],
      ...r.movs.map(m => { const d = new Date(m.created_at), p = byId[m.product_id];
        return [dayKey(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`, p ? p.name : m.product_id, REASONS[m.reason] || m.reason,
          m.channel ? CH_LABEL[m.channel] : '', m.delta, m.unit_price == null ? '' : m.unit_price,
          m.reason === 'salida' && m.unit_price != null ? -m.delta * m.unit_price : '', m.unit_cost == null ? '' : m.unit_cost, m.stock_after]; })],
      [12, 7, 34, 13, 9, 10, 14, 15, 13, 10]), 'Movimientos');
    X.utils.book_append_sheet(wb, sheet([['Producto', 'Marca', 'Categoría', 'Stock', 'Avisar con', 'Costo c/u ($)', 'Precio c/u ($)', 'Valor a precio ($)', 'Valor a costo ($)'],
      ...products.map(p => [p.name, p.brand, catLabel(p.category), counted(p) ? p.stock : 'Sin contar', p.min_stock, p.cost == null ? '' : p.cost, p.price,
        counted(p) ? p.stock * p.price : '', counted(p) && p.cost != null ? p.stock * p.cost : ''])], [34, 18, 26, 10, 10, 13, 13, 16, 16]), 'Inventario');
    X.writeFile(wb, `MAVE-ventas-${dayKey(r.from)}-a-${dayKey(last)}.xlsx`);
    busy(); toast('Excel descargado.');
  });

  // ── Inicio ────────────────────────────────────────────────
  (async () => {
    if (/type=recovery/.test(location.hash)) { recovering = true; show('reset'); }
    const { data } = await sb.auth.getSession();
    if (!recovering) await enter(data.session);
  })();
})();
