(function () {
  'use strict';

  var CITY = (new URLSearchParams(location.search).get('city') || 'delhi').toLowerCase();
  var CITY_NAMES = { delhi: 'Delhi', mumbai: 'Mumbai', bengaluru: 'Bengaluru', hyderabad: 'Hyderabad' };
  var ALL_PANELS = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function rupee(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }

  function diffClass(alt) {
    if (alt.isCheaper) return 'chp';
    if (String(alt.diff).charAt(0) === '▲') return 'prem';
    return '';
  }

  function renderAlt(a) {
    return '<div class="card' + (a.isCheaper ? ' is-cheaper' : '') + '">' +
      '<div class="imgwrap">' +
        '<img loading="lazy" src="' + esc(a.image) + '" onerror="this.style.opacity=0.2">' +
        '<div class="score ' + esc(a.scoreClass) + '">' + a.similarity + '%</div>' +
      '</div>' +
      '<div class="body">' +
        '<div class="name">' + esc(a.name) + '</div>' +
        '<div class="code">' + esc(a.code) + '</div>' +
        '<div class="meta">' + esc(a.material) + '</div>' +
        '<div class="meta">' + esc((a.dims || {}).raw || '') + '</div>' +
        '<div class="psfline">' + rupee(a.psf) + ' <span class="psfu">/ sq.ft</span></div>' +
        '<div class="pricerow"><span class="price">' + rupee(a.perPanel) + '</span>' +
        '<span class="diff ' + diffClass(a) + '">' + esc(a.diff) + '</span></div>' +
      '</div>' +
    '</div>';
  }

  function renderPanel(p) {
    var html =
      '<section class="row" data-search="' + esc(p.search) + '" data-cheaper="' + (p.cheaperCount || 0) + '">' +
      '<div class="selcard">' +
        '<div class="selimg"><img loading="lazy" src="' + esc(p.image) + '" onerror="this.style.opacity=0.2"></div>' +
        '<div class="selbody">' +
          '<div class="seltag">SELECTED</div>' +
          '<div class="selname">' + esc(p.name) + '</div>' +
          '<div class="code">' + esc(p.code) + '</div>' +
          '<div class="meta">' + esc(p.material) + '</div>' +
          '<div class="meta">' + esc((p.dims || {}).raw || '') + '</div>' +
          '<div class="psfline">' + rupee(p.psf) + ' <span class="psfu">/ sq.ft</span></div>' +
          '<div class="selprice">' + rupee(p.perPanel) +
            '<span class="psf"> ' + (CITY_NAMES[CITY] || CITY) + ' · per panel</span>' +
          '</div>' +
        '</div>' +
      '</div>';

    if (!p.alternatives || p.alternatives.length === 0) {
      html += '<div class="nomatch">Unique design — no visually similar panel found.</div>';
    } else {
      html += '<div class="railwrap"><div class="rail" tabindex="0">' +
        p.alternatives.map(renderAlt).join('') +
      '</div></div>';
    }

    return html + '</section>';
  }

  function applyFilter() {
    var q         = document.getElementById('q').value.trim().toLowerCase();
    var cheapOnly = document.getElementById('cheapOnly').checked;
    var rows      = document.querySelectorAll('#catalog .row');
    var visible   = 0;
    rows.forEach(function (row) {
      var ok = (!q || row.dataset.search.indexOf(q) >= 0) &&
               (!cheapOnly || parseInt(row.dataset.cheaper) > 0);
      row.style.display = ok ? '' : 'none';
      if (ok) visible++;
    });
    document.getElementById('resCount').textContent = visible + ' of ' + rows.length + ' panels';
  }

  function setCity(city) {
    CITY = city;

    document.querySelectorAll('.city-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.city === city);
    });
    var ql = document.getElementById('quoteLink');
    if (ql) ql.href = 'quote.html?city=' + city;

    var wrap = document.getElementById('catalog');
    wrap.innerHTML = '<div class="qb-empty" style="padding:60px 0">Loading ' + (CITY_NAMES[city] || city) + '…</div>';
    document.getElementById('resCount').textContent = '';

    fetch('assets/data/' + city + '.json')
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        ALL_PANELS = data.panels || [];
        wrap.innerHTML = ALL_PANELS.map(renderPanel).join('');
        history.replaceState(null, '', '?city=' + city);
        applyFilter();
      })
      .catch(function (e) {
        wrap.innerHTML = '<div class="qb-empty">Failed to load ' + city + ' catalog: ' + e.message + '</div>';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.city-tab').forEach(function (tab) {
      tab.addEventListener('click', function (e) {
        e.preventDefault();
        setCity(tab.dataset.city);
      });
    });
    document.getElementById('q').addEventListener('input', applyFilter);
    document.getElementById('cheapOnly').addEventListener('change', applyFilter);
    setCity(CITY);
  });
})();
