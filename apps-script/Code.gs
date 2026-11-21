/**
 * Market Sales Log: backend (Google Apps Script)
 *
 * This file is bound to your Google Sheet (Extensions > Apps Script).
 * It is deployed as a web app and is the only thing that touches your data.
 *
 * The password lives in Project Settings > Script Properties under the key
 * APP_PASSWORD. It is never stored in the GitHub repo.
 *
 * Every request from the app is a POST with a text/plain JSON body:
 *   { "password": "...", "action": "...", "payload": { ... } }
 * text/plain keeps the browser from sending a CORS preflight, which
 * Apps Script cannot answer.
 */

var TIMEZONE = 'America/Denver';
var MIN_PASSWORD_LENGTH = 12;

var SHEETS = {
  Products: ['id', 'name', 'category', 'price', 'active', 'stock'],
  Sales: ['sale_id', 'timestamp', 'items', 'total', 'method', 'device', 'status',
          'receipt_link', 'note', 'cancelled', 'subtotal', 'discount', 'items_json'],
  Receipts: ['email_id', 'received_at', 'amount', 'method', 'sender', 'pdf_link',
             'matched_sale_id']
};

var METHODS = ['Zelle', 'Venmo', 'PayPal', 'Cash App', 'Cash'];

/* ------------------------------------------------------------------ */
/* One-time setup: run this once from the editor (select "setup", Run) */
/* ------------------------------------------------------------------ */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TIMEZONE);
  Object.keys(SHEETS).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SHEETS[name];
    var existing = sheet.getLastColumn() > 0
      ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      : [];
    // Add any missing headers to the right, never reorder existing ones.
    headers.forEach(function (h) {
      if (existing.indexOf(h) === -1) {
        existing.push(h);
        sheet.getRange(1, existing.length).setValue(h);
      }
    });
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
  });
  // Remove the default empty "Sheet1" if it is still there and empty.
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(sheet1);
  }
  var pw = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD');
  if (!pw) {
    Logger.log('Setup done. Next: add APP_PASSWORD in Project Settings > Script Properties.');
  } else if (pw.length < MIN_PASSWORD_LENGTH) {
    Logger.log('Setup done, but APP_PASSWORD is too short. Use at least ' + MIN_PASSWORD_LENGTH + ' characters.');
  } else {
    Logger.log('Setup done. Password is set. You can deploy the web app now.');
  }
}

