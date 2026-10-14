/**
 * Geotab Camera-Services (media-services.geotab.com) client for the exhibit add-in.
 *
 * Covers Geotab-native cameras only (GO Focus / GO Focus Plus via SmarterAI,
 * Surfsight, Sensata). VisionTrack cameras are handled by the VisionTrack add-in.
 *
 * Auth is the MyGeotab session: four X-MyGeotab-* headers, no token. The add-in
 * runs on the MyGeotab origin (same as the built-in Cameras view), so the calls
 * are same-site; from a localhost dev host the browser may block them (CORS).
 *
 * Response shapes for /Video/Requests and the resource lists are handled
 * defensively (array vs. {items|data|results}, mediaUrl|url|uri) because this
 * module has not yet been exercised against a live database — the UI keeps the
 * raw JSON of every call in a collapsible box for the first live run.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CameraServices = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var BASE = 'https://media-services.geotab.com';
  var headers = null, log = [];

  function init(session, serverHost) {
    var host = (session && (session.path || session.server)) || serverHost || (typeof location !== 'undefined' ? location.host : '');
    host = String(host).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    headers = {
      'X-MyGeotab-Database': session.database,
      'X-MyGeotab-Path': host,
      'X-MyGeotab-SessionId': session.sessionId,
      'X-MyGeotab-Username': session.userName,
      'Content-Type': 'application/json'
    };
    return headers;
  }
  function ready() { return !!(headers && headers['X-MyGeotab-SessionId']); }

  function call(method, path, body, query) {
    if (!ready()) return Promise.reject(new Error('Camera-services session headers not initialised.'));
    var url = BASE + path;
    if (query) {
      var qs = Object.keys(query).filter(function (k) { return query[k] != null && query[k] !== ''; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); }).join('&');
      if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
    }
    var entry = { method: method, url: url, body: body || null, status: null, response: null, error: null, t: new Date().toISOString() };
    log.push(entry); if (log.length > 60) log.shift();
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, mode: 'cors', credentials: 'omit' })
      .then(function (r) {
        entry.status = r.status;
        return r.text().then(function (txt) {
          var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
          entry.response = data;
          if (!r.ok) {
            var msg = r.status === 401 ? 'media-services returned 401 — MyGeotab session not accepted (expired, or headers incomplete)'
              : r.status === 403 ? 'media-services returned 403 — this user lacks the required camera role (ViewRecordedVideo / ListAssets)'
              : 'media-services returned ' + r.status + (data && data.errors ? ': ' + [].concat(data.errors).join('; ') : '') + (data && data.traceId ? ' [traceId ' + data.traceId + ']' : '');
            entry.error = msg; throw new Error(msg);
          }
          return data;
        });
      }, function (e) { entry.error = String(e); throw new Error('media-services unreachable (' + e.message + ') — if running from a dev host this is likely CORS; load the add-in inside MyGeotab.'); });
  }
  function unwrap(d) {
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return [];
    var k = ['items', 'data', 'results', 'requests', 'mediaRequests', 'value'].filter(function (x) { return Array.isArray(d[x]); })[0];
    return k ? d[k] : [d];
  }
  function urlOf(res) {
    if (!res) return null;
    if (typeof res === 'string') return res;
    return res.mediaUrl || res.url || res.uri || res.resourceUrl || res.videoUrl || res.downloadUrl || res.link || null;
  }
  function statusOf(x) { return (x && (x.status || x.mediaRequestStatus || x.requestStatus)) || ''; }
  function isReady(x) { return /ResponseReady|ResponsePartiallyReady/i.test(statusOf(x)); }
  function isFailed(x) { return /DeviceUnavailable|RequestTimedOut|RequestFailed|QueueOverflow|MarkedForDeletion/i.test(statusOf(x)); }

  /** Pairing for a GO serial. Returns array of mappings (possibly empty). */
  function findMappings(goSerial) {
    return call('GET', '/DeviceMappings/serialNumber/' + encodeURIComponent(goSerial)).then(unwrap)
      .catch(function (e) { if (/404/.test(e.message)) return []; throw e; });
  }
  /** Existing media requests (ready or pending) for the GO serial in a window. */
  function listRequests(goSerial, fromIso, toIso) {
    return call('GET', '/Video/Requests', null, { StartTimeUtc: fromIso, EndTimeUtc: toIso, SerialNumber: goSerial }).then(unwrap);
  }
  function exceptionMedia(exceptionId) {
    return call('GET', '/Media/Exception/' + encodeURIComponent(exceptionId)).then(unwrap);
  }
  function requestExceptionMedia(exceptionId, preS, postS) {
    return call('POST', '/Media/Exception/' + encodeURIComponent(exceptionId), { preEventDuration: preS, postEventDuration: postS, mediaResourceType: 'Video' });
  }
  function requestClip(mapping, startIso, endIso) {
    return call('POST', '/Media', {
      requestStartTime: startIso, requestEndTime: endIso, mediaResourceType: 'Video',
      partnerDeviceId: mapping.partnerDeviceId, goDeviceSerialNumber: mapping.associatedDeviceSerialNumber, partnerId: mapping.partnerId
    });
  }
  function getRequest(id) { return call('GET', '/Media/' + encodeURIComponent(id)); }
  function getResources(id) { return call('GET', '/Media/' + encodeURIComponent(id) + '/Resources'); }
  function getVideoResources(id) { return call('GET', '/Video/Resources/' + encodeURIComponent(id)); }

  /** Normalise any request/resources payload into {id, status, ruleName, start, end, videos:[{url,cameraId,label}], thumbs:[url], raw}. */
  function normalizeItem(x) {
    var vids = [], thumbs = [];
    [].concat(x.videoResources || [], x.mediaResources || [], (x.resources || [])).forEach(function (r) {
      var u = urlOf(r); if (!u) return;
      var label = (r.cameraId || r.camera || r.direction || r.thumbnailDirection || r.name || '').toString();
      if (/thumb|snapshot|jpg|jpeg|png/i.test(label + ' ' + (r.mediaResourceType || r.type || '') + ' ' + u.split('?')[0].slice(-5))) thumbs.push(u);
      else vids.push({ url: u, cameraId: label, start: r.startTime || r.actualMediaStartTime || null, end: r.endTime || r.actualMediaEndTime || null, error: r.error || null });
    });
    [].concat(x.thumbnails || []).forEach(function (t) { var u = urlOf(t); if (u) thumbs.push(u); });
    return {
      id: x.mediaRequestId || x.id || x.requestId || null, status: statusOf(x), ruleName: x.ruleName || null, exceptionId: x.exceptionId || null,
      partnerId: x.partnerId || null, partnerDeviceId: x.partnerDeviceId || null,
      start: x.actualMediaStartTime || x.requestStartTime || x.startTimeUtc || null, end: x.actualMediaEndTime || x.requestEndTime || x.endTimeUtc || null,
      source: x.source || x.mediaRequestType || null, videos: vids, thumbs: thumbs, failureReason: x.failureReason || null, raw: x
    };
  }
  /** Resolve resources for a request id (tries /Media/{id}/Resources then /Video/Resources/{id}). */
  function resolve(id) {
    return getResources(id).then(function (r) {
      var item = normalizeItem(Object.assign({}, r.mediaRequest || {}, { mediaResources: r.mediaResources, videoResources: r.videoResources }));
      if (!item.videos.length) return getVideoResources(id).then(function (v) { return normalizeItem(v); }).catch(function () { return item; });
      return item;
    });
  }
  /** Poll a request until ready/failed. onTick(item) each poll. */
  function poll(id, onTick, intervalMs, maxMs) {
    intervalMs = intervalMs || 10000; maxMs = maxMs || 6 * 60000;
    var started = Date.now();
    return new Promise(function (res, rej) {
      (function tick() {
        getRequest(id).then(function (r) {
          var item = normalizeItem(r); if (onTick) onTick(item);
          if (isReady(r)) return resolve(id).then(res, function () { res(item); });
          if (isFailed(r)) return res(item);
          if (Date.now() - started > maxMs) return res(item);
          setTimeout(tick, intervalMs);
        }).catch(rej);
      })();
    });
  }

  return { init: init, ready: ready, findMappings: findMappings, listRequests: listRequests, exceptionMedia: exceptionMedia,
    requestExceptionMedia: requestExceptionMedia, requestClip: requestClip, getRequest: getRequest, resolve: resolve, poll: poll,
    normalizeItem: normalizeItem, isReady: isReady, isFailed: isFailed, log: log, BASE: BASE };
});
