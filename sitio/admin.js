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
    if (e.target.closest('[data-dec]')) { changeStock(p, -1, null, e.target.closest('[data-dec]')); return; }
    if (e.target.closest('[data-inc]')) { changeStock(p, 1, null, e.target.closest('[data-inc]')); return; }
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
  async function changeStock(p, delta, reason, btn) {
    if (btn) btn.disabled = true;
    const { data, error } = await sb.rpc('adjust_stock', { p_id: p.id, p_delta: delta, p_reason: reason });
    if (btn) btn.disabled = false;
    if (error || !data) { toast(error ? friendly(error) : 'No se pudo guardar el cambio.', true); return false; }
    const wasAvail = applyRow(p, data);
    let msg = delta > 0 ? `+${delta} · ${p.name}: ${units(data.stock)}` : `${delta} · ${p.name}: ${units(data.stock)}`;
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
    $('#sd-state').textContent = !c ? 'Escribe abajo cuántas unidades hay para empezar a llevar la cuenta.'
      : p.stock === 0 ? 'Agotado en la tienda. Al sumar unidades vuelve a estar disponible.'
      : isLow(p) ? `Poco stock: avisa con ${p.min_stock} o menos.` : (p.available ? 'Disponible en la tienda.' : 'Marcado como agotado a mano.');
  }
  const REASONS = { entrada: 'Entrada', salida: 'Salida', conteo: 'Conteo', inicial: 'Stock inicial', ajuste: 'Ajuste' };
  async function loadHistory(p) {
    const ul = $('#sd-history');
    const { data, error } = await sb.from('stock_movements').select('delta,stock_after,reason,created_at').eq('product_id', p.id).order('created_at', { ascending: false }).limit(10);
    if (stockP !== p) return;
    if (error) { ul.innerHTML = '<li class="muted">No se pudo cargar el historial.</li>'; return; }
    ul.innerHTML = (data || []).length ? data.map(m => {
      const d = new Date(m.created_at);
      const when = d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
      return `<li><span class="d ${m.delta > 0 ? 'up' : 'down'}">${m.delta > 0 ? '+' : ''}${m.delta}</span><span>${esc(REASONS[m.reason] || m.reason)} · quedan ${m.stock_after}</span><time datetime="${esc(m.created_at)}">${esc(when)}</time></li>`;
    }).join('') : '<li class="muted">Todavía no hay movimientos.</li>';
  }
  function openStock(p) {
    stockP = p; $('#sd-in').value = ''; $('#sd-count').value = '';
    $('#sd-history').innerHTML = '<li class="muted">Cargando…</li>';
    renderStock(); openDlg($('#stock-dlg')); loadHistory(p);
  }
  $('#stock-dlg').addEventListener('close', () => { stockP = null; });
  $('#stock-dlg').querySelector('[data-close]').addEventListener('click', () => { stockP = null; });
  $('#sd-dec').addEventListener('click', e => stockP && changeStock(stockP, -1, 'salida', e.currentTarget));
  $('#sd-inc').addEventListener('click', e => stockP && changeStock(stockP, 1, 'entrada', e.currentTarget));
  $('#sd-in-form').addEventListener('submit', async e => {
    e.preventDefault(); const n = parseCount($('#sd-in').value);
    if (!n || isNaN(n)) { toast('Escribe cuántas unidades llegaron. Ej.: 6', true); $('#sd-in').focus(); return; }
    if (await changeStock(stockP, n, 'entrada')) $('#sd-in').value = '';
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
      min_stock: minIn === null ? 3 : minIn
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

  // ── Inicio ────────────────────────────────────────────────
  (async () => {
    if (/type=recovery/.test(location.hash)) { recovering = true; show('reset'); }
    const { data } = await sb.auth.getSession();
    if (!recovering) await enter(data.session);
  })();
})();