/* ------------------------------------------------------------------ */
/* Web app entry points                                                */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, message: 'Market Sales Log backend is running.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.' });
  }

  // Sign in also needs a passed Google reCAPTCHA (when RECAPTCHA_SECRET is set).
  if (req.action === 'login') {
    var captchaError = checkCaptcha_(req.payload && req.payload.captcha);
    if (captchaError) return json_({ ok: false, error: captchaError });
  }

  var auth = checkPassword_(req.password);
  if (auth.locked) return json_({ ok: false, error: auth.error, locked: true, retryInMinutes: auth.minutes });
  if (auth !== true) return json_({ ok: false, error: auth, auth: false });

  try {
    var handler = ACTIONS[req.action];
    if (!handler) return json_({ ok: false, error: 'Unknown action: ' + req.action });
    var result = handler(req.payload || {});
    result.ok = true;
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

var ACTIONS = {
  login: function () { return {}; },
  bootstrap: bootstrap_,
  saveProduct: saveProduct_,
  importProducts: importProducts_,
  deleteProduct: deleteProduct_,
  addSale: addSale_,
  setVoided: setVoided_,
  setNote: setNote_
};

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

/*
 * Lockout: after MAX_FAILS wrong passwords within FAIL_WINDOW_MIN minutes, every
 * request is refused for LOCK_MIN minutes, even with the right password. This stops
 * anyone from guessing the password by trying many times.
 * The tradeoff: someone guessing on purpose could also lock you out for a while.
 * If that happens at the market, open the script editor, choose "unlock" and click Run.
 */
var MAX_FAILS = 10;
var FAIL_WINDOW_MIN = 10;
var LOCK_MIN = 15;

// Returns true, an error message string, or { locked: true, error, minutes }.
function checkPassword_(given) {
  var real = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD');
  if (!real) return 'The password has not been set up yet (Script Properties > APP_PASSWORD).';
  if (real.length < MIN_PASSWORD_LENGTH) return 'The server password is too short. Use at least ' + MIN_PASSWORD_LENGTH + ' characters.';

  var cache = CacheService.getScriptCache();
  var lockedUntil = Number(cache.get('pw_locked_until') || 0);
  if (lockedUntil > Date.now()) return lockedResponse_(lockedUntil);

  if (typeof given === 'string' && safeEqual_(digest_(given), digest_(real))) return true;

  var nowLocked = recordFailure_(cache);
  Utilities.sleep(1500); // slows down guessing
  if (nowLocked) return lockedResponse_(nowLocked);
  return 'Wrong password.';
}

// Counts a wrong password. Returns the lock end time if this failure starts a lockout, else 0.
function recordFailure_(cache) {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var now = Date.now();
    var state = JSON.parse(cache.get('pw_fails') || 'null');
    if (!state || now - state.start > FAIL_WINDOW_MIN * 60000) state = { n: 0, start: now };
    state.n += 1;
    if (state.n >= MAX_FAILS) {
      var until = now + LOCK_MIN * 60000;
      cache.put('pw_locked_until', String(until), LOCK_MIN * 60);
      cache.remove('pw_fails');
      console.warn('Locked for ' + LOCK_MIN + ' minutes after ' + MAX_FAILS + ' wrong passwords.');
      return until;
    }
    var secondsLeft = Math.max(1, Math.ceil((state.start + FAIL_WINDOW_MIN * 60000 - now) / 1000));
    cache.put('pw_fails', JSON.stringify(state), secondsLeft);
    return 0;
  } finally {
    lock.releaseLock();
  }
}

function lockedResponse_(until) {
  var minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return {
    locked: true,
    minutes: minutes,
    error: 'Too many wrong passwords. Locked for safety. Try again in ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '.'
  };
}

/*
 * Google reCAPTCHA check for sign in. Returns '' when it passes, or an error message.
 * Turned on by adding the secret key in Script Properties as RECAPTCHA_SECRET.
 */
function checkCaptcha_(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
  if (!secret) return '';
  if (!token || typeof token !== 'string') return 'Please complete the captcha.';
  try {
    var res = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'post',
      payload: { secret: secret, response: token },
      muteHttpExceptions: true
    });
    var data = JSON.parse(res.getContentText() || '{}');
    if (data.success === true) return '';
    console.warn('Captcha failed: ' + JSON.stringify(data['error-codes'] || []));
    return 'The captcha check did not pass. Try again.';
  } catch (err) {
    return 'Could not check the captcha right now. Try again.';
  }
}

// Emergency: run this from the script editor to end a lockout right away.
function unlock() {
  var cache = CacheService.getScriptCache();
  cache.remove('pw_locked_until');
  cache.remove('pw_fails');
  Logger.log('Unlocked. The app works again.');
}

function digest_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function bootstrap_() {
  return {
    products: readRows_('Products').map(cleanProduct_),
    sales: readRows_('Sales').map(cleanSale_),
    serverTime: new Date().toISOString()
  };
}

function saveProduct_(p) {
  var product = validateProduct_(p);
  return withLock_(function () {
    upsert_('Products', 'id', product);
    return { product: cleanProduct_(findRow_('Products', 'id', product.id).obj) };
  });
}

function importProducts_(payload) {
  var list = (payload.products || []).map(validateProduct_);
  if (!list.length) throw new Error('No products to import.');
  return withLock_(function () {
    list.forEach(function (p) { upsert_('Products', 'id', p); });
    return { products: readRows_('Products').map(cleanProduct_) };
  });
}

