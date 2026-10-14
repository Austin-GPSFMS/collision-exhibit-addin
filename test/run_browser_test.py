#!/usr/bin/env python3
"""
Headless end-to-end test of the add-in (API path via mock api, and xlsx import path).

  python3 test/run_browser_test.py [--xlsx path/to/export.xlsx]

Serves the project root on a local port, loads collisionExhibit.standalone.html
with a MyGeotab-like harness, drives the add-in through the mock API, fills the
20-V73 case inputs, captures screenshots and renders the exhibit to PDF under
test/out/.
"""
import argparse, http.server, json, os, socketserver, sys, threading, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'test', 'out'); os.makedirs(OUT, exist_ok=True)

ap = argparse.ArgumentParser(); ap.add_argument('--xlsx'); ap.add_argument('--port', type=int, default=8765)
args = ap.parse_args()

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(('127.0.0.1', args.port), Quiet); threading.Thread(target=srv.serve_forever, daemon=True).start()

fixture = json.load(open(os.path.join(ROOT, 'test', 'fixture_20v73_f350.json')))
mock_js = open(os.path.join(ROOT, 'test', 'mock_api.js')).read()

CASE_INPUTS = {
    'cx-vehicle-desc': '2020 Ford F-350', 'cx-driver': 'Gbenga Olorunsogbon',
    'cx-location-label': 'Farmington Ave SE at Co Rd 33, Buffalo, MN',
    'cx-conditions': 'Dense fog documented in the 09:18 AM scene photograph',
    'cx-reported': 'Front of the F-350 struck the side of a third-party vehicle (T-bone configuration), per scene evidence; the third party is not visible to this vehicle\'s telemetry',
    'cx-impact-config': 'frontal', 'cx-recon-time': '08:22:16', 'cx-recon-fwd': '-7.43220', 'cx-recon-lat': '-71.84465',
    'cx-recon-speed': '12.427', 'cx-recon-depicts': 'passenger-side', 'cx-client': 'Arvig'
}

def drive(page, label, loader):
    page.goto(f'http://127.0.0.1:{args.port}/collisionExhibit.standalone.html')
    page.wait_for_function('typeof L !== "undefined" && typeof Chart !== "undefined" && typeof XLSX !== "undefined"')
    page.add_script_tag(content=mock_js)
    page.evaluate('''(fx) => {
        window.__api = window.makeMockApi(fx);
        window.__addin = geotab.addin.collisionExhibit();
        return new Promise(res => { window.__addin.initialize(window.__api, {}, () => { window.__addin.focus(window.__api); res(); }); });
    }''', fixture)
    page.wait_for_function('document.querySelectorAll("#cx-device option").length > 1', timeout=10000)
    loader(page)
    page.wait_for_selector('#cx-work', state='visible', timeout=30000)
    page.wait_for_function('!!window.__collisionExhibitDebug.getState().result')
    # case inputs
    page.evaluate('() => document.querySelectorAll("details").forEach(d => d.open = true)')
    for k, v in CASE_INPUTS.items():
        page.fill(f'#{k}', v) if page.locator(f'#{k}').evaluate('e => e.tagName') != 'SELECT' else page.select_option(f'#{k}', v)
        page.dispatch_event(f'#{k}', 'change')
    page.click('#cx-analyze')
    page.wait_for_timeout(2500)  # tiles
    err = page.locator('#cx-error').inner_text()
    assert not err.strip(), f'UI error: {err}'
    if label == 'api':
        page.wait_for_function('document.querySelectorAll("#cx-cam-list .cx-cam-item").length >= 1', timeout=15000)
        page.evaluate('() => { window.__camPollFast = true; }')
        page.click('#cx-cam-request')
        page.wait_for_function('document.querySelectorAll("#cx-cam-list .cx-cam-item").length >= 2', timeout=15000)
        page.click('#cx-cam-exceptions button[data-act=get]')
        page.wait_for_function('document.querySelectorAll("#cx-cam-list .cx-cam-item").length >= 3', timeout=15000)
        cam = page.evaluate('''() => ({ status: document.getElementById('cx-cam-status').textContent, items: Array.from(document.querySelectorAll('#cx-cam-list .cx-cam-item')).map(e => ({ h: e.querySelector('.h').textContent, videos: e.querySelectorAll('video').length, pill: e.querySelector('.cx-pill').textContent })), exc: document.querySelectorAll('#cx-cam-exceptions .row').length })''')
        print('[camera]', json.dumps(cam, indent=1))
        st_cam = cam
    st = page.evaluate('''() => { const s = window.__collisionExhibitDebug.getState(); const r = s.result; const F = r.format;
        return { source: s.bundle.source, accelUnit: s.bundle.meta.accelUnitDetected || null, gps: s.bundle.gps.length, accel: s.bundle.accel.length,
          buffer: r.buffer && [F.clock(r.buffer.start), F.clock(r.buffer.end), r.buffer.count], pulse: r.pulse.found && [F.clock(r.pulse.start, true), F.clock(r.pulse.end, true), r.pulse.composition],
          peaks: r.pulse.found && Object.fromEntries(Object.entries(r.pulse.peaks).map(([k, v]) => [k, v && +v.g.toFixed(3)])),
          onset: r.approach && r.approach.onset && F.clock(r.approach.onset.t), rest: r.post.rest && F.clock(r.post.rest.t), rollOut: r.post.rollOutFt,
          ignOff: r.post.ignitionOff && F.clock(r.post.ignitionOff), driver: r.driverName, trip: r.trip && r.trip.distanceMi, addresses: s.inputs.addresses,
          reconLag: r.recon && r.recon.lagS, warnings: r.warnings, title: r.header.title, apiCalls: window.__api._calls.length }; }''')
    print(f'[{label}]', json.dumps(st, indent=1))
    page.screenshot(path=os.path.join(OUT, f'ui_{label}.png'), full_page=True)
    html = page.evaluate('() => window.__collisionExhibitDebug.buildExhibit()')
    assert 'data:image/jpeg' in html or 'Map image unavailable' in html, 'exhibit built without map'
    print(f'[{label}] exhibit html {len(html)//1024} KB; map captured: {"data:image/jpeg" in html}')
    open(os.path.join(OUT, f'exhibit_{label}.html'), 'w').write(html)
    p2 = page.context.new_page(); p2.set_content(html, wait_until='load'); p2.wait_for_timeout(1500)
    p2.emulate_media(media='print')
    p2.pdf(path=os.path.join(OUT, f'exhibit_{label}.pdf'), format='Letter', print_background=True, prefer_css_page_size=True)
    p2.close()
    if label == 'api': st['camera'] = st_cam
    return st

