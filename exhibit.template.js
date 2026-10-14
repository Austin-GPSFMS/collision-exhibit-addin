/* global */
/**
 * Collision Telemetry Exhibit — print document builder.
 * CollisionExhibit.build(model, assets) → self-contained HTML (letter, GPSFMS brand).
 * Generated from exhibit.template.js by tools/build.py (injects the logo).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CollisionExhibit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LOGO = 'data:image/png;base64,__LOGO_B64__';
  var COMPANY = 'GPS Fleet Management Solutions · 315 Hwy 70 East, Suite E — Garner, NC 27529 · www.gpsfms.com · Geotab Authorized Partner & Reseller';

  function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function para(s) { return esc(s).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>'); }

  var CSS = [
    '@import url("https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap");',
    '@page { size: letter; margin: 0.55in 0.55in 0.75in 0.55in; }',
    '* { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; }',
    'body { font-family: Roboto, Arial, Helvetica, sans-serif; color: #1C2B39; font-size: 10.5pt; line-height: 1.35; background: #fff; }',
    '.page { max-width: 7.4in; margin: 0 auto; padding: 24px 0 60px; }',
    '@media screen { body { background: #e9ecef; } .page { background: #fff; padding: 40px 48px 80px; margin: 24px auto; box-shadow: 0 2px 12px rgba(0,0,0,.15); max-width: 8.5in; } }',
    '.toolbar { position: fixed; top: 12px; right: 12px; z-index: 9; display: flex; gap: 8px; }',
    '.toolbar button { font: 600 13px Roboto, Arial; padding: 8px 14px; border-radius: 4px; border: 1px solid #25477B; background: #25477B; color: #fff; cursor: pointer; }',
    '.toolbar button.secondary { background: #fff; color: #25477B; }',
    '@media print { .toolbar { display: none; } .page { padding: 0; } }',
    '.titlebar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }',
    '.titlebar h1 { font-size: 22pt; color: #25477B; margin: 0; font-weight: 700; }',
    '.titlebar img { height: 0.62in; }',
    'h2.sub { color: #0084C2; font-size: 12.5pt; margin: 4px 0 8px; font-weight: 700; }',
    'h2.sec { color: #25477B; font-size: 14pt; margin: 18px 0 6px; font-weight: 700; break-after: avoid; }',
    'table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }',
    'table.kv td { border: 1px solid #d9dee5; padding: 4px 8px; vertical-align: top; }',
    'table.kv td:first-child { width: 1.55in; background: #F4F4F4; color: #374151; }',
    'table.grid th { background: #25477B; color: #fff; text-align: left; padding: 4px 8px; font-weight: 700; }',
    'table.grid td { border-bottom: 1px solid #e1e5ea; padding: 4px 8px; vertical-align: top; }',
    'table.grid tr:nth-child(even) td { background: #F7F8FA; }',
    'table.tl td:first-child { width: 1.05in; font-weight: 500; white-space: nowrap; border-left: 3px solid #0084C2; }',
    'table.tl tr.impact td:first-child { border-left-color: #b3261e; font-weight: 700; }',
    'table.tl tr.rest td:first-child, table.tl tr.post td:first-child { border-left-color: #25477B; }',
    'table.mono td { font-variant-numeric: tabular-nums; }',
    'p { margin: 4px 0 8px; text-align: justify; }',
    'p.cap { font-size: 8.5pt; color: #374151; margin: 4px 0 10px; text-align: left; }',
    'figure { margin: 6px 0 4px; break-inside: avoid; }',
    'figure img { width: 100%; display: block; border: 1px solid #d9dee5; }',
    '.figrow { display: flex; gap: 14px; align-items: flex-start; break-inside: avoid; }',
    '.figrow figure { flex: 1 1 0; }',
    '.figrow figcaption { font-size: 8.5pt; color: #374151; margin-bottom: 4px; }',
    '.figrow figcaption.red { color: #b3261e; }',
    '.footer { font-size: 8pt; color: #4b5563; border-top: 1px solid #25477B; padding-top: 4px; margin-top: 24px; }',
    'table.pagewrap { width: 100%; border-collapse: collapse; }',
    'table.pagewrap > tbody > tr > td, table.pagewrap > tfoot > tr > td { padding: 0; border: 0; }',
    'table.pagewrap > tfoot { display: table-footer-group; }',
    '@media print { .page { padding: 0; } .footer { margin-top: 10px; } }',
    '.avoid { break-inside: avoid; }',
    '.warn { background: #fff7e6; border: 1px solid #f1d8a3; padding: 6px 10px; font-size: 9pt; }',
    'tr { break-inside: avoid; }'
  ].join('\n');

  function build(m, a) {
    var r = m.result, H = r.header, F = r.format, t = m.texts || {}, inp = m.inputs || {};
    var tzLine = 'Prepared from unaltered MyGeotab system records. Times shown in local ' + r.tzLong + ' (' + r.timeZone + ').';
    var out = [];
    out.push('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Collision Telemetry Exhibit — ' + esc(m.bundle.meta.deviceName) + ' — ' + esc(F.iso(r.eventTime).slice(0, 10)) + '</title><style>' + CSS + '</style></head><body>');
    out.push('<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button><button class="secondary" onclick="window.close()">Close</button></div>');
    out.push('<div class="page"><table class="pagewrap"><tbody><tr><td>');
    out.push('<div class="titlebar"><h1>Collision Telemetry Exhibit</h1><img src="' + a.logo + '" alt="GPS Fleet Management Solutions"></div>');
    out.push('<h2 class="sub">' + esc(H.title) + '</h2>');

    // header table
    var kv = [
      ['Collision detection', H.collisionDetection], ['Vehicle', H.vehicle + (inp.vehicleDescription && H.vehicle.indexOf(inp.vehicleDescription) < 0 ? ' — ' + inp.vehicleDescription : '')],
      ['Driver', H.driver], ['Trip', H.trip], ['Location', H.location], ['Reported event', H.reportedEvent], ['Conditions', H.conditions],
      ['Speed', H.speed], ['Data sources', H.dataSources], ['Prepared', H.prepared]
    ].filter(function (x) { return x[1]; });
    if (m.client) kv.splice(1, 0, ['Client', m.client]);
    out.push('<table class="kv">' + kv.map(function (x) { return '<tr><td>' + esc(x[0]) + '</td><td>' + esc(x[1]) + '</td></tr>'; }).join('') + '</table>');

    // discrepancy
    if (t.discrepancy && t.discrepancy.trim()) {
      out.push('<h2 class="sec">Point-of-Impact Discrepancy — Reconstruction vs. Physical Evidence</h2><p>' + para(t.discrepancy) + '</p>');
      var figs = [];
      if (a.reconImg) figs.push('<figure><figcaption class="red">Geotab reconstruction — point of impact as depicted' + (inp.reconDepicts ? ' (' + esc(inp.reconDepicts) + ')' : '') + '; estimate from the trigger-time accelerometer sample, contradicted above</figcaption><img src="' + a.reconImg + '"></figure>');
      var firstPhoto = (a.photos || [])[0];
      if (firstPhoto) figs.push('<figure><figcaption>' + esc(firstPhoto.caption || 'Scene photograph') + (firstPhoto.lat != null ? ' (GPS-stamped ' + firstPhoto.lat.toFixed(6) + ', ' + firstPhoto.lon.toFixed(6) + ')' : '') + '</figcaption><img src="' + firstPhoto.dataUrl + '"></figure>');
      if (figs.length) out.push('<div class="figrow">' + figs.join('') + '</div>');
    }

    // timeline
    out.push('<h2 class="sec">Event Timeline</h2><table class="grid tl">' + (m.timeline || []).map(function (row) {
      return '<tr class="' + esc(row.kind || '') + '"><td>' + esc(row.label) + '</td><td>' + esc(row.text) + '</td></tr>';
    }).join('') + '</table>');

    // pulse chart
    if (a.pulseChart) {
      out.push('<div class="avoid"><h2 class="sec">Impact Pulse — ' + (r.pulse.found ? 'High-Rate Accelerometer Capture' : 'Accelerometer Samples Near the Event') + '</h2><figure><img src="' + a.pulseChart + '"></figure><p class="cap">' + esc(t.pulseCaption) + '</p></div>');
    }
    if (a.speedChart) {
      out.push('<div class="avoid"><h2 class="sec">Speed Profile — Final Approach (GPS-logged' + (r.buffer ? ', 1 Hz forensic buffer' : '') + ')</h2><figure><img src="' + a.speedChart + '"></figure><p class="cap">' + esc(t.speedCaption) + '</p></div>');
    }

    // map
    out.push('<div class="avoid"><h2 class="sec">Collision Site — Satellite View</h2>');
    if (a.map) out.push('<figure><img src="' + a.map + '"></figure><p class="cap">' + esc(t.mapCaption) + '</p>');
    else out.push('<div class="warn">Map image unavailable — the tile server blocked canvas export in this browser. Use the “Map image override” field in the add-in to supply a Trips History screenshot.</div>');
    out.push('</div>');

    // summary
    out.push('<h2 class="sec">Device Event Log Summary</h2><table class="grid"><tr><th style="width:2in">Metric</th><th>' + esc(m.bundle.meta.deviceName) + ' recorded value</th></tr>' +
      (m.summary || []).map(function (s) { return '<tr><td>' + esc(s[0]) + '</td><td>' + esc(s[1]) + '</td></tr>'; }).join('') + '</table>');

    // further photos
    var rest = (a.photos || []).slice(t.discrepancy && t.discrepancy.trim() ? 1 : 0);
    if (rest.length) {
      out.push('<h2 class="sec">Scene Photographs</h2>');
      for (var i = 0; i < rest.length; i += 2) {
        out.push('<div class="figrow">' + rest.slice(i, i + 2).map(function (p) { return '<figure><figcaption>' + esc(p.caption || 'Scene photograph') + (p.time ? ' — ' + esc(p.time) : '') + (p.lat != null ? ' (GPS-stamped ' + p.lat.toFixed(6) + ', ' + p.lon.toFixed(6) + ')' : '') + '</figcaption><img src="' + p.dataUrl + '"></figure>'; }).join('') + '</div>');
      }
    }

    // appendix
    if (r.appendix && r.appendix.length) {
      out.push('<h2 class="sec">Appendix — Forensic GPS Buffer, ' + esc(F.clock(r.buffer.start)) + '–' + esc(F.clock(r.buffer.end)) + ' ' + esc(r.tzAbbrev) + ' (1-second accident log)</h2>');
      out.push('<table class="grid mono"><tr><th>Time (' + esc(r.tzAbbrev) + ')</th><th>Speed (mph)</th><th>Latitude</th><th>Longitude</th><th>Note</th></tr>' +
        r.appendix.map(function (x) { return '<tr><td>' + esc(x.clock) + '</td><td>' + (x.mph != null ? x.mph.toFixed(1) : '') + '</td><td>' + x.lat.toFixed(5) + '</td><td>' + x.lon.toFixed(5) + '</td><td>' + esc(x.note) + '</td></tr>'; }).join('') + '</table>');
    }
    out.push('<p class="cap">' + esc(t.source) + '</p>');
    out.push('</td></tr></tbody><tfoot><tr><td><div class="footer">' + esc(COMPANY) + '<br>' + esc(tzLine) + '</div></td></tr></tfoot></table></div></body></html>');
    return out.join('\n');
  }

  return { build: build, LOGO: LOGO };
});