// Removes a product row. Past sales keep their own copy of the item name and price,
// so sales history and totals are not affected.
function deleteProduct_(payload) {
  if (!payload.id) throw new Error('Missing product id.');
  return withLock_(function () {
    var found = findRow_('Products', 'id', payload.id);
    if (!found) throw new Error('Product not found. It may already be deleted.');
    sheet_('Products').deleteRow(found.rowIndex);
    return { products: readRows_('Products').map(cleanProduct_) };
  });
}

function addSale_(s) {
  if (!s.sale_id) throw new Error('Missing sale id.');
  if (METHODS.indexOf(s.method) === -1) throw new Error('Unknown payment method.');
  var items = Array.isArray(s.items) ? s.items : [];
  if (!items.length) throw new Error('A sale needs at least one item.');

  // Recompute totals on the server so the sheet is always consistent.
  var subtotal = 0;
  items.forEach(function (it) {
    it.qty = Math.max(1, Math.round(Number(it.qty) || 0));
    it.price = toCents_(it.price);
    subtotal += it.qty * it.price;
  });
  var discount = Math.min(subtotal, Math.max(0, toCents_(s.discount || 0)));
  var total = subtotal - discount;

  var ts = new Date(s.timestamp);
  if (isNaN(ts.getTime())) ts = new Date();

  var row = {
    sale_id: String(s.sale_id),
    timestamp: ts,
    items: items.map(function (it) {
      return it.qty + ' x ' + it.name + ' @ ' + money_(it.price);
    }).join('; '),
    total: total / 100,
    method: s.method,
    device: String(s.device || ''),
    status: s.method === 'Cash' ? 'cash' : 'missing',
    receipt_link: '',
    note: String(s.note || ''),
    cancelled: false, // the app calls this "cancel sale"
    subtotal: subtotal / 100,
    discount: discount / 100,
    items_json: JSON.stringify(items)
  };

  return withLock_(function () {
    // Idempotent: if the app retries a sale that already saved, do not duplicate it.
    var existing = findRow_('Sales', 'sale_id', row.sale_id);
    if (existing) return { sale: cleanSale_(existing.obj), duplicate: true };
    appendRow_('Sales', row);
    return { sale: cleanSale_(row) };
  });
}

function setVoided_(p) {
  return withLock_(function () {
    var found = findRow_('Sales', 'sale_id', String(p.sale_id));
    if (!found) throw new Error('Sale not found.');
    setCell_('Sales', found.rowIndex, 'cancelled', !!p.voided);
    found.obj.cancelled = !!p.voided;
    return { sale: cleanSale_(found.obj) };
  });
}

function setNote_(p) {
  return withLock_(function () {
    var found = findRow_('Sales', 'sale_id', String(p.sale_id));
    if (!found) throw new Error('Sale not found.');
    setCell_('Sales', found.rowIndex, 'note', String(p.note || ''));
    found.obj.note = String(p.note || '');
    return { sale: cleanSale_(found.obj) };
  });
}

/* ------------------------------------------------------------------ */
/* Validation and cleaning                                             */
/* ------------------------------------------------------------------ */

function validateProduct_(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('Product name is required.');
  var price = toCents_(p.price);
  if (price < 0) throw new Error('Price cannot be negative.');
  return {
    id: String(p.id || ('P' + Utilities.getUuid().slice(0, 8))),
    name: name,
    category: String(p.category || 'Other').trim() || 'Other',
    price: price / 100,
    active: p.active === false || p.active === 'FALSE' ? false : true,
    // Left out (undefined) when the request did not include stock, so an existing value is kept.
    stock: p.stock === undefined ? undefined : cleanStock_(p.stock)
  };
}

function cleanProduct_(r) {
  return {
    id: String(r.id),
    name: String(r.name),
    category: String(r.category || 'Other'),
    price: Number(r.price) || 0,
    active: !(r.active === false || String(r.active).toUpperCase() === 'FALSE'),
    stock: cleanStock_(r.stock, true)
  };
}