def load_api(page):
    page.select_option('#cx-device', 'b7')
    page.select_option('#cx-tz', 'America/Chicago')
    page.fill('#cx-event-date', '2026-09-30'); page.fill('#cx-event-time', '08:22:16')
    page.click('#cx-load')

def load_xlsx(page):
    buf = open(args.xlsx, 'rb').read()
    page.evaluate('(b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return window.__collisionExhibitDebug.importXlsxBuffer(u8.buffer); }',
                  __import__('base64').b64encode(buf).decode())

with sync_playwright() as pw:
    # No proxy: every external host is served from test/vendor via route interception.
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, ignore_https_errors=True, device_scale_factor=1)
    ctx.add_init_script('window.geotab = window.geotab || { addin: {} };')
    page = ctx.new_page()
    # Sandbox has no CDN/tile egress: serve vendored libs and a placeholder tile instead.
    VENDOR = os.path.join(ROOT, 'test', 'vendor')
    def route_cdn(route):
        name = route.request.url.rsplit('/', 1)[-1]
        f = os.path.join(VENDOR, name)
        if os.path.exists(f):
            route.fulfill(path=f, content_type='text/css' if name.endswith('.css') else 'application/javascript')
        else:
            route.abort()
    ctx.route('https://cdnjs.cloudflare.com/**', route_cdn)
    ctx.route('https://server.arcgisonline.com/**', lambda r: r.fulfill(path=os.path.join(VENDOR, 'tile.png'), content_type='image/png', headers={'Access-Control-Allow-Origin': '*'}))
    ctx.route('https://**.tile.openstreetmap.org/**', lambda r: r.fulfill(path=os.path.join(VENDOR, 'tile.png'), content_type='image/png', headers={'Access-Control-Allow-Origin': '*'}))
    ctx.route('https://fonts.googleapis.com/**', lambda r: r.abort())
    # media-services mock: paired GO Focus Plus camera, one ready request, clip request that becomes ready on 2nd poll
    ms_state = {'polls': 0}
    def route_ms(route):
        req = route.request; url = req.url; m = req.method
        def j(obj, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(obj), headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
        if m == 'OPTIONS': return route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'})
        if '/DeviceMappings/serialNumber/' in url: return j([{'deviceMappingId': 'dm1', 'partnerDeviceId': 'GEXKKFBRDVVR', 'associatedDeviceSerialNumber': 'G9XXXXXXXXXX', 'partnerId': 'smarterai', 'deviceStatus': 'online', 'partnerDeviceHealthStatus': 'Healthy'}])
        if '/Video/Requests' in url: return j([{'mediaRequestId': 'req_existing', 'status': 'ResponseReady', 'ruleName': 'Possible collision', 'partnerId': 'smarterai', 'requestStartTime': '2026-09-30T13:22:05Z', 'requestEndTime': '2026-09-30T13:22:25Z', 'videoResources': [{'cameraId': 'FrontFacing', 'mediaUrl': 'https://media.example.test/front.mp4', 'startTime': '2026-09-30T13:22:05Z'}, {'cameraId': 'DriverFacing', 'mediaUrl': 'https://media.example.test/driver.mp4'}], 'thumbnails': [{'url': 'https://media.example.test/thumb.jpg'}]}])
        if url.endswith('/Media') and m == 'POST': return j({'mediaRequestId': 'req_new', 'status': 'RequestQueued', 'requestStartTime': json.loads(req.post_data)['requestStartTime'], 'requestEndTime': json.loads(req.post_data)['requestEndTime']})
        if '/Media/req_new/Resources' in url: return j({'mediaRequest': {'mediaRequestId': 'req_new', 'status': 'ResponseReady'}, 'mediaResources': [{'cameraId': 'FrontFacing', 'mediaUrl': 'https://media.example.test/new_front.mp4'}]})
        if '/Media/req_new' in url:
            ms_state['polls'] += 1
            return j({'mediaRequestId': 'req_new', 'status': 'ResponseReady' if ms_state['polls'] >= 2 else 'RequestQueued'})
        if '/Media/Exception/' in url and m == 'GET': return j([{'mediaRequestId': 'req_exc', 'status': 'ResponseReady', 'ruleName': 'Possible collision', 'videoResources': [{'cameraId': 'FrontFacing', 'mediaUrl': 'https://media.example.test/exc.mp4'}]}])
        return j({'status': 404, 'name': 'NotFound', 'errors': ['mock: ' + m + ' ' + url], 'traceId': 't'}, 404)
    ctx.route('https://media-services.geotab.com/**', route_ms)
    ctx.route('https://media.example.test/**', lambda r: r.fulfill(status=404, body=''))
    page.on('pageerror', lambda e: print('PAGEERROR', e))
    page.on('console', lambda m: print('CONSOLE', m.type, m.text) if m.type in ('error', 'warning') else None)
    results = {'api': drive(page, 'api', load_api)}
    if args.xlsx:
        results['xlsx'] = drive(page, 'xlsx', load_xlsx)
    browser.close()

# cross-check API path vs the Node-validated numbers
a = results['api']
checks = [
    ('accel unit', a['accelUnit'], 'm/s² (converted to g)'),
    ('buffer', a['buffer'], ['08:21:48', '08:22:22', 35]),
    ('pulse', a['pulse'], ['08:22:15.120', '08:22:15.410', 'tri-axial']),
    ('peaks', a['peaks'], {'fwd': -2.186, 'lat': -2.233, 'vert': 2.418}),
    ('onset', a['onset'], '08:21:57'), ('rest', a['rest'], '08:22:22'), ('ignition off', a['ignOff'], '08:43:31'),
    ('driver from trip', a['driver'], 'Gbenga Olorunsogbon'), ('recon lag', a['reconLag'], 0.9),
    ('addresses', bool(a['addresses'].get('rest')), True),
    ('camera paired', 'smarterai' in a['camera']['status'], True),
    ('camera existing request rendered with 2 videos', a['camera']['items'][0]['videos'], 2),
    ('camera clip request queued then ready', any('req' in i['h'] or i['pill'] == 'ResponseReady' for i in a['camera']['items'][1:]), True),
    ('camera exception rows', a['camera']['exc'], 1),
]
fails = 0
for name, got, exp in checks:
    ok = got == exp; fails += 0 if ok else 1
    print(f'{"PASS" if ok else "FAIL"}  {name}: {got}' + ('' if ok else f'  (expected {exp})'))
srv.shutdown()
print(f'{fails} failure(s); outputs in test/out/')
sys.exit(1 if fails else 0)
