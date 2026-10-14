// Regression check: analysis.js vs the hand-built 20-V73 F350 exhibit (Arvig, 2026-09-30).
// Run: node test/validate_20v73.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const A = require('../analysis.js');

const bundle = JSON.parse(fs.readFileSync(new URL('./fixture_20v73_f350.json', import.meta.url)));
const tz = 'America/Chicago';
const local = (s) => {
  // '2026-09-30 08:22:16.300' in America/Chicago (CDT, UTC-5) → epoch ms
  const [d, t] = s.split(' ');
  return Date.parse(`${d}T${t}-05:00`);
};

const inputs = {
  timeZone: tz,
  eventTime: local('2026-09-30 08:22:16.300'),
  reportedEvent: 'Front of the F-350 struck the side of a third-party vehicle (T-bone configuration), per scene evidence',
  impactConfig: 'frontal', reconDepicts: 'passenger-side',
  conditions: 'Dense fog documented in the 09:18 AM scene photograph',
  locationLabel: 'Farmington Ave SE at Co Rd 33, Buffalo, MN',
  addresses: { tripStart: '12776 Rolling Ridge Rd, Becker, MN', rest: '5445 Co Rd 33, Buffalo, MN', pulse: 'Farmington Ave SE at its junction with Co Rd 33 SE' },
  recon: { triggerTime: local('2026-09-30 08:22:16.000'), fwdFtS2: -7.43220, latFtS2: -71.84465, speedMph: 12.427, gpsAccuracyFt: 8.2, speedAccuracyMph: 2.2 },
  driverName: 'Gbenga Olorunsogbon'
};

const r = A.analyze(bundle, inputs);
const F = r.format;
let fails = 0;
function check(name, actual, expected, tol) {
  const ok = typeof expected === 'number' ? Math.abs(actual - expected) <= (tol ?? 0) : actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : '  (expected ' + JSON.stringify(expected) + ')'}`);
  if (!ok) fails++;
}

console.log('--- exhibit-stated values');
check('buffer start', F.clock(r.buffer.start), '08:21:48');
check('buffer end', F.clock(r.buffer.end), '08:22:22');
check('buffer count', r.buffer.count, 35);
check('pulse found', r.pulse.found, true);
check('lateral peak g', r.pulse.peaks.lat.g, -2.233, 0.0005);
check('lateral peak t', F.clock(r.pulse.peaks.lat.t, true), '08:22:15.120');
check('long peak g', r.pulse.peaks.fwd.g, -2.186, 0.0005);
check('long peak t', F.clock(r.pulse.peaks.fwd.t, true), '08:22:15.410');
check('vert peak g', r.pulse.peaks.vert.g, 2.418, 0.0005);
check('vert peak t', F.clock(r.pulse.peaks.vert.t, true), '08:22:15.130');
check('pulse start', F.clock(r.pulse.start, true), '08:22:15.120');
check('pulse end', F.clock(r.pulse.end, true), '08:22:15.410');
check('pulse duration ~0.3 s', r.pulse.durationS, 0.29, 0.02);
check('composition tri-axial', r.pulse.composition, 'tri-axial');
check('speed range at pulse 15–18', `${r.speedRange[0]}-${r.speedRange[1]}`, '15-18');
check('braking onset', F.clock(r.approach.onset.t), '08:21:57');
check('onset speed 57', Math.round(r.approach.onset.mph), 57);
check('two decel phases', r.approach.phases.length, 2);
check('phase1 ~1.2 mph/s', r.approach.phases[0].mphPerS, 1.2, 0.35);
check('phase1 end 08:22:05', F.clock(r.approach.phases[0].end), '08:22:05');
check('phase2 ~3.5 mph/s', r.approach.phases[1].mphPerS, 3.5, 0.4);
check('phase2 ~0.16 g', r.approach.phases[1].g, 0.16, 0.02);
check('braking ~25 s', Math.round(r.approach.brakingDurationS), 18, 8);
check('no hard braking spike', r.approach.hardBraking, false);
check('no swerve', r.swerve.length, 0);
check('rest time', F.clock(r.post.rest.t), '08:22:22');
check('rest ~7 s after pulse', Math.round(r.post.timeToRestS), 7);
console.log(`      roll-out ft (exhibit said ~70; xlsx coords are 5-dp): path=${r.post.rollOutFt} straight=${r.post.rollOutStraightFt}`);
check('repositioning interval count', r.post.movements.filter(m => m.kind === 'repositioning').length, 1);
check('repositioning start ~08:23:14-21', ['08:23:14','08:23:15','08:23:21'].includes(F.clock(r.post.movements[0].start)), true);
check('repositioning max ≤ 7 mph', r.post.movements[0].maxMph <= 7, true);
check('ignition off', F.clock(r.post.ignitionOff), '08:43:31');
check('engine running ~21 min', r.post.engineRunningAfterRestMin, 21);
check('no relocation', r.post.movedAfterIgnitionOffFt < 150, true);
check('collision fault time', F.clock(r.collisionFault.t, true), '08:22:16.300');
check('TPMS fault post-event', r.faults.find(f => f.category === 'tpms').phase, 'post-event');
check('recon stated fwd g', r.recon.stated.fwd.g, -0.231, 0.001);
check('recon stated lat g', r.recon.stated.lat.g, -2.233, 0.001);
check('recon lag ~0.9 s', r.recon.lagS, 0.9, 0.05);
check('recon missed peak', r.recon.missedPeak, true);
check('vertical baseline ~1.0', r.verticalBaseline, 1.0, 0.15);
check('trip start', F.clock(r.tripStart), '07:50:54');
check('trip ~19 mi', r.tripDistanceMi, 19, 1);
check('no other excursions', r.otherExcursions.length, 0);
check('tz abbrev', r.tzAbbrev, 'CDT');
check('data end', F.clock(r.dataEnd), '10:15:22');

console.log('\n--- header');
for (const k of Object.keys(r.header)) console.log(`${k}: ${r.header[k]}`);
console.log('\n--- timeline');
r.timeline.forEach(t => console.log(`${t.label.padEnd(14)} ${t.text}`));
console.log('\n--- summary');
r.summary.forEach(s => console.log(`${s[0]}: ${s[1]}`));
console.log('\n--- discrepancy');
console.log(r.discrepancy && r.discrepancy.text);
console.log('\n--- appendix (annotated rows)');
r.appendix.filter(a => a.note).forEach(a => console.log(`${a.clock} ${a.mph.toFixed(1)} ${a.note}`));
console.log('\n--- warnings', r.warnings);
console.log(`\n${fails} failure(s)`);
process.exit(fails ? 1 : 0);
