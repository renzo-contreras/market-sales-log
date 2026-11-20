/* Market Sales Log: front end
 * Plain JavaScript, no build step. Money is kept in cents inside the app.
 * Sales, cancellations and notes go through a queue saved on the device, so a
 * failed save is retried and always shown, never lost silently.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var TZ = 'America/Denver';
  var METHODS = ['Zelle', 'Venmo', 'PayPal', 'Cash App', 'Cash'];
  var FEE_RATE = typeof CFG.FEE_RATE === 'number' ? CFG.FEE_RATE : 0.10;
  var params = new URLSearchParams(location.search);
  var MOCK = params.has('mock') || sessionStorage.getItem('msl.mock') === '1';
  if (MOCK) sessionStorage.setItem('msl.mock', '1');

  // Practice mode keeps its own copy of everything so it never mixes with real data.
  var NS = MOCK ? 'msl.practice.' : 'msl.';
  var KEY = { pw: NS + 'pw', cache: NS + 'cache', queue: NS + 'queue', cart: NS + 'cart', tab: NS + 'tab' };

  /* ---------------- State ---------------- */

  var state = {
    password: load(KEY.pw, null),
    products: [],      // {id, name, category, price(cents), active}
    sales: [],         // confirmed by server, {sale_id, timestamp, items[{name,qty,price(cents)}], total(cents), ...}
    queue: load(KEY.queue, []), // [{op_id, action, payload, error}]
    cart: load(KEY.cart, null) || emptyCart(),
    tab: load(KEY.tab, 'sell'),
    category: 'All',
    salesDay: 'all',
    totalsDay: 'all',
    cartOpen: false,
    flushing: false,
    lastLoadError: null
  };

  var cache = load(KEY.cache, null);
  if (cache) {
    state.products = cache.products || [];
    state.sales = cache.sales || [];
  }

  function emptyCart() { return { lines: [], discount: null, note: '', method: null }; }

  /* ---------------- Storage helpers ---------------- */

  function load(k, fallback) {
    try { var v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ }
  }
  function persistCache() { save(KEY.cache, { products: state.products, sales: state.sales }); }
  function persistQueue() { save(KEY.queue, state.queue); }
  function persistCart() { save(KEY.cart, state.cart); }

  /* ---------------- Formatting ---------------- */

  var fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  var fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  var fmtDayLabel = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  var fmtFull = new Intl.DateTimeFormat('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });

  function money(c) {
    var neg = c < 0; c = Math.abs(Math.round(c));
    var s = '$' + Math.floor(c / 100).toLocaleString('en-US') + '.' + String(c % 100).padStart(2, '0');
    return neg ? '-' + s : s;
  }
  function toCents(v) {
    var str = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (str === '') return NaN;
    var n = Number(str);
    return isNaN(n) ? NaN : Math.round(n * 100);
  }
  function dayKey(iso) { return fmtDayKey.format(new Date(iso)); }
  function dayLabel(key) { return fmtDayLabel.format(new Date(key + 'T12:00:00Z')); }
  function timeLabel(iso) { return fmtTime.format(new Date(iso)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function deviceType() {
    var ua = navigator.userAgent;
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua))) return 'phone';
    if (/Android/.test(ua)) return 'tablet';
    return 'computer';
  }

  function newSaleId() {
    var p = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    var rand = Math.random().toString(36).slice(2, 5).toUpperCase();
    return p.month + p.day + '-' + p.hour + p.minute + p.second + '-' + rand;
  }
  function newId(prefix) { return prefix + Math.random().toString(36).slice(2, 10); }

  /* ---------------- Server data mapping ---------------- */

  function fromServerProduct(p) {
    return { id: p.id, name: p.name, category: p.category || 'Other', price: Math.round(Number(p.price) * 100) || 0, active: p.active !== false,
      stock: (p.stock === '' || p.stock == null || isNaN(Number(p.stock))) ? null : Number(p.stock) };
  }
  function fromServerSale(s) {
    return {
      sale_id: s.sale_id,
      timestamp: s.timestamp,
      items: (s.items || []).map(function (it) {
        return { id: it.id, name: it.name, qty: Number(it.qty) || 1, price: Number(it.price) || 0 }; // price already cents
      }),
      items_text: s.items_text || '',
      subtotal: Math.round(Number(s.subtotal) * 100) || 0,
      discount: Math.round(Number(s.discount) * 100) || 0,
      total: Math.round(Number(s.total) * 100) || 0,
      method: s.method, device: s.device, status: s.status,
      receipt_link: s.receipt_link || '', note: s.note || '', voided: !!s.voided
    };
  }

  /* ---------------- API ---------------- */

  function api(action, payload) {
    if (MOCK) return mockApi(action, payload || {});
    if (!CFG.API_URL) return Promise.reject(new Error('The app is not connected yet. Add the web app URL to config.js.'));
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 25000);
    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ password: state.password, action: action, payload: payload || {} }),
      redirect: 'follow',
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) throw new Error('Server error (' + res.status + ').');
      return res.json();
    }).then(function (data) {
      if (!data.ok) {
        var err = new Error(data.error || 'Unknown error.');
        err.auth = data.auth === false;
        throw err;
      }
      return data;
    }).catch(function (err) {
      if (err.name === 'AbortError') throw new Error('No response from the server. Check the connection.');
      if (err instanceof TypeError) throw new Error('Could not reach the server. Check the connection.');
      throw err;
    }).finally(function () { clearTimeout(timer); });
  }

  /* ---------------- Loading and syncing ---------------- */

  function refresh(opts) {
    opts = opts || {};
    return api('bootstrap').then(function (data) {
      state.products = (data.products || []).map(fromServerProduct);
      state.sales = (data.sales || []).map(fromServerSale);
      state.lastLoadError = null;
      persistCache();
      render();
    }).catch(function (err) {
      if (err.auth) return signOut(err.message);
      state.lastLoadError = err.message;
      if (!opts.quiet) toast('Could not load data: ' + err.message, { bad: true });
      renderSync();
    });
  }

  // Apply queued (not yet saved) operations on top of the server data for display.
  function displaySales() {
    var map = {};
    var list = state.sales.map(function (s) { var c = Object.assign({}, s); map[c.sale_id] = c; return c; });
    state.queue.forEach(function (op) {
      var p = op.payload;
      if (op.action === 'addSale' && !map[p.sale_id]) {
        var local = saleFromPayload(p);
        local.pending = true; local.error = op.error || null;
        map[p.sale_id] = local; list.push(local);
      } else if (map[p.sale_id]) {
        var s = map[p.sale_id];
        if (op.action === 'setVoided') s.voided = !!p.voided;
        if (op.action === 'setNote') s.note = p.note;
        s.pending = true; if (op.error) s.error = op.error;
      }
    });
    return list.sort(function (a, b) { return a.timestamp < b.timestamp ? 1 : -1; });
  }

  function saleFromPayload(p) {
    var items = p.items.map(function (it) { return { id: it.id, name: it.name, qty: it.qty, price: toCents(it.price) }; });
    var subtotal = items.reduce(function (a, it) { return a + it.qty * it.price; }, 0);
    var discount = Math.min(subtotal, toCents(p.discount || 0));
    return {
      sale_id: p.sale_id, timestamp: p.timestamp, items: items, subtotal: subtotal, discount: discount,
      total: subtotal - discount, method: p.method, device: p.device,
      status: p.method === 'Cash' ? 'cash' : 'missing', receipt_link: '', note: p.note || '', voided: false
    };
  }

  function enqueue(action, payload) {
    state.queue.push({ op_id: newId('op'), action: action, payload: payload, error: null });
    persistQueue();
    render();
    flush();
  }

  function flush() {
    if (state.flushing || !state.queue.length) return renderSync();
    state.flushing = true;
    renderSync();
    var op = state.queue[0];
    api(op.action, op.payload).then(function (data) {
      state.queue.shift();
      persistQueue();
      if (data.sale) {
        var s = fromServerSale(data.sale);
        var i = state.sales.findIndex(function (x) { return x.sale_id === s.sale_id; });
        if (i >= 0) state.sales[i] = s; else state.sales.push(s);
        persistCache();
      }
      state.flushing = false;
      render();
      flush();
    }).catch(function (err) {
      state.flushing = false;
      if (err.auth) return signOut(err.message);
      op.error = err.message;
      persistQueue();
      render();
      scheduleRetry();
    });
  }

  var retryTimer = null;
  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(flush, 15000);
  }

  function renderSync() {
    var el = document.getElementById('sync');
    if (!el) return;
    var text = el.querySelector('.sync-text');
    var failed = state.queue.filter(function (o) { return o.error; }).length;
    el.className = 'sync';
    if (failed) {
      el.classList.add('error');
      text.textContent = 'Not saved (' + state.queue.length + '). Retry';
    } else if (state.queue.length || state.flushing) {
      el.classList.add('saving');
      text.textContent = 'Saving ' + state.queue.length;
    } else if (state.lastLoadError) {
      el.classList.add('error');
      text.textContent = 'Offline. Retry';
    } else {
      text.textContent = 'Saved';
    }
  }

  /* ---------------- Auth ---------------- */

  function signOut(message) {
    state.password = null;
    localStorage.removeItem(KEY.pw);
    showLogin(message);
  }

  function showLogin(message) {
    document.getElementById('app').hidden = true;
    document.getElementById('login').hidden = false;
    document.title = 'Sign in'; // no hint about the app until signed in
    var err = document.getElementById('login-error');
    err.hidden = !message; err.textContent = message || '';
    setTimeout(function () { document.getElementById('login-password').focus(); }, 50);
  }

  function showApp() {
    document.getElementById('login').hidden = true;
    document.getElementById('app').hidden = false;
    document.title = 'Market Sales';
    render();
  }

  document.getElementById('login-show').addEventListener('click', function (e) {
    var input = document.getElementById('login-password');
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    input.focus();
  });

  /* Captcha: Google reCAPTCHA checkbox, shown right after the password on every sign in.
     The server checks the answer with Google before it checks the password.
     Practice mode uses Google's public test key, which always passes. */
  var CAPTCHA_KEY = MOCK ? '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI' : (CFG.RECAPTCHA_SITE_KEY || '');
  var captchaLoad = null, captchaWidget = null;

  function loadCaptcha() {
    if (captchaLoad) return captchaLoad;
    captchaLoad = new Promise(function (resolve, reject) {
      window.mslCaptchaReady = function () { resolve(window.grecaptcha); };
      var s = document.createElement('script');
      s.src = 'https://www.google.com/recaptcha/api.js?onload=mslCaptchaReady&render=explicit&hl=en';
      s.async = true;
      s.onerror = function () { captchaLoad = null; s.remove(); reject(new Error('Could not load the captcha. Check the connection.')); };
      document.head.appendChild(s);
    });
    return captchaLoad;
  }

  function showPasswordStep(message) {
    document.getElementById('captcha-step').hidden = true;
    document.getElementById('login-form').hidden = false;
    var errEl = document.getElementById('login-error');
    errEl.textContent = message || ''; errEl.hidden = !message;
    var btn = document.getElementById('login-submit');
    btn.disabled = false; btn.textContent = 'Enter';
    if (!message) document.getElementById('login-password').focus();
  }

  function showCaptchaStep() {
    var status = document.getElementById('captcha-status');
    document.getElementById('login-form').hidden = true;
    document.getElementById('captcha-step').hidden = false;
    status.textContent = 'Loading...';
    loadCaptcha().then(function (g) {
      status.textContent = '';
      var box = document.getElementById('captcha-box');
      if (captchaWidget === null) {
        captchaWidget = g.render(box, {
          sitekey: CAPTCHA_KEY,
          theme: (currentTheme() === 'light' || (currentTheme() === 'system' && !matchMedia('(prefers-color-scheme: dark)').matches)) ? 'light' : 'dark',
          callback: function (token) { doLogin(token); },
          'expired-callback': function () { status.textContent = 'The check expired. Tap the box again.'; }
        });
      } else {
        g.reset(captchaWidget);
      }
    }).catch(function (err) { showPasswordStep(err.message); });
  }

  function doLogin(captchaToken) {
    var input = document.getElementById('login-password');
    var status = document.getElementById('captcha-status');
    status.textContent = 'Checking...';
    api('login', captchaToken ? { captcha: captchaToken } : {}).then(function () {
      save(KEY.pw, state.password);
      input.value = '';
      showPasswordStep();
      showApp();
      refresh();
      flush();
    }).catch(function (err) {
      state.password = null;
      if (captchaWidget !== null && window.grecaptcha) window.grecaptcha.reset(captchaWidget);
      status.textContent = '';
      showPasswordStep(err.message);
    });
  }

  document.getElementById('captcha-back').addEventListener('click', function () {
    state.password = null;
    showPasswordStep();
  });

  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('login-password');
    if (!input.value) return;
    state.password = input.value;
    document.getElementById('login-error').hidden = true;
    if (CAPTCHA_KEY) return showCaptchaStep();
    var btn = document.getElementById('login-submit');
    btn.disabled = true; btn.textContent = 'Checking...';
    doLogin(null);
  });

  /* ---------------- Rendering ---------------- */

  var view = document.getElementById('view');

  function render() {
    sizeLayout();
    if (!state.password) return;
    document.querySelectorAll('.tabbar button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    var fn = { sell: renderSell, sales: renderSales, totals: renderTotals, products: renderProducts }[state.tab] || renderSell;
    view.innerHTML = queueBanner() + fn();
    positionToast();
    renderSync();
  }

  function queueBanner() {
    var failed = state.queue.filter(function (o) { return o.error; });
    if (!failed.length) return '';
    return '<div class="banner bad"><span>' + plural(state.queue.length, 'change') +
      ' not saved yet: ' + esc(failed[0].error) + '</span>' +
      '<button class="btn" data-action="retry">Retry now</button></div>';
  }

  /* ----- Sell ----- */

  // Items sold per product id, from sales that are not cancelled. Cancelling a sale puts its items back.
  function soldById(list) {
    var m = {};
    (list || displaySales()).forEach(function (s) {
      if (s.voided) return;
      (s.items || []).forEach(function (it) { if (it.id) m[it.id] = (m[it.id] || 0) + it.qty; });
    });
    return m;
  }

  function activeProducts() { return state.products.filter(function (p) { return p.active; }); }
  function categories(list) {
    var seen = [];
    list.forEach(function (p) { if (seen.indexOf(p.category) === -1) seen.push(p.category); });
    return seen;
  }

  function cartTotals() {
    var subtotal = state.cart.lines.reduce(function (a, l) { return a + l.qty * l.price; }, 0);
    var d = state.cart.discount, discount = 0;
    if (d) discount = d.type === 'percent' ? Math.round(subtotal * d.value / 100) : d.value;
    discount = Math.min(subtotal, Math.max(0, discount));
    var count = state.cart.lines.reduce(function (a, l) { return a + l.qty; }, 0);
    return { subtotal: subtotal, discount: discount, total: subtotal - discount, count: count };
  }

  function renderSell() {
    var products = activeProducts();
    var cats = categories(products);
    if (state.category !== 'All' && cats.indexOf(state.category) === -1) state.category = 'All';
    var shown = state.category === 'All' ? products : products.filter(function (p) { return p.category === state.category; });
    var sold = soldById();
    var qtyById = {};
    state.cart.lines.forEach(function (l) { if (l.productId) qtyById[l.productId] = (qtyById[l.productId] || 0) + l.qty; });

    var chips = cats.length > 1 ? '<div class="chips">' + ['All'].concat(cats).map(function (c) {
      return '<button class="chip' + (c === state.category ? ' active' : '') + '" data-action="category" data-value="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('') + '</div>' : '';

    var grid;
    if (!products.length) {
      grid = '<div class="empty">No products yet.<br><br><button class="btn btn-primary" data-action="goto" data-value="products">Add products</button></div>';
    } else {
      grid = '<div class="grid">' + shown.map(function (p) {
        var q = qtyById[p.id];
        var left = p.stock == null ? null : p.stock - (sold[p.id] || 0) - (q || 0);
        // Sell tiles only mention stock when it matters: 25% of the starting stock or less
        // (gray), 3 or less (orange warning), sold out (red). Products tab always shows it.
        var showLeft = left != null && (left <= 3 || left <= p.stock * 0.25);
        var stockTag = !showLeft ? '' : (left <= 0 ? '<span class="p-stock out">' + (left < 0 ? 'Over stock by ' + (-left) : 'Sold out') + '</span>'
          : '<span class="p-stock' + (left <= 3 ? ' low' : '') + '">' + left + ' left</span>');
        return '<button class="product' + (q ? ' in-cart' : '') + (left != null && left <= 0 ? ' sold-out' : '') + '" data-action="add" data-id="' + esc(p.id) + '">' +
          (q ? '<span class="qty">' + q + '</span>' : '') +
          '<span class="p-name">' + esc(p.name) + '</span><span class="p-foot"><span class="p-price num">' + money(p.price) + '</span>' + stockTag + '</span></button>';
      }).join('') +
      '<button class="product custom" data-action="custom"><span class="p-name">+ Custom item</span><span class="p-price">Any amount</span></button>' +
      '</div>';
    }

    return '<div class="sell"><div>' + chips + grid + '</div>' + renderCart() + '</div>';
  }

  function renderCart() {
    var t = cartTotals();
    var c = state.cart;
    var lines = c.lines.map(function (l, i) {
      var overridden = l.basePrice != null && l.price !== l.basePrice;
      return '<div class="line"><div><div class="line-name">' + esc(l.name) + '</div>' +
        '<button class="line-price num' + (overridden ? ' overridden' : '') + '" data-action="price" data-i="' + i + '">' +
        money(l.price) + ' each' + (overridden ? ' (was ' + money(l.basePrice) + ')' : '') + '</button></div>' +
        '<div class="stepper"><button data-action="dec" data-i="' + i + '" aria-label="Less">&minus;</button>' +
        '<span class="q num">' + l.qty + '</span>' +
        '<button data-action="inc" data-i="' + i + '" aria-label="More">+</button></div>' +
        '<div class="line-total num">' + money(l.qty * l.price) + '</div></div>';
    }).join('');

    var disabled = c.lines.length ? '' : ' disabled';
    var discLabel = c.discount ? (c.discount.type === 'percent' ? c.discount.value + '% off' : money(c.discount.value) + ' off') : 'Discount';

    return '<aside class="cart' + (state.cartOpen ? ' open' : '') + '">' +
      '<button class="cart-head" data-action="toggle-cart">' +
        '<span class="c-count">' + (t.count ? plural(t.count, 'item') : 'Cart is empty') + '</span>' +
        '<span class="c-total num">' + money(t.total) + '</span>' +
        '<svg class="chev" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>' +
      '</button>' +
      '<div class="cart-body">' +
        (lines || '<p class="muted">Tap products to add them.</p>') +
        '<div class="cart-tools">' +
          '<button class="btn" data-action="discount"' + disabled + '>' + esc(discLabel) + '</button>' +
          '<button class="btn" data-action="note"' + disabled + '>' + (c.note ? 'Edit note' : 'Note') + '</button>' +
          '<button class="btn btn-danger" data-action="clear"' + disabled + '>Clear</button>' +
        '</div>' +
        (c.note ? '<div class="cart-note">Note: ' + esc(c.note) + '</div>' : '') +
        (t.discount ? '<div class="sums"><div><span>Subtotal</span><span class="num">' + money(t.subtotal) + '</span></div>' +
          '<div><span>Discount</span><span class="num">-' + money(t.discount) + '</span></div></div>' : '') +
      '</div>' +
      '<div class="pay"><div class="pay-label">How did they pay?</div><div class="methods">' +
        METHODS.map(function (m) {
          var sel = c.method === m;
          return '<button class="method' + (sel ? ' selected' : '') + '" data-action="pay" data-value="' + esc(m) + '" aria-pressed="' + sel + '"' + disabled + '>' + esc(m) + '</button>';
        }).join('') +
      '</div>' +
      '<button class="confirm" data-action="confirm"' + (c.lines.length && c.method ? '' : ' disabled') + '>' +
        (c.method && c.lines.length ? 'Confirm ' + money(t.total) + ' via ' + esc(c.method) : (c.lines.length ? 'Choose a payment method' : 'Confirm sale')) +
      '</button></div></aside>';
  }

  function addToCart(p) {
    var line = state.cart.lines.find(function (l) { return l.productId === p.id && l.price === p.price; });
    if (line) line.qty += 1;
    else state.cart.lines.push({ productId: p.id, name: p.name, price: p.price, basePrice: p.price, qty: 1 });
    persistCart();
    render();
  }

  function completeSale() {
    var method = state.cart.method;
    if (!state.cart.lines.length || METHODS.indexOf(method) === -1) return;
    var t = cartTotals();
    var payload = {
      sale_id: newSaleId(),
      timestamp: new Date().toISOString(),
      items: state.cart.lines.map(function (l) { return { id: l.productId || '', name: l.name, qty: l.qty, price: l.price / 100 }; }),
      discount: t.discount / 100,
      method: method,
      device: deviceType(),
      note: state.cart.note || ''
    };
    state.cart = emptyCart();
    state.cartOpen = false;
    persistCart();
    enqueue('addSale', payload);
    toast(money(t.total) + ' via ' + method + ' recorded', {
      action: 'Undo',
      onAction: function () {
        enqueue('setVoided', { sale_id: payload.sale_id, voided: true });
        toast('Sale cancelled. It stays in the list, crossed out.');
      },
      ms: 8000
    });
  }

  /* ----- Sales log ----- */

  function dayChips(list, current, action) {
    var days = [];
    list.forEach(function (s) { var k = dayKey(s.timestamp); if (days.indexOf(k) === -1) days.push(k); });
    days.sort();
    if (days.length < 2) return '';
    return '<div class="chips">' + [['all', 'All days']].concat(days.map(function (d) { return [d, dayLabel(d)]; })).map(function (d) {
      return '<button class="chip' + (d[0] === current ? ' active' : '') + '" data-action="' + action + '" data-value="' + d[0] + '">' + esc(d[1]) + '</button>';
    }).join('') + '</div>';
  }

  function filterDay(list, day) {
    return day === 'all' ? list : list.filter(function (s) { return dayKey(s.timestamp) === day; });
  }

  function receiptTag(s) {
    if (s.method === 'Cash' || s.status === 'cash') return '<span class="tag">Cash, no receipt needed</span>';
    if (s.status === 'matched' || s.receipt_link) return '<span class="tag ok">Receipt matched</span>';
    return '<span class="tag warn">Receipt missing</span>';
  }

  function itemsSummary(s) {
    if (s.items && s.items.length) return s.items.map(function (it) { return (it.qty > 1 ? it.qty + ' x ' : '') + it.name; }).join(', ');
    return s.items_text || '';
  }

  function renderSales() {
    var all = displaySales();
    var list = filterDay(all, state.salesDay);
    var live = list.filter(function (s) { return !s.voided; });
    var sum = live.reduce(function (a, s) { return a + s.total; }, 0);
    var rows = list.map(function (s) {
      var tags = '<span class="tag">' + esc(s.method) + '</span>' + (s.method === 'Cash' ? '' : receiptTag(s));
      if (s.voided) tags += '<span class="tag bad">Cancelled</span>';
      if (s.error) tags += '<span class="tag bad">Not saved</span>';
      else if (s.pending) tags += '<span class="tag warn">Saving</span>';
      if (s.discount) tags += '<span class="tag">Discount ' + money(s.discount) + '</span>';
      if (s.note) tags += '<span class="tag">Note</span>';
      return '<button class="row' + (s.voided ? ' voided' : '') + '" data-action="sale" data-id="' + esc(s.sale_id) + '">' +
        '<span class="r-time num">' + esc(timeLabel(s.timestamp)) + '</span>' +
        '<span class="r-items">' + esc(itemsSummary(s)) + '</span>' +
        '<span class="r-total num">' + money(s.total) + '</span>' +
        '<span class="r-tags">' + tags + '</span></button>';
    }).join('');
    return dayChips(all, state.salesDay, 'sales-day') +
      '<div class="list-head"><h2>' + plural(live.length, 'sale') + '</h2><span class="muted num">' + money(sum) + ' total</span></div>' +
      (rows ? '<div class="list">' + rows + '</div>' : '<div class="empty">No sales yet.</div>');
  }

  function openSale(id) {
    var s = displaySales().find(function (x) { return x.sale_id === id; });
    if (!s) return;
    var items = s.items.map(function (it) {
      return '<tr><td>' + it.qty + ' x ' + esc(it.name) + '</td><td class="r num">' + money(it.price * it.qty) + '</td></tr>';
    }).join('');
    if (s.discount) items += '<tr><td>Discount</td><td class="r num">-' + money(s.discount) + '</td></tr>';
    items += '<tr><td><strong>Total</strong></td><td class="r num"><strong>' + money(s.total) + '</strong></td></tr>';
    openModal(
      '<h2>Sale ' + esc(s.sale_id) + '</h2>' +
      (s.voided ? '<div class="banner warn">This sale is cancelled. It is not counted in totals.</div>' : '') +
      '<table class="items-table">' + items + '</table>' +
      '<dl class="kv">' +
        '<dt>Time</dt><dd>' + esc(fmtFull.format(new Date(s.timestamp))) + '</dd>' +
        '<dt>Paid with</dt><dd>' + esc(s.method) + '</dd>' +
        '<dt>Receipt</dt><dd>' + (s.receipt_link ? '<a href="' + esc(s.receipt_link) + '" target="_blank" rel="noopener">Open receipt</a>' : receiptTag(s)) + '</dd>' +
        '<dt>Device</dt><dd>' + esc(s.device || '') + '</dd>' +
        '<dt>Note</dt><dd>' + esc(s.note || 'None') + '</dd>' +
      '</dl>' +
      '<div class="actions">' +
        '<button class="btn" data-action="edit-note" data-id="' + esc(s.sale_id) + '">' + (s.note ? 'Edit note' : 'Add note') + '</button>' +
        (s.voided
          ? '<button class="btn" data-action="unvoid" data-id="' + esc(s.sale_id) + '">Restore sale</button>'
          : '<button class="btn btn-danger" data-action="void" data-id="' + esc(s.sale_id) + '">Cancel sale</button>') +
      '</div>' +
      '<div class="actions"><button class="btn" data-action="close">Close</button></div>'
    );
  }

  /* ----- Totals ----- */

  function computeTotals(list) {
    var live = list.filter(function (s) { return !s.voided; });
    var gross = live.reduce(function (a, s) { return a + s.total; }, 0);
    var fee = Math.round(gross * FEE_RATE);
    var byMethod = METHODS.map(function (m) {
      var ss = live.filter(function (s) { return s.method === m; });
      return { method: m, count: ss.length, total: ss.reduce(function (a, s) { return a + s.total; }, 0) };
    });
    var days = {};
    live.forEach(function (s) {
      var k = dayKey(s.timestamp);
      days[k] = days[k] || { day: k, count: 0, gross: 0 };
      days[k].count++; days[k].gross += s.total;
    });
    var byDay = Object.keys(days).sort().map(function (k) {
      var d = days[k]; d.fee = Math.round(d.gross * FEE_RATE); d.net = d.gross - d.fee; return d;
    });
    var receipts = { matched: 0, missing: 0, cash: 0 };
    live.forEach(function (s) {
      if (s.method === 'Cash' || s.status === 'cash') receipts.cash++;
      else if (s.status === 'matched' || s.receipt_link) receipts.matched++;
      else receipts.missing++;
    });
    var items = {};
    live.forEach(function (s) {
      (s.items || []).forEach(function (it) {
        var k = it.id || ('custom:' + it.name);
        items[k] = items[k] || { id: it.id, name: it.name, qty: 0 };
        items[k].qty += it.qty;
      });
    });
    var byItem = Object.keys(items).map(function (k) { return items[k]; }).sort(function (a, b) { return b.qty - a.qty; });
    return { live: live, gross: gross, fee: fee, net: gross - fee, byMethod: byMethod, byDay: byDay, byItem: byItem, receipts: receipts, voided: list.length - live.length };
  }

  function renderTotals() {
    var all = displaySales();
    var list = filterDay(all, state.totalsDay);
    var t = computeTotals(list);
    var allSold = soldById(all); // "Left" always counts every day, even when one day is selected
    var pct = Math.round(FEE_RATE * 100);
    var pending = state.queue.filter(function (o) { return o.action === 'addSale'; }).length;
    return dayChips(all, state.totalsDay, 'totals-day') +
      (pending ? '<div class="banner warn">' + plural(pending, 'sale') + ' still saving. Totals include them.</div>' : '') +
      '<div class="cards">' +
        card('Total sales', money(t.gross)) +
        card('Market fee (' + pct + '%)', money(t.fee)) +
        card('Your net', money(t.net), true) +
        card('Sales', String(t.live.length)) +
      '</div>' +
      '<h2 class="section-title">By payment method</h2>' +
      '<table class="table"><tr><th>Method</th><th class="r">Sales</th><th class="r">Total</th></tr>' +
        t.byMethod.map(function (m) {
          return '<tr><td>' + esc(m.method) + '</td><td class="r num">' + m.count + '</td><td class="r num">' + money(m.total) + '</td></tr>';
        }).join('') + '</table>' +
      (t.byItem.length ? '<h2 class="section-title">Items sold</h2>' +
      '<table class="table"><tr><th>Item</th><th class="r">Sold</th><th class="r">Left</th></tr>' +
        t.byItem.map(function (it) {
          var p = state.products.find(function (x) { return x.id === it.id; });
          var left = p && p.stock != null ? p.stock - (allSold[p.id] || 0) : null;
          return '<tr><td>' + esc(it.name) + '</td><td class="r num">' + it.qty + '</td><td class="r num">' + (left == null ? '<span class="muted">-</span>' : left) + '</td></tr>';
        }).join('') + '</table>' : '') +
      (t.byDay.length ? '<h2 class="section-title">By day</h2>' +
      '<table class="table"><tr><th>Day</th><th class="r">Sales</th><th class="r">Total</th><th class="r">Fee</th><th class="r">Net</th></tr>' +
        t.byDay.map(function (d) {
          return '<tr><td>' + esc(dayLabel(d.day)) + '</td><td class="r num">' + d.count + '</td><td class="r num">' + money(d.gross) +
            '</td><td class="r num">' + money(d.fee) + '</td><td class="r num">' + money(d.net) + '</td></tr>';
        }).join('') + '</table>' : '') +
      '<h2 class="section-title">Receipts</h2>' +
      '<table class="table"><tr><td>Matched</td><td class="r num">' + t.receipts.matched + '</td></tr>' +
        '<tr><td>Missing</td><td class="r num">' + t.receipts.missing + '</td></tr>' +
        '<tr><td>Cash (no receipt)</td><td class="r num">' + t.receipts.cash + '</td></tr>' +
        '<tr><td>Cancelled sales (not counted)</td><td class="r num">' + t.voided + '</td></tr></table>' +
      '<h2 class="section-title">Report for the market</h2>' +
      '<div class="btn-row"><button class="btn btn-primary btn-lg" data-action="print">Print or save PDF</button>' +
      '<button class="btn btn-lg" data-action="csv">Download CSV</button></div>';
  }

  function card(k, v, strong) {
    return '<div class="card' + (strong ? ' strong' : '') + '"><div class="k">' + esc(k) + '</div><div class="v num">' + esc(v) + '</div></div>';
  }

  /* ----- Export ----- */

  function reportScope() {
    var all = displaySales().slice().sort(function (a, b) { return a.timestamp < b.timestamp ? -1 : 1; });
    var list = filterDay(all, state.totalsDay);
    var label = state.totalsDay === 'all' ? 'All days' : dayLabel(state.totalsDay);
    return { list: list, label: label, t: computeTotals(list) };
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    var r = reportScope();
    var rows = [['sale_id', 'date', 'time', 'items', 'subtotal', 'discount', 'total', 'method', 'receipt_status', 'receipt_link', 'cancelled', 'note', 'device']];
    r.list.forEach(function (s) {
      rows.push([s.sale_id, dayKey(s.timestamp), timeLabel(s.timestamp), itemsSummary(s),
        (s.subtotal / 100).toFixed(2), (s.discount / 100).toFixed(2), (s.total / 100).toFixed(2), s.method,
        s.method === 'Cash' ? 'cash' : (s.receipt_link ? 'matched' : (s.status || 'missing')), s.receipt_link,
        s.voided ? 'yes' : 'no', s.note, s.device]);
    });
    rows.push([]);
    rows.push(['Totals (cancelled sales excluded)']);
    r.t.byMethod.forEach(function (m) { rows.push([m.method, '', '', plural(m.count, 'sale'), '', '', (m.total / 100).toFixed(2)]); });
    rows.push(['Total sales', '', '', '', '', '', (r.t.gross / 100).toFixed(2)]);
    rows.push(['Market fee ' + Math.round(FEE_RATE * 100) + '%', '', '', '', '', '', (r.t.fee / 100).toFixed(2)]);
    rows.push(['Net', '', '', '', '', '', (r.t.net / 100).toFixed(2)]);
    var csv = rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n');
    var name = 'market-sales-' + (state.totalsDay === 'all' ? 'all-days' : state.totalsDay) + '.csv';
    var file = new File([csv], name, { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPad|iPhone|Android/.test(navigator.userAgent + (navigator.maxTouchPoints > 1 ? 'iPad' : ''))) {
      navigator.share({ files: [file], title: name }).catch(function () {});
    } else {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    }
  }

  function printReport() {
    var r = reportScope();
    var pct = Math.round(FEE_RATE * 100);
    var rows = r.list.map(function (s) {
      var receipt = s.method === 'Cash' ? 'Cash' : (s.receipt_link ? '<a href="' + esc(s.receipt_link) + '">' + esc(s.receipt_link) + '</a>' : 'Missing');
      return '<tr' + (s.voided ? ' class="void"' : '') + '><td>' + esc(s.sale_id) + '</td><td>' + esc(dayLabel(dayKey(s.timestamp))) + ' ' + esc(timeLabel(s.timestamp)) +
        '</td><td>' + esc(itemsSummary(s)) + (s.discount ? ' (discount ' + money(s.discount) + ')' : '') + (s.voided ? ' (CANCELLED)' : '') +
        '</td><td>' + esc(s.method) + '</td><td class="r">' + money(s.total) + '</td><td>' + receipt + '</td></tr>';
    }).join('');
    document.getElementById('report').innerHTML =
      '<h1>Sales report: ' + esc(CFG.SELLER_NAME || '') + '</h1>' +
      '<p>' + esc(CFG.MARKET_NAME || '') + ', ' + esc(r.label) + '</p>' +
      '<p>Generated ' + esc(fmtFull.format(new Date())) + ' (Mountain Time)</p>' +
      '<h2>Summary</h2><table>' +
        r.t.byMethod.map(function (m) { return '<tr><td>' + esc(m.method) + '</td><td class="r">' + m.count + ' sales</td><td class="r">' + money(m.total) + '</td></tr>'; }).join('') +
        '<tr class="summary"><td>Total sales</td><td class="r">' + r.t.live.length + ' sales</td><td class="r">' + money(r.t.gross) + '</td></tr>' +
        '<tr class="summary"><td>Market fee (' + pct + '%)</td><td></td><td class="r">' + money(r.t.fee) + '</td></tr>' +
        '<tr><td>Net to seller</td><td></td><td class="r">' + money(r.t.net) + '</td></tr>' +
      '</table>' +
      (r.t.byDay.length > 1 ? '<h2>By day</h2><table><tr><th>Day</th><th class="r">Sales</th><th class="r">Total</th><th class="r">Fee</th></tr>' +
        r.t.byDay.map(function (d) { return '<tr><td>' + esc(dayLabel(d.day)) + '</td><td class="r">' + d.count + '</td><td class="r">' + money(d.gross) + '</td><td class="r">' + money(d.fee) + '</td></tr>'; }).join('') + '</table>' : '') +
      '<h2>Every sale</h2><p>Cancelled sales are crossed out and not counted.</p>' +
      '<table><tr><th>ID</th><th>Time</th><th>Items</th><th>Method</th><th class="r">Total</th><th>Receipt</th></tr>' + rows + '</table>';
    setTimeout(function () { window.print(); }, 50);
  }

  /* ----- Products ----- */

  function renderProducts() {
    var sold = soldById();
    var productRow = function (p) { return productRowHtml(p, sold[p.id] || 0); };
    var active = state.products.filter(function (p) { return p.active; });
    var hidden = state.products.filter(function (p) { return !p.active; });
    var groups = categories(active).map(function (c) {
      return '<div class="group-title">' + esc(c) + '</div><div class="list">' +
        active.filter(function (p) { return p.category === c; }).map(productRow).join('') + '</div>';
    }).join('');
    return '<div class="btn-row" style="margin-bottom:8px">' +
        '<button class="btn btn-primary btn-lg" data-action="new-product">Add product</button>' +
        '<button class="btn btn-lg" data-action="import">Import list</button>' +
      '</div>' +
      (state.products.length ? groups : '<div class="empty">No products yet. Add them one by one or import a list.</div>') +
      (hidden.length ? '<div class="group-title">Hidden (not shown on the Sell screen)</div><div class="list">' + hidden.map(productRow).join('') + '</div>' : '');
  }

  function productRowHtml(p, sold) {
    var stock = p.stock == null ? '' : ' · <span class="' + (p.stock - sold <= 0 ? 'stock-out' : '') + '">' + (p.stock - sold) + ' left of ' + p.stock + '</span>';
    return '<div class="prow' + (p.active ? '' : ' hidden-p') + '"><div><div><strong>' + esc(p.name) + '</strong></div>' +
      '<div class="p-meta num">' + money(p.price) + ' · ' + sold + ' sold' + stock + (p.active ? '' : ' · ' + esc(p.category)) + '</div></div>' +
      '<button class="btn" data-action="edit-product" data-id="' + esc(p.id) + '">Edit</button>' +
      '<button class="btn" data-action="toggle-product" data-id="' + esc(p.id) + '">' + (p.active ? 'Hide' : 'Show') + '</button></div>';
  }

  function productForm(p) {
    var cats = categories(state.products);
    openModal(
      '<h2>' + (p ? 'Edit product' : 'Add product') + '</h2>' +
      '<form id="product-form">' +
        '<label class="field"><span>Name</span><input name="name" required value="' + esc(p ? p.name : '') + '"></label>' +
        '<label class="field"><span>Category</span><input name="category" list="cat-list" value="' + esc(p ? p.category : (cats[0] || '')) + '" placeholder="Prints, Stickers..."></label>' +
        '<datalist id="cat-list">' + cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
        '<label class="field"><span>Price ($)</span><input name="price" inputmode="decimal" required value="' + (p ? (p.price / 100).toFixed(2) : '') + '"></label>' +
        '<label class="field"><span>Stock (how many you bring, optional)</span><input name="stock" inputmode="numeric" value="' + (p && p.stock != null ? p.stock : '') + '" placeholder="Leave blank to not track"></label>' +
        '<p class="muted" style="margin:-6px 0 14px;font-size:14px">Items sold and items left are counted from your sales. Cancelled sales put items back.</p>' +
        '<p class="error" id="form-error" hidden></p>' +
        '<div class="actions"><button type="button" class="btn" data-action="close">Cancel</button>' +
        '<button type="submit" class="btn btn-primary">Save</button></div>' +
      '</form>'
    );
    var form = document.getElementById('product-form');
    if (!p) form.name.focus();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var price = toCents(form.price.value);
      var err = document.getElementById('form-error');
      if (!form.name.value.trim()) { err.textContent = 'Add a name.'; err.hidden = false; return; }
      if (isNaN(price) || price < 0) { err.textContent = 'Price must be a number, like 25 or 12.50.'; err.hidden = false; return; }
      var stockRaw = form.stock.value.trim();
      var stock = stockRaw === '' ? '' : Number(stockRaw);
      if (stock !== '' && (!Number.isInteger(stock) || stock < 0)) { err.textContent = 'Stock must be a whole number, like 20. Or leave it blank.'; err.hidden = false; return; }
      var data = { id: p ? p.id : newId('P'), name: form.name.value.trim(), category: form.category.value.trim() || 'Other', price: price / 100, active: p ? p.active : true, stock: stock };
      saveProductNow(data, form.querySelector('[type=submit]'));
    });
  }

  function saveProductNow(data, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    return api('saveProduct', data).then(function (res) {
      var p = fromServerProduct(res.product);
      var i = state.products.findIndex(function (x) { return x.id === p.id; });
      if (i >= 0) state.products[i] = p; else state.products.push(p);
      persistCache();
      closeModal();
      render();
      toast('Saved ' + p.name);
    }).catch(function (err) {
      if (err.auth) return signOut(err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      toast('Not saved: ' + err.message, { bad: true });
    });
  }

  /* Import: one product per line ("Name, Category, Price" or "Name, Price"), or a CSV with a header row. */
  function parseCsvLine(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',' || ch === '\t') { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function parseProductList(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var result = { products: [], errors: [] };
    if (!lines.length) return result;
    var first = parseCsvLine(lines[0]).map(function (h) { return h.toLowerCase(); });
    var cols = null;
    if (first.indexOf('name') !== -1 && first.indexOf('price') !== -1) {
      cols = { name: first.indexOf('name'), category: first.indexOf('category'), price: first.indexOf('price'), stock: first.indexOf('stock') };
      lines.shift();
    }
    lines.forEach(function (line, i) {
      var f = parseCsvLine(line);
      var name, category, price, stock;
      if (cols) {
        name = f[cols.name]; category = cols.category >= 0 ? f[cols.category] : ''; price = f[cols.price];
        if (cols.stock >= 0) stock = f[cols.stock] || '';
      } else if (f.length >= 4) {
        name = f[0]; category = f[1]; price = f[2]; stock = f[3];
      } else if (f.length === 3) {
        name = f[0]; category = f[1]; price = f[2];
      } else if (f.length === 2) {
        name = f[0]; category = ''; price = f[1];
      } else {
        result.errors.push('Line ' + (i + 1) + ': needs a name and a price'); return;
      }
      var cents = toCents(price);
      if (!name || isNaN(cents)) { result.errors.push('Line ' + (i + 1) + ': could not read "' + line + '"'); return; }
      if (stock !== undefined && stock !== '' && (!/^\d+$/.test(stock))) { result.errors.push('Line ' + (i + 1) + ': stock must be a whole number in "' + line + '"'); return; }
      var existing = state.products.find(function (p) { return p.name.toLowerCase() === name.toLowerCase(); });
      var item = { id: existing ? existing.id : newId('P'), name: name, category: category || 'Other', price: cents / 100, active: true, _update: !!existing };
      if (stock !== undefined) item.stock = stock === '' ? '' : Number(stock); // left out = keep the current stock
      result.products.push(item);
    });
    return result;
  }

  function importForm() {
    openModal(
      '<h2>Import products</h2>' +
      '<p class="muted">Paste one product per line: <strong>Name, Category, Price, Stock</strong>. Stock is optional. A CSV with a header row (name, category, price, stock) also works. Products with the same name are updated, not duplicated.</p>' +
      '<label class="field"><span>Paste here</span><textarea id="import-text" placeholder="Sticker pack, Stickers, 8, 40&#10;Large print, Prints, 40, 12&#10;Tote bag, Merch, 25"></textarea></label>' +
      '<label class="field"><span>Or choose a CSV file</span><input type="file" id="import-file" accept=".csv,text/csv,text/plain"></label>' +
      '<div id="import-preview"></div>' +
      '<div class="actions"><button class="btn" data-action="close">Cancel</button>' +
      '<button class="btn btn-primary" id="import-go" disabled>Import</button></div>'
    );
    var ta = document.getElementById('import-text');
    var parsed = { products: [], errors: [] };
    function update() {
      parsed = parseProductList(ta.value);
      var n = parsed.products.length;
      var upd = parsed.products.filter(function (p) { return p._update; }).length;
      document.getElementById('import-preview').innerHTML = (n || parsed.errors.length) ?
        '<div class="preview">' +
          parsed.products.map(function (p) { return '<div>' + esc(p.name) + ' · ' + esc(p.category) + ' · ' + money(toCents(p.price)) + (p.stock !== undefined && p.stock !== '' ? ' · stock ' + p.stock : '') + (p._update ? ' <span class="tag">update</span>' : '') + '</div>'; }).join('') +
          parsed.errors.map(function (e) { return '<div class="error">' + esc(e) + '</div>'; }).join('') +
        '</div>' : '';
      var go = document.getElementById('import-go');
      go.disabled = !n;
      go.textContent = n ? 'Import ' + plural(n, 'product') + (upd ? ' (' + upd + ' updated)' : '') : 'Import';
    }
    ta.addEventListener('input', update);
    document.getElementById('import-file').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      f.text().then(function (t) { ta.value = t; update(); });
    });
    document.getElementById('import-go').addEventListener('click', function (e) {
      var btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Importing...';
      var list = parsed.products.map(function (p) { var c = Object.assign({}, p); delete c._update; return c; });
      api('importProducts', { products: list }).then(function (res) {
        state.products = res.products.map(fromServerProduct);
        persistCache(); closeModal(); render();
        toast('Imported ' + plural(list.length, 'product'));
      }).catch(function (err) {
        if (err.auth) return signOut(err.message);
        btn.disabled = false; btn.textContent = 'Try again';
        toast('Import failed: ' + err.message, { bad: true });
      });
    });
  }

  /* ---------------- Modals, prompts, toast ---------------- */

  var modal = document.getElementById('modal');
  function openModal(html) {
    modal.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + html + '</div>';
    modal.hidden = false;
  }
  function closeModal() { modal.hidden = true; modal.innerHTML = ''; }
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

  function promptMoney(title, current, onSave, extraHtml) {
    openModal(
      '<h2>' + esc(title) + '</h2><form id="money-form">' + (extraHtml || '') +
      '<label class="field"><span id="money-label">Amount ($)</span><input name="amount" inputmode="decimal" value="' + esc(current) + '" autocomplete="off"></label>' +
      '<p class="error" id="form-error" hidden></p>' +
      '<div class="actions"><button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>'
    );
    var form = document.getElementById('money-form');
    form.amount.focus(); form.amount.select();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var ok = onSave(form.amount.value, form);
      if (ok === false) { var err = document.getElementById('form-error'); err.textContent = 'Enter a number, like 20 or 12.50.'; err.hidden = false; return; }
      closeModal(); render();
    });
    return form;
  }

  function promptText(title, current, onSave) {
    openModal(
      '<h2>' + esc(title) + '</h2><form id="text-form">' +
      '<label class="field"><span>Note</span><input name="text" value="' + esc(current) + '" autocomplete="off"></label>' +
      '<div class="actions"><button type="button" class="btn" data-action="close">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div></form>'
    );
    var form = document.getElementById('text-form');
    form.text.focus();
    form.addEventListener('submit', function (e) { e.preventDefault(); onSave(form.text.value.trim()); closeModal(); render(); });
  }

  /* ---------------- Appearance ---------------- */
  // Saved per device. Dark is the default. index.html applies it before the page draws.

  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'light' || t === 'system' ? t : 'dark';
  }
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('msl.theme', t); } catch (e) {}
    syncThemeColor();
  }
  // Matches the phone's status bar color to the background.
  function syncThemeColor() {
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.body).backgroundColor);
  }
  syncThemeColor();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { requestAnimationFrame(syncThemeColor); });
  document.addEventListener('visibilitychange', syncThemeColor);

  /* ---------------- Full screen ----------------
     Works in Safari on iPad and in desktop browsers. Hidden where the browser
     can't do it (Safari on iPhone) and when already opened from the home screen,
     which has no toolbar anyway. */
  var fsBtn = document.getElementById('fs-btn');
  function isStandalone() {
    return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  }
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsAvailable() {
    var d = document.documentElement;
    return !!(d.requestFullscreen || d.webkitRequestFullscreen) && !isStandalone();
  }
  function syncFsButton() {
    fsBtn.hidden = !fsAvailable();
    var on = !!fsElement();
    fsBtn.classList.toggle('on', on);
    fsBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  }
  function toggleFullscreen() {
    var d = document.documentElement, p;
    try {
      if (fsElement()) p = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else p = (d.requestFullscreen || d.webkitRequestFullscreen).call(d);
    } catch (err) { p = Promise.reject(err); }
    if (p && p.catch) p.catch(function () { toast('Full screen is not available here. Try Add to Home Screen.', { bad: true }); });
  }
  document.addEventListener('fullscreenchange', syncFsButton);
  document.addEventListener('webkitfullscreenchange', syncFsButton);
  syncFsButton();

  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  // On phones the cart is pinned to the bottom, so the snackbar sits just above it
  // instead of covering the payment buttons.
  /* Measure the real visible height and top bar so the iPad cart always fits on screen. */
  function sizeLayout() {
    var root = document.documentElement.style;
    root.setProperty('--app-h', window.innerHeight + 'px');
    var bar = document.querySelector('.topbar');
    if (bar && bar.offsetHeight) root.setProperty('--top-h', bar.offsetHeight + 'px');
  }
  window.addEventListener('resize', sizeLayout);
  window.addEventListener('orientationchange', function () { setTimeout(sizeLayout, 300); });
  document.addEventListener('fullscreenchange', sizeLayout);
  document.addEventListener('webkitfullscreenchange', sizeLayout);
  sizeLayout();

  function positionToast() {
    if (toastEl.hidden) return;
    var cart = document.querySelector('.cart');
    if (cart && getComputedStyle(cart).position === 'fixed') {
      toastEl.style.setProperty('--toast-bottom', (window.innerHeight - cart.getBoundingClientRect().top + 12) + 'px');
    } else {
      toastEl.style.removeProperty('--toast-bottom');
    }
  }
  function toast(msg, opts) {
    opts = opts || {};
    clearTimeout(toastTimer);
    toastEl.className = 'toast' + (opts.bad ? ' bad' : '');
    toastEl.innerHTML = '<span>' + esc(msg) + '</span>' + (opts.action ? '<button type="button">' + esc(opts.action) + '</button>' : '');
    toastEl.hidden = false;
    positionToast();
    if (opts.action) {
      toastEl.querySelector('button').onclick = function () { toastEl.hidden = true; opts.onAction(); };
    }
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, opts.ms || (opts.bad ? 6000 : 2500));
  }

  /* ---------------- Events ---------------- */

  document.querySelector('.tabbar').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tab]'); if (!b) return;
    state.tab = b.dataset.tab; save(KEY.tab, state.tab);
    document.getElementById('view').scrollTop = 0;
    render();
  });

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var a = el.dataset.action, id = el.dataset.id, i = Number(el.dataset.i), v = el.dataset.value;
    var line = state.cart.lines[i];

    switch (a) {
      case 'add': {
        var p = state.products.find(function (x) { return x.id === id; });
        if (p) addToCart(p);
        break;
      }
      case 'custom':
        promptMoney('Custom item', '', function (val, form) {
          var c = toCents(val); if (isNaN(c) || c <= 0) return false;
          var name = form.cname.value.trim() || 'Custom item';
          state.cart.lines.push({ productId: '', name: name, price: c, basePrice: null, qty: 1 });
          persistCart();
        }, '<label class="field"><span>Description (optional)</span><input name="cname" autocomplete="off" placeholder="Custom item"></label>');
        break;
      case 'inc': line.qty++; persistCart(); render(); break;
      case 'dec':
        line.qty--;
        if (line.qty <= 0) state.cart.lines.splice(i, 1);
        persistCart(); render(); break;
      case 'price':
        promptMoney('Price for ' + line.name, (line.price / 100).toFixed(2), function (val) {
          var c = toCents(val); if (isNaN(c) || c < 0) return false;
          line.price = c; persistCart();
        });
        break;
      case 'discount': {
        var d = state.cart.discount || { type: 'amount', value: 0 };
        var form = promptMoney('Discount for this sale',
          d.value ? (d.type === 'percent' ? String(d.value) : (d.value / 100).toFixed(2)) : '',
          function (val, f) {
            var type = f.querySelector('.seg .active').dataset.type;
            if (String(val).trim() === '' || Number(val) === 0) { state.cart.discount = null; persistCart(); return; }
            var n = type === 'percent' ? Number(val) : toCents(val);
            if (isNaN(n) || n < 0 || (type === 'percent' && n > 100)) return false;
            state.cart.discount = { type: type, value: n }; persistCart();
          },
          '<div class="seg"><button type="button" data-type="amount" class="' + (d.type === 'amount' ? 'active' : '') + '">$ off</button>' +
          '<button type="button" data-type="percent" class="' + (d.type === 'percent' ? 'active' : '') + '">% off</button></div>');
        form.querySelectorAll('.seg button').forEach(function (b) {
          b.addEventListener('click', function () {
            form.querySelectorAll('.seg button').forEach(function (x) { x.classList.toggle('active', x === b); });
            document.getElementById('money-label').textContent = b.dataset.type === 'percent' ? 'Percent off' : 'Amount off ($)';
            form.amount.focus();
          });
        });
        if (d.type === 'percent') document.getElementById('money-label').textContent = 'Percent off';
        break;
      }
      case 'note':
        promptText('Note for this sale', state.cart.note, function (t) { state.cart.note = t; persistCart(); });
        break;
      case 'clear': state.cart = emptyCart(); persistCart(); render(); break;
      case 'toggle-cart': state.cartOpen = !state.cartOpen; render(); break;
      case 'pay':
        state.cart.method = state.cart.method === v ? null : v; // tap again to unselect
        persistCart(); render(); break;
      case 'confirm': completeSale(); break;
      case 'category': state.category = v; render(); break;
      case 'goto': state.tab = v; save(KEY.tab, v); render(); break;
      case 'sales-day': state.salesDay = v; render(); break;
      case 'totals-day': state.totalsDay = v; render(); break;
      case 'sale': openSale(id); break;
      case 'void':
        enqueue('setVoided', { sale_id: id, voided: true }); closeModal(); toast('Sale cancelled'); break;
      case 'unvoid':
        enqueue('setVoided', { sale_id: id, voided: false }); closeModal(); toast('Sale restored'); break;
      case 'edit-note': {
        var s = displaySales().find(function (x) { return x.sale_id === id; });
        promptText('Note', s ? s.note : '', function (t) { enqueue('setNote', { sale_id: id, note: t }); });
        break;
      }
      case 'print': printReport(); break;
      case 'csv': exportCsv(); break;
      case 'new-product': productForm(null); break;
      case 'edit-product': productForm(state.products.find(function (x) { return x.id === id; })); break;
      case 'toggle-product': {
        var pr = state.products.find(function (x) { return x.id === id; });
        if (pr) saveProductNow({ id: pr.id, name: pr.name, category: pr.category, price: pr.price / 100, active: !pr.active, stock: pr.stock == null ? '' : pr.stock });
        break;
      }
      case 'import': importForm(); break;
      case 'close': closeModal(); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'retry':
        state.queue.forEach(function (o) { o.error = null; });
        clearTimeout(retryTimer);
        if (state.lastLoadError) refresh();
        flush(); render();
        break;
      case 'theme':
        setTheme(v);
        document.querySelectorAll('[data-action=theme]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.value === v);
          b.setAttribute('aria-pressed', String(b.dataset.value === v));
        });
        break;
      case 'menu':
        var cur = currentTheme();
        openModal('<h2>Menu</h2>' +
          '<div class="menu-label">Appearance</div>' +
          '<div class="seg three" role="group" aria-label="Appearance">' +
            [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match device']].map(function (o) {
              return '<button type="button" data-action="theme" data-value="' + o[0] + '" class="' + (cur === o[0] ? 'active' : '') + '" aria-pressed="' + (cur === o[0]) + '">' + o[1] + '</button>';
            }).join('') +
          '</div>' +
          '<div class="menu-list">' +
          '<button class="btn" data-action="reload">Refresh data</button>' +
          '<button class="btn btn-danger" data-action="signout">Sign out of this device</button>' +
          '<button class="btn" data-action="close">Close</button></div>' +
          '<p class="muted" style="margin-top:16px">Device: ' + esc(deviceType()) + (MOCK ? ' · Practice mode (mock data)' : '') + '</p>');
        break;
      case 'reload': closeModal(); refresh().then(function () { toast('Up to date'); }); break;
      case 'signout':
        if (state.queue.length && !confirm('Some changes are not saved yet. Sign out anyway? They stay on this device.')) return;
        closeModal(); signOut();
        break;
    }
  });

  // Pull the other device's sales regularly, and when the app comes back to the foreground.
  setInterval(function () {
    if (state.password && document.visibilityState === 'visible' && !state.queue.length && modal.hidden) refresh({ quiet: true });
  }, (CFG.REFRESH_SECONDS || 30) * 1000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.password) { flush(); refresh({ quiet: true }); }
  });
  window.addEventListener('online', function () { flush(); refresh({ quiet: true }); });

  /* ---------------- Practice mode (no backend) ----------------
   * Open the app with ?mock in the address to try it with fake data
   * saved only in this browser. Password: practice-password
   * Add ?mock&fail to simulate a broken connection.
   */
  function mockApi(action, payload) {
    var db = load('msl.mock.db', null) || {
      products: [
        { id: 'P1', name: 'Sticker', category: 'Stickers', price: 5, active: true, stock: 50 },
        { id: 'P2', name: 'Sticker pack (5)', category: 'Stickers', price: 20, active: true },
        { id: 'P3', name: 'Small print 5x7', category: 'Prints', price: 15, active: true },
        { id: 'P4', name: 'Large print 11x14', category: 'Prints', price: 40, active: true, stock: 4 },
        { id: 'P5', name: 'Collage original', category: 'Originals', price: 120, active: true, stock: 1 },
        { id: 'P6', name: 'Postcard', category: 'Paper', price: 4, active: true },
        { id: 'P7', name: 'Tote bag', category: 'Merch', price: 25, active: true }
      ],
      sales: []
    };
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (params.has('fail') && action !== 'login') return reject(new Error('Could not reach the server (practice failure).'));
        // Same lockout as the real server: 10 wrong passwords in 10 minutes locks everyone out for 15 minutes.
        // Add ?mock&unlock to the address to clear it.
        var lk = load('msl.practice.lockout', { n: 0, start: 0, until: 0 });
        if (params.has('unlock')) lk = { n: 0, start: 0, until: 0 };
        var now = Date.now();
        var lockedMsg = function () {
          var m = Math.max(1, Math.ceil((lk.until - now) / 60000));
          return 'Too many wrong passwords. Locked for safety. Try again in ' + m + ' minute' + (m === 1 ? '' : 's') + '.';
        };
        if (action === 'login' && !payload.captcha) return reject(new Error('Please complete the captcha.'));
        if (lk.until > now) { save('msl.practice.lockout', lk); return reject(new Error(lockedMsg())); }
        if (state.password !== 'practice-password') {
          if (now - lk.start > 10 * 60000) lk = { n: 0, start: now, until: 0 };
          lk.n += 1;
          if (lk.n >= 10) { lk.until = now + 15 * 60000; save('msl.practice.lockout', lk); return reject(new Error(lockedMsg())); }
          save('msl.practice.lockout', lk);
          var e = new Error('Wrong password.'); e.auth = true; return reject(e);
        }
        save('msl.practice.lockout', lk);
        var out = { ok: true };
        if (action === 'bootstrap') { out.products = db.products; out.sales = db.sales; }
        if (action === 'saveProduct') {
          var i = db.products.findIndex(function (p) { return p.id === payload.id; });
          var merged = Object.assign({}, i >= 0 ? db.products[i] : {}, payload);
          if (i >= 0) db.products[i] = merged; else db.products.push(merged);
          out.product = merged;
        }
        if (action === 'importProducts') {
          payload.products.forEach(function (p) {
            var j = db.products.findIndex(function (x) { return x.id === p.id; });
            if (j >= 0) db.products[j] = Object.assign({}, db.products[j], p); else db.products.push(p);
          });
          out.products = db.products;
        }
        if (action === 'addSale') {
          var found = db.sales.find(function (s) { return s.sale_id === payload.sale_id; });
          if (!found) {
            var s = saleFromPayload(payload);
            found = Object.assign({}, s, {
              items: s.items, subtotal: s.subtotal / 100, discount: s.discount / 100, total: s.total / 100
            });
            db.sales.push(found);
          }
          out.sale = found;
        }
        if (action === 'setVoided' || action === 'setNote') {
          var t = db.sales.find(function (s) { return s.sale_id === payload.sale_id; });
          if (!t) return reject(new Error('Sale not found.'));
          if (action === 'setVoided') t.voided = payload.voided; else t.note = payload.note;
          out.sale = t;
        }
        save('msl.mock.db', db);
        resolve(out);
      }, 350);
    });
  }

  /* ---------------- Start ---------------- */

  if (MOCK) document.querySelector('.brand').textContent = 'Practice mode';
  if (state.password) { showApp(); refresh({ quiet: !!cache }); flush(); }
  else showLogin();
})();