// Starting stock: a whole number, or blank when you do not track stock for that product.
// Items sold and items left are calculated from the sales, so cancelled sales put items back automatically.
// lenient = true when reading the sheet: a typo there shows as "not tracked" instead of breaking the app.
function cleanStock_(v, lenient) {
  if (v === null || v === undefined || String(v).trim() === '') return '';
  var n = Math.round(Number(v));
  if (isNaN(n) || n < 0) {
    if (lenient) return '';
    throw new Error('Stock must be a whole number, 0 or more.');
  }
  return n;
}

function cleanSale_(r) {
  var items = [];
  try { items = JSON.parse(r.items_json || '[]'); } catch (e) {}
  var ts = r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp);
  return {
    sale_id: String(r.sale_id),
    timestamp: isNaN(ts.getTime()) ? '' : ts.toISOString(),
    items: items,
    items_text: String(r.items || ''),
    total: Number(r.total) || 0,
    subtotal: Number(r.subtotal) || Number(r.total) || 0,
    discount: Number(r.discount) || 0,
    method: String(r.method || ''),
    device: String(r.device || ''),
    status: String(r.status || ''),
    receipt_link: String(r.receipt_link || ''),
    note: String(r.note || ''),
    voided: r.cancelled === true || String(r.cancelled).toUpperCase() === 'TRUE'
  };
}

/* ------------------------------------------------------------------ */
/* Sheet helpers (columns are found by header name, not position)     */
/* ------------------------------------------------------------------ */

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run setup() in the script editor.');
  return sh;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function readRows_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = headers_(sh);
  return sh.getRange(2, 1, last - 1, headers.length).getValues()
    .filter(function (row) { return row.join('') !== ''; })
    .map(function (row) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = row[i]; });
      return o;
    });
}

function findRow_(name, key, value) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var headers = headers_(sh);
  var col = headers.indexOf(key);
  var data = sh.getRange(2, 1, last - 1, headers.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][col]) === String(value)) {
      var o = {};
      headers.forEach(function (h, j) { o[h] = data[i][j]; });
      return { rowIndex: i + 2, obj: o };
    }
  }
  return null;
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  var headers = headers_(sh);
  sh.appendRow(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}

function upsert_(name, key, obj) {
  var found = findRow_(name, key, obj[key]);
  if (!found) return appendRow_(name, obj);
  var sh = sheet_(name);
  var headers = headers_(sh);
  var row = headers.map(function (h) { return obj[h] === undefined ? found.obj[h] : obj[h]; });
  sh.getRange(found.rowIndex, 1, 1, headers.length).setValues([row]);
}

function setCell_(name, rowIndex, key, value) {
  var sh = sheet_(name);
  var col = headers_(sh).indexOf(key);
  if (col === -1) throw new Error('Missing column "' + key + '" in ' + name + '.');
  sh.getRange(rowIndex, col + 1).setValue(value);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

// Accepts dollars as a number or string ("12", "12.50", "$12.50") and returns cents.
function toCents_(v) {
  var n = Number(String(v === undefined ? 0 : v).replace(/[$,\s]/g, ''));
  if (isNaN(n)) throw new Error('Invalid price: ' + v);
  return Math.round(n * 100);
}

function money_(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* Phase 2: payment receipts from Gmail                                */
/* ------------------------------------------------------------------ */

/*
 * How it works:
 * 1. Gmail filters put every payment email (Venmo, Cash App, PayPal, Chase Zelle)
 *    under the label "market-receipts" in this account.
 * 2. processReceipts() runs every 5 minutes (run installReceiptTrigger() once).
 *    It reads new labeled emails, pulls out amount, sender and time, and adds a
 *    row to the Receipts tab. Then it labels the email "market-processed".
 * 3. Each unmatched receipt is compared with the sales: same payment method, same
 *    total, within MATCH_WINDOW_MIN minutes, not cancelled, no receipt yet.
 *    It only matches when exactly one sale fits, so it never guesses.
 * 4. When it matches, it saves a PDF of the email in the "Receipts" folder (next to
 *    this Sheet in Drive) and links it to the sale. Payments that never match a
 *    sale (personal ones) get a row in the Receipts tab but no PDF.
 */

var RECEIPT_LABEL = 'market-receipts';
var PROCESSED_LABEL = 'market-processed';
var MATCH_WINDOW_MIN = 30;
var RETRY_MATCH_HOURS = 48; // keep trying to match a receipt for this long

// Run once from the editor: choose installReceiptTrigger, then Run.
function installReceiptTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processReceipts') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processReceipts').timeBased().everyMinutes(5).create();
  receiptFolder_(); // asks for Drive permission now and creates the folder if needed
  Logger.log('Receipt checking is on. It runs every 5 minutes.');
}

