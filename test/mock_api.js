/**
 * Mock MyGeotab `api` object built from a normalized fixture bundle, returning
 * API-shaped entities (LogRecord km/h, StatusData m/s² with diagnostic ids,
 * FaultData, Trip, DebugData, Diagnostic/User/Controller lookups, GetAddresses).
 * Used by test/run_browser_test.py to exercise the API path end to end.
 */
window.makeMockApi = function (fx) {
  var KM = 1.609344, MS2 = 9.80665, iso = function (ms) { return new Date(ms).toISOString(); };
  var diagNames = {
    DiagnosticAccelerationForwardBrakingId: { name: 'Acceleration forward or braking', unit: 'UnitOfMeasureMetersPerSecondSquaredId' },
    DiagnosticAccelerationSideToSideId: { name: 'Acceleration side to side', unit: 'UnitOfMeasureMetersPerSecondSquaredId' },
    DiagnosticAccelerationUpDownId: { name: 'Acceleration up or down', unit: 'UnitOfMeasureMetersPerSecondSquaredId' },
    DiagnosticIgnitionId: { name: 'Ignition', unit: 'UnitOfMeasureNoneId' },
    DiagnosticEngineRoadSpeedId: { name: 'Engine road speed', unit: 'UnitOfMeasureKilometersPerHourId' },
    DiagnosticAccidentLevelAccelerationEventId: { name: 'Alert: Collision limit for acceleration exceeded', unit: 'UnitOfMeasureNoneId' }
  };
  var axisId = { fwd: 'DiagnosticAccelerationForwardBrakingId', lat: 'DiagnosticAccelerationSideToSideId', vert: 'DiagnosticAccelerationUpDownId' };
  var status = [];
  fx.accel.forEach(function (a) { status.push({ dateTime: iso(a.t), data: a.g * MS2, diagnostic: { id: axisId[a.axis] } }); });
  fx.status.forEach(function (s) {
    var id = s.name === 'Engine road speed' ? 'DiagnosticEngineRoadSpeedId' : (s.id || ('diag_' + s.name.replace(/\W+/g, '_')));
    if (!diagNames[id]) diagNames[id] = { name: s.name, unit: 'UnitOfMeasureNoneId' };
    status.push({ dateTime: iso(s.t), data: s.name === 'Engine road speed' ? s.value * KM : s.value, diagnostic: { id: id } });
  });
  fx.ignition.forEach(function (x) { status.push({ dateTime: iso(x.t), data: x.on ? 1 : 0, diagnostic: { id: 'DiagnosticIgnitionId' } }); });
  var logs = fx.gps.map(function (g) { return { dateTime: iso(g.t), latitude: g.lat, longitude: g.lon, speed: g.mph != null ? g.mph * KM : null }; });
  var faults = fx.faults.map(function (f) {
    var id = f.diagId || ('diag_' + f.name.replace(/\W+/g, '_')); if (!diagNames[id]) diagNames[id] = { name: f.name, unit: 'UnitOfMeasureNoneId' };
    return { dateTime: iso(f.t), diagnostic: { id: id }, controller: { id: 'ControllerTelematicsDeviceId' }, failureMode: null, faultState: 'Active' };
  });
  var ignOff = (fx.ignition.filter(function (x) { return !x.on; })[0] || {}).t;
  var last = fx.gps[fx.gps.length - 1];
  var trips = [{ start: iso(fx.gps[0].t), stop: iso(ignOff || last.t), nextTripStart: iso((ignOff || last.t) + 3600000), distance: 19.2 * KM, maxSpeed: 60 * KM,
    driver: { id: 'u_driver' }, stopPoint: { x: last.lon, y: last.lat }, device: { id: 'b7' } }];
  var debug = fx.debug.map(function (d) { return { dateTime: iso(d.t), debugReason: d.reason }; });
  var inWin = function (ms, s) { return (!s.fromDate || ms >= Date.parse(s.fromDate)) && (!s.toDate || ms <= Date.parse(s.toDate)); };
  var calls = [];
  function handle(method, p) {
    calls.push([method, p && p.typeName]);
    if (method === 'GetAddresses') {
      return p.coordinates.map(function (c, i) {
        var a = [['12776 Rolling Ridge Rd', 'Becker'], ['Farmington Ave SE', 'Buffalo'], ['5445 Co Rd 33', 'Buffalo']][i] || ['Unknown Rd', 'Somewhere'];
        return { street: a[0], city: a[1], region: 'MN', formattedAddress: a[0] + ', ' + a[1] + ', MN, USA' };
      });
    }
    if (method !== 'Get') throw new Error('mock: unsupported ' + method);
    var s = p.search || {};
    switch (p.typeName) {
      case 'Device': return [{ id: 'b7', name: '20-V73 F350', serialNumber: 'G9XXXXXXXXXX', vehicleIdentificationNumber: '1FD8W3HN0LED61010', groups: [{ id: 'GroupCompanyId' }] }];
      case 'User': return s.id ? [{ id: s.id, firstName: 'Gbenga', lastName: 'Olorunsogbon' }] : [{ name: s.name, timeZoneId: 'America/Chicago' }];
      case 'LogRecord': return logs.filter(function (l) { return inWin(Date.parse(l.dateTime), s); });
      case 'StatusData': return status.filter(function (x) { return inWin(Date.parse(x.dateTime), s) && (!s.diagnosticSearch || s.diagnosticSearch.id === x.diagnostic.id); });
      case 'FaultData': return faults.filter(function (x) { return inWin(Date.parse(x.dateTime), s); });
      case 'Trip': return trips.filter(function (t) { return Date.parse(t.start) <= Date.parse(s.toDate) && Date.parse(t.stop) >= Date.parse(s.fromDate); });
      case 'DebugData': return debug.filter(function (x) { return inWin(Date.parse(x.dateTime), s); });
      case 'DriverChange': return [{ dateTime: iso(fx.driverChanges[0] ? fx.driverChanges[0].t : fx.gps[0].t), type: 'DriverKey', driver: { id: 'u_driver' } }];
      case 'ExceptionEvent': return [{ id: 'exc_1', activeFrom: iso(fx.faults[0].t), activeTo: iso(fx.faults[0].t + 1000), rule: { id: 'RuleAccidentId' }, device: { id: 'b7' } }];
      case 'Diagnostic': var d = diagNames[s.id]; return d ? [{ id: s.id, name: d.name, unitOfMeasure: { id: d.unit } }] : [];
      case 'Controller': return [{ id: s.id, name: 'Telematics device' }];
      case 'FailureMode': return [{ id: s.id, name: 'Unknown' }];
      case 'Rule': return [{ id: s.id, name: s.id === 'RuleAccidentId' ? 'Possible collision' : 'Rule' }];
      default: throw new Error('mock: unsupported type ' + p.typeName);
    }
  }
  return {
    _calls: calls,
    getSession: function (cb) { cb({ userName: 'tester@gpsfms.com', database: 'arvig', sessionId: 'x' }); },
    call: function (method, params, ok, fail) { try { var r = handle(method, params); setTimeout(function () { ok(r); }, 5); } catch (e) { setTimeout(function () { fail(e); }, 5); } },
    multiCall: function (list, ok, fail) { try { var r = list.map(function (c) { return handle(c[0], c[1]); }); setTimeout(function () { ok(r); }, 5); } catch (e) { setTimeout(function () { fail(e); }, 5); } }
  };
};
