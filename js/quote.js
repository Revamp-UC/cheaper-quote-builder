/* Cheaper Quote Builder
 * UrbanCompany PDFs use Identity-H CID fonts (no ToUnicode) so their embedded
 * text is garbage. We render each page to canvas via pdf.js, then run FREE
 * in-browser OCR (Tesseract.js — no API key, no network, no per-use cost) on the
 * rendered image, parse the quote, match panels to our 116-panel catalog, and
 * auto-generate cheaper look-alike quotes (qty recomputed by wall area).
 */
(function () {
  'use strict';

  if (window['pdfjsLib']) {
    window['pdfjsLib'].GlobalWorkerOptions.workerSrc = 'assets/vendor/pdf.worker.min.js';
  }
  var TDIR = 'assets/vendor/tesseract/';

  // ---------- state ----------
  var CATALOG = [];
  var review = { customer: '', subtotal: 0, taxes: 0, total: 0, panels: [], accessories: [], numbersOk: true };
  var ocrWorker = null;

  // ---------- tiny helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function rupee(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }
  function show(id) { $(id).hidden = false; }
  function hide(id) { $(id).hidden = true; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function unitArea(d) { return (d && d.L_ft && d.W_in) ? d.L_ft * (d.W_in / 12) : null; }
  function words(s) { return norm(s).split(' ').filter(function (w) { return w.length > 2; }); }
  function wordOverlap(a, b) {
    var aw = words(a), bw = words(b);
    if (!aw.length || !bw.length) return 0;
    var hits = aw.filter(function (w) { return bw.indexOf(w) >= 0; }).length;
    return hits / Math.max(aw.length, bw.length);
  }

  // ---------- load catalog ----------
  function loadCatalog() {
    return fetch('assets/data/panels.json')
      .then(function (r) { if (!r.ok) throw new Error('panels.json ' + r.status); return r.json(); })
      .then(function (j) { CATALOG = j.panels || []; });
  }

  // ---------- render PDF pages to canvas ----------
  function renderPdf(arrayBuffer) {
    var pages = $('pdfPages');
    pages.innerHTML = '<div class="qb-pdf-empty">Rendering…</div>';
    var pdfjs = window['pdfjsLib'];
    return pdfjs.getDocument({ data: arrayBuffer }).promise.then(function (doc) {
      pages.innerHTML = '';
      var chain = Promise.resolve();
      for (var i = 1; i <= doc.numPages; i++) (function (n) {
        chain = chain.then(function () {
          return doc.getPage(n).then(function (page) {
            var vp = page.getViewport({ scale: 2.0 });
            var canvas = el('canvas', 'qb-pdf-canvas');
            canvas.width = vp.width; canvas.height = vp.height;
            pages.appendChild(canvas);
            return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          });
        });
      })(i);
      return chain;
    }).catch(function (e) {
      pages.innerHTML = '<div class="qb-pdf-empty qb-err">Could not render PDF: ' + esc(e.message) + '</div>';
      throw e;
    });
  }

  // ---------- OCR: free, in-browser (Tesseract.js) ----------
  function getWorker() {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    if (!window.Tesseract) return Promise.reject(new Error('OCR engine (Tesseract) failed to load — hard-refresh the page (Cmd+Shift+R).'));
    setLoadingMsg('Starting OCR engine (one-time, ~20s)…');
    return window.Tesseract.createWorker('eng', 1, {
      workerPath: TDIR + 'worker.min.js',
      corePath: TDIR,
      langPath: TDIR,
      gzip: true,
      logger: function (m) {
        var pct = m.progress != null ? ' ' + Math.round(m.progress * 100) + '%' : '';
        if (m.status === 'recognizing text') setLoadingMsg('Reading quote…' + pct);
        else if (/load|initial/i.test(m.status || '')) setLoadingMsg('Starting OCR engine (one-time)… ' + m.status + pct);
      }
    }).then(function (w) { ocrWorker = w; return w; });
  }
  function ocrAllPages() {
    var canvases = Array.prototype.slice.call($('pdfPages').querySelectorAll('canvas.qb-pdf-canvas'));
    if (!canvases.length) return Promise.reject(new Error('PDF rendered no pages'));
    return getWorker().then(function (worker) {
      var text = '', chain = Promise.resolve();
      canvases.forEach(function (cv, i) {
        chain = chain.then(function () {
          setLoadingMsg('Reading page ' + (i + 1) + ' of ' + canvases.length + '…');
          return worker.recognize(cv).then(function (res) { text += '\n' + res.data.text; });
        });
      });
      return chain.then(function () { return text; });
    });
  }

  // ---------- parse OCR text of a UC wall-panel quotation ----------
  function parseQuoteText(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    function num(s) { var d = String(s).replace(/[^\d]/g, ''); return d ? parseInt(d, 10) : null; }
    // amount on the LAST line matching a keyword
    function amountFor(re) {
      var val = null;
      lines.forEach(function (l) {
        if (re.test(l)) { var m = l.match(/\d[\d,]*/g); if (m && m.length) val = num(m[m.length - 1]); }
      });
      return val;
    }
    var subtotal = amountFor(/sub\s*total/i);
    var taxes = amountFor(/tax(es)?\b/i);
    var discount = amountFor(/discount/i);
    var total = amountFor(/total\s*amount/i);
    if (total == null) total = amountFor(/\btotal\b/i);  // fallback

    // The ₹ glyph frequently OCRs as a leading "glue" digit on ANY amount
    // (e.g. "₹18,319"→"318,319" on subtotal, "₹3,117"→"23,117" on discount).
    // The quote identity is exact:  subtotal + taxes − discount = total.
    // Reconcile all four against it, "de-gluing" (dropping the spurious leading
    // digit) whichever field breaks the identity — pick the fix with fewest changes.
    var reconciled = false;   // did the four amounts satisfy the identity (after de-glue)?
    (function reconcile() {
      function opts(v) {
        if (v == null) return [{ v: null, cost: 0 }];
        var o = [{ v: v, cost: 0 }], s = String(Math.abs(v));
        if (s.length > 1) o.push({ v: parseInt(s.slice(1), 10), cost: 1 });  // drop glue digit
        return o;
      }
      var S = opts(subtotal), T = opts(taxes),
          D = (discount == null ? [{ v: 0, cost: 0 }] : opts(discount)), G = opts(total), best = null;
      S.forEach(function (s) { T.forEach(function (t) { D.forEach(function (d) { G.forEach(function (g) {
        if (s.v == null || t.v == null || g.v == null || g.v <= 0) return;
        if (s.v + t.v - d.v === g.v) {
          var cost = s.cost + t.cost + d.cost + g.cost;
          if (!best || cost < best.cost) best = { s: s.v, t: t.v, d: d.v, g: g.v, cost: cost };
        }
      }); }); }); });
      if (best) { subtotal = best.s; taxes = best.t; discount = best.d; total = best.g; reconciled = true; }
      else if (total != null && taxes != null) {                        // fallback: derive subtotal
        var dv = total - taxes + (discount || 0); if (dv > 0) subtotal = dv;
      }
    })();

    var customer = '';
    lines.forEach(function (l) {
      var m = l.match(/customer\s*name\s*[:\-]?\s*(.+)/i);
      if (m && !customer) customer = m[1].replace(/[^A-Za-z .'-]+$/, '').trim();
    });

    // panels/trims: bullet lines ending in xN whose name STARTS with a code-like
    // token (e.g. "5083", "0G29", "183S", "0952/0414"). Accessories like Polyfix,
    // Silicon glue, Copper wire start with a plain word → excluded here.
    function looksLikePanel(name) {
      // Code tokens may carry a "*" footnote marker (catalog has X905*, 9472*, 9382*…)
      // which OCR sometimes renders as "°" — strip such symbols before testing.
      var t = (name.split(/\s+/)[0] || '').replace(/[^0-9A-Za-z/]/g, '');
      // must be a code-like token (has a digit): panels & coded beadings do; plain
      // accessories (Silicon glue, Polyfix, Metal clips, Visible H Trim) do not.
      return /\d/.test(t) && t.length >= 2 && t.length <= 10;
    }
    var items = [], accessories = [];
    lines.forEach(function (l) {
      var qm = l.match(/[xX×*]\s*(\d{1,3})\s*$/);
      if (!qm) return;
      var qty = parseInt(qm[1], 10);
      // OCR renders the "•" bullet as «, «+, +, » etc. Strip ALL leading non-alphanumerics.
      var name = l.replace(/[xX×*]\s*\d{1,3}\s*$/, '').replace(/^[^0-9A-Za-z]+/, '').trim();
      if (qty < 1 || qty > 500 || !name) return;
      if (looksLikePanel(name)) items.push({ name: name, qty: qty });
      else accessories.push({ name: name, qty: qty });   // glue, clips, trims, shelf, light…
    });
    return { customer: customer, subtotal: subtotal, taxes: taxes, total: total, items: items, accessories: accessories, reconciled: reconciled };
  }

  // ---------- match extracted name → catalog panel ----------
  function matchPanel(rawName) {
    if (!rawName) return null;
    var n = norm(rawName);
    // 1. 4-digit code — catalog names begin with it (e.g. "9472* Nio Plain Gold"),
    //    and the SKU carries it as a suffix (e.g. "UC/P1/PPN/K9472"). Deterministic.
    var codeM = n.match(/\b(\d{4})\b/);
    if (codeM) {
      var c4 = codeM[1];
      var hits = CATALOG.filter(function (p) {
        return new RegExp('\\b' + c4 + '\\b').test(norm(p.name)) || (p.code || '').indexOf(c4) >= 0;
      });
      if (hits.length === 1) return { panel: hits[0], how: 'code' };
      if (hits.length > 1) {  // e.g. plain vs beading share a code — pick best name overlap
        var b = null, bs = -1;
        hits.forEach(function (p) { var s = wordOverlap(rawName, p.name); if (s > bs) { bs = s; b = p; } });
        return { panel: b, how: 'code' };
      }
    }
    // 2. exact normalized name
    var exact = CATALOG.find(function (p) { return norm(p.name) === n; });
    if (exact) return { panel: exact, how: 'exact' };
    // 3. fuzzy word overlap
    var best = null, bestScore = 0;
    CATALOG.forEach(function (p) {
      var s = wordOverlap(rawName, p.name);
      if (s > bestScore) { bestScore = s; best = p; }
    });
    if (bestScore >= 0.45) return { panel: best, how: 'fuzzy' };
    return null;
  }

  // ---------- loading overlay ----------
  function showLoading(msg) { var ov = $('loadingOverlay'); if (ov) { $('loadingMsg').textContent = msg || 'Working…'; ov.hidden = false; } }
  function hideLoading() { var ov = $('loadingOverlay'); if (ov) ov.hidden = true; }
  function setLoadingMsg(msg) { var m = $('loadingMsg'); if (m) m.textContent = msg; }

  // ---------- AI/OCR extraction banner (shown on build + result) ----------
  function showExtractionBanner(customer, matched, totalItems, unmatched, beadingOnly) {
    var missed = (unmatched || []).length;
    var html = '📄 Auto-read from PDF · <b>' + esc(customer || '—') + '</b> · ' +
      matched + ' panel(s) matched to catalog';
    if (missed) html += ' · <span class="qb-warn-inline">⚠ not in catalog: ' + unmatched.map(esc).join(', ') + '</span>';
    if (beadingOnly && beadingOnly.length) html += ' · <span class="qb-warn-inline">⚠ qty inferred from beading (verify): ' + beadingOnly.map(esc).join(', ') + '</span>';
    ['aiBanner', 'aiBannerResult'].forEach(function (id) {
      var b = $(id); if (!b) return;
      b.innerHTML = html + ' <button class="qb-banner-edit qb-linkbtn" style="margin-left:10px">Edit / fix</button>';
      b.hidden = false;
    });
    document.querySelectorAll('.qb-banner-edit').forEach(function (btn) {
      btn.addEventListener('click', function () { toBuild(); });
    });
  }
  function hideBanners() { ['aiBanner', 'aiBannerResult'].forEach(function (id) { var b = $(id); if (b) b.hidden = true; }); }

  // ================= ENGINE (verified) =================
  function computeSwap(row, alt) {
    var oa = unitArea(row.panel.dims), aa = unitArea(alt.dims), qtyAlt;
    if (oa && aa) qtyAlt = Math.max(1, Math.ceil(row.qty * oa / aa)); else qtyAlt = row.qty;
    var origCost = row.qty * row.panel.perPanel, altCost = qtyAlt * alt.perPanel;
    return { alt: alt, qtyOrig: row.qty, qtyAlt: qtyAlt, origCost: origCost, altCost: altCost, saving: origCost - altCost };
  }
  function bestSwap(row) {
    var best = null;
    (row.cheaper || []).forEach(function (a) {
      var s = computeSwap(row, a);
      if (s.saving > 0 && (!best || s.saving > best.saving)) best = s;
    });
    return best;
  }
  function priceQuote(swaps) {
    var S0 = review.subtotal, T0 = review.taxes, origTotal = review.total || (S0 + T0);
    var effRate = S0 ? (T0 / S0) : 0;
    var saving = swaps.reduce(function (s, x) { return s + x.saving; }, 0);
    var S1 = S0 - saving;
    var T1 = Math.round(effRate * S1);
    var d = S1 >= 25000 ? 0.08 : S1 >= 15000 ? 0.05 : 0;
    var D1 = Math.round(d * S1);
    var total1 = S1 + T1 - D1;
    return { subtotal: S1, taxes: T1, discountPct: d * 100, discount: D1, total: total1, panelSaving: saving, savedVsOrig: origTotal - total1 };
  }
  var MAX_QUOTES = 100;               // safety cap for combinatorial blow-up
  var lastQuoteTotal = 0;             // how many combinations existed before capping

  // Full PnC: every subset of panels × every cheaper alternative for each.
  // For each replaceable panel the choices are {keep} ∪ {each positive-saving alt};
  // the Cartesian product across panels (minus the all-keep case) = every option.
  function generateQuotes() {
    // Consider EVERY cheaper-look-alike (per the catalog) for each panel — even ones
    // that turn out net-premium once quantity is recomputed by wall area (smaller
    // panels need more units). We show all and mark save vs premium; nothing hidden.
    var perPanel = review.panels.map(function (r) {
      var swaps = (r.cheaper || []).map(function (a) { return computeSwap(r, a); })
        .sort(function (a, b) { return b.saving - a.saving; });
      return { row: r, swaps: swaps };
    }).filter(function (x) { return x.swaps.length; });
    if (!perPanel.length) { lastQuoteTotal = 0; return []; }

    var results = [];
    (function recurse(idx, chosen) {
      if (idx === perPanel.length) {
        if (chosen.length) {
          var swaps = chosen.map(function (c) { return Object.assign({ row: c.row }, c.swap); });
          results.push({ swaps: swaps, price: priceQuote(swaps) });
        }
        return;
      }
      recurse(idx + 1, chosen);                                   // keep this panel
      perPanel[idx].swaps.forEach(function (s) {                  // or swap it for each alt
        recurse(idx + 1, chosen.concat([{ row: perPanel[idx].row, swap: s }]));
      });
    })(0, []);

    // dedupe by exact panel→alt mapping, sort by savings, cap for UI sanity
    var seen = {}, uniq = [];
    results.forEach(function (q) {
      var key = q.swaps.map(function (s) { return s.row.panel.code + '>' + s.alt.code; }).sort().join('|');
      if (seen[key]) return; seen[key] = 1; uniq.push(q);
    });
    uniq.sort(function (a, b) { return b.price.savedVsOrig - a.price.savedVsOrig; });
    lastQuoteTotal = uniq.length;
    return uniq.slice(0, MAX_QUOTES);
  }

  // ================= ENTRY UI =================
  function addPanel(p) {
    if (review.panels.some(function (r) { return r.panel.code === p.code; })) return;
    var cheaper = (p.alternatives || []).filter(function (a) { return a.isCheaper && a.perPanel; });
    review.panels.push({ panel: p, qty: 1, cheaper: cheaper });
    renderPanelTable();
  }
  function renderPanelTable() {
    var tb = $('panelTable').querySelector('tbody'); tb.innerHTML = '';
    review.panels.forEach(function (r, idx) {
      var n = r.cheaper.length;
      var tr = el('tr');
      tr.innerHTML =
        '<td><input class="qb-qty" type="number" min="1" value="' + r.qty + '" data-i="' + idx + '"></td>' +
        '<td><div class="qb-cellmain">' + esc(r.panel.name) + (r.fromBeading ? ' <span class="qb-pill qb-pill-warn">qty from beading</span>' : '') + '</div><div class="qb-cellsub">' + esc(r.panel.code) + ' · ' + esc(r.panel.material) + ' · ' + esc(r.panel.dims ? r.panel.dims.raw : '') + '</div></td>' +
        '<td>' + rupee(r.panel.perPanel) + '</td>' +
        '<td>' + (n ? '<span class="qb-pill qb-pill-ok">' + n + ' cheaper</span>' : '<span class="qb-pill qb-pill-mut">none</span>') + '</td>' +
        '<td><button class="qb-x" data-drop="' + idx + '" title="Remove">✕</button></td>';
      tb.appendChild(tr);
    });
    $('panelEmpty').hidden = review.panels.length > 0;
    $('panelTable').hidden = review.panels.length === 0;
    updateResidual();
  }
  function updateResidual() {
    var panelCost = review.panels.reduce(function (s, r) { return s + r.qty * r.panel.perPanel; }, 0);
    var resid = (review.subtotal || 0) - panelCost;
    var withCheaper = review.panels.filter(function (r) { return r.cheaper.length; }).length;
    // Layer-2 guard: the four amounts MUST satisfy  subtotal + taxes − discount = total.
    var identityOff = (review.subtotal && review.total) &&
      (review.subtotal + review.taxes - review.total < 0 || review.subtotal + review.taxes - review.total > review.subtotal);
    var numbersBad = review.numbersOk === false || identityOff;
    $('residual').innerHTML =
      (numbersBad ? '<div class="qb-warn qb-warn-strong">⚠ Numbers don\'t add up — the reader may have mis-read a figure. Please check Sub&nbsp;total, Taxes &amp; Total above before generating.</div>' : '') +
      '<div class="qb-label" style="margin:0 0 6px">Sanity check</div>' +
      'Panels added: <b>' + review.panels.length + '</b> · with cheaper option: <b>' + withCheaper + '</b><br>' +
      'Catalog panel cost: <b>' + rupee(panelCost) + '</b> · implied accessories: <b class="' + (resid < 0 ? 'qb-neg' : '') + '">' + rupee(resid) + '</b>' +
      (resid < 0 ? '<div class="qb-warn">⚠ Negative — check quantities or subtotal.</div>' : '') +
      (review.panels.length && !withCheaper ? '<div class="qb-warn">No added panel has a cheaper look-alike — no quotes will generate.</div>' : '');
  }

  // ---- autocomplete ----
  function runAutocomplete(q) {
    var list = $('acList');
    q = norm(q);
    if (!q) { list.hidden = true; return; }
    var hits = CATALOG.filter(function (p) {
      return norm(p.name + ' ' + p.code + ' ' + p.material + ' ' + (p.search || '')).indexOf(q) >= 0;
    }).slice(0, 8);
    if (!hits.length) { list.innerHTML = '<div class="qb-ac-none">No match in catalog</div>'; list.hidden = false; return; }
    list.innerHTML = '';
    hits.forEach(function (p) {
      var n = (p.alternatives || []).filter(function (a) { return a.isCheaper && a.perPanel; }).length;
      var item = el('div', 'qb-ac-item');
      item.innerHTML =
        '<span class="qb-ac-thumb">' + (p.image ? '<img loading="lazy" src="' + esc(p.image) + '">' : '') + '</span>' +
        '<span class="qb-ac-body"><b>' + esc(p.name) + '</b><span class="qb-cellsub">' + esc(p.code) + ' · ' + esc(p.material) + ' · ' + rupee(p.perPanel) + '</span></span>' +
        (n ? '<span class="qb-pill qb-pill-ok">' + n + ' cheaper</span>' : '<span class="qb-pill qb-pill-mut">none</span>');
      item.addEventListener('click', function () { addPanel(p); $('acInput').value = ''; list.hidden = true; });
      list.appendChild(item);
    });
    list.hidden = false;
  }

  // ================= RESULTS UI =================
  function renderResults(quotes) {
    hide('dropState'); hide('buildState'); show('resultState');
    var orig = review.total || (review.subtotal + review.taxes);
    var nSave = quotes.filter(function (q) { return q.price.savedVsOrig > 0; }).length;
    var countTxt = quotes.length + ' option(s) · ' + nSave + ' save money';
    if (lastQuoteTotal > quotes.length) countTxt = 'top ' + quotes.length + ' of ' + lastQuoteTotal + ' combinations · ' + nSave + ' save money';
    $('resultMeta').innerHTML = (review.customer ? '<b>' + esc(review.customer) + '</b> · ' : '') +
      'Original total <b>' + rupee(orig) + '</b> · ' + countTxt;
    var grid = $('quoteGrid'); grid.innerHTML = '';
    if (!quotes.length) {
      show('noQuotes');
      $('noQuotes').textContent = review.panels.length
        ? 'None of the added panels have a cheaper look-alike in the catalog.'
        : 'Add at least one panel to generate quotes.';
      return;
    }
    hide('noQuotes');
    quotes.forEach(function (q) {
      var searchStr = q.swaps.map(function (s) { return [s.row.panel.name, s.row.panel.code, s.row.panel.material, s.alt.name, s.alt.code].join(' '); }).join(' ').toLowerCase();
      var saved = q.price.savedVsOrig, isSave = saved > 0;
      var card = el('div', 'qb-card' + (isSave ? '' : ' qb-card-prem')); card.setAttribute('data-search', searchStr);
      card.innerHTML =
        '<div class="qb-card-top">' +
          '<span class="qb-card-kicker">' + (q.swaps.length === 1 ? '1 panel swapped' : q.swaps.length + ' panels swapped') + '</span>' +
          (isSave ? '<span class="qb-saved">▼ ' + rupee(saved) + ' saved</span>'
                  : '<span class="qb-prem">▲ ' + rupee(-saved) + ' more</span>') +
        '</div>' +
        '<div class="qb-card-swaps">' + q.swaps.map(swapCard).join('') + '</div>' +
        '<div class="qb-card-bottom">' +
          '<div class="qb-newtotal"><span class="qb-nt-label">New total</span><span class="qb-nt-val">' + rupee(q.price.total) + '</span></div>' +
          '<div class="qb-was">was ' + rupee(orig) + '</div>' +
          '<div class="qb-viewbtn">View full quote →</div>' +
        '</div>';
      card.addEventListener('click', function () { openQuoteModal(q); });
      grid.appendChild(card);
    });
  }
  // compact swap block for a result card (new panel prominent, original as subtext)
  function swapCard(s) {
    var sim = s.alt.similarity;
    return '<div class="qb-swap2">' +
      '<span class="qb-swap2-imgs">' + thumb(s.row.panel.image, null) + '<span class="qb-arrow">→</span>' + thumb(s.alt.image, sim) + '</span>' +
      '<span class="qb-swap2-info">' +
        '<span class="qb-swap2-new">' + esc(s.alt.name) + ' <span class="qb-sim ' + (sim >= 85 ? 'hi' : 'mid') + '">' + sim + '%</span></span>' +
        '<span class="qb-swap2-old">replaces ' + esc(s.row.panel.name) + ' <span class="qb-mut">×' + s.qtyOrig + '→×' + s.qtyAlt + '</span>' +
          (s.saving > 0 ? '<span class="qb-delta qb-delta-save">▼ ' + rupee(s.saving) + '</span>'
                        : '<span class="qb-delta qb-delta-prem">▲ ' + rupee(-s.saving) + '</span>') + '</span>' +
      '</span>' +
    '</div>';
  }

  // ---- full-quote detail modal (complete itemised quote, swaps highlighted) ----
  function openQuoteModal(q) {
    var swapByCode = {};
    q.swaps.forEach(function (s) { swapByCode[s.row.panel.code] = s; });
    var origDiscount = Math.max(0, review.subtotal + review.taxes - review.total);
    var origPanelCost = review.panels.reduce(function (t, r) { return t + r.qty * r.panel.perPanel; }, 0);
    var accResidual = Math.max(0, review.subtotal - origPanelCost);
    function dimOf(x) { return x && x.dims ? x.dims.raw : '—'; }
    function mthumb(src) { return '<span class="qb-mthumb">' + (src ? '<img loading="lazy" src="' + esc(src) + '">' : '') + '</span>'; }
    function nameCell(inner) { return '<td><div class="qb-mnamecell">' + inner + '</div></td>'; }

    // panel rows (with thumbnails)
    var rows = '';
    review.panels.forEach(function (r) {
      var s = swapByCode[r.panel.code];
      if (s) {
        rows +=
          '<tr class="qb-mrow-orig">' + nameCell(mthumb(r.panel.image) + '<s>' + esc(r.panel.name) + '</s>') +
            '<td>' + esc(dimOf(r.panel)) + '</td><td>×' + s.qtyOrig + '</td><td>' + rupee(r.panel.perPanel) + '</td><td>' + rupee(s.origCost) + '</td></tr>' +
          '<tr class="qb-mrow-new">' + nameCell(mthumb(s.alt.image) + '<span class="qb-swaptag">SWAP →</span> ' + esc(s.alt.name) +
            ' <span class="qb-sim ' + (s.alt.similarity >= 85 ? 'hi' : 'mid') + '">' + s.alt.similarity + '%</span>') +
            '<td>' + esc(dimOf(s.alt)) + '</td><td>×' + s.qtyAlt + '</td><td>' + rupee(s.alt.perPanel) + '</td>' +
            '<td>' + rupee(s.altCost) + ' ' + (s.saving > 0 ? '<span class="qb-delta qb-delta-save">▼ ' + rupee(s.saving) + '</span>' : '<span class="qb-delta qb-delta-prem">▲ ' + rupee(-s.saving) + '</span>') + '</td></tr>';
      } else {
        rows +=
          '<tr>' + nameCell(mthumb(r.panel.image) + esc(r.panel.name) + ' <span class="qb-unchg">unchanged</span>') +
            '<td>' + esc(dimOf(r.panel)) + '</td><td>×' + r.qty + '</td><td>' + rupee(r.panel.perPanel) + '</td><td>' + rupee(r.qty * r.panel.perPanel) + '</td></tr>';
      }
    });

    var accHtml = (review.accessories || []).length
      ? (review.accessories || []).map(function (a) { return '<span class="qb-acc-chip">' + esc(a.name) + ' ×' + a.qty + '</span>'; }).join('')
      : '<span class="qb-mut">none detected</span>';

    var origDiscPct = review.subtotal ? Math.round(origDiscount / review.subtotal * 100) : 0;
    var newDiscPct = Math.round(q.price.discountPct);
    function prow(k, o, n, cls) {
      var chg = (o !== n);
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + esc(k) + '</td><td>' + rupee(o) + '</td>' +
        '<td>' + (chg ? '<b>' + rupee(n) + '</b>' : rupee(n)) + '</td></tr>';
    }
    var discRow =
      '<tr><td>Discount</td>' +
      '<td>' + rupee(origDiscount) + (origDiscount ? ' <span class="qb-mut">(' + origDiscPct + '%)</span>' : '') + '</td>' +
      '<td>' + (q.price.discount ? '<b>' + rupee(q.price.discount) + '</b> <span class="qb-mut">(' + newDiscPct + '%)</span>' : rupee(0)) + '</td></tr>';
    var saved = q.price.savedVsOrig, isSave = saved > 0;

    $('modalBody').innerHTML =
      '<div class="qb-modal-head">' +
        '<div class="qb-modal-headL"><div class="qb-modal-title">' + esc(review.customer || 'Alternative quote') + '</div>' +
        '<div class="qb-modal-sub">' + (q.swaps.length === 1 ? esc(q.swaps[0].row.panel.name + ' → ' + q.swaps[0].alt.name) : 'Swapping ' + q.swaps.length + ' panels') + '</div></div>' +
        '<div class="qb-modal-headR">' +
          '<div class="' + (isSave ? 'qb-saved' : 'qb-prem') + ' qb-modal-badge">' + (isSave ? '▼ ' + rupee(saved) + ' saved' : '▲ ' + rupee(-saved) + ' more') + '</div>' +
          '<div class="qb-modal-nt">New total <b>' + rupee(q.price.total) + '</b> <span class="qb-modal-was">was ' + rupee(review.total || (review.subtotal + review.taxes)) + '</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="qb-modal-sec">Panels <span class="qb-hint">(swapped rows highlighted)</span></div>' +
      '<div class="qb-modal-tablewrap"><table class="qb-modal-table">' +
        '<thead><tr><th>Panel</th><th>Dimensions</th><th>Qty</th><th>₹/panel</th><th>Line total</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' +
      '<div class="qb-modal-sec">Accessories &amp; installation <span class="qb-hint">(unchanged · ' + rupee(accResidual) + ')</span></div>' +
      '<div class="qb-acc-list">' + accHtml + '</div>' +
      '<div class="qb-modal-sec">Pricing <span class="qb-hint">(original → this option)</span></div>' +
      '<div class="qb-modal-tablewrap"><table class="qb-modal-table qb-price-table">' +
        '<thead><tr><th>&nbsp;</th><th>Original</th><th>This quote</th></tr></thead><tbody>' +
        prow('Sub total', review.subtotal, q.price.subtotal) +
        prow('Taxes & fees', review.taxes, q.price.taxes) +
        discRow +
        prow('Total', review.total, q.price.total, 'qb-mrow-total') +
        '</tbody></table></div>';
    $('quoteModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal() { $('quoteModal').hidden = true; document.body.style.overflow = ''; }
  function thumb(src, sim) {
    return '<span class="qb-thumb">' + (src ? '<img loading="lazy" src="' + esc(src) + '">' : '') +
      (sim != null ? '<span class="qb-score ' + (sim >= 85 ? 'hi' : 'mid') + '">' + sim + '%</span>' : '') + '</span>';
  }
  function fl(k, v, cls) { return '<div class="qb-fl' + (cls ? ' ' + cls : '') + '"><span>' + esc(k) + '</span><span>' + v + '</span></div>'; }

  // ================= FLOW =================
  function toBuild() { hide('dropState'); hide('resultState'); show('buildState'); renderPanelTable(); }

  function applyExtraction(parsed) {
    review.customer = parsed.customer || '';
    review.subtotal = parsed.subtotal || 0;
    review.taxes = parsed.taxes || 0;
    review.total = parsed.total || 0;
    review.numbersOk = parsed.reconciled !== false;   // did the amounts add up?
    review.panels = [];
    // dedupe accessories by normalized name (PDFs repeat line items across pages)
    var accSeen = {}; review.accessories = [];
    (parsed.accessories || []).forEach(function (a) {
      var k = norm(a.name); if (accSeen[k]) return; accSeen[k] = 1;
      review.accessories.push(a);
    });

    // Match lines to the catalog. A design's leading code token (e.g. "X905",
    // stripped of the "*" marker) identifies it. Real PANEL lines are matched first;
    // a beading/trim line is only kept if NO real panel already covers that design
    // (so "X905* L Bidding Wood" doesn't spawn a phantom panel next to the real
    // "X905* Small square Wood"). A design present ONLY via its beading (e.g. D164)
    // is still captured, flagged fromBeading so its qty can be verified.
    function leadCode(name) { return (name.split(/\s+/)[0] || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase(); }
    function isBeadingLine(name) { return /bidding|beading|\btrim\b/i.test(name); }
    var byCode = {}, leadSeen = {}, unmatched = [], beadingLines = [];
    parsed.items.forEach(function (it) {
      if (isBeadingLine(it.name)) { beadingLines.push(it); return; }   // defer beadings
      var m = matchPanel(it.name);
      if (!m) { if (unmatched.indexOf(it.name) < 0) unmatched.push(it.name); return; }
      var code = m.panel.code, sc = wordOverlap(it.name, m.panel.name);
      if (!byCode[code] || sc > byCode[code].sc) byCode[code] = { panel: m.panel, qty: it.qty, sc: sc, fromBeading: false };
      leadSeen[leadCode(it.name)] = true;
    });
    beadingLines.forEach(function (it) {
      if (leadSeen[leadCode(it.name)]) return;                          // redundant trim for a real panel
      var m = matchPanel(it.name);
      if (!m) { if (unmatched.indexOf(it.name) < 0) unmatched.push(it.name); return; }
      var code = m.panel.code, sc = wordOverlap(it.name, m.panel.name);
      if (!byCode[code] || sc > byCode[code].sc) byCode[code] = { panel: m.panel, qty: it.qty, sc: sc, fromBeading: true };
      leadSeen[leadCode(it.name)] = true;
    });
    var beadingOnly = [];
    Object.keys(byCode).forEach(function (code) {
      var e = byCode[code];
      addPanel(e.panel);
      var row = review.panels[review.panels.length - 1];
      row.qty = Math.max(1, e.qty || 1);
      row.fromBeading = e.fromBeading;
      if (e.fromBeading) beadingOnly.push(e.panel.name);
    });

    // reflect into edit form
    $('fCustomer').value = review.customer;
    $('fSubtotal').value = review.subtotal || '';
    $('fTaxes').value = review.taxes || '';
    $('fTotal').value = review.total || '';

    return { matched: Object.keys(byCode).length, totalItems: parsed.items.length, unmatched: unmatched, beadingOnly: beadingOnly };
  }

  function handleFile(file) {
    if (!file) return;
    hideBanners();
    showLoading('Loading PDF…');
    file.arrayBuffer().then(function (buf) {
      setLoadingMsg('Rendering pages…');
      return renderPdf(buf);
    }).then(function () {
      setLoadingMsg('Reading quote (free OCR)…');
      return ocrAllPages();
    }).then(function (text) {
      window.QB.lastOcr = text;
      var parsed = parseQuoteText(text);
      applyExtraction(parsed);
      hideLoading();

      // Auto-advance ONLY when data is usable AND the amounts add up. If the numbers
      // don't reconcile, never silently generate — route to the review screen where
      // updateResidual() shows a clear warning for the human to fix first.
      if (review.panels.length && review.subtotal && review.total && review.numbersOk) {
        renderResults(generateQuotes());
      } else {
        toBuild();  // needs a human check/fix
      }
    }).catch(function (e) {
      hideLoading();
      $('dropStatus').textContent = '⚠ Auto-read failed: ' + e.message + ' — add panels manually below.';
      $('dropStatus').className = 'qb-drop-status qb-err';
      toBuild();
    });
  }

  function resetAll() {
    review = { customer: '', subtotal: 0, taxes: 0, total: 0, panels: [], accessories: [], numbersOk: true };
    $('pdfPages').innerHTML = '<div class="qb-pdf-empty">No PDF uploaded — enter details manually on the right.</div>';
    ['fCustomer', 'fSubtotal', 'fTaxes', 'fTotal'].forEach(function (id) { $(id).value = ''; });
    hide('buildState'); hide('resultState'); show('dropState');
    $('dropStatus').textContent = ''; $('dropStatus').className = 'qb-drop-status';
  }

  function wire() {
    var input = $('pdfInput');
    function pick() { input.click(); }
    $('uploadBtn').addEventListener('click', pick);
    $('dropzone').addEventListener('click', pick);
    $('reuploadBtn').addEventListener('click', resetAll);   // "← Back" on review → start over
    $('newQuoteBtn').addEventListener('click', resetAll);   // "⬆ New Quote" on results
    input.addEventListener('change', function () { handleFile(input.files[0]); input.value = ''; });

    var dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); }); });
    dz.addEventListener('drop', function (e) { handleFile(e.dataTransfer.files[0]); });

    $('fCustomer').addEventListener('input', function () { review.customer = this.value; });
    ['fSubtotal', 'fTaxes', 'fTotal'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        review.subtotal = parseInt($('fSubtotal').value || 0, 10);
        review.taxes = parseInt($('fTaxes').value || 0, 10);
        review.total = parseInt($('fTotal').value || 0, 10);
        updateResidual();
      });
    });

    var ac = $('acInput');
    ac.addEventListener('input', function () { runAutocomplete(this.value); });
    ac.addEventListener('focus', function () { if (this.value) runAutocomplete(this.value); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.qb-ac')) $('acList').hidden = true; });

    $('panelTable').addEventListener('input', function (e) {
      var q = e.target.closest('.qb-qty'); if (!q) return;
      review.panels[+q.dataset.i].qty = Math.max(1, parseInt(q.value || 1, 10)); updateResidual();
    });
    $('panelTable').addEventListener('click', function (e) {
      var b = e.target.closest('[data-drop]'); if (!b) return;
      review.panels.splice(+b.getAttribute('data-drop'), 1); renderPanelTable();
    });

    $('generateBtn').addEventListener('click', function () { renderResults(generateQuotes()); });
    $('backToBuild').addEventListener('click', function () { toBuild(); });

    $('modalClose').addEventListener('click', closeModal);
    $('modalBackdrop').addEventListener('click', closeModal);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    // Pre-warm the OCR engine in the background so the first upload is instant
    // (the ~6MB core + language data downloads/compiles once, up front).
    if (window.Tesseract) getWorker().catch(function () {});
  }

  // ---------- debug hook ----------
  window.QB = {
    get review() { return review; }, set review(v) { review = v; },
    get catalog() { return CATALOG; },
    loadCatalog: loadCatalog, addPanel: addPanel, generateQuotes: generateQuotes,
    priceQuote: priceQuote, computeSwap: computeSwap, bestSwap: bestSwap,
    renderResults: renderResults, toBuild: toBuild, renderPanelTable: renderPanelTable,
    renderPdf: renderPdf, ocrAllPages: ocrAllPages, parseQuoteText: parseQuoteText,
    applyExtraction: applyExtraction, matchPanel: matchPanel
  };

  loadCatalog().then(wire).catch(function (e) {
    document.querySelector('main').innerHTML = '<div class="qb-empty">Failed to load catalog: ' + e.message + '</div>';
  });
})();