// Turns receipt checking off.
function removeReceiptTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processReceipts') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Receipt checking is off.');
}

function processReceipts() {
  var processed = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
  var threads = GmailApp.search('label:' + RECEIPT_LABEL + ' -label:' + PROCESSED_LABEL + ' newer_than:7d', 0, 50);
  var known = {};
  readRows_('Receipts').forEach(function (r) { known[String(r.email_id)] = true; });
  var added = 0, skipped = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var id = msg.getId();
      if (known[id]) return;
      var parsed = parseReceipt_(msg.getFrom(), msg.getSubject(), htmlToText_(msg.getBody()));
      if (!parsed) { skipped++; console.log('Not a received payment, skipped: ' + msg.getSubject()); return; }
      withLock_(function () {
        appendRow_('Receipts', {
          email_id: id,
          received_at: msg.getDate(),
          amount: parsed.amount / 100,
          method: parsed.method,
          sender: parsed.sender,
          pdf_link: '',
          matched_sale_id: ''
        });
      });
      known[id] = true;
      added++;
    });
    thread.addLabel(processed);
  });

  var matched = matchPendingReceipts_();
  console.log('Receipts: ' + added + ' new, ' + skipped + ' skipped, ' + matched + ' matched.');
}

// Tries to match every recent unmatched receipt. Also catches sales that were
// entered after the payment email arrived.
function matchPendingReceipts_() {
  var now = Date.now();
  var receipts = readRows_('Receipts').filter(function (r) {
    var t = new Date(r.received_at).getTime();
    return !r.matched_sale_id && !isNaN(t) && now - t < RETRY_MATCH_HOURS * 3600000;
  });
  if (!receipts.length) return 0;
  var count = 0;
  receipts.forEach(function (r) {
    withLock_(function () {
      var sales = readRows_('Sales').map(function (s, i) { s._row = i + 2; return s; });
      var sale = findMatchingSale_(sales, {
        method: String(r.method),
        amount: Math.round(Number(r.amount) * 100),
        time: new Date(r.received_at).getTime()
      });
      if (!sale) return;
      var pdf = saveReceiptPdf_(String(r.email_id), r, sale);
      var rec = findRow_('Receipts', 'email_id', String(r.email_id));
      setCell_('Receipts', rec.rowIndex, 'pdf_link', pdf);
      setCell_('Receipts', rec.rowIndex, 'matched_sale_id', String(sale.sale_id));
      setCell_('Sales', sale._row, 'receipt_link', pdf);
      setCell_('Sales', sale._row, 'status', 'matched');
      count++;
    });
  });
  return count;
}

// Pure function (no Google services) so it can be tested on its own.
// Returns the one sale that fits, or null when none or more than one fit.
function findMatchingSale_(sales, receipt) {
  var fits = sales.filter(function (s) {
    if (String(s.method) !== receipt.method) return false;
    if (s.cancelled === true || String(s.cancelled).toUpperCase() === 'TRUE') return false;
    if (s.receipt_link) return false;
    if (Math.round(Number(s.total) * 100) !== receipt.amount) return false;
    var t = new Date(s.timestamp).getTime();
    return !isNaN(t) && Math.abs(t - receipt.time) <= MATCH_WINDOW_MIN * 60000;
  });
  return fits.length === 1 ? fits[0] : null;
}

/*
 * Reads one payment email. Returns { method, amount (cents), sender } for money
 * you received, or null for anything else (money you sent, requests, promos).
 * Formats checked against real emails from Nov 2026: Venmo, PayPal, Chase Zelle.
 * Cash App is a best guess until a real sample is checked.
 */
