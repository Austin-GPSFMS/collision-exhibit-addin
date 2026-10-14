/* global geotab, L, Chart, XLSX, CollisionAnalysis, CollisionExhibit, CameraServices */
/**
 * MyGeotab Add-In: Collision Telemetry Exhibit
 *
 * Pulls the GO device's own records for a window around an incident
 * (LogRecord, StatusData, FaultData, DebugData, Trip, DriverChange,
 * ExceptionEvent), runs the analysis engine (analysis.js), shows the result on
 * a satellite map with charts and editable tables, and exports the GPSFMS
 * branded exhibit (exhibit.js) as a print-ready page.
 */
geotab.addin.collisionExhibit = function () {
  'use strict';

  var KM_PER_MILE = 1.609344;
  var MS2_PER_G = 9.80665;
  var ACCEL_DIAG = {
    DiagnosticAccelerationForwardBrakingId: 'fwd',
    DiagnosticAccelerationSideToSideId: 'lat',
    DiagnosticAccelerationUpDownId: 'vert'
  };
  var TZ_LIST = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax', 'UTC'];
  var TILE_SAT = { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Imagery © Esri, Maxar, Earthstar Geographics' };
  var TILE_REF = { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', attr: '' };
  var TILE_STREET = { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© OpenStreetMap contributors' };

  // ---------- state ----------
  var api, elAddin, session = {};
  var deviceCache = [];
  var state = resetState();
  var map, mapLayers = {}, charts = {};

  function resetState() {
    return {
      bundle: null, inputs: { timeZone: null, addresses: {} }, result: null,
      edits: { timeline: null, summary: null, texts: {} },
      photos: [], reconImg: null, mapOverride: null, client: ''
    };
  }

  // ---------- small helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function showError(msg) { var e = $('cx-error'); e.style.display = msg ? '' : 'none'; e.textContent = msg || ''; }
  function setLoading(msg) { var e = $('cx-loading'); e.style.display = msg ? '' : 'none'; e.textContent = msg || ''; }
  function call(method, params) {
    return new Promise(function (res, rej) { api.call(method, params, res, rej); });
  }
  function multi(calls) { return new Promise(function (res, rej) { api.multiCall(calls, res, rej); }); }
  function tryCall(method, params, fallback) { return call(method, params).catch(function () { return fallback; }); }
  function iso(ms) { return new Date(ms).toISOString(); }
  function readFileAsDataUrl(file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(file); }); }
  function readFileAsArrayBuffer(file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(file); }); }
  function download(name, content, type) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: type || 'application/octet-stream' });
    var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  /** Local wall-clock (date 'YYYY-MM-DD', time 'HH:MM[:SS]') in an IANA zone → epoch ms. */
  function localToEpoch(dateStr, timeStr, tz) {
    if (!dateStr || !timeStr) return null;
    var p = dateStr.split('-').map(Number), q = timeStr.split(':').map(Number);
    var guess = Date.UTC(p[0], p[1] - 1, p[2], q[0], q[1], q[2] || 0);
    // iterate: offset(tz, guess) so that formatting guess-offset in tz gives the wall clock
    for (var i = 0; i < 3; i++) {
      var off = tzOffsetMs(tz, guess);
      var next = Date.UTC(p[0], p[1] - 1, p[2], q[0], q[1], q[2] || 0) - off;
      if (next === guess) break; guess = next;
    }
    return guess;
  }
  function tzOffsetMs(tz, ms) {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var o = {}; f.formatToParts(new Date(ms)).forEach(function (x) { o[x.type] = x.value; });
    var asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour === 24 ? 0 : +o.hour, +o.minute, +o.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }
  function epochToLocalParts(ms, tz) {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var o = {}; f.formatToParts(new Date(ms)).forEach(function (x) { o[x.type] = x.value; });
    return { date: o.year + '-' + o.month + '-' + o.day, time: (o.hour === '24' ? '00' : o.hour) + ':' + o.minute + ':' + o.second };
  }

  // ---------- session / devices ----------
  function loadSession() {
    return new Promise(function (resolve) {
      api.getSession(function (s, server) {
        session = s || {};
        if (server && !session.path) session.path = server;
        try { CameraServices.init(session); } catch (e) { /* no camera access */ }
        call('Get', { typeName: 'User', search: { name: session.userName }, resultsLimit: 1 }).then(function (users) {
          var u = users && users[0];
          session.timeZone = (u && u.timeZoneId) || Intl.DateTimeFormat().resolvedOptions().timeZone;
          resolve(session);
        }).catch(function () { session.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; resolve(session); });
      });
    });
  }
  function loadDevices() {
    return call('Get', { typeName: 'Device', resultsLimit: 10000 }).then(function (devices) {
      deviceCache = (devices || []).filter(function (d) { return d.id !== 'NoDeviceId'; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      populateDevices('');
    });
  }
  function populateDevices(filter) {
    var sel = $('cx-device'), f = (filter || '').toLowerCase(), cur = sel.value;
    var list = deviceCache.filter(function (d) { return !f || (d.name || '').toLowerCase().indexOf(f) >= 0 || (d.serialNumber || '').toLowerCase().indexOf(f) >= 0 || (d.vehicleIdentificationNumber || '').toLowerCase().indexOf(f) >= 0; });
    sel.innerHTML = '<option value="">— select vehicle (' + list.length + ') —</option>' + list.slice(0, 2000).map(function (d) {
      return '<option value="' + esc(d.id) + '">' + esc(d.name) + (d.vehicleIdentificationNumber ? ' · ' + esc(d.vehicleIdentificationNumber) : '') + '</option>';
    }).join('');
    if (cur && list.some(function (d) { return d.id === cur; })) sel.value = cur;
  }
  function populateTz(def) {
    var sel = $('cx-tz'), list = TZ_LIST.slice();
    if (def && list.indexOf(def) < 0) list.unshift(def);
    sel.innerHTML = list.map(function (z) { return '<option value="' + z + '">' + z + '</option>'; }).join('');
    sel.value = def || 'America/New_York';
  }

  // ---------- API fetch + normalize ----------
  function fetchBundle(deviceId, fromMs, toMs, tz) {
    var dev = deviceCache.filter(function (d) { return d.id === deviceId; })[0] || { id: deviceId, name: deviceId };
    var ds = { deviceSearch: { id: deviceId }, fromDate: iso(fromMs), toDate: iso(toMs) };
    setLoading('Fetching GPS log, status data, faults, trips…');
    return multi([
      ['Get', { typeName: 'LogRecord', search: ds, resultsLimit: 100000 }],
      ['Get', { typeName: 'StatusData', search: ds, resultsLimit: 100000 }],
      ['Get', { typeName: 'FaultData', search: ds, resultsLimit: 10000 }],
      ['Get', { typeName: 'Trip', search: { deviceSearch: { id: deviceId }, fromDate: iso(fromMs - 6 * 3600000), toDate: iso(toMs) }, resultsLimit: 1000 }]
    ]).then(function (r) {
      var logs = r[0] || [], status = r[1] || [], faults = r[2] || [], trips = r[3] || [];
      // optional entity types (permission-dependent) fetched individually so one failure doesn't sink the batch
      return Promise.all([
        tryCall('Get', { typeName: 'DebugData', search: ds, resultsLimit: 50000 }, []),
        tryCall('Get', { typeName: 'DriverChange', search: ds, resultsLimit: 1000 }, []),
        tryCall('Get', { typeName: 'ExceptionEvent', search: ds, resultsLimit: 5000 }, [])
      ]).then(function (opt) {
        return resolveNames(status, faults, trips, opt[1], opt[2]).then(function (names) {
          return normalizeApiData(dev, logs, status, faults, trips, opt[0], opt[1], opt[2], names, fromMs, toMs, tz);
        });
      });
    });
  }

  /** Resolve Diagnostic / Controller / FailureMode / User / Rule names for the ids seen. */
  function resolveNames(status, faults, trips, driverChanges, exceptions) {
    setLoading('Resolving diagnostic and driver names…');
    var ids = { Diagnostic: {}, Controller: {}, FailureMode: {}, User: {}, Rule: {} };
    status.forEach(function (s) { if (s.diagnostic && s.diagnostic.id) ids.Diagnostic[s.diagnostic.id] = 1; });
    faults.forEach(function (f) {
      if (f.diagnostic && f.diagnostic.id) ids.Diagnostic[f.diagnostic.id] = 1;
      if (f.controller && f.controller.id) ids.Controller[f.controller.id] = 1;
      if (f.failureMode && f.failureMode.id) ids.FailureMode[f.failureMode.id] = 1;
    });
    trips.forEach(function (t) { if (t.driver && t.driver.id && t.driver.id !== 'UnknownDriverId') ids.User[t.driver.id] = 1; });
    (driverChanges || []).forEach(function (d) { if (d.driver && d.driver.id && d.driver.id !== 'UnknownDriverId') ids.User[d.driver.id] = 1; });
    (exceptions || []).forEach(function (e) { if (e.rule && e.rule.id) ids.Rule[e.rule.id] = 1; });
    var calls = [], keys = [];
    Object.keys(ids).forEach(function (type) {
      Object.keys(ids[type]).forEach(function (id) { calls.push(['Get', { typeName: type, search: { id: id }, resultsLimit: 1 }]); keys.push([type, id]); });
    });
    var names = { Diagnostic: {}, Controller: {}, FailureMode: {}, User: {}, Rule: {} };
    if (!calls.length) return Promise.resolve(names);
    // chunk to keep multiCall payloads reasonable
    var chunks = []; for (var i = 0; i < calls.length; i += 100) chunks.push([calls.slice(i, i + 100), keys.slice(i, i + 100)]);
    return chunks.reduce(function (p, ch) {
      return p.then(function () {
        return multi(ch[0]).then(function (res) {
          res.forEach(function (arr, j) {
            var ent = arr && arr[0]; if (!ent) return;
            var k = ch[1][j];
            names[k[0]][k[1]] = k[0] === 'User' ? ((ent.firstName || '') + ' ' + (ent.lastName || '')).trim() || ent.name
              : { name: ent.name, unit: ent.unitOfMeasure && ent.unitOfMeasure.id, code: ent.code };
          });
        }).catch(function () { /* name resolution is best-effort */ });
      });
    }, Promise.resolve()).then(function () { return names; });
  }

  function normalizeApiData(dev, logs, status, faults, trips, debug, driverChanges, exceptions, names, fromMs, toMs, tz) {
    var gps = logs.map(function (l) {
      return { t: Date.parse(l.dateTime), lat: l.latitude, lon: l.longitude, mph: l.speed != null ? l.speed / KM_PER_MILE : null, reason: null };
    }).sort(function (a, b) { return a.t - b.t; });

    var accel = [], st = [], ignition = [];
    // unit detection for accelerometer diagnostics: API returns m/s² for the acceleration
    // diagnostics on most databases; verify from the diagnostic's unitOfMeasure and, failing
    // that, from the vertical axis magnitude (≈9.8 → m/s², ≈1.0 → g).
    var vertRaw = status.filter(function (s) { return s.diagnostic && s.diagnostic.id === 'DiagnosticAccelerationUpDownId'; }).map(function (s) { return Math.abs(s.data); }).sort(function (a, b) { return a - b; });
    var vertMed = vertRaw.length ? vertRaw[Math.floor(vertRaw.length / 2)] : null;
    var unitInfo = names.Diagnostic.DiagnosticAccelerationUpDownId || {};
    var accelDivisor = /MetersPerSecondSquared|m\/s/i.test(unitInfo.unit || '') ? MS2_PER_G
      : /GForce|g-force/i.test(unitInfo.unit || '') ? 1
      : (vertMed != null && vertMed > 5 && vertMed < 15) ? MS2_PER_G : 1;

    status.forEach(function (s) {
      var id = s.diagnostic && s.diagnostic.id, t = Date.parse(s.dateTime);
      if (ACCEL_DIAG[id]) { accel.push({ t: t, axis: ACCEL_DIAG[id], g: s.data / accelDivisor }); return; }
      if (id === 'DiagnosticIgnitionId') { ignition.push({ t: t, on: !!s.data }); }
      var meta = names.Diagnostic[id] || {}; var name = meta.name || id, unit = meta.unit || '', val = s.data;
      if (id === 'DiagnosticEngineRoadSpeedId' || /KilometersPerHour/i.test(unit)) { val = val / KM_PER_MILE; unit = 'mph'; }
      st.push({ t: t, name: name, id: id, value: val, unit: unit });
    });
    // collapse ignition to transitions
    ignition.sort(function (a, b) { return a.t - b.t; });
    var ignT = []; ignition.forEach(function (x) { if (!ignT.length || ignT[ignT.length - 1].on !== x.on) ignT.push(x); });

    var fl = faults.map(function (f) {
      var id = f.diagnostic && f.diagnostic.id, meta = names.Diagnostic[id] || {};
      return { t: Date.parse(f.dateTime), name: meta.name || id, diagId: id,
        controller: f.controller && (names.Controller[f.controller.id] || {}).name || null,
        failureMode: f.failureMode && (names.FailureMode[f.failureMode.id] || {}).name || null,
        faultState: f.faultState || null };
    });
    var dbg = (debug || []).map(function (d) { return { t: Date.parse(d.dateTime), reason: d.debugReason || d.reason || '' }; })
      .filter(function (d) { return d.reason && !/^\d+$/.test(d.reason); });
    var tr = trips.map(function (t) {
      return { start: Date.parse(t.start), stop: t.stop ? Date.parse(t.stop) : null, nextTripStart: t.nextTripStart ? Date.parse(t.nextTripStart) : null,
        distanceMi: t.distance != null ? t.distance / KM_PER_MILE : null, maxSpeedMph: t.maxSpeed != null ? t.maxSpeed / KM_PER_MILE : null,
        driverName: t.driver && t.driver.id && names.User[t.driver.id] || null,
        stopLat: t.stopPoint && t.stopPoint.y, stopLon: t.stopPoint && t.stopPoint.x };
    });
    var dc = (driverChanges || []).map(function (d) { return { t: Date.parse(d.dateTime), type: d.type, driverName: d.driver && names.User[d.driver.id] || null }; });
    var ex = (exceptions || []).map(function (e) { return { id: e.id, t: Date.parse(e.activeFrom), end: e.activeTo ? Date.parse(e.activeTo) : null, ruleName: e.rule && (names.Rule[e.rule.id] || {}).name || (e.rule && e.rule.id) }; });

    return {
      source: 'api',
      meta: {
        deviceName: dev.name, deviceId: dev.id, serialNumber: dev.serialNumber || null,
        vin: dev.vehicleIdentificationNumber || dev.engineVehicleIdentificationNumber || null,
        vehicleDescription: null, deviceGroups: (dev.groups || []).map(function (g) { return g.id; }).join(', '),
        company: session.database || null, timeZone: tz, from: fromMs, to: toMs,
        accelUnitDetected: accelDivisor === 1 ? 'g' : 'm/s² (converted to g)'
      },
      gps: gps, accel: accel, status: st, faults: fl, debug: dbg, ignition: ignT, trips: tr, driverChanges: dc, exceptions: ex
    };
  }

  // ---------- xlsx import (Advanced Log Data & Collisions Report) ----------
  var POSIX_TZ = { CST6CDT: 'America/Chicago', EST5EDT: 'America/New_York', MST7MDT: 'America/Denver', PST8PDT: 'America/Los_Angeles', EST: 'America/New_York', CST: 'America/Chicago', MST: 'America/Phoenix', PST: 'America/Los_Angeles' };
  var XLSX_AXIS = { 'Acceleration forward or braking': 'fwd', 'Acceleration side to side': 'lat', 'Acceleration up or down': 'vert' };
  function normalizeXlsx(buf) {
    var wb = XLSX.read(buf, { type: 'array', cellDates: false });
    var ws = wb.Sheets.Data; if (!ws) throw new Error('No "Data" sheet — is this an Advanced Log Data & Collisions export?');
    var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
    var meta = {}; for (var i = 0; i < 9; i++) if (rows[i] && rows[i][0]) meta[rows[i][0]] = rows[i][1];
    var tzName = POSIX_TZ[String(meta.TimeZone)] || $('cx-tz').value;
    var hdr = rows[9]; var col = {}; hdr.forEach(function (h, j) { col[h] = j; });
    function num(v) { if (v === true) return 1; if (v === false) return 0; var f = parseFloat(v); return isNaN(f) ? null : f; }
    function tms(v) {
      // Excel serial (days since 1899-12-30) → wall-clock ms as if UTC → re-anchored to the report zone.
      // Raw serials are used instead of SheetJS cellDates, which round through the browser's local zone.
      var wall = typeof v === 'number' ? Math.round((v - 25569) * 86400000) : Date.parse(String(v).replace(' ', 'T') + 'Z');
      return wall - tzOffsetMs(tzName, wall);
    }
    var speedKm = /km/i.test(String(meta.SpeedUnit || 'mph'));
    var gps = [], accel = [], st = [], faults = [], debug = [], ign = [], dc = [], lastIgn = null, first = null;
    for (var r = 10; r < rows.length; r++) {
      var row = rows[r]; if (!row || row[col.DebugDateTime] == null) continue;
      if (!first) first = row;
      var type = row[col.DebugRecordType], t = tms(row[col.DebugDateTime]);
      if (type === 'GpsRecord') {
        var lat = num(row[col.DebugLatitude]), lon = num(row[col.DebugLongitude]), sp = num(row[col.DebugSpeed]);
        if (sp != null && speedKm) sp /= KM_PER_MILE;
        if (lat != null && lon != null) gps.push({ t: t, lat: lat, lon: lon, mph: sp, reason: row[col.DebugRecordReason] || null });
        var ig = num(row[col.DebugIgnition]); if (ig != null && ig !== lastIgn) { ign.push({ t: t, on: !!ig }); lastIgn = ig; }
      } else if (type === 'EngineStatusRecord') {
        var name = row[col.DiagnosticName] || '', val = num(row[col.DebuggingStatusRecordDisplayData]), unit = row[col.DebuggingStatusRecordUnitOfMeasureName] || '';
        if (XLSX_AXIS[name] && val != null) accel.push({ t: t, axis: XLSX_AXIS[name], g: val });
        else if (val != null) { if (name === 'Engine road speed' && /km/i.test(unit)) { val /= KM_PER_MILE; unit = 'mph'; } st.push({ t: t, name: name, id: row[col.DiagnosticId] || null, value: val, unit: unit }); }
      } else if (type === 'EngineFaultRecord') {
        faults.push({ t: t, name: row[col.DiagnosticName] || '', controller: row[col.ControllerName] || null, failureMode: row[col.FailureModeName] || null, diagId: row[col.DiagnosticId] || null });
      } else if (type === 'DebugRecord') {
        var reason = String(row[col.DebugRecordReason] || ''); if (reason && !/^\d+$/.test(reason)) debug.push({ t: t, reason: reason });
      } else if (type === 'DriverChange') {
        dc.push({ t: t, type: String(row[col.DebugRecordReason] || ''), driverName: null });
      }
    }
    gps.sort(function (a, b) { return a.t - b.t; });
    return {
      source: 'xlsx',
      meta: { deviceName: first ? first[col.DeviceName] : '', deviceId: first ? first[col.DeviceId] : '', deviceGroups: first ? first[col.DeviceGroup] : '',
        company: meta.CompanyName || null, timeZone: tzName, reportTimeZone: meta.TimeZone, from: meta.FromDate ? tms(meta.FromDate) : null, to: meta.ToDate ? tms(meta.ToDate) : null, vin: null, vehicleDescription: null },
      gps: gps, accel: accel, status: st, faults: faults, debug: debug, ignition: ign, trips: [], driverChanges: dc, exceptions: []
    };
  }

  // ---------- inputs ↔ form ----------
  function readInputs() {
    var tz = $('cx-tz').value;
    var inp = state.inputs;
    inp.timeZone = tz;
    inp.eventTime = localToEpoch($('cx-event-date').value, $('cx-event-time').value, tz);
    inp.reportedEvent = $('cx-reported').value.trim();
    inp.impactConfig = $('cx-impact-config').value;
    inp.conditions = $('cx-conditions').value.trim();
    inp.locationLabel = $('cx-location-label').value.trim();
    inp.driverName = $('cx-driver').value.trim() || null;
    inp.vehicleDescription = $('cx-vehicle-desc').value.trim() || null;
    inp.pulseThresholdG = parseFloat($('cx-pulse-threshold').value) || 0.5;
    var rt = $('cx-recon-time').value;
    if (rt && ($('cx-recon-fwd').value || $('cx-recon-lat').value)) {
      inp.recon = {
        triggerTime: localToEpoch($('cx-event-date').value, rt, tz),
        fwdFtS2: parseFloat($('cx-recon-fwd').value), latFtS2: parseFloat($('cx-recon-lat').value),
        speedMph: parseFloat($('cx-recon-speed').value) || null,
        gpsAccuracyFt: parseFloat($('cx-recon-gps').value) || null, speedAccuracyMph: parseFloat($('cx-recon-spd-acc').value) || null
      };
      inp.reconDepicts = $('cx-recon-depicts').value || null;
    } else { inp.recon = null; inp.reconDepicts = null; }
    inp.photos = state.photos.map(function (p) { return { caption: p.caption, lat: p.lat, lon: p.lon, time: p.time }; });
    state.client = $('cx-client').value.trim();
    return inp;
  }
  function writeInputs(inp) {
    if (inp.timeZone) $('cx-tz').value = inp.timeZone;
    if (inp.eventTime) { var p = epochToLocalParts(inp.eventTime, inp.timeZone); $('cx-event-date').value = p.date; $('cx-event-time').value = p.time; }
    $('cx-reported').value = inp.reportedEvent || ''; $('cx-impact-config').value = inp.impactConfig || '';
    $('cx-conditions').value = inp.conditions || ''; $('cx-location-label').value = inp.locationLabel || '';
    $('cx-driver').value = inp.driverName || ''; $('cx-vehicle-desc').value = inp.vehicleDescription || '';
    $('cx-pulse-threshold').value = inp.pulseThresholdG || 0.5;
    if (inp.recon) {
      $('cx-recon-time').value = epochToLocalParts(inp.recon.triggerTime, inp.timeZone).time;
      $('cx-recon-fwd').value = inp.recon.fwdFtS2 != null ? inp.recon.fwdFtS2 : ''; $('cx-recon-lat').value = inp.recon.latFtS2 != null ? inp.recon.latFtS2 : '';
      $('cx-recon-speed').value = inp.recon.speedMph || ''; $('cx-recon-gps').value = inp.recon.gpsAccuracyFt || 8.2; $('cx-recon-spd-acc').value = inp.recon.speedAccuracyMph || 2.2;
      $('cx-recon-depicts').value = inp.reconDepicts || ''; $('cx-recon-details').open = true;
    }
    $('cx-client').value = state.client || '';
  }

  // ---------- load flow ----------
  function onLoad() {
    showError(null);
    var deviceId = $('cx-device').value, tz = $('cx-tz').value;
    var eventMs = localToEpoch($('cx-event-date').value, $('cx-event-time').value, tz);
    if (!deviceId) return showError('Select a vehicle.');
    if (eventMs == null) return showError('Enter the event date and time.');
    var before = (parseInt($('cx-before').value, 10) || 60) * 60000, after = (parseInt($('cx-after').value, 10) || 120) * 60000;
    $('cx-load').disabled = true;
    fetchBundle(deviceId, eventMs - before, eventMs + after, tz).then(function (bundle) {
      state = resetState(); state.bundle = bundle; state.client = $('cx-client').value.trim() || session.database || '';
      $('cx-client').value = state.client;
      if (!$('cx-vehicle-desc').value && bundle.meta.vin) $('cx-vehicle-desc').placeholder = 'VIN ' + bundle.meta.vin + ' — enter year/make/model';
      var trip = bundle.trips.filter(function (t) { return t.start <= eventMs && (!t.stop || t.stop >= eventMs - 1000); })[0];
      if (trip && trip.driverName && !$('cx-driver').value) $('cx-driver').value = trip.driverName;
      var cf = bundle.faults.filter(function (f) { return f.diagId === 'DiagnosticAccidentLevelAccelerationEventId' || /collision/i.test(f.name); })[0];
      if (cf && !$('cx-recon-time').value) $('cx-recon-time').value = epochToLocalParts(cf.t, tz).time;
      return afterBundleLoaded();
    }).catch(function (err) {
      showError('Load failed: ' + (err && err.message ? err.message : JSON.stringify(err)));
    }).then(function () { setLoading(null); $('cx-load').disabled = false; });
  }

  function onImportXlsx(file) {
    showError(null); setLoading('Parsing export…');
    readFileAsArrayBuffer(file).then(function (buf) {
      var bundle = normalizeXlsx(buf);
      state = resetState(); state.bundle = bundle; state.client = bundle.meta.company || $('cx-client').value;
      $('cx-client').value = state.client; $('cx-tz').value = bundle.meta.timeZone;
      var cf = bundle.faults.filter(function (f) { return /collision/i.test(f.name); })[0];
      var anchor = cf ? cf.t : (bundle.meta.from != null ? bundle.meta.from : bundle.gps[0].t);
      if (!$('cx-event-date').value || cf) { var p = epochToLocalParts(anchor, bundle.meta.timeZone); $('cx-event-date').value = p.date; $('cx-event-time').value = p.time; if (cf) $('cx-recon-time').value = p.time; }
      return afterBundleLoaded();
    }).catch(function (err) { showError('Import failed: ' + (err && err.message ? err.message : err)); }).then(function () { setLoading(null); });
  }

  function afterBundleLoaded() {
    $('cx-work').style.display = '';
    runAnalysis();
    renderStatus();
    cameraInit();
    // reverse-geocode key points (API only), then re-run so addresses land in the text
    if (api && state.result) {
      var r = state.result, pts = [], keys = [];
      if (r.tripStartPos) { pts.push({ x: r.tripStartPos.lon, y: r.tripStartPos.lat }); keys.push('tripStart'); }
      if (r.pulsePos) { pts.push({ x: r.pulsePos.lon, y: r.pulsePos.lat }); keys.push('pulse'); }
      if (r.post && r.post.rest) { pts.push({ x: r.post.rest.lon, y: r.post.rest.lat }); keys.push('rest'); }
      if (pts.length) {
        setLoading('Reverse-geocoding…');
        return tryCall('GetAddresses', { coordinates: pts, movingAddresses: false }, []).then(function (addrs) {
          (addrs || []).forEach(function (a, i) {
            if (!a) return;
            var short = [a.street, a.city, a.region].filter(Boolean).join(', ') || a.formattedAddress;
            state.inputs.addresses[keys[i]] = short;
          });
          if (!$('cx-location-label').value && state.inputs.addresses.pulse) $('cx-location-label').value = state.inputs.addresses.pulse;
          runAnalysis();
        });
      }
    }
  }

  function renderStatus() {
    var b = state.bundle, r = state.result, el = $('cx-status'); if (!b) return;
    var F = r.format;
    var chips = [
      ['GPS records ' + b.gps.length, ''], ['accelerometer samples ' + b.accel.length, b.accel.length ? '' : 'bad'],
      ['status records ' + b.status.length, ''], ['faults ' + b.faults.length, ''], ['trips ' + b.trips.length, ''],
      [r.buffer ? 'forensic 1 Hz buffer ' + F.clock(r.buffer.start) + '–' + F.clock(r.buffer.end) + ' (' + r.buffer.count + ' fixes)' : 'no forensic buffer', r.buffer ? 'ok' : 'bad'],
      [r.collisionFault ? 'collision fault ' + F.clock(r.collisionFault.t, true) : 'no collision fault', r.collisionFault ? 'ok' : ''],
      [r.pulse.found ? 'pulse ' + F.clock(r.pulse.start, true) + ' (' + r.pulse.composition + ')' : 'no pulse ≥ ' + r.config.pulseThresholdG + ' g', r.pulse.found ? 'ok' : 'bad'],
      ['source: ' + (b.source === 'api' ? 'MyGeotab API' : 'xlsx export') + (b.meta.accelUnitDetected ? ' · accel ' + b.meta.accelUnitDetected : ''), '']
    ];
    el.innerHTML = chips.map(function (c) { return '<span class="cx-chip ' + c[1] + '">' + esc(c[0]) + '</span>'; }).join('');
    el.style.display = '';
  }

  // ---------- analysis + render ----------
  function runAnalysis() {
    if (!state.bundle) return;
    var inp = readInputs();
    try {
      state.result = CollisionAnalysis.analyze(state.bundle, inp, { pulseThresholdG: inp.pulseThresholdG });
    } catch (e) { showError('Analysis error: ' + (e && e.stack || e)); return; }
    renderKeyFacts(); renderWarnings(); renderMap(); renderCharts(); renderTimeline(); renderSummary(); renderTexts(); renderStatus();
  }
  function renderWarnings() {
    var w = $('cx-warnings'), r = state.result;
    w.style.display = r.warnings.length ? '' : 'none'; w.innerHTML = r.warnings.map(esc).join('<br>');
  }
  function renderKeyFacts() {
    var r = state.result, F = r.format, p = r.pulse, kf = [];
    kf.push(['Event time (' + r.eventTimeSource + ')', F.clock(r.eventTime, true) + ' ' + r.tzAbbrev]);
    if (p.found) {
      kf.push(['Pulse', F.clock(p.start, true) + '–' + F.clock(p.end, true).slice(-6) + ' (' + p.durationS.toFixed(2) + ' s)']);
      ['lat', 'fwd', 'vert'].forEach(function (ax) { if (p.peaks[ax]) kf.push([(ax === 'fwd' ? 'Longitudinal' : ax === 'lat' ? 'Lateral' : 'Vertical') + ' peak', (p.peaks[ax].g > 0 ? '+' : '') + p.peaks[ax].g.toFixed(3) + ' g @ ' + F.clock(p.peaks[ax].t, true).slice(-6), ax !== 'vert' && Math.abs(p.peaks[ax].g) > 1 ? 'red' : '']); });
      kf.push(['Composition', p.composition]);
    } else kf.push(['Pulse', 'none ≥ ' + r.config.pulseThresholdG + ' g']);
    if (r.speedRange) kf.push(['Speed at pulse', '~' + Math.round(r.speedRange[0]) + '–' + Math.round(r.speedRange[1]) + ' mph']);
    if (r.approach && r.approach.onset) kf.push(['Braking onset', F.clock(r.approach.onset.t) + ' from ' + Math.round(r.approach.onset.mph) + ' mph (' + Math.round(r.approach.brakingDurationS) + ' s)']);
    if (r.post.rest) { kf.push(['At rest', F.clock(r.post.rest.t) + (r.post.rollOutFt != null ? ' · ~' + r.post.rollOutFt + ' ft roll-out' : '')]); }
    if (r.post.ignitionOff) kf.push(['Ignition off', F.clock(r.post.ignitionOff) + (r.post.engineRunningAfterRestMin != null ? ' (' + r.post.engineRunningAfterRestMin + ' min after rest)' : '')]);
    if (r.recon) kf.push(['Recon lag vs peak', (r.recon.lagS != null ? r.recon.lagS + ' s' : '—') + (r.recon.missedPeak ? ' · missed peak' : ''), r.recon.missedPeak ? 'red' : '']);
    kf.push(['Vertical baseline', r.verticalBaseline.toFixed(2) + ' g']);
    $('cx-keyfacts').innerHTML = kf.map(function (k) { return '<div class="cx-kf"><div class="k">' + esc(k[0]) + '</div><div class="v ' + (k[2] || '') + '">' + esc(k[1]) + '</div></div>'; }).join('');
  }

  // ---------- map ----------
  function ensureMap() {
    if (map) return map;
    map = L.map('cx-map', { preferCanvas: false, zoomControl: true });
    var sat = L.tileLayer(TILE_SAT.url, { maxZoom: 20, attribution: TILE_SAT.attr, crossOrigin: 'anonymous' });
    var ref = L.tileLayer(TILE_REF.url, { maxZoom: 20, attribution: TILE_REF.attr, crossOrigin: 'anonymous', opacity: 0.9 });
    var street = L.tileLayer(TILE_STREET.url, { maxZoom: 19, attribution: TILE_STREET.attr, crossOrigin: 'anonymous' });
    sat.addTo(map); ref.addTo(map);
    L.control.layers({ 'Satellite': sat, 'Streets': street }, { 'Road labels': ref }, { collapsed: true }).addTo(map);
    mapLayers.base = sat; mapLayers.ref = ref; mapLayers.street = street;
    mapLayers.group = L.layerGroup().addTo(map);
    $('cx-map-fit').addEventListener('click', fitMap);
    ['cx-map-labels', 'cx-map-trail', 'cx-map-crumbs'].forEach(function (id) { $(id).addEventListener('change', renderMap); });
    return map;
  }
  function mapAnnotations() {
    // Shared description of what goes on the map (used by Leaflet and by the canvas capture)
    var r = state.result, b = state.bundle, F = r.format, A = { lines: [], points: [], labels: [], arrow: null };
    var trail = b.gps.filter(function (g) { return g.t >= (r.tripStart || 0) && g.t <= (r.post.ignitionOff || r.dataEnd); });
    if ($('cx-map-trail').checked) A.lines.push({ pts: trail, color: '#ffd600', width: 3, dash: [10, 8], outline: '#000' });
    if (r.buffer && $('cx-map-crumbs').checked) {
      var buf = b.gps.filter(function (g) { return g.t >= r.buffer.start && g.t <= r.buffer.end; });
      A.lines.push({ pts: buf, color: '#ffd600', width: 3, outline: '#000' });
      buf.forEach(function (g) { A.points.push({ lat: g.lat, lon: g.lon, kind: 'crumb', title: F.clock(g.t) + ' · ' + (g.mph != null ? g.mph.toFixed(1) + ' mph' : '') }); });
    }
    var p = r.pulse, labels = $('cx-map-labels').checked;
    if (r.approach && r.approach.onset) {
      var o = bracketPos(r.approach.onset.t);
      if (o) { A.points.push({ lat: o.lat, lon: o.lon, kind: 'onset' }); if (labels) A.labels.push({ lat: o.lat, lon: o.lon, cls: 'dark', text: ['BRAKING BEGINS — ' + F.timeTenths(r.approach.onset.t), Math.round(r.approach.onset.mph) + ' mph; ' + (r.approach.phases || []).map(function (ph) { return ph.label + ' ~' + ph.mphPerS.toFixed(1) + ' mph/s'; }).join(', then ')], dir: 'left' }); }
    }
    if (r.pulsePos) {
      A.points.push({ lat: r.pulsePos.lat, lon: r.pulsePos.lon, kind: 'pulse' });
      if (labels) A.labels.push({ lat: r.pulsePos.lat, lon: r.pulsePos.lon, cls: 'red', dir: 'right',
        text: p.found ? ['RECORDED IMPACT PULSE — ' + F.timeTenths(p.peakTime) + ' ' + r.tzAbbrev,
          (r.speedRange ? '~' + Math.round(r.speedRange[0]) + '–' + Math.round(r.speedRange[1]) + ' mph' : '') + (r.inputsLocation ? ' at ' + r.inputsLocation : ''),
          'peak ' + ['lat', 'fwd', 'vert'].filter(function (ax) { return p.peaks[ax]; }).map(function (ax) { return (p.peaks[ax].g > 0 ? '+' : '') + p.peaks[ax].g.toFixed(2) + ' g ' + (ax === 'fwd' ? 'longitudinal' : ax === 'lat' ? 'lateral' : 'vertical'); }).join(' / ')]
          : ['EVENT TIME — ' + F.timeTenths(r.eventTime) + ' ' + r.tzAbbrev, 'no impact-level accelerometer pulse recorded'] });
    }
    if (r.recon && r.recon.triggerTime && r.pulsePos) {
      var rp = bracketPos(r.recon.triggerTime, true);
      if (rp) A.points.push({ lat: rp.lat, lon: rp.lon, kind: 'recon', title: 'Recon trigger ' + F.clock(r.recon.triggerTime, true) });
    }
    if (r.post.rest) {
      A.points.push({ lat: r.post.rest.lat, lon: r.post.rest.lon, kind: 'rest' });
      if (labels) A.labels.push({ lat: r.post.rest.lat, lon: r.post.rest.lon, cls: 'navy', dir: 'left',
        text: ['FINAL REST — ' + F.time(r.post.rest.t), (r.post.rollOutFt != null ? '~' + r.post.rollOutFt + ' ft past pulse' : '') + (state.inputs.addresses.rest ? ' · ' + state.inputs.addresses.rest : ''),
          (r.post.ignitionOff ? 'Engine off ' + F.time(r.post.ignitionOff) + '; ' : '') + (r.post.movedAfterIgnitionOffFt >= r.config.sceneRadiusFt ? 'relocated after ignition off' : 'no further movement')] });
    }
    state.photos.forEach(function (ph, i) {
      if (ph.lat != null && ph.lon != null) {
        A.points.push({ lat: ph.lat, lon: ph.lon, kind: 'photo', title: 'Photo ' + (i + 1) });
        var d = r.post.rest ? Math.round(CollisionAnalysis.haversineFt(ph.lat, ph.lon, r.post.rest.lat, r.post.rest.lon)) : null;
        if (labels) A.labels.push({ lat: ph.lat, lon: ph.lon, cls: 'green', dir: 'right', text: ['SCENE PHOTO ' + (ph.time ? ph.time : '') + ' (GPS-stamped)', d != null ? '~' + d + ' ft from logged rest position' : ''] });
      }
    });
    // direction-of-travel arrow ~ 80 m before the pulse, along heading
    if (r.pulsePos && r.headingDeg != null) {
      var back = bracketPos(r.pulseTime - 6000);
      if (back) A.arrow = { lat: back.lat, lon: back.lon, heading: r.headingDeg };
    }
    return A;
  }
  function bracketPos(t, interpolate) {
    var gps = state.bundle.gps; if (!gps.length) return null;
    return { lat: CollisionAnalysis.interp(gps, 'lat', t), lon: CollisionAnalysis.interp(gps, 'lon', t) };
  }
  function renderMap() {
    if (!state.result) return;
    var m = ensureMap(); mapLayers.group.clearLayers();
    var A = mapAnnotations();
    A.lines.forEach(function (ln) {
      var ll = ln.pts.map(function (g) { return [g.lat, g.lon]; }); if (ll.length < 2) return;
      L.polyline(ll, { color: ln.outline, weight: ln.width + 3, opacity: 0.9, dashArray: ln.dash ? ln.dash.join(' ') : null }).addTo(mapLayers.group);
      L.polyline(ll, { color: ln.color, weight: ln.width, opacity: 1, dashArray: ln.dash ? ln.dash.join(' ') : null }).addTo(mapLayers.group);
    });
    A.points.forEach(function (pt) {
      var mk;
      if (pt.kind === 'crumb') mk = L.circleMarker([pt.lat, pt.lon], { radius: 3, color: '#000', weight: 1, fillColor: '#fff', fillOpacity: 1 });
      else if (pt.kind === 'pulse') mk = L.marker([pt.lat, pt.lon], { icon: L.divIcon({ className: '', html: '<div class="cx-x">✕</div>', iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 1000 });
      else if (pt.kind === 'rest') mk = L.circleMarker([pt.lat, pt.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#25477B', fillOpacity: 1 });
      else if (pt.kind === 'onset') mk = L.circleMarker([pt.lat, pt.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#1C2B39', fillOpacity: 1 });
      else if (pt.kind === 'recon') mk = L.circleMarker([pt.lat, pt.lon], { radius: 5, color: '#fff', weight: 1.5, fillColor: '#b45309', fillOpacity: 1 });
      else if (pt.kind === 'photo') mk = L.circleMarker([pt.lat, pt.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#1b5e20', fillOpacity: 1 });
      if (pt.title) mk.bindTooltip(pt.title);
      mk.addTo(mapLayers.group);
    });
    A.labels.forEach(function (lb) {
      L.marker([lb.lat, lb.lon], { icon: L.divIcon({ className: '', html: '', iconSize: [0, 0] }), interactive: false })
        .bindTooltip(lb.text.filter(Boolean).map(esc).join('<br>'), { permanent: true, direction: lb.dir, offset: [lb.dir === 'right' ? 30 : -30, lb.dir === 'right' ? -30 : 30], className: 'cx-lbl ' + lb.cls, opacity: 1 })
        .addTo(mapLayers.group);
    });
    if (A.arrow) {
      L.marker([A.arrow.lat, A.arrow.lon], { icon: L.divIcon({ className: '', html: '<div class="cx-arrow" style="transform:rotate(' + A.arrow.heading + 'deg)"></div>', iconSize: [14, 18], iconAnchor: [7, 9] }), interactive: false }).addTo(mapLayers.group);
    }
    if (!map._cxFitted) { fitMap(); map._cxFitted = true; }
  }
  function fitMap() {
    var r = state.result; if (!r || !map) return;
    var pts = [];
    if (r.buffer) state.bundle.gps.filter(function (g) { return g.t >= r.buffer.start && g.t <= r.buffer.end; }).forEach(function (g) { pts.push([g.lat, g.lon]); });
    if (r.pulsePos) pts.push([r.pulsePos.lat, r.pulsePos.lon]);
    if (r.post.rest) pts.push([r.post.rest.lat, r.post.rest.lon]);
    if (!pts.length && state.bundle.gps.length) pts = state.bundle.gps.map(function (g) { return [g.lat, g.lon]; });
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 18 });
    setTimeout(function () { map.invalidateSize(); }, 50);
  }

  /** Draw the current map view (tiles + annotations) onto a canvas → data URL. */
  function captureMap() {
    if (state.mapOverride) return Promise.resolve(state.mapOverride);
    if (!map) return Promise.resolve(null);
    var cont = map.getContainer(), rect = cont.getBoundingClientRect();
    var W = Math.round(rect.width), H = Math.round(rect.height), dpr = 2;
    var cv = document.createElement('canvas'); cv.width = W * dpr; cv.height = H * dpr;
    var ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.fillStyle = '#e5e7eb'; ctx.fillRect(0, 0, W, H);
    // tiles, in layer order (base then overlay)
    var imgs = cont.querySelectorAll('.leaflet-tile-pane img.leaflet-tile-loaded');
    Array.prototype.forEach.call(imgs, function (img) {
      var r2 = img.getBoundingClientRect();
      try { ctx.globalAlpha = parseFloat(getComputedStyle(img.parentNode.parentNode).opacity || 1); ctx.drawImage(img, r2.left - rect.left, r2.top - rect.top, r2.width, r2.height); } catch (e) { /* skip */ }
    });
    ctx.globalAlpha = 1;
    var A = mapAnnotations();
    function P(lat, lon) { var p = map.latLngToContainerPoint([lat, lon]); return [p.x, p.y]; }
    A.lines.forEach(function (ln) {
      if (ln.pts.length < 2) return;
      [[ln.outline, ln.width + 3], [ln.color, ln.width]].forEach(function (s) {
        ctx.beginPath(); ctx.strokeStyle = s[0]; ctx.lineWidth = s[1]; ctx.setLineDash(ln.dash || []); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ln.pts.forEach(function (g, i) { var p = P(g.lat, g.lon); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.stroke();
      });
    });
    ctx.setLineDash([]);
    A.points.forEach(function (pt) {
      var p = P(pt.lat, pt.lon);
      if (pt.kind === 'crumb') { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke(); }
      else if (pt.kind === 'pulse') {
        ctx.lineCap = 'round'; [[ '#fff', 7 ], ['#e0211d', 3.5]].forEach(function (s) { ctx.strokeStyle = s[0]; ctx.lineWidth = s[1]; ctx.beginPath(); ctx.moveTo(p[0] - 8, p[1] - 8); ctx.lineTo(p[0] + 8, p[1] + 8); ctx.moveTo(p[0] + 8, p[1] - 8); ctx.lineTo(p[0] - 8, p[1] + 8); ctx.stroke(); });
      } else {
        var col = { rest: '#25477B', onset: '#1C2B39', recon: '#b45309', photo: '#1b5e20' }[pt.kind], rad = pt.kind === 'recon' ? 5 : 7;
        ctx.beginPath(); ctx.arc(p[0], p[1], rad, 0, 7); ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
    });
    if (A.arrow) {
      var ap = P(A.arrow.lat, A.arrow.lon), ang = (A.arrow.heading - 90) * Math.PI / 180;
      ctx.save(); ctx.translate(ap[0], ap[1]); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-6, -7); ctx.lineTo(-2, 0); ctx.lineTo(-6, 7); ctx.closePath();
      ctx.fillStyle = '#ffd600'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
    }
    // callout boxes
    ctx.font = 'bold 11px Roboto, Arial, sans-serif'; ctx.textBaseline = 'top';
    var placed = [];
    A.labels.forEach(function (lb) {
      var lines = lb.text.filter(Boolean), p = P(lb.lat, lb.lon);
      var wmax = 0; lines.forEach(function (l) { wmax = Math.max(wmax, ctx.measureText(l).width); });
      var bw = wmax + 14, bh = lines.length * 14 + 8;
      var bx = lb.dir === 'right' ? p[0] + 40 : p[0] - 40 - bw, by = lb.dir === 'right' ? p[1] - 40 - bh : p[1] + 40;
      bx = Math.max(6, Math.min(W - bw - 6, bx)); by = Math.max(6, Math.min(H - bh - 6, by));
      // nudge down if overlapping an earlier box
      placed.forEach(function (q) { if (bx < q.x + q.w && bx + bw > q.x && by < q.y + q.h && by + bh > q.y) by = q.y + q.h + 6; });
      placed.push({ x: bx, y: by, w: bw, h: bh });
      // leader line
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(bx + (lb.dir === 'right' ? 0 : bw), by + bh / 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); ctx.strokeStyle = { red: '#b3261e', navy: '#25477B', dark: '#1C2B39', green: '#1b5e20' }[lb.cls]; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = { red: '#b3261e', navy: '#25477B', dark: '#1C2B39', green: '#1b5e20' }[lb.cls];
      roundRect(ctx, bx, by, bw, bh, 4); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#fff'; lines.forEach(function (l, i) { ctx.fillText(l, bx + 7, by + 5 + i * 14); });
    });
    // attribution
    ctx.font = '9px Arial'; ctx.fillStyle = 'rgba(255,255,255,.85)'; var at = 'Imagery © Esri, Maxar, Earthstar Geographics'; var aw = ctx.measureText(at).width + 8;
    ctx.fillRect(W - aw, H - 14, aw, 14); ctx.fillStyle = '#333'; ctx.fillText(at, W - aw + 4, H - 12);
    try { return Promise.resolve(cv.toDataURL('image/jpeg', 0.92)); }
    catch (e) { return Promise.resolve(null); } // tainted canvas (tile server without CORS) → caller falls back
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // ---------- charts ----------
  function renderCharts() {
    var r = state.result, F = r.format, p = r.pulse;
    Object.keys(charts).forEach(function (k) { charts[k].destroy(); }); charts = {};
    // pulse chart
    var ctx1 = $('cx-chart-pulse').getContext('2d');
    var samples = p.found ? p.samples : state.bundle.accel.filter(function (a) { return Math.abs(a.t - r.eventTime) <= 5000; });
    if (samples.length) {
      var t0 = Math.floor(Math.min.apply(null, samples.map(function (a) { return a.t; })) / 1000) * 1000;
      var ds = [['fwd', 'Longitudinal (fwd/braking)', '#b3261e'], ['lat', 'Lateral (side to side)', '#b8860b'], ['vert', 'Vertical (up/down)', '#0084C2']].map(function (d) {
        return { label: d[1], borderColor: d[2], backgroundColor: d[2], data: samples.filter(function (a) { return a.axis === d[0]; }).map(function (a) { return { x: a.t - t0, y: a.g }; }), showLine: true, pointRadius: 3, borderWidth: 1.6, tension: 0 };
      });
      var annPlugin = { id: 'cxAnn', afterDatasetsDraw: function (chart) {
        var c = chart.ctx, xs = chart.scales.x, ys = chart.scales.y;
        if (r.recon && r.recon.triggerTime) {
          var x1 = xs.getPixelForValue(r.recon.triggerTime - t0), x2 = xs.getPixelForValue(r.recon.triggerTime - t0 + 300);
          c.save(); c.fillStyle = 'rgba(255,193,7,.25)'; c.fillRect(x1, ys.top, x2 - x1, ys.bottom - ys.top);
          c.fillStyle = '#b45309'; c.font = 'bold 10px Roboto, Arial'; c.textAlign = 'center'; c.fillText('recon trigger window', (x1 + x2) / 2, ys.top + 10); c.fillText('(values Geotab\'s point-of-impact used)', (x1 + x2) / 2, ys.top + 21); c.restore();
        }
        if (p.found) {
          // peak summary box (top-left) + small rings on the peak samples — avoids label collisions
          c.save(); c.font = 'bold 10px Roboto, Arial'; c.textAlign = 'left';
          var lines = [['lat', '#b8860b', 'lateral'], ['fwd', '#b3261e', 'longitudinal'], ['vert', '#0084C2', 'vertical']].filter(function (d) { return p.peaks[d[0]]; })
            .map(function (d) { var pk = p.peaks[d[0]]; return [d[1], (pk.g > 0 ? '+' : '') + pk.g.toFixed(2) + ' g ' + d[2] + ' @ ' + F.clock(pk.t, true).slice(-6)]; });
          var bw = 0; lines.forEach(function (l) { bw = Math.max(bw, c.measureText(l[1]).width); });
          c.fillStyle = 'rgba(255,255,255,.9)'; c.fillRect(xs.left + 6, ys.top + 4, bw + 14, lines.length * 13 + 8);
          c.strokeStyle = '#d1d5db'; c.strokeRect(xs.left + 6, ys.top + 4, bw + 14, lines.length * 13 + 8);
          lines.forEach(function (l, i) { c.fillStyle = l[0]; c.fillText(l[1], xs.left + 13, ys.top + 17 + i * 13); });
          [['lat', '#b8860b'], ['fwd', '#b3261e'], ['vert', '#0084C2']].forEach(function (d) {
            var pk = p.peaks[d[0]]; if (!pk) return; var x = xs.getPixelForValue(pk.t - t0), y = ys.getPixelForValue(pk.g);
            c.beginPath(); c.arc(x, y, 6, 0, 7); c.strokeStyle = d[1]; c.lineWidth = 1.5; c.stroke();
          });
          c.restore();
        }
        c.save(); c.strokeStyle = '#9ca3af'; c.setLineDash([3, 3]); c.beginPath(); var y1 = ys.getPixelForValue(r.verticalBaseline); c.moveTo(xs.left, y1); c.lineTo(xs.right, y1); c.stroke(); var y0 = ys.getPixelForValue(0); c.beginPath(); c.moveTo(xs.left, y0); c.lineTo(xs.right, y0); c.stroke(); c.restore();
      } };
      charts.pulse = new Chart(ctx1, { type: 'scatter', data: { datasets: ds }, plugins: [annPlugin], options: {
        animation: false, responsive: true, maintainAspectRatio: false, devicePixelRatio: 2,
        scales: { x: { title: { display: true, text: 'milliseconds after ' + F.clock(t0, true) + ' ' + r.tzAbbrev }, ticks: { stepSize: 250 } }, y: { title: { display: true, text: 'acceleration (g)' }, suggestedMin: -1, suggestedMax: 2, grace: '12%' } },
        layout: { padding: { top: 6 } },
        plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + c.parsed.y.toFixed(3) + ' g @ ' + F.clock(c.parsed.x + t0, true); } } } }
      } });
      state._pulseT0 = t0;
    }
    // speed chart
    var ctx2 = $('cx-chart-speed').getContext('2d');
    var sp = r.approach ? r.approach.speeds.slice() : [];
    state.bundle.gps.filter(function (g) { return g.t > r.pulseTime && g.t <= (r.post.rest ? r.post.rest.t + 3000 : r.pulseTime + 30000) && g.mph != null; }).forEach(function (g) { sp.push({ t: g.t, mph: g.mph }); });
    if (r.buffer) sp = sp.filter(function (s) { return s.t >= r.buffer.start - 1000; });
    if (sp.length) {
      var spPlugin = { id: 'cxSp', afterDatasetsDraw: function (chart) {
        var c = chart.ctx, xs = chart.scales.x, ys = chart.scales.y; c.save();
        var x = xs.getPixelForValue(r.pulseTime); c.strokeStyle = '#b3261e'; c.setLineDash([5, 4]); c.lineWidth = 1.5; c.beginPath(); c.moveTo(x, ys.top); c.lineTo(x, ys.bottom); c.stroke(); c.setLineDash([]);
        c.fillStyle = '#b3261e'; c.font = 'bold 10px Roboto, Arial'; c.textAlign = 'right';
        c.fillText((p.found ? 'IMPACT PULSE ' : 'EVENT ') + F.clock(r.pulseTime, true).slice(0, -2), x - 6, ys.top + 12);
        if (r.speedRange) c.fillText('~' + (r.speedRange[0] === r.speedRange[1] ? r.speedRange[0] : r.speedRange[0] + '–' + r.speedRange[1]) + ' mph', x - 6, ys.top + 24);
        if (r.approach && r.approach.onset) { var xo = xs.getPixelForValue(r.approach.onset.t); c.fillStyle = '#1C2B39'; c.textAlign = 'left'; c.fillText('braking begins ' + F.clock(r.approach.onset.t) + ' (' + Math.round(r.approach.onset.mph) + ' mph)', xo + 8, ys.getPixelForValue(r.approach.onset.mph) + 16); }
        if (r.post.rest) { var xr = xs.getPixelForValue(r.post.rest.t); c.fillStyle = '#25477B'; c.textAlign = 'right'; c.fillText('at rest ' + F.clock(r.post.rest.t), xr - 6, ys.getPixelForValue(0) - 10); }
        c.restore();
      } };
      charts.speed = new Chart(ctx2, { type: 'line', data: { datasets: [{ label: 'GPS speed (mph)', data: sp.map(function (s) { return { x: s.t, y: s.mph }; }), borderColor: '#25477B', backgroundColor: '#25477B', pointRadius: 2.5, borderWidth: 1.8, tension: 0 }] }, plugins: [spPlugin], options: {
        animation: false, responsive: true, maintainAspectRatio: false, parsing: false, devicePixelRatio: 2,
        scales: { x: { type: 'linear', ticks: { callback: function (v) { return F.clock(v); }, maxTicksLimit: 10 } }, y: { title: { display: true, text: 'GPS speed (mph)' }, min: 0, grace: '10%' } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: function (c) { return F.clock(c[0].parsed.x, true); }, label: function (c) { return c.parsed.y.toFixed(1) + ' mph'; } } } }
      } });
    }
  }

  // ---------- editable tables / texts ----------
  function renderTimeline() {
    var r = state.result, rows = state.edits.timeline || r.timeline.map(function (t) { return { label: t.label, text: t.text, kind: t.kind }; });
    var tb = $('cx-timeline').querySelector('tbody');
    tb.innerHTML = rows.map(function (row, i) {
      return '<tr><td><input type="text" data-i="' + i + '" data-k="label" value="' + esc(row.label) + '"></td><td><textarea rows="2" data-i="' + i + '" data-k="text">' + esc(row.text) + '</textarea></td><td><button class="cx-del" data-i="' + i + '" title="Remove">×</button></td></tr>';
    }).join('');
    tb.querySelectorAll('input,textarea').forEach(function (el) { el.addEventListener('input', function () { ensureTimelineEdits()[+el.dataset.i][el.dataset.k] = el.value; }); });
    tb.querySelectorAll('.cx-del').forEach(function (el) { el.addEventListener('click', function () { ensureTimelineEdits().splice(+el.dataset.i, 1); renderTimeline(); }); });
  }
  function ensureTimelineEdits() { if (!state.edits.timeline) state.edits.timeline = state.result.timeline.map(function (t) { return { label: t.label, text: t.text, kind: t.kind }; }); return state.edits.timeline; }
  function renderSummary() {
    var r = state.result, rows = state.edits.summary || r.summary.map(function (s) { return [s[0], s[1]]; });
    var tb = $('cx-summary').querySelector('tbody');
    tb.innerHTML = rows.map(function (row, i) { return '<tr><td><input type="text" data-i="' + i + '" data-k="0" value="' + esc(row[0]) + '"></td><td><textarea rows="2" data-i="' + i + '" data-k="1">' + esc(row[1]) + '</textarea></td></tr>'; }).join('');
    tb.querySelectorAll('input,textarea').forEach(function (el) { el.addEventListener('input', function () { if (!state.edits.summary) state.edits.summary = r.summary.map(function (s) { return [s[0], s[1]]; }); state.edits.summary[+el.dataset.i][+el.dataset.k] = el.value; }); });
  }
  function computedTexts() {
    var r = state.result, F = r.format, p = r.pulse, b = state.bundle;
    var t = {};
    t.discrepancy = r.discrepancy && (r.discrepancy.applicable || state.inputs.reconDepicts) ? r.discrepancy.text : '';
    t.pulseCaption = p.found
      ? 'Vertical-axis baseline is ' + r.verticalBaseline.toFixed(1) + ' g (gravity). ' + (r.recon ? 'The shaded band marks the reconstruction\'s trigger timestamp (' + F.clock(r.recon.triggerTime, true) + '–' + F.clock(r.recon.triggerTime + 300, true).slice(-6) + ')' + (r.recon.lagS != null && Math.abs(r.recon.lagS) >= 0.3 ? ', ~' + Math.abs(r.recon.lagS) + ' s ' + (r.recon.lagS > 0 ? 'after' : 'before') + ' the recorded peak' : '') + (r.recon.missedPeak ? ' — by then the primary signal had decayed and the sample Geotab\'s point-of-impact estimate was computed from no longer reflects the pulse. ' : '. ') : '') +
        'Samples are the device\'s curve-logged accelerometer capture around the detected event; lines connect consecutive logged samples.'
      : 'No accelerometer excursion at or above ' + r.config.pulseThresholdG.toFixed(1) + ' g was logged within ±2 minutes of the event time; samples shown are the curve-logged values nearest the event.';
    t.speedCaption = (r.buffer ? 'GPS-logged speed from the 1 Hz forensic accident buffer (' + F.clock(r.buffer.start) + '–' + F.clock(r.buffer.end) + '). ' : 'GPS-logged speed from curve-logged records; positions and speeds between records are interpolated. ') +
      (r.approach && r.approach.onset ? 'Deceleration from ' + Math.round(r.approach.onset.mph) + ' mph begins ' + F.time(r.approach.onset.t) + (r.approach.phases && r.approach.phases.length === 2 ? ' — ' + r.approach.phases[0].label + ' (~' + r.approach.phases[0].mphPerS.toFixed(1) + ' mph/s), then ' + r.approach.phases[1].label + ' (~' + r.approach.phases[1].mphPerS.toFixed(1) + ' mph/s) from ' + F.time(r.approach.phases[1].start) : '') + '.' : '');
    t.mapCaption = state.mapOverride
      ? 'Base image: MyGeotab Trips History satellite view supplied by the analyst.'
      : 'Base map: Esri World Imagery satellite tiles. Trip trail (dashed) and 1 Hz forensic breadcrumbs (solid, white dots) are plotted directly from logged GPS coordinates; the pulse marker is placed at the position interpolated between the bracketing 1 Hz fixes and the rest marker at the logged rest fix — no screenshot georeferencing is involved.' +
        (r.inputsPhotoDist ? '' : '') + (state.photos.some(function (ph) { return ph.lat != null; }) && r.post.rest ? ' The GPS-stamped scene photograph plots within ~' + Math.round(Math.min.apply(null, state.photos.filter(function (ph) { return ph.lat != null; }).map(function (ph) { return CollisionAnalysis.haversineFt(ph.lat, ph.lon, r.post.rest.lat, r.post.rest.lon); }))) + ' ft of the logged rest position, corroborating the recorded location.' : '');
    t.source = 'Source: MyGeotab GO device records (GPS log' + (r.buffer ? ' including the 1 Hz forensic accident buffer' : '') + ', accelerometer capture, engine status and fault data) retrieved ' + (b.source === 'api' ? 'via the MyGeotab API on ' + F.dateShort(Date.now()) : 'from the Advanced Log Data & Collisions Report export') +
      (r.recon ? '; Geotab Collision Reconstruction (BETA) report' : '') + (state.photos.length ? '; ' + (state.photos.some(function (ph) { return ph.lat != null; }) ? 'Timemark GPS-verified ' : '') + 'scene photograph(s)' : '') + '. ' + r.caveats.join(' ');
    return t;
  }
  function renderTexts() {
    var c = computedTexts(), e = state.edits.texts;
    [['discrepancy', 'cx-text-discrepancy'], ['pulseCaption', 'cx-text-pulse-caption'], ['speedCaption', 'cx-text-speed-caption'], ['mapCaption', 'cx-text-map-caption'], ['source', 'cx-text-source']].forEach(function (k) {
      var el = $(k[1]); el.value = e[k[0]] != null ? e[k[0]] : c[k[0]];
      el.oninput = function () { e[k[0]] = el.value; };
    });
  }
  function currentTexts() { var c = computedTexts(), e = state.edits.texts, o = {}; Object.keys(c).forEach(function (k) { o[k] = e[k] != null ? e[k] : c[k]; }); return o; }

  // ---------- photos ----------
  function renderPhotos() {
    var el = $('cx-photo-list');
    el.innerHTML = state.photos.map(function (p, i) {
      return '<div class="cx-photo"><img src="' + p.dataUrl + '"><div class="cx-field"><label>Caption</label><input type="text" data-i="' + i + '" data-k="caption" value="' + esc(p.caption) + '"></div>' +
        '<div class="cx-field"><label>Photo time (as stamped)</label><input type="text" data-i="' + i + '" data-k="time" value="' + esc(p.time || '') + '" placeholder="09:18 CDT"></div>' +
        '<div class="cx-field"><label>Latitude (stamp)</label><input type="text" data-i="' + i + '" data-k="lat" value="' + (p.lat != null ? p.lat : '') + '" placeholder="45.141305"></div>' +
        '<div class="cx-field"><label>Longitude (stamp)</label><input type="text" data-i="' + i + '" data-k="lon" value="' + (p.lon != null ? p.lon : '') + '" placeholder="-93.776613"></div>' +
        '<button class="cx-del" data-i="' + i + '" title="Remove">×</button></div>';
    }).join('');
    el.querySelectorAll('input').forEach(function (inp) { inp.addEventListener('change', function () {
      var p = state.photos[+inp.dataset.i], k = inp.dataset.k; p[k] = (k === 'lat' || k === 'lon') ? (parseFloat(inp.value) || null) : inp.value; runAnalysis();
    }); });
    el.querySelectorAll('.cx-del').forEach(function (b) { b.addEventListener('click', function () { state.photos.splice(+b.dataset.i, 1); renderPhotos(); runAnalysis(); }); });
  }


  // ---------- camera footage (Geotab-native via media-services) ----------
  var cam = { mapping: null, items: [], polling: {} };
  function camStatus(msg, cls) { var el = $('cx-cam-status'); el.innerHTML = msg; el.className = cls || 'cx-muted'; }
  function camRaw() { try { $('cx-cam-raw').textContent = JSON.stringify(CameraServices.log.slice(-12), null, 1); } catch (e) { /* ignore */ } }
  function cameraInit() {
    cam = { mapping: null, items: [], polling: {} };
    $('cx-cam-list').innerHTML = ''; $('cx-cam-exceptions').innerHTML = ''; $('cx-cam-tools').style.display = 'none';
    var b = state.bundle;
    if (!b || b.source !== 'api') { camStatus('Camera lookup needs the API path (not available for an imported export).'); return; }
    if (!CameraServices.ready()) { camStatus('No MyGeotab session available for media-services.'); return; }
    var serial = b.meta.serialNumber;
    if (!serial) { camStatus('Device has no serial number — cannot look up a camera pairing.'); return; }
    camStatus('Checking media-services for a camera paired to ' + esc(serial) + '…');
    CameraServices.findMappings(serial).then(function (maps) {
      camRaw();
      var m = (maps || []).filter(function (x) { return x && x.partnerDeviceId; });
      if (!m.length) { camStatus('No Geotab-native camera is paired to this device. (VisionTrack cameras are handled in the VisionTrack add-in\'s Collision Center.)'); return; }
      cam.mapping = m[0];
      camStatus('Paired camera: <b>' + esc(m[0].partnerId || 'unknown partner') + '</b> ' + esc(m[0].partnerDeviceId) +
        (m[0].deviceStatus ? ' · <span class="cx-pill ' + (/online/i.test(m[0].deviceStatus) ? 'ok' : 'wait') + '">' + esc(m[0].deviceStatus) + '</span>' : '') +
        (m[0].partnerDeviceHealthStatus ? ' · health ' + esc(m[0].partnerDeviceHealthStatus) : '') + (m.length > 1 ? ' (+' + (m.length - 1) + ' more)' : ''), '');
      $('cx-cam-tools').style.display = '';
      renderCamExceptions();
      camFind();
    }).catch(function (e) { camRaw(); camStatus('Camera lookup failed: ' + esc(e.message), 'cx-warn'); });
  }
  function renderCamExceptions() {
    var r = state.result, F = r.format, ex = (state.bundle.exceptions || []).filter(function (e) { return e.id && Math.abs(e.t - r.pulseTime) <= 15 * 60000; });
    var el = $('cx-cam-exceptions');
    if (!ex.length) { el.innerHTML = '<span class="cx-muted">No exception events within ±15 min of the pulse (camera events usually arrive as exceptions — none to pull media for).</span>'; return; }
    el.innerHTML = '<div class="cx-muted">Exception events near the pulse — camera partners attach media to these:</div>' + ex.map(function (e, i) {
      return '<div class="row"><span style="min-width:90px">' + esc(F.clock(e.t)) + '</span><span style="flex:1">' + esc(e.ruleName || e.id) + '</span>' +
        '<button class="cx-btn cx-btn-sm" data-exc="' + esc(e.id) + '" data-act="get">Get media</button><button class="cx-btn cx-btn-sm" data-exc="' + esc(e.id) + '" data-act="request">Request ±10 s</button></div>';
    }).join('');
    el.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.exc; btn.disabled = true;
        var p = btn.dataset.act === 'get' ? CameraServices.exceptionMedia(id).then(function (items) { addCamItems(items.map(CameraServices.normalizeItem)); })
          : CameraServices.requestExceptionMedia(id, 10, 10).then(function (req) { var it = CameraServices.normalizeItem(req || {}); if (it.id) { addCamItems([it]); camPoll(it.id); } });
        p.catch(function (e) { camStatus('Exception media: ' + esc(e.message), 'cx-warn'); }).then(function () { camRaw(); btn.disabled = false; });
      });
    });
  }
  function camFind() {
    var r = state.result, b = state.bundle; $('cx-cam-busy').textContent = 'Searching existing requests…';
    CameraServices.listRequests(b.meta.serialNumber, iso(r.pulseTime - 30 * 60000), iso(r.pulseTime + 60 * 60000)).then(function (items) {
      var norm = items.map(CameraServices.normalizeItem);
      addCamItems(norm);
      norm.forEach(function (it) { if (it.id && CameraServices.isReady(it.raw) && !it.videos.length) camResolve(it.id); else if (it.id && !CameraServices.isReady(it.raw) && !CameraServices.isFailed(it.raw)) camPoll(it.id); });
      $('cx-cam-busy').textContent = norm.length ? norm.length + ' request(s) found in −30/+60 min' : 'No existing footage requests in −30/+60 min of the pulse.';
    }).catch(function (e) { $('cx-cam-busy').textContent = ''; camStatus('Footage search failed: ' + esc(e.message), 'cx-warn'); }).then(camRaw);
  }
  function camRequest() {
    var r = state.result, pre = parseInt($('cx-cam-pre').value, 10) || 10, post = parseInt($('cx-cam-post').value, 10) || 10;
    if (!cam.mapping) return;
    $('cx-cam-busy').textContent = 'Requesting clip ' + iso(r.pulseTime - pre * 1000) + ' → ' + iso(r.pulseTime + post * 1000) + '…';
    CameraServices.requestClip(cam.mapping, iso(r.pulseTime - pre * 1000), iso(r.pulseTime + post * 1000)).then(function (req) {
      var it = CameraServices.normalizeItem(req || {});
      if (!it.id) throw new Error('No request id returned — see call log.');
      addCamItems([it]); camPoll(it.id);
      $('cx-cam-busy').textContent = 'Clip requested (' + it.id + '); the camera uploads when it is online — polling every 10 s.';
    }).catch(function (e) { $('cx-cam-busy').textContent = ''; camStatus('Clip request failed: ' + esc(e.message), 'cx-warn'); }).then(camRaw);
  }
  function camPoll(id) {
    if (cam.polling[id]) return; cam.polling[id] = true;
    CameraServices.poll(id, function (it) { addCamItems([it]); camRaw(); }).then(function (it) { addCamItems([it]); delete cam.polling[id]; camRaw(); })
      .catch(function (e) { delete cam.polling[id]; camStatus('Polling ' + esc(id) + ' failed: ' + esc(e.message), 'cx-warn'); });
  }
  function camResolve(id) { CameraServices.resolve(id).then(function (it) { addCamItems([it]); camRaw(); }).catch(function () { camRaw(); }); }
  function addCamItems(items) {
    items.forEach(function (it) {
      var key = it.id || JSON.stringify(it.raw).slice(0, 80);
      var idx = cam.items.findIndex(function (x) { return (x.id || JSON.stringify(x.raw).slice(0, 80)) === key; });
      if (idx >= 0) { var prev = cam.items[idx]; if (!it.videos.length && prev.videos.length) it.videos = prev.videos; if (!it.thumbs.length) it.thumbs = prev.thumbs; cam.items[idx] = it; } else cam.items.push(it);
    });
    renderCamItems();
  }
  function renderCamItems() {
    var F = state.result.format, el = $('cx-cam-list');
    el.innerHTML = cam.items.map(function (it, i) {
      var st = it.status || '—', cls = CameraServices.isReady(it.raw) ? 'ok' : CameraServices.isFailed(it.raw) ? 'bad' : 'wait';
      var vids = it.videos.map(function (v, j) {
        return '<div><video controls preload="metadata" src="' + esc(v.url) + '"></video><div class="cx-actions"><span class="cx-muted">' + esc(v.cameraId || 'camera') + (v.start ? ' · ' + esc(F.clock(Date.parse(v.start), true)) : '') + '</span>' +
          '<button class="cx-btn cx-btn-sm" data-dl="' + i + ':' + j + '">Download</button><a class="cx-btn cx-btn-sm" href="' + esc(v.url) + '" target="_blank" rel="noopener">Open</a></div></div>';
      }).join('');
      var thumbs = it.thumbs.length ? '<div class="thumbs">' + it.thumbs.map(function (u) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '"></a>'; }).join('') + '</div>' : '';
      return '<div class="cx-cam-item"><div class="h"><span><b>' + esc(it.ruleName || it.source || 'Media request') + '</b>' + (it.start ? ' · ' + esc(F.clock(Date.parse(it.start), true)) : '') + (it.end ? '–' + esc(F.clock(Date.parse(it.end), true).slice(-6)) : '') + '</span><span class="cx-pill ' + cls + '">' + esc(st) + '</span></div>' +
        (vids || (cls === 'wait' ? '<div class="cx-muted">Waiting for the camera to upload…</div>' : cls === 'bad' ? '<div class="cx-muted">' + esc(it.failureReason || 'Request failed on the camera side.') + '</div>' : '<div class="cx-muted">Ready but no video URL in the response — see call log.</div>')) + thumbs + '</div>';
    }).join('');
    el.querySelectorAll('[data-dl]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var ij = btn.dataset.dl.split(':'), v = cam.items[+ij[0]].videos[+ij[1]];
        var name = fileStem() + '_' + (cam.items[+ij[0]].ruleName || 'clip').replace(/[^a-z0-9]+/gi, '_') + '_' + (v.cameraId || ij[1]).replace(/[^a-z0-9]+/gi, '_') + '.mp4';
        btn.disabled = true; btn.textContent = 'Downloading…';
        fetch(v.url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); }).then(function (blob) { download(name, blob); })
          .catch(function () { window.open(v.url, '_blank'); }) // storage URL without CORS → open in a tab (browser's own save works there)
          .then(function () { btn.disabled = false; btn.textContent = 'Download'; });
      });
    });
  }

  // ---------- export ----------
  function buildExhibit() {
    var r = state.result; if (!r) return Promise.reject(new Error('Run an analysis first.'));
    return captureMap().then(function (mapUrl) {
      var assets = {
        logo: CollisionExhibit.LOGO, map: mapUrl, mapFailed: !mapUrl && !state.mapOverride,
        pulseChart: charts.pulse ? charts.pulse.toBase64Image('image/png', 1) : null,
        speedChart: charts.speed ? charts.speed.toBase64Image('image/png', 1) : null,
        reconImg: state.reconImg, photos: state.photos
      };
      return CollisionExhibit.build({
        result: r, inputs: state.inputs, client: state.client, bundle: state.bundle,
        timeline: state.edits.timeline || r.timeline, summary: state.edits.summary || r.summary, texts: currentTexts()
      }, assets);
    });
  }
  function openExhibit() {
    buildExhibit().then(function (html) {
      var w = window.open('', '_blank');
      if (!w) { showError('Pop-up blocked — allow pop-ups for MyGeotab, or use "Exhibit (.html)" and open the file.'); return; }
      w.document.open(); w.document.write(html); w.document.close();
    }).catch(function (e) { showError(e.message || String(e)); });
  }
  function exportHtml() {
    buildExhibit().then(function (html) { download(fileStem() + '.html', html, 'text/html'); }).catch(function (e) { showError(e.message || String(e)); });
  }
  function fileStem() {
    var r = state.result, name = (state.bundle.meta.deviceName || 'vehicle').replace(/[^a-z0-9]+/gi, '_');
    return 'Collision_Telemetry_Exhibit_' + name + '_' + r.format.iso(r.eventTime).slice(0, 10);
  }
  function saveCase() {
    var r = state.result;
    var out = { version: 1, savedAt: new Date().toISOString(), client: state.client, inputs: state.inputs, edits: state.edits,
      photos: state.photos, reconImg: state.reconImg, mapOverride: state.mapOverride, bundle: state.bundle,
      analysis: r ? JSON.parse(JSON.stringify(r, function (k, v) { return k === 'format' ? undefined : v; })) : null };
    download(fileStem() + '.case.json', JSON.stringify(out), 'application/json');
  }
  function loadCase(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var c = JSON.parse(fr.result);
        state = resetState(); state.bundle = c.bundle; state.inputs = c.inputs || state.inputs; state.edits = c.edits || state.edits;
        state.photos = c.photos || []; state.reconImg = c.reconImg || null; state.mapOverride = c.mapOverride || null; state.client = c.client || '';
        writeInputs(state.inputs); renderPhotos();
        $('cx-recon-img-preview').innerHTML = state.reconImg ? '<img src="' + state.reconImg + '">' : '';
        $('cx-map-override-preview').innerHTML = state.mapOverride ? '<img src="' + state.mapOverride + '">' : '';
        $('cx-work').style.display = ''; runAnalysis(); renderStatus();
      } catch (e) { showError('Could not open case file: ' + e.message); }
    };
    fr.readAsText(file);
  }
  function exportCsv() {
    var r = state.result; if (!r || !r.appendix) return showError('No forensic buffer to export.');
    var rows = [['Time (' + r.tzAbbrev + ')', 'Speed (mph)', 'Latitude', 'Longitude', 'Note']].concat(r.appendix.map(function (a) { return [a.clock, a.mph != null ? a.mph.toFixed(1) : '', a.lat, a.lon, a.note]; }));
    download(fileStem() + '_forensic_buffer.csv', rows.map(function (rw) { return rw.map(function (c) { var s = String(c == null ? '' : c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(','); }).join('\n'), 'text/csv');
  }

  // ---------- wiring ----------
  function wire() {
    $('cx-load').addEventListener('click', onLoad);
    $('cx-device-filter').addEventListener('input', function () { populateDevices(this.value); });
    $('cx-import-xlsx').addEventListener('click', function () { $('cx-xlsx-file').click(); });
    $('cx-xlsx-file').addEventListener('change', function () { if (this.files[0]) onImportXlsx(this.files[0]); this.value = ''; });
    $('cx-load-case').addEventListener('click', function () { $('cx-case-file').click(); });
    $('cx-case-file').addEventListener('change', function () { if (this.files[0]) loadCase(this.files[0]); this.value = ''; });
    $('cx-analyze').addEventListener('click', runAnalysis);
    ['cx-reported', 'cx-impact-config', 'cx-conditions', 'cx-location-label', 'cx-driver', 'cx-vehicle-desc', 'cx-pulse-threshold', 'cx-recon-time', 'cx-recon-fwd', 'cx-recon-lat', 'cx-recon-speed', 'cx-recon-gps', 'cx-recon-spd-acc', 'cx-recon-depicts', 'cx-client', 'cx-tz']
      .forEach(function (id) { $(id).addEventListener('change', function () { if (state.bundle) runAnalysis(); }); });
    $('cx-photos').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files); this.value = '';
      Promise.all(files.map(readFileAsDataUrl)).then(function (urls) {
        urls.forEach(function (u, i) { state.photos.push({ dataUrl: u, caption: files[i].name.replace(/\.[^.]+$/, ''), lat: null, lon: null, time: '' }); });
        renderPhotos(); if (state.bundle) runAnalysis();
      });
    });
    $('cx-recon-img').addEventListener('change', function () { var f = this.files[0]; if (!f) return; readFileAsDataUrl(f).then(function (u) { state.reconImg = u; $('cx-recon-img-preview').innerHTML = '<img src="' + u + '">'; }); });
    $('cx-map-override').addEventListener('change', function () { var f = this.files[0]; if (!f) { state.mapOverride = null; $('cx-map-override-preview').innerHTML = ''; return; } readFileAsDataUrl(f).then(function (u) { state.mapOverride = u; $('cx-map-override-preview').innerHTML = '<img src="' + u + '">'; if (state.bundle) runTextsOnly(); }); });
    $('cx-timeline-add').addEventListener('click', function () { ensureTimelineEdits().push({ label: '', text: '', kind: 'context' }); renderTimeline(); });
    $('cx-timeline-reset').addEventListener('click', function () { state.edits.timeline = null; renderTimeline(); });
    $('cx-summary-reset').addEventListener('click', function () { state.edits.summary = null; renderSummary(); });
    $('cx-open-exhibit').addEventListener('click', openExhibit);
    $('cx-cam-find').addEventListener('click', camFind);
    $('cx-cam-request').addEventListener('click', camRequest);
    $('cx-export-html').addEventListener('click', exportHtml);
    $('cx-save-case').addEventListener('click', saveCase);
    $('cx-export-csv').addEventListener('click', exportCsv);
  }
  function runTextsOnly() { renderTexts(); }

  // Expose a small debugging surface (also used by the test harness)
  var debugApi = { getState: function () { return state; }, runAnalysis: runAnalysis, buildExhibit: buildExhibit, captureMap: captureMap, importXlsxBuffer: function (buf) { var b = normalizeXlsx(buf); state = resetState(); state.bundle = b; state.client = b.meta.company || ''; $('cx-client').value = state.client; $('cx-tz').value = b.meta.timeZone; var cf = b.faults.filter(function (f) { return /collision/i.test(f.name); })[0]; var anchor = cf ? cf.t : b.gps[0].t; var p = epochToLocalParts(anchor, b.meta.timeZone); $('cx-event-date').value = p.date; $('cx-event-time').value = p.time; if (cf) $('cx-recon-time').value = p.time; return afterBundleLoaded(); } };

  return {
    initialize: function (freshApi, freshState, initializeCallback) {
      api = freshApi;
      elAddin = document.getElementById('collisionExhibit');
      window.__collisionExhibitDebug = debugApi;
      wire();
      var today = new Date().toISOString().slice(0, 10); $('cx-event-date').value = today;
      populateTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
      initializeCallback();
    },
    focus: function (freshApi) {
      api = freshApi;
      elAddin.className = '';
      if (api && api.getSession) {
        loadSession().then(function (s) { populateTz(s.timeZone); if (!$('cx-client').value && s.database) $('cx-client').value = s.database; return loadDevices(); })
          .catch(function (err) { showError('Failed to load devices: ' + (err && err.message ? err.message : err)); });
      }
      setTimeout(function () { if (map) map.invalidateSize(); }, 100);
    },
    blur: function () { elAddin.className = 'hidden'; }
  };
};
