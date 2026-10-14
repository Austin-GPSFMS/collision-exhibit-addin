#!/usr/bin/env python3
"""
Convert a MyGeotab "Advanced Log Data and Collisions Report" export (.xlsx)
into the normalized record bundle the add-in's analysis engine consumes.

This exists for two reasons:
  1. Regression fixtures — validate analysis.js against exhibits that were
     built by hand from the same export.
  2. Offline fallback — a case can still be analysed from an export when the
     API window has aged out or the database is not reachable.

Usage:
    python3 xlsx_to_records.py <report.xlsx> <out.json> [--tz America/Chicago]

The report header carries a TimeZone line (e.g. CST6CDT / EST5EDT); --tz
overrides it with an IANA zone. Output timestamps are epoch milliseconds UTC,
matching what the add-in derives from API ISO dateTime strings.
"""
import argparse, json, math, sys
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd

POSIX_TZ_MAP = {
    'CST6CDT': 'America/Chicago', 'EST5EDT': 'America/New_York',
    'MST7MDT': 'America/Denver', 'PST8PDT': 'America/Los_Angeles',
    'EST': 'America/New_York', 'CST': 'America/Chicago',
    'MST': 'America/Phoenix', 'PST': 'America/Los_Angeles',
}
AXIS = {
    'Acceleration forward or braking': 'fwd',
    'Acceleration side to side': 'lat',
    'Acceleration up or down': 'vert',
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx'); ap.add_argument('out'); ap.add_argument('--tz')
    a = ap.parse_args()

    hdr = pd.read_excel(a.xlsx, sheet_name='Data', header=None, nrows=9)
    meta = {str(r[0]): r[1] for r in hdr.itertuples(index=False)}
    tzname = a.tz or POSIX_TZ_MAP.get(str(meta.get('TimeZone')), str(meta.get('TimeZone')))
    tz = ZoneInfo(tzname)
    speed_unit = str(meta.get('SpeedUnit', 'mph')).lower()

    df = pd.read_excel(a.xlsx, sheet_name='Data', header=9)
    df['t'] = pd.to_datetime(df['DebugDateTime'])

    def ms(ts):
        if pd.isna(ts):
            return None
        return int(ts.to_pydatetime().replace(tzinfo=tz).timestamp() * 1000)

    def num(v):
        try:
            f = float(v)
            return None if math.isnan(f) else f
        except Exception:
            return None

    gps, accel, status, faults, debug, ignition, driver_changes = [], [], [], [], [], [], []
    last_ign = None
    for r in df.sort_values('t').itertuples(index=False):
        rt = r.DebugRecordType
        t = ms(r.t)
        if rt == 'GpsRecord':
            sp = num(r.DebugSpeed)
            if sp is not None and speed_unit.startswith('km'):
                sp = sp / 1.609344
            lat, lon = num(r.DebugLatitude), num(r.DebugLongitude)
            if lat is not None and lon is not None:
                gps.append({'t': t, 'lat': lat, 'lon': lon, 'mph': sp,
                            'reason': None if pd.isna(r.DebugRecordReason) else str(r.DebugRecordReason)})
            ign = num(r.DebugIgnition)
            if ign is not None and ign != last_ign:
                ignition.append({'t': t, 'on': bool(ign)})
                last_ign = ign
        elif rt == 'EngineStatusRecord':
            name = '' if pd.isna(r.DiagnosticName) else str(r.DiagnosticName)
            val = num(r.DebuggingStatusRecordDisplayData)
            unit = '' if pd.isna(r.DebuggingStatusRecordUnitOfMeasureName) else str(r.DebuggingStatusRecordUnitOfMeasureName)
            if name in AXIS and val is not None:
                accel.append({'t': t, 'axis': AXIS[name], 'g': val})
            elif val is not None:
                if name == 'Engine road speed' and unit.startswith('km'):
                    val, unit = val / 1.609344, 'mph'
                status.append({'t': t, 'name': name, 'id': None if pd.isna(r.DiagnosticId) else str(r.DiagnosticId),
                               'value': val, 'unit': unit})
        elif rt == 'EngineFaultRecord':
            faults.append({'t': t, 'name': str(r.DiagnosticName),
                           'controller': None if pd.isna(r.ControllerName) else str(r.ControllerName),
                           'failureMode': None if pd.isna(r.FailureModeName) else str(r.FailureModeName),
                           'diagId': None if pd.isna(r.DiagnosticId) else str(r.DiagnosticId)})
        elif rt == 'DebugRecord':
            reason = str(r.DebugRecordReason)
            if not reason.isdigit():
                debug.append({'t': t, 'reason': reason})
        elif rt == 'DriverChange':
            driver_changes.append({'t': t, 'type': str(r.DebugRecordReason), 'driverName': None})

    first = df.iloc[0]
    out = {
        'source': 'xlsx',
        'meta': {
            'deviceName': str(first['DeviceName']), 'deviceId': str(first['DeviceId']),
            'deviceGroups': str(first['DeviceGroup']),
            'company': str(meta.get('CompanyName')),
            'timeZone': tzname, 'reportTimeZone': str(meta.get('TimeZone')),
            'from': ms(pd.to_datetime(meta.get('FromDate'))), 'to': ms(pd.to_datetime(meta.get('ToDate'))),
            'vin': None, 'vehicleDescription': None,
        },
        'gps': gps, 'accel': accel, 'status': status, 'faults': faults,
        'debug': debug, 'ignition': ignition, 'trips': [], 'driverChanges': driver_changes,
        'exceptions': [],
    }
    with open(a.out, 'w') as f:
        json.dump(out, f)
    print(f"wrote {a.out}: gps={len(gps)} accel={len(accel)} status={len(status)} faults={len(faults)} "
          f"debug={len(debug)} ignition={len(ignition)} tz={tzname}")


if __name__ == '__main__':
    main()
