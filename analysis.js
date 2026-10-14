/* eslint-disable */
/**
 * Collision Telemetry Exhibit — analysis engine.
 *
 * Pure functions over a normalized record bundle (see normalizeApiData in
 * collisionExhibit.js, or tools/xlsx_to_records.py for the same shape built
 * from an Advanced Log & Collisions export). No DOM, no API — runs in the
 * browser and in Node (test/validate_20v73.mjs).
 *
 * Bundle shape (all times epoch ms UTC):
 *   gps:      [{t, lat, lon, mph}]
 *   accel:    [{t, axis:'fwd'|'lat'|'vert', g}]      g = g-force, vert ~1.0 at rest
 *   status:   [{t, name, id, value, unit}]            non-accelerometer diagnostics
 *   faults:   [{t, name, controller, failureMode, diagId}]
 *   debug:    [{t, reason}]
 *   ignition: [{t, on}]
 *   trips:    [{start, stop, nextTripStart, distanceMi, driverName, maxSpeedMph, stopLat, stopLon}]
 *   driverChanges: [{t, type, driverName}]
 *   exceptions: [{t, ruleName, duration}]
 *   meta:     {deviceName, vin, vehicleDescription, timeZone, ...}
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CollisionAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FT_PER_M = 3.28084;
  var G_PER_MPH_S = 0.44704 / 9.80665;   // 1 mph/s in g  (≈0.0456)
  var G_PER_FT_S2 = 1 / 32.174;          // ft/s² → g
  var DEFAULTS = {
    pulseThresholdG: 0.5,      // deviation that counts as an impact-level excursion
    pulseGapS: 0.5,            // samples closer than this belong to one pulse
    bufferMinRun: 8,           // ≥ this many ~1 Hz GPS records = forensic buffer
    hardBrakingG: 0.35,        // per-crumb decel flagged as hard/panic braking
    swerveG: 0.30,             // pre-impact lateral excursion flagged as evasive input
    restSpeedMph: 0.6,
    sceneRadiusFt: 150,        // movement beyond this from rest = relocation
    approachLookbackS: 60
  };

  // ---------------------------------------------------------------- helpers
  function toRad(d) { return d * Math.PI / 180; }
  function haversineFt(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * FT_PER_M;
  }
  function bearingDeg(lat1, lon1, lat2, lon2) {
    var y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    var x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function compass(deg) {
    var pts = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
    return pts[Math.round(deg / 45) % 8];
  }
  function byT(a, b) { return a.t - b.t; }
  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function round(x, d) { var p = Math.pow(10, d == null ? 1 : d); return Math.round(x * p) / p; }
  function sgn(x, d) { var r = round(x, d); return (r > 0 ? '+' : '') + r.toFixed(d == null ? 1 : d); }

  /** Interpolate a {t,value} series at time t (linear, clamped). */
  function interp(series, key, t) {
    if (!series.length) return null;
    if (t <= series[0].t) return series[0][key];
    if (t >= series[series.length - 1].t) return series[series.length - 1][key];
    var lo = 0, hi = series.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (series[mid].t <= t) lo = mid; else hi = mid; }
    var a = series[lo], b = series[hi];
    if (b.t === a.t) return a[key];
    var f = (t - a.t) / (b.t - a.t);
    return a[key] + (b[key] - a[key]) * f;
  }
  function bracket(series, t) {
    var before = null, after = null;
    for (var i = 0; i < series.length; i++) {
      if (series[i].t <= t) before = series[i]; else { after = series[i]; break; }
    }
    return { before: before, after: after };
  }

  // ------------------------------------------------------------- formatting
  function makeFormatter(timeZone) {
    var tz = timeZone || 'UTC';
    var cache = {};
    function fmt(opts) {
      var k = JSON.stringify(opts);
      if (!cache[k]) cache[k] = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, opts));
      return cache[k];
    }
    function parts(ms, opts) {
      var o = {}; fmt(opts).formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
      return o;
    }
    var F = {
      timeZone: tz,
      tzAbbrev: function (ms) { return parts(ms, { timeZoneName: 'short', hour: 'numeric' }).timeZoneName || tz; },
      tzLong: function (ms) { return parts(ms, { timeZoneName: 'long', hour: 'numeric' }).timeZoneName || tz; },
      /** 8:22:15 AM */
      time: function (ms) {
        var p = parts(ms, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
        return p.hour + ':' + p.minute + ':' + p.second + ' ' + p.dayPeriod;
      },
      /** 08:22:15.120 (24h, ms) — used in tables/charts */
      clock: function (ms, frac) {
        var p = parts(ms, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        var s = p.hour + ':' + p.minute + ':' + p.second;
        if (frac) { var f = Math.round(ms % 1000); s += '.' + String(f < 0 ? f + 1000 : f).padStart(3, '0'); }
        return s;
      },
      /** 8:22:15.1 AM */
      timeTenths: function (ms) {
        var p = parts(ms, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
        var tenth = Math.floor((ms % 1000) / 100);
        return p.hour + ':' + p.minute + ':' + p.second + (tenth ? '.' + tenth : '') + ' ' + p.dayPeriod;
      },
      hm: function (ms) {
        var p = parts(ms, { hour: 'numeric', minute: '2-digit', hour12: true });
        return p.hour + ':' + p.minute + ' ' + p.dayPeriod;
      },
      dateLong: function (ms) {
        return fmt({ month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ms));
      },
      dateShort: function (ms) { return fmt({ month: '2-digit', day: '2-digit', year: '2-digit' }).format(new Date(ms)); },
      iso: function (ms) { return new Date(ms).toISOString(); }
    };
    return F;
  }

  // ----------------------------------------------------------- core blocks
  function detectForensicBuffer(gps, eventTime, cfg) {
    // Runs of consecutive GPS records at ~1 s spacing. API LogRecords carry no
    // log reason, so cadence is the detector; the report's "Accident" reason is
    // only available from an xlsx bundle and is reported alongside when present.
    // Collapse near-duplicate timestamps (e.g. 16.000 and 16.003 — a curve record
    // and a buffer record for the same fix) so they don't break the cadence run.
    var pts = [];
    gps.forEach(function (g) {
      if (pts.length && g.t - pts[pts.length - 1].t < 100) {
        if (g.reason === 'Accident') pts[pts.length - 1] = g;
        return;
      }
      pts.push(g);
    });
    var runs = [], start = 0;
    for (var i = 1; i <= pts.length; i++) {
      var dt = i < pts.length ? (pts[i].t - pts[i - 1].t) / 1000 : Infinity;
      // 1 Hz cadence; allow a 2 s gap (the buffer's closing zero-speed record often lands 2 s out)
      if (!(dt >= 0.5 && dt <= 2.5)) {
        if (i - start >= cfg.bufferMinRun) runs.push({ startIdx: start, endIdx: i - 1 });
        start = i;
      }
    }
    if (!runs.length) return null;
    var best = null, bestDist = Infinity;
    runs.forEach(function (r) {
      var s = pts[r.startIdx].t, e = pts[r.endIdx].t;
      var d = eventTime == null ? 0 : (eventTime < s ? s - eventTime : eventTime > e ? eventTime - e : 0);
      if (d < bestDist) { bestDist = d; best = r; }
    });
    if (eventTime != null && bestDist > 10 * 60 * 1000) return null;
    var accidentTagged = gps.filter(function (g) { return g.reason === 'Accident'; }).length;
    return {
      start: pts[best.startIdx].t, end: pts[best.endIdx].t,
      count: gps.filter(function (g) { return g.t >= pts[best.startIdx].t && g.t <= pts[best.endIdx].t; }).length,
      records: gps.filter(function (g) { return g.t >= pts[best.startIdx].t && g.t <= pts[best.endIdx].t; }),
      accidentTaggedCount: accidentTagged || null
    };
  }

  function characterizePulse(accel, eventTime, baseline, cfg) {
    var win = accel.filter(function (a) { return Math.abs(a.t - eventTime) <= 120000; });
    if (!win.length) return { found: false, reason: 'No accelerometer samples within ±2 minutes of the event time.' };
    function dev(a) { return a.axis === 'vert' ? Math.abs(a.g - baseline) : Math.abs(a.g); }
    var hot = win.filter(function (a) { return dev(a) >= cfg.pulseThresholdG; }).sort(byT);
    var maxDev = win.reduce(function (m, a) { return dev(a) > dev(m) ? a : m; }, win[0]);
    if (!hot.length) {
      return {
        found: false, maxSample: maxDev, maxDeviationG: dev(maxDev),
        reason: 'No accelerometer excursion reached ' + cfg.pulseThresholdG.toFixed(1) +
          ' g within ±2 minutes of the event time (largest: ' + dev(maxDev).toFixed(2) + ' g on the ' +
          axisLabel(maxDev.axis) + ' axis at ' + maxDev.t + ').'
      };
    }
    // cluster hot samples into pulses; pick the cluster containing the max deviation
    var clusters = [], cur = [hot[0]];
    for (var i = 1; i < hot.length; i++) {
      if ((hot[i].t - hot[i - 1].t) / 1000 <= cfg.pulseGapS) cur.push(hot[i]);
      else { clusters.push(cur); cur = [hot[i]]; }
    }
    clusters.push(cur);
    var peakSample = hot.reduce(function (m, a) { return dev(a) > dev(m) ? a : m; }, hot[0]);
    var cl = clusters.filter(function (c) { return c.indexOf(peakSample) >= 0; })[0];
    var excStart = cl[0].t, excEnd = cl[cl.length - 1].t;
    // Pulse core: the contiguous part of the excursion at ≥ 50 % of the peak
    // deviation. The decay tail (0.5–0.7 g residuals) is reported separately as
    // the excursion window so duration isn't inflated by it.
    var coreThr = Math.max(cfg.pulseThresholdG, 0.5 * dev(peakSample));
    var core = cl.filter(function (a) { return dev(a) >= coreThr; });
    var start = core[0].t, end = core[core.length - 1].t;
    var peaks = {};
    ['fwd', 'lat', 'vert'].forEach(function (ax) {
      var s = win.filter(function (a) { return a.axis === ax && a.t >= excStart - 60 && a.t <= excEnd + 60; });
      if (!s.length) { peaks[ax] = null; return; }
      var p = s.reduce(function (m, a) { return dev(a) > dev(m) ? a : m; }, s[0]);
      peaks[ax] = { g: p.g, t: p.t, devG: dev(p) };
    });
    var L = peaks.fwd ? peaks.fwd.devG : 0, S = peaks.lat ? peaks.lat.devG : 0, V = peaks.vert ? peaks.vert.devG : 0;
    var hi = Math.max(L, S), lo = Math.min(L, S);
    var composition, compositionText;
    if (S < 0.4 * L && V < 0.4 * L) {
      composition = 'longitudinal';
      compositionText = 'Pure longitudinal pulse — consistent with hard braking or a frontal/rear impact along the vehicle axis; no lateral or vertical component of note.';
    } else if (L < 0.4 * S) {
      composition = V >= 0.5 * S ? 'lateral-vertical' : 'lateral';
      compositionText = composition === 'lateral'
        ? 'Lateral-dominant pulse — consistent with side contact or a broadside load; the longitudinal axis shows little change.'
        : 'Lateral plus vertical pulse with little longitudinal change — at low speed this pattern matches curb strike, terrain, or low-speed side contact; at higher speed it matches a broadside load.';
    } else if (lo >= 0.6 * hi) {
      composition = V >= 0.5 * hi ? 'tri-axial' : 'longitudinal-lateral';
      compositionText = composition === 'tri-axial'
        ? 'Near-equal longitudinal and lateral peaks with a pronounced vertical excursion — a tri-axial pulse. This pattern arises from terrain traversal or from a frontal strike into a crossing vehicle with front-end override of the struck vehicle\'s structure; scene evidence decides which.'
        : 'Combined longitudinal and lateral pulse of similar magnitude — consistent with an angled impact or a frontal strike into a crossing vehicle.';
    } else {
      composition = 'mixed';
      compositionText = 'Mixed pulse with unequal axis contributions — interpret with scene evidence.';
    }
    // previous collisions by the same threshold anywhere else in data
    return {
      found: true, start: start, end: end, durationS: (end - start) / 1000,
      excursionStart: excStart, excursionEnd: excEnd, excursionDurationS: (excEnd - excStart) / 1000,
      peaks: peaks, peakSample: peakSample, peakTime: peakSample.t,
      composition: composition, compositionText: compositionText,
      samples: win.filter(function (a) { return a.t >= excStart - 1500 && a.t <= excEnd + 1500; }).sort(byT),
      verticalBaseline: baseline
    };
  }

  function axisLabel(ax) { return ax === 'fwd' ? 'longitudinal' : ax === 'lat' ? 'lateral' : 'vertical'; }

  /** Two-segment piecewise-linear fit of speed vs time; returns slopes (mph/s). */
  function fitDecelPhases(pts) {
    // pts: [{t, mph}] sorted, t in ms
    if (pts.length < 3) return null;
    var t0 = pts[0].t; // fit in seconds relative to the first point (epoch-ms values lose precision in the normal equations)
    function fit(seg) {
      var n = seg.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
      seg.forEach(function (p) { var x = (p.t - t0) / 1000, y = p.mph; sx += x; sy += y; sxx += x * x; sxy += x * y; });
      var den = n * sxx - sx * sx;
      var m = den === 0 ? 0 : (n * sxy - sx * sy) / den, b = (sy - m * sx) / n;
      var sse = 0; seg.forEach(function (p) { var e = p.mph - (m * (p.t - t0) / 1000 + b); sse += e * e; });
      return { slope: m, intercept: b, sse: sse, n: n };
    }
    var single = fit(pts);
    var best = null;
    for (var k = 2; k <= pts.length - 2; k++) {
      var a = fit(pts.slice(0, k + 1)), b = fit(pts.slice(k));
      var sse = a.sse + b.sse;
      if (!best || sse < best.sse) best = { k: k, a: a, b: b, sse: sse };
    }
    var phases;
    if (best && best.sse < 0.6 * single.sse && Math.abs(best.a.slope - best.b.slope) > 0.8) {
      phases = [
        { start: pts[0].t, end: pts[best.k].t, mphPerS: -best.a.slope, g: -best.a.slope * G_PER_MPH_S,
          fromMph: pts[0].mph, toMph: pts[best.k].mph },
        { start: pts[best.k].t, end: pts[pts.length - 1].t, mphPerS: -best.b.slope, g: -best.b.slope * G_PER_MPH_S,
          fromMph: pts[best.k].mph, toMph: pts[pts.length - 1].mph }
      ];
    } else {
      phases = [{ start: pts[0].t, end: pts[pts.length - 1].t, mphPerS: -single.slope, g: -single.slope * G_PER_MPH_S,
        fromMph: pts[0].mph, toMph: pts[pts.length - 1].mph }];
    }
    phases.forEach(function (p) {
      p.label = p.mphPerS < 0.5 ? 'coasting' : p.mphPerS < 2 ? 'gentle' : p.mphPerS < 4 ? 'firm' : p.mphPerS < 7 ? 'hard' : 'severe';
    });
    return phases;
  }

  function analyzeApproach(gps, pulseTime, cfg) {
    var seg = gps.filter(function (g) { return g.t >= pulseTime - cfg.approachLookbackS * 1000 && g.t <= pulseTime && g.mph != null; });
    if (seg.length < 3) return null;
    // speed peak within lookback, then braking onset = last time speed was within 1 mph of that peak before the final descent
    var peak = seg.reduce(function (m, g) { return g.mph > m.mph ? g : m; }, seg[0]);
    // onset = first record after the speed plateau that reads below (peak − 1 mph);
    // the braking fit runs from the last plateau record so the first drop is included.
    var lastPlateau = seg.indexOf(peak);
    for (var i = seg.indexOf(peak); i < seg.length - 1; i++) {
      if (seg[i].mph >= peak.mph - 1.0) lastPlateau = i; else break;
    }
    var onsetIdx = Math.min(lastPlateau + 1, seg.length - 1);
    var onset = { t: seg[onsetIdx].t, mph: peak.mph };
    var braking = seg.slice(lastPlateau);
    // per-crumb decel
    var crumbs = [];
    for (var j = 1; j < seg.length; j++) {
      var dt = (seg[j].t - seg[j - 1].t) / 1000;
      if (dt <= 0) continue;
      var d = -(seg[j].mph - seg[j - 1].mph) / dt;
      crumbs.push({ t: seg[j].t, mphPerS: d, g: d * G_PER_MPH_S });
    }
    var maxDecel = crumbs.reduce(function (m, c) { return (!m || c.g > m.g) ? c : m; }, null);
    var phases = braking.length >= 3 ? fitDecelPhases(braking) : null;
    var totalDropMph = onset.mph - braking[braking.length - 1].mph;
    return {
      lookbackS: cfg.approachLookbackS, peakMph: peak.mph, peakTime: peak.t,
      onset: totalDropMph > 3 ? { t: onset.t, mph: onset.mph } : null,
      brakingDurationS: totalDropMph > 3 ? (pulseTime - onset.t) / 1000 : 0,
      phases: totalDropMph > 3 ? phases : null,
      maxCrumbDecel: maxDecel, hardBraking: !!(maxDecel && maxDecel.g >= cfg.hardBrakingG),
      speeds: seg.map(function (g) { return { t: g.t, mph: g.mph }; })
    };
  }

  function analyzePostEvent(gps, status, ignition, trips, pulseTime, pulsePos, dataEnd, cfg) {
    var after = gps.filter(function (g) { return g.t >= pulseTime; });
    var rest = null;
    for (var i = 0; i < after.length; i++) {
      var g = after[i];
      if (g.mph != null && g.mph <= cfg.restSpeedMph) {
        // sustained: all records in next 15 s also at/near zero
        var ok = after.filter(function (h) { return h.t > g.t && h.t <= g.t + 15000; })
          .every(function (h) { return h.mph == null || h.mph <= cfg.restSpeedMph + 0.5; });
        if (ok) { rest = g; break; }
      }
    }
    var result = { rest: null };
    if (!rest) return result;
    // roll-out: path length from pulse position through crumbs to rest
    var path = 0, prev = pulsePos;
    after.filter(function (h) { return h.t > pulseTime && h.t <= rest.t; }).forEach(function (h) {
      if (prev) path += haversineFt(prev.lat, prev.lon, h.lat, h.lon);
      prev = h;
    });
    result.rest = { t: rest.t, lat: rest.lat, lon: rest.lon };
    result.rollOutFt = pulsePos ? round(path, 0) : null;
    result.rollOutStraightFt = pulsePos ? round(haversineFt(pulsePos.lat, pulsePos.lon, rest.lat, rest.lon), 0) : null;
    result.timeToRestS = (rest.t - pulseTime) / 1000;

    // movement intervals after rest (GPS speed or engine road speed)
    var moves = after.filter(function (h) { return h.t > rest.t && h.mph != null && h.mph > cfg.restSpeedMph; })
      .map(function (h) { return { t: h.t, mph: h.mph, lat: h.lat, lon: h.lon, src: 'gps' }; });
    status.filter(function (s) { return s.t > rest.t && /engine road speed/i.test(s.name) && s.value > cfg.restSpeedMph; })
      .forEach(function (s) { moves.push({ t: s.t, mph: s.value, src: 'engine' }); });
    moves.sort(byT);
    var intervals = [], cur = null;
    moves.forEach(function (m) {
      if (cur && m.t - cur.end <= 10000) {
        cur.end = m.t; cur.maxMph = Math.max(cur.maxMph, m.mph); cur.minMph = Math.min(cur.minMph, m.mph);
        if (m.lat != null) cur.maxDistFt = Math.max(cur.maxDistFt, haversineFt(rest.lat, rest.lon, m.lat, m.lon));
      } else {
        if (cur) intervals.push(cur);
        cur = { start: m.t, end: m.t, maxMph: m.mph, minMph: m.mph,
          maxDistFt: m.lat != null ? haversineFt(rest.lat, rest.lon, m.lat, m.lon) : 0 };
      }
    });
    if (cur) intervals.push(cur);
    intervals = intervals.filter(function (iv) { return iv.maxMph >= 2 || iv.maxDistFt >= 50; });
    intervals.forEach(function (iv) {
      // displacement: any GPS crumb during/after interval far from rest
      var far = after.filter(function (h) { return h.t >= iv.start && h.t <= iv.end + 10000; })
        .reduce(function (m, h) { return Math.max(m, haversineFt(rest.lat, rest.lon, h.lat, h.lon)); }, iv.maxDistFt);
      iv.maxDistFt = round(far, 0);
      iv.kind = far >= cfg.sceneRadiusFt ? 'relocation' : 'repositioning';
    });
    result.movements = intervals;
    var leftScene = intervals.filter(function (iv) { return iv.kind === 'relocation'; })[0] || null;
    result.leftSceneAt = leftScene ? leftScene.start : null;

    // ignition off after event
    var ignOff = ignition.filter(function (x) { return !x.on && x.t > pulseTime; })[0];
    var trip = trips.filter(function (tr) { return tr.start <= pulseTime && (tr.stop == null || tr.stop >= pulseTime - 1000); })[0];
    var offT = ignOff ? ignOff.t : (trip && trip.stop ? trip.stop : null);
    result.ignitionOff = offT;
    result.ignitionOffSource = ignOff ? 'ignition diagnostic' : (trip ? 'trip stop' : null);
    result.engineRunningAfterRestMin = offT ? round((offT - rest.t) / 60000, 0) : null;
    result.ignitionOnAgain = ignition.filter(function (x) { return x.on && offT && x.t > offT; }).map(function (x) { return x.t; });
    // movement after ignition off = tow / relocation while off
    var lastPos = rest;
    var farAfterOff = gps.filter(function (h) { return offT && h.t > offT; })
      .reduce(function (m, h) { return Math.max(m, haversineFt(rest.lat, rest.lon, h.lat, h.lon)); }, 0);
    result.movedAfterIgnitionOffFt = round(farAfterOff, 0);
    result.dataEnd = dataEnd;
    var lastGps = gps[gps.length - 1];
    result.finalPosition = lastGps ? { t: lastGps.t, lat: lastGps.lat, lon: lastGps.lon,
      distFromRestFt: round(haversineFt(rest.lat, rest.lon, lastGps.lat, lastGps.lon), 0) } : null;
    return result;
  }

  function classifyFaults(faults, eventTime) {
    return faults.slice().sort(byT).map(function (f) {
      var dt = (f.t - eventTime) / 1000;
      var phase = dt < -5 ? 'pre-event' : dt <= 5 ? 'at-impact' : 'post-event';
      var n = (f.name || '').toLowerCase();
      var cat = /collision/.test(n) || f.diagId === 'DiagnosticAccidentLevelAccelerationEventId' ? 'collision'
        : /unplug|power removed|all power|battery/.test(n) ? 'power'
        : /tpms|tire/.test(n) ? 'tpms'
        : /can|network|bus|communication|j1939|obd/.test(n) ? 'network'
        : /evap|emission|catalyst|o2|oxygen/.test(n) ? 'emissions'
        : 'other';
      return Object.assign({}, f, { phase: phase, category: cat, offsetS: round(dt, 1) });
    });
  }

  function reconCheck(recon, accel, pulse, baseline) {
    if (!recon || recon.triggerTime == null) return null;
    var out = { triggerTime: recon.triggerTime, stated: {}, raw: {}, lagS: null, missedPeak: false };
    var axes = { fwd: recon.fwdFtS2, lat: recon.latFtS2, vert: recon.vertFtS2 };
    Object.keys(axes).forEach(function (ax) {
      if (axes[ax] == null || isNaN(axes[ax])) return;
      var g = axes[ax] * G_PER_FT_S2;
      var series = accel.filter(function (a) { return a.axis === ax; }).sort(byT);
      var br = bracket(series, recon.triggerTime);
      var near = series.filter(function (a) { return Math.abs(a.t - recon.triggerTime) <= 3000; })
        .reduce(function (m, a) { return (!m || Math.abs(a.g - g) < Math.abs(m.g - g)) ? a : m; }, null);
      out.stated[ax] = { ftS2: axes[ax], g: g };
      out.raw[ax] = {
        atTrigger: br.before ? { g: br.before.g, t: br.before.t } : null,
        interpolated: series.length ? interp(series, 'g', recon.triggerTime) : null,
        matchingSample: near ? { g: near.g, t: near.t } : null,
        peak: pulse && pulse.found && pulse.peaks[ax] ? pulse.peaks[ax] : null
      };
      if (pulse && pulse.found && pulse.peaks[ax] && ax !== 'vert') {
        if (Math.abs(g) < 0.6 * pulse.peaks[ax].devG) out.missedPeak = true;
      }
    });
    if (pulse && pulse.found) out.lagS = round((recon.triggerTime - pulse.peakTime) / 1000, 1);
    return out;
  }

  // -------------------------------------------------------------- analyze()
  function analyze(bundle, inputs, options) {
    var cfg = Object.assign({}, DEFAULTS, options || {});
    inputs = inputs || {};
    var tz = inputs.timeZone || (bundle.meta && bundle.meta.timeZone) || 'UTC';
    var F = makeFormatter(tz);
    var warnings = [];

    var gps = (bundle.gps || []).filter(function (g) { return g.lat != null && g.lon != null; }).sort(byT);
    var accel = (bundle.accel || []).slice().sort(byT);
    var status = (bundle.status || []).slice().sort(byT);
    var faults = (bundle.faults || []).slice().sort(byT);
    var ignition = (bundle.ignition || []).slice().sort(byT);
    var trips = (bundle.trips || []).slice().sort(function (a, b) { return a.start - b.start; });
    var debug = (bundle.debug || []).slice().sort(byT);
    var dataEnd = Math.max.apply(null, [].concat(gps, accel, status, faults, debug).map(function (r) { return r.t; }).concat([0]));
    var dataStart = Math.min.apply(null, [].concat(gps, accel, status).map(function (r) { return r.t; }).concat([Infinity]));

    // event time: user-stated → collision fault → largest accelerometer excursion
    var collisionFault = faults.filter(function (f) {
      return f.diagId === 'DiagnosticAccidentLevelAccelerationEventId' || /collision/i.test(f.name || '');
    })[0] || null;
    var eventTime = inputs.eventTime != null ? inputs.eventTime : null;
    var eventTimeSource = eventTime != null ? 'stated' : null;
    if (eventTime == null && collisionFault) { eventTime = collisionFault.t; eventTimeSource = 'collision fault'; }
    var vertAll = accel.filter(function (a) { return a.axis === 'vert'; });
    var vertQuiet = eventTime != null ? vertAll.filter(function (a) { return Math.abs(a.t - eventTime) > 10000; }) : vertAll;
    var baseline = median((vertQuiet.length >= 5 ? vertQuiet : vertAll).map(function (a) { return a.g; }));
    if (baseline == null) baseline = 1.0;
    if (eventTime == null && accel.length) {
      baseline = median(vertAll.map(function (a) { return a.g; })) || 1.0;
      var mx = accel.reduce(function (m, a) {
        var d = a.axis === 'vert' ? Math.abs(a.g - baseline) : Math.abs(a.g);
        return d > m.d ? { d: d, a: a } : m;
      }, { d: -1, a: null });
      eventTime = mx.a.t; eventTimeSource = 'largest accelerometer excursion';
      vertQuiet = vertAll.filter(function (a) { return Math.abs(a.t - eventTime) > 10000; });
      baseline = median((vertQuiet.length >= 5 ? vertQuiet : vertAll).map(function (a) { return a.g; })) || 1.0;
    }
    if (eventTime == null) { eventTime = gps.length ? gps[Math.floor(gps.length / 2)].t : Date.now(); eventTimeSource = 'data midpoint (no event evidence)'; warnings.push('No event time supplied and no collision fault or accelerometer excursion found; analysis anchored to the data midpoint.'); }

    var buffer = detectForensicBuffer(gps, eventTime, cfg);
    var pulse = characterizePulse(accel, eventTime, baseline, cfg);
    var pulseTime = pulse.found ? pulse.peakTime : eventTime;
    var speedSeries = gps.filter(function (g) { return g.mph != null; });
    var pulsePos = gps.length ? { lat: interp(gps, 'lat', pulseTime), lon: interp(gps, 'lon', pulseTime) } : null;
    var br = bracket(speedSeries, pulseTime);
    var speedAtPulse = speedSeries.length ? interp(speedSeries, 'mph', pulseTime) : null;
    // speed through the pulse: from the fix preceding the pulse down to the value interpolated at pulse end
    var speedRange = null;
    if (br.before && br.after) {
      var endT = pulse.found ? pulse.end : pulseTime;
      var vEnd = interp(speedSeries, 'mph', endT), vStart = interp(speedSeries, 'mph', pulse.found ? pulse.start : pulseTime);
      var lo = Math.min(vEnd, vStart), hi = Math.max(br.before.mph, vStart);
      speedRange = [Math.floor(lo), Math.round(hi)];
      if (speedRange[1] - speedRange[0] < 2) speedRange = [Math.round((lo + hi) / 2), Math.round((lo + hi) / 2)];
    }
    var heading = null;
    if (gps.length > 1) {
      var hb = bracket(gps, pulseTime - 3000), ha = bracket(gps, pulseTime);
      var p1 = hb.before || gps[0], p2 = ha.before || gps[gps.length - 1];
      if (p1 !== p2) heading = bearingDeg(p1.lat, p1.lon, p2.lat, p2.lon);
    }
    var engineSpeedAtPulse = (function () {
      var s = status.filter(function (x) { return /engine road speed/i.test(x.name); });
      var b = bracket(s, pulseTime); return b.before && pulseTime - b.before.t < 10000 ? b.before : null;
    })();

    var approach = analyzeApproach(gps, pulseTime, cfg);
    var post = analyzePostEvent(gps, status, ignition, trips, pulseTime, pulsePos, dataEnd, cfg);
    var faultsC = classifyFaults(faults, eventTime);
    var recon = reconCheck(inputs.recon, accel, pulse, baseline);

    // pre-impact lateral excursion (evasive input)
    var swerve = accel.filter(function (a) {
      return a.axis === 'lat' && a.t < (pulse.found ? pulse.start : eventTime) - 100 && a.t > eventTime - 30000 && Math.abs(a.g) >= cfg.swerveG;
    });
    // other excursions elsewhere in data
    var otherExcursions = accel.filter(function (a) {
      var d = a.axis === 'vert' ? Math.abs(a.g - baseline) : Math.abs(a.g);
      return d >= cfg.pulseThresholdG && (!pulse.found || a.t < pulse.start - 2000 || a.t > pulse.end + 2000);
    });

    // trip containing the event
    var trip = trips.filter(function (tr) { return tr.start <= eventTime && (tr.stop == null || tr.stop >= eventTime - 1000); })[0] || null;
    var ignOn = ignition.filter(function (x) { return x.on && x.t <= eventTime; }).pop() || null;
    var tripStart = trip ? trip.start : (ignOn ? ignOn.t : (gps.length ? gps[0].t : null));
    var tripStartPos = gps.filter(function (g) { return tripStart == null || g.t >= tripStart - 1000; })[0] || null;
    var tripDistanceMi = trip && trip.distanceMi != null ? trip.distanceMi : (function () {
      var d = 0; var seg = gps.filter(function (g) { return g.t >= (tripStart || 0) && g.t <= (post.ignitionOff || dataEnd); });
      for (var i = 1; i < seg.length; i++) d += haversineFt(seg[i - 1].lat, seg[i - 1].lon, seg[i].lat, seg[i].lon);
      return round(d / 5280, 0);
    })();

    // driver identity
    var driverName = (trip && trip.driverName) || null;
    var driverSource = driverName ? 'Geotab Drive pairing on the trip record' : null;
    var dc = (bundle.driverChanges || []).filter(function (d) { return d.t <= eventTime + 3600000; });
    if (!driverName && dc.length && dc[dc.length - 1].driverName) { driverName = dc[dc.length - 1].driverName; driverSource = 'driver change record (' + dc[dc.length - 1].type + ')'; }

    // status signals near the event (brake, seatbelt, turn signals, gear, door)
    var signals = status.filter(function (s) {
      return Math.abs(s.t - pulseTime) <= 90000 && /brake|seatbelt|turn signal|gear|door|airbag|cruise/i.test(s.name);
    });

    // ------------------------------------------------------------ timeline
    var T = [];
    function add(t, text, kind) { if (t != null) T.push({ t: t, text: text, kind: kind || 'context' }); }
    var addr = inputs.addresses || {};
    if (tripStart != null) add(tripStart, 'Ignition on; departs ' + (addr.tripStart || 'trip origin') +
      (heading != null ? ', ' + compass(heading) + 'bound toward the incident location' : '') + '.', 'trip');
    if (buffer) {
      var b0 = buffer.records[0];
      add(buffer.start, '1-second forensic GPS buffering begins; ' + round(b0.mph, 0) + ' mph' +
        (heading != null ? ' ' + compass(heading) + 'bound' : '') +
        (pulsePos ? ', ~' + round(haversineFt(b0.lat, b0.lon, pulsePos.lat, pulsePos.lon) / 5280, 1) + ' mi before the recorded pulse location' : '') + '.', 'buffer');
    }
    if (approach && approach.onset) {
      var ph = approach.phases || [];
      var phTxt = ph.length === 2
        ? ' — ' + ph[0].label + ' (~' + round(ph[0].mphPerS, 1) + ' mph/s) through ' + F.time(ph[0].end) + ', then ' + ph[1].label + ' (~' + round(ph[1].mphPerS, 1) + ' mph/s, ~' + round(ph[1].g, 2) + ' g) through ' + F.time(ph[1].end)
        : ph.length === 1 ? ' — ' + ph[0].label + ' (~' + round(ph[0].mphPerS, 1) + ' mph/s, ~' + round(ph[0].g, 2) + ' g)' : '';
      add(approach.onset.t, 'Deceleration begins from ' + round(approach.onset.mph, 0) + ' mph' + phTxt +
        '. ' + (swerve.length ? 'Lateral excursion of ' + round(Math.max.apply(null, swerve.map(function (s) { return Math.abs(s.g); })), 2) + ' g recorded before the pulse — possible evasive input.' : 'No impact signature anywhere in this phase.'), 'approach');
    }
    if (pulse.found) {
      var pk = pulse.peaks;
      add(pulse.peakTime, 'RECORDED IMPACT PULSE at ' + (speedRange ? '~' + (speedRange[0] === speedRange[1] ? speedRange[0] : speedRange[0] + '–' + speedRange[1]) + ' mph' : (speedAtPulse != null ? '~' + round(speedAtPulse, 0) + ' mph' : 'unknown speed')) +
        ': peak ' + (pk.lat ? sgn(pk.lat.g, 2) + ' g lateral, ' : '') + (pk.fwd ? sgn(pk.fwd.g, 2) + ' g longitudinal' : '') + (pk.vert ? ', ' + sgn(pk.vert.g, 2) + ' g vertical' : '') +
        ' over ~' + round(pulse.durationS, 1) + ' s. ' + pulse.compositionText, 'impact');
    } else {
      add(eventTime, 'Event time (' + eventTimeSource + '). ' + pulse.reason, 'impact');
    }
    if (collisionFault) add(collisionFault.t, 'Geotab "' + collisionFault.name + '" fault logs' + (recon ? '; Collision Reconstruction trigger timestamp' : '') + '.', 'fault');
    if (post.rest) {
      add(post.rest.t, 'Vehicle at rest' + (post.rollOutFt != null ? ' ~' + post.rollOutFt + ' ft past the pulse location' : '') +
        (addr.rest ? ' (' + addr.rest + ')' : '') + ', ' + round(post.timeToRestS, 0) + ' s after the pulse.', 'rest');
      (post.movements || []).forEach(function (iv) {
        if (iv.kind === 'repositioning') add(iv.start, 'Brief low-speed repositioning (' + round(iv.minMph, 0) + '–' + round(iv.maxMph, 0) + ' mph, within ~' + iv.maxDistFt + ' ft); vehicle remains at the rest location.', 'post');
        else add(iv.start, 'Vehicle leaves the rest location (moves ~' + iv.maxDistFt + ' ft, up to ' + round(iv.maxMph, 0) + ' mph).', 'post');
      });
    }
    faultsC.filter(function (f) { return f.category !== 'collision'; }).forEach(function (f) {
      add(f.t, f.name + ' fault logs' + (f.controller ? ' (' + f.controller + ')' : '') + ' — ' + f.phase +
        (f.phase === 'pre-event' ? '; pre-existing, not attributable to the event.' : f.phase === 'at-impact' ? '; coincident with the impact.' : '.'), 'fault');
    });
    if (post.ignitionOff) add(post.ignitionOff, 'Ignition switched off' + (post.engineRunningAfterRestMin != null ? ' — engine had been left running ~' + post.engineRunningAfterRestMin + ' minutes post-event' : '') + '.', 'post');
    if (post.rest && dataEnd) add(dataEnd, (post.movedAfterIgnitionOffFt >= cfg.sceneRadiusFt ? 'Vehicle relocated ~' + post.movedAfterIgnitionOffFt + ' ft from the rest position after ignition off (tow/recovery).' : 'No further movement') + ' through the end of the data (' + F.time(dataEnd) + ').', 'context');
    T.sort(byT);
    T.forEach(function (row) { row.label = (row.kind === 'impact' && pulse.found) || (row.kind === 'fault' && Math.abs(row.t - pulseTime) < 10000) ? F.timeTenths(row.t) : F.time(row.t); });

    // ----------------------------------------------------------- summary table
    var S = [];
    S.push(['Collision fault', collisionFault ? '"' + collisionFault.name + '" at ' + F.clock(collisionFault.t, true) : 'None logged in the export window']);
    if (pulse.found) {
      var pk2 = pulse.peaks;
      S.push(['Peak accelerometer readings', [pk2.lat && sgn(pk2.lat.g, 3) + ' g lateral (' + F.clock(pk2.lat.t, true) + ')', pk2.fwd && sgn(pk2.fwd.g, 3) + ' g longitudinal (' + F.clock(pk2.fwd.t, true) + ')', pk2.vert && sgn(pk2.vert.g, 3) + ' g vertical (' + F.clock(pk2.vert.t, true) + ')'].filter(Boolean).join(' / ') + ', in one ~' + round(pulse.durationS, 1) + ' s pulse']);
    } else {
      S.push(['Accelerometer', pulse.reason]);
    }
    if (recon) {
      var rs = recon.stated, rr = recon.raw;
      var parts = [];
      if (rs.fwd) parts.push(round(rs.fwd.ftS2, 2) + ' ft/s² longitudinal');
      if (rs.lat) parts.push(round(rs.lat.ftS2, 2) + ' ft/s² lateral');
      var gparts = [];
      if (rs.fwd) gparts.push(sgn(rs.fwd.g, 2) + ' g'); if (rs.lat) gparts.push(sgn(rs.lat.g, 2) + ' g');
      S.push(['Reconstruction sample vs. peak', 'Recon report values (' + parts.join(' / ') + ' = ' + gparts.join(' / ') + ') ' +
        (recon.lagS != null && Math.abs(recon.lagS) >= 0.3 ? 'reflect the trigger-time sample ~' + Math.abs(recon.lagS) + ' s ' + (recon.lagS > 0 ? 'after' : 'before') + ' the peak' : 'align with the recorded peak') +
        (recon.missedPeak ? '; the ' + (rs.fwd && rr.fwd.peak && Math.abs(rs.fwd.g) < 0.6 * rr.fwd.peak.devG ? 'longitudinal' : 'lateral') + ' peak was missed' : '')]);
    }
    S.push(['Pulse interpretation', pulse.found ? pulse.compositionText + (inputs.impactConfig ? ' Scene evidence indicates a ' + inputs.impactConfig + ' configuration.' : '') + ' The other party, if any, is not observable in this device\'s telemetry.' : 'No impact-level pulse recorded; contact, if any, fell below the device\'s logging thresholds.']);
    S.push(['Other impact signatures', otherExcursions.length ? otherExcursions.length + ' additional accelerometer excursion(s) ≥ ' + cfg.pulseThresholdG + ' g elsewhere in the data (' + otherExcursions.slice(0, 3).map(function (a) { return F.clock(a.t, true); }).join(', ') + (otherExcursions.length > 3 ? ', …' : '') + ')' : 'None — no additional accelerometer excursion anywhere in the ' + (buffer ? round((pulseTime - buffer.start) / 1000, 0) + '-second pre-event buffer or the ' : '') + 'remainder of the trip']);
    if (approach) {
      S.push(['Pre-event driver input', approach.onset
        ? 'Progressive braking from ' + round(approach.onset.mph, 0) + ' mph beginning ' + F.time(approach.onset.t) + ' — ' + (approach.phases || []).map(function (p) { return p.label; }).join(' then ') + ', ~' + round(approach.brakingDurationS, 0) + ' s total; ' + (approach.hardBraking ? 'hard-braking crumb of ~' + round(approach.maxCrumbDecel.g, 2) + ' g recorded' : 'no panic spike') + ', ' + (swerve.length ? 'lateral excursion recorded before the pulse' : 'no swerve excursion recorded before the pulse')
        : 'No sustained deceleration in the ' + cfg.approachLookbackS + ' s before the event (peak ' + round(approach.peakMph, 0) + ' mph); ' + (swerve.length ? 'lateral excursion recorded before the pulse' : 'no swerve excursion recorded')]);
    }
    if (post.rest) {
      S.push(['Post-event', 'At rest ' + round(post.timeToRestS, 0) + ' s after pulse; ' +
        ((post.movements || []).length ? (post.movements || []).map(function (iv) { return (iv.kind === 'repositioning' ? 'minor repositioning ' : 'relocation ') + F.hm(iv.start); }).join(', ') + '; ' : 'no further movement; ') +
        (post.ignitionOff ? 'engine off ' + F.time(post.ignitionOff) : 'ignition remained on through the data end') +
        faultsC.filter(function (f) { return f.phase === 'post-event'; }).map(function (f) { return ' (' + f.name + ' logged ' + F.time(f.t) + (f.category === 'tpms' ? ' — evaluate for crash-related sensor/wiring damage' : f.category === 'power' ? ' — device power interruption' : '') + ')'; }).join('') +
        (post.movedAfterIgnitionOffFt >= cfg.sceneRadiusFt ? '; relocated ~' + post.movedAfterIgnitionOffFt + ' ft after ignition off' : '; no movement through export end ' + F.hm(dataEnd))]);
    }
    S.push(['Axis orientation check', (otherExcursions.length ? 'Other accelerometer excursions were curve-logged elsewhere in the trip; ' : 'No accelerometer excursions were curve-logged elsewhere in the trip, so device axis orientation could not be independently verified from this export; ') + 'the vertical axis read ~' + round(baseline, 1) + ' g at baseline, indicating ' + (Math.abs(baseline - 1) < 0.15 ? 'correct vertical alignment' : 'a non-standard mounting orientation — interpret axis labels with caution')]);
    if (driverName || inputs.driverName) S.push(['Driver identification', (inputs.driverName || driverName) + (driverSource ? ' per ' + driverSource : ' per client records') + '; device names carry operator labels and do not by themselves prove who was driving']);

    // ------------------------------------------------------- header fields
    var H = {};
    var detect = collisionFault ? 'Geotab "' + collisionFault.name + '" device fault at ' + F.clock(collisionFault.t, true) + ' ' + F.tzAbbrev(collisionFault.t) + (recon ? '; Collision Reconstruction (BETA) report generated' : '')
      : pulse.found ? 'No collision fault logged; accelerometer excursion of ' + round(pulse.peakSample.g, 2) + ' g recorded at ' + F.clock(pulse.peakTime, true) + ' ' + F.tzAbbrev(pulse.peakTime)
      : 'No collision fault and no impact-level accelerometer excursion recorded';
    H.collisionDetection = detect;
    H.vehicle = (bundle.meta.deviceName || '') + (bundle.meta.vehicleDescription ? ' — ' + bundle.meta.vehicleDescription : '') + (bundle.meta.vin ? ', VIN ' + bundle.meta.vin : '');
    H.driver = inputs.driverName || driverName ? (inputs.driverName || driverName) + (driverSource ? ' (' + driverSource + ')' : '') : 'Not established from telemetry — device name carries an operator label only';
    H.trip = (tripStart != null ? 'Departed ' + (addr.tripStart || 'trip origin') + ' ' + F.hm(tripStart) : '') +
      (post.rest ? '; trip ended at the incident site' + (addr.rest ? ' (' + addr.rest + ')' : '') + ' ' + F.hm(post.ignitionOff || post.rest.t) : '') +
      (tripDistanceMi != null ? ' — ' + round(tripDistanceMi, 0) + ' mi' : '');
    H.location = (heading != null ? compass(heading).charAt(0).toUpperCase() + compass(heading).slice(1) + 'bound' : '') + (addr.pulse ? ' on ' + addr.pulse : '') +
      (pulsePos ? '; recorded pulse at ' + pulsePos.lat.toFixed(4) + ', ' + pulsePos.lon.toFixed(4) : '') +
      (post.rest ? '; vehicle at rest ' + (post.rollOutFt != null ? '~' + post.rollOutFt + ' ft beyond the pulse location' : '') : '');
    H.reportedEvent = inputs.reportedEvent || '';
    H.conditions = inputs.conditions || '';
    H.speed = pulse.found && speedRange
      ? 'Recorded pulse occurred at ~' + (speedRange[0] === speedRange[1] ? speedRange[0] : speedRange[0] + '–' + speedRange[1]) + ' mph' +
        (approach && approach.onset ? ', at the end of a ' + round(approach.brakingDurationS, 0) + '-second deceleration from ' + round(approach.onset.mph, 0) + ' mph' : '') +
        (inputs.recon && inputs.recon.speedAccuracyMph ? ' (Geotab-stated accuracy ±' + inputs.recon.speedAccuracyMph + ' mph' + (inputs.recon.gpsAccuracyFt ? '; GPS ±' + inputs.recon.gpsAccuracyFt + ' ft' : '') + ')' : '')
      : (speedAtPulse != null ? 'GPS speed ~' + round(speedAtPulse, 0) + ' mph at the event time' : '');
    H.dataSources = ['MyGeotab GO device records (GPS log, accelerometer, engine status and fault data)' + (bundle.source === 'xlsx' ? ' via Advanced Log Data & Collisions Report' : ' via MyGeotab API')]
      .concat(recon ? ['Geotab Collision Reconstruction (BETA)'] : [])
      .concat(inputs.photos && inputs.photos.length ? [(inputs.photos.some(function (p) { return p.lat != null; }) ? 'Timemark GPS-verified scene photograph(s)' : 'Scene photograph(s)')] : [])
      .join('; ');
    H.prepared = F.dateLong(Date.now()) + ' by GPS Fleet Management Solutions from unaltered system records';
    H.title = (collisionFault ? 'Detected Collision' : pulse.found ? 'Recorded Impact Event' : 'Alleged Incident') + ' — ' + (inputs.locationLabel || addr.pulse || '') + ' — ' + F.dateLong(eventTime) + ', ' + F.hm(eventTime) + ' ' + F.tzAbbrev(eventTime);

    // --------------------------------------------------- discrepancy prose
    var discrepancy = null;
    if (recon && pulse.found) {
      var rs2 = recon.stated, pk3 = pulse.peaks;
      var lagTxt = recon.lagS != null && Math.abs(recon.lagS) >= 0.3 ? 'approximately ' + Math.abs(recon.lagS) + ' seconds ' + (recon.lagS > 0 ? 'after' : 'before') + ' the recorded peak' : 'at the recorded peak';
      var statedG = [rs2.fwd ? sgn(rs2.fwd.g, 2) + ' g longitudinal' : null, rs2.lat ? sgn(rs2.lat.g, 2) + ' g lateral' : null].filter(Boolean).join(' / ');
      var rawG = [pk3.fwd ? sgn(pk3.fwd.g, 2) + ' g longitudinal' : null, pk3.lat ? sgn(pk3.lat.g, 2) + ' g lateral' : null, pk3.vert ? sgn(pk3.vert.g, 2) + ' g vertical' : null].filter(Boolean).join(' / ');
      discrepancy = {
        applicable: recon.missedPeak || (inputs.reconDepicts && inputs.impactConfig && inputs.reconDepicts !== inputs.impactConfig),
        text: (inputs.reconDepicts ? 'Geotab\'s Collision Reconstruction depicts the vehicle receiving a ' + inputs.reconDepicts + ' impact. ' : '') +
          (inputs.impactConfig && inputs.reconDepicts && inputs.impactConfig !== inputs.reconDepicts ? 'Scene evidence shows a different configuration: ' + inputs.impactConfig + '. ' : '') +
          'The reconstruction\'s estimate derives from accelerometer values present at its ' + F.clock(recon.triggerTime, true) + ' trigger timestamp (' + statedG + ', the ft/s² figures printed in the report) — ' + lagTxt +
          (recon.missedPeak ? ', when the ' + (rs2.fwd && pk3.fwd && Math.abs(rs2.fwd.g) < 0.6 * pk3.fwd.devG ? 'longitudinal' : 'lateral') + ' signal had already decayed; the residual sample reads to the algorithm as a ' + (rs2.fwd && pk3.fwd && Math.abs(rs2.fwd.g) < 0.6 * pk3.fwd.devG ? 'broadside' : 'frontal') + ' load. ' : '. ') +
          'The full high-rate capture shows a single pulse at ' + F.clock(pulse.start, true) + '–' + F.clock(pulse.end, true) + ' with peaks of ' + rawG + '. ' + pulse.compositionText +
          ' Geotab\'s own report notes the point of impact is an accelerometer-derived estimate that may vary' + (recon.missedPeak ? '; its impact graphic should not be relied upon for this event.' : '.')
      };
    }

    // ------------------------------------------------------------ appendix
    var appendix = null;
    if (buffer) {
      appendix = buffer.records.map(function (g) {
        var notes = [];
        if (approach && approach.onset && g.t === approach.onset.t) notes.push('Deceleration begins');
        if (pulse.found) {
          var nb = bracket(buffer.records, pulse.peakTime);
          if (nb.before === g && nb.after) notes.push('Pulse at ' + F.clock(pulse.peakTime, true) + ' (between this record and next)');
          else if (nb.before === g && !nb.after) notes.push('Pulse at ' + F.clock(pulse.peakTime, true));
        }
        if (recon && Math.abs(g.t - recon.triggerTime) < 500) notes.push('Reconstruction trigger timestamp');
        if (post.rest && g.t === post.rest.t) notes.push('At rest' + (addr.rest ? ' — ' + addr.rest : ''));
        return { t: g.t, clock: F.clock(g.t, true), mph: g.mph, lat: g.lat, lon: g.lon, note: notes.join('; ') };
      });
    }

    var caveats = [
      'Records are reproduced as logged; no values have been modified.',
      recon ? 'Geotab states GPS accuracy of ±' + (inputs.recon.gpsAccuracyFt || '8.2') + ' ft and speed accuracy of ±' + (inputs.recon.speedAccuracyMph || '2.2') + ' mph for this event, notes the point of impact is an accelerometer-derived estimate that may vary, and does not authenticate the Collision Reconstruction report for litigation purposes.' : null,
      'This device\'s telemetry records only the equipped vehicle\'s own motion; any other party\'s position, speed, or actions are not observable from it.',
      pulse.found ? null : 'Contact below the device\'s accelerometer logging thresholds would not produce a recorded pulse; the absence of a pulse does not by itself establish that no contact occurred.',
      !buffer ? 'No 1-second forensic GPS buffer was captured, which indicates the device did not detect a collision-level event; positions between curve-logged records are interpolated.' : null,
      'This exhibit presents recorded telematics data and documented physical evidence only and does not constitute a determination of fault.'
    ].filter(Boolean);

    if (!buffer) warnings.push('No forensic (1 Hz) GPS buffer detected near the event time.');
    if (!pulse.found) warnings.push('No impact-level accelerometer pulse detected (threshold ' + cfg.pulseThresholdG + ' g).');
    if (Math.abs(baseline - 1) >= 0.15) warnings.push('Vertical baseline is ' + round(baseline, 2) + ' g — device may be mounted off-axis.');
    if (bundle.meta && /GO Mobile/i.test(bundle.meta.deviceGroups || '') && accel.length) warnings.push('Device group label says "GO Mobile" but full accelerometer data is present — capability judged from records, not the label.');

    return {
      config: cfg, timeZone: tz, tzAbbrev: F.tzAbbrev(eventTime), tzLong: F.tzLong(eventTime),
      eventTime: eventTime, eventTimeSource: eventTimeSource,
      dataStart: dataStart, dataEnd: dataEnd,
      collisionFault: collisionFault, buffer: buffer ? { start: buffer.start, end: buffer.end, count: buffer.count, accidentTaggedCount: buffer.accidentTaggedCount } : null,
      verticalBaseline: baseline,
      pulse: pulse, pulseTime: pulseTime, pulsePos: pulsePos, speedAtPulse: speedAtPulse, speedRange: speedRange,
      engineSpeedAtPulse: engineSpeedAtPulse, headingDeg: heading, headingText: heading != null ? compass(heading) : null,
      approach: approach, post: post, faults: faultsC, recon: recon, swerve: swerve, otherExcursions: otherExcursions,
      trip: trip, tripStart: tripStart, tripStartPos: tripStartPos, tripDistanceMi: tripDistanceMi,
      driverName: driverName, driverSource: driverSource, signals: signals,
      timeline: T, summary: S, header: H, discrepancy: discrepancy, appendix: appendix, caveats: caveats,
      warnings: warnings,
      format: F
    };
  }

  return {
    analyze: analyze, makeFormatter: makeFormatter, haversineFt: haversineFt, interp: interp,
    DEFAULTS: DEFAULTS, G_PER_FT_S2: G_PER_FT_S2, G_PER_MPH_S: G_PER_MPH_S
  };
});