function parseReceipt_(from, subject, text) {
  var f = String(from || '').toLowerCase();
  var subj = String(subject || '').replace(/[ \s]+/g, ' ').trim();
  var body = String(text || '').replace(/[ \t ]+/g, ' ');
  var amt = '\\$\\s?([\\d,]+(?:\\.\\d{2})?)';
  var m;

  if (/@venmo\.com/.test(f)) {
    // "Calvin Knutzen paid $1.00 to your Venmo account..." or "... paid your $5.00 request"
    m = subj.match(new RegExp('^(.+?) paid (?:you |your )?' + amt, 'i'));
    if (!m || /^you\b/i.test(m[1])) return null;
    return { method: 'Venmo', amount: toCents_(m[2]), sender: m[1].trim() };
  }

  if (/paypal\.com/.test(f)) {
    // "Calvin Knutzen sent you $1.00 USD"
    m = subj.match(new RegExp('^(.+?) sent you ' + amt + '\\s*USD', 'i'));
    if (!m) return null;
    return { method: 'PayPal', amount: toCents_(m[2]), sender: m[1].trim() };
  }

  if (/chase\.com/.test(f)) {
    // Subject "You received money with Zelle(R)", body "NAME sent you money ... Amount $1.00"
    if (!/received money with zelle/i.test(subj)) return null;
    var who = body.match(/([^\n]+?) sent you money/i);
    var a = body.match(new RegExp('Amount\\s*' + amt, 'i'));
    if (!a) return null;
    return { method: 'Zelle', amount: toCents_(a[1]), sender: who ? titleCase_(who[1].trim()) : '' };
  }

  if (/square\.com|cash\.app/.test(f)) {
    // Best guess: "Calvin Knutzen sent you $1" or "... sent you $1.00 for ..."
    m = subj.match(new RegExp('^(.+?) sent you ' + amt, 'i'));
    if (!m || /^you\b/i.test(m[1])) return null;
    return { method: 'Cash App', amount: toCents_(m[2]), sender: m[1].trim() };
  }

  return null;
}

function titleCase_(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
}

// Rough HTML to plain text, enough to read amounts and names.
function htmlToText_(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&reg;/gi, '®')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

// The "Receipts" folder next to this Sheet in Drive (created if missing).
function receiptFolder_() {
  var parents = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var found = parent.getFoldersByName('Receipts');
  return found.hasNext() ? found.next() : parent.createFolder('Receipts');
}

// Saves the email as a PDF named like "2026-12-06 1412 Venmo $25.00 Jane Doe S-123.pdf".
function saveReceiptPdf_(emailId, receipt, sale) {
  var msg = GmailApp.getMessageById(emailId);
  var when = Utilities.formatDate(msg.getDate(), TIMEZONE, 'yyyy-MM-dd HHmm');
  var header = '<div style="font:13px Arial;border-bottom:1px solid #ccc;padding:8px 0;margin-bottom:12px">' +
    '<b>From:</b> ' + escHtml_(msg.getFrom()) + '<br><b>To:</b> ' + escHtml_(msg.getTo()) +
    '<br><b>Date:</b> ' + escHtml_(Utilities.formatDate(msg.getDate(), TIMEZONE, 'MMM d, yyyy h:mm a')) + ' (Mountain Time)' +
    '<br><b>Subject:</b> ' + escHtml_(msg.getSubject()) +
    '<br><b>Matched sale:</b> ' + escHtml_(String(sale.sale_id)) + '</div>';
  var name = when + ' ' + receipt.method + ' ' + money_(Math.round(Number(receipt.amount) * 100)) + ' ' +
    String(receipt.sender || '').replace(/[\\\/:*?"<>|]/g, '') + ' ' + sale.sale_id;
  var pdf = Utilities.newBlob(header + msg.getBody(), 'text/html', name + '.html').getAs('application/pdf').setName(name + '.pdf');
  return receiptFolder_().createFile(pdf).getUrl();
}

function escHtml_(s) {
  return String(s || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
