// Configurable egress travel distance standards.
// Default values: IBC 2024, Section 1017 (Exit Access Travel Distance), Table 1017.2.
// Every value is editable in the UI; edits are persisted in localStorage and can be
// exported/imported as JSON so other codes or jurisdictions can be plugged in.
(function (global) {
  'use strict';

  const STORAGE_KEY = 'egress.standards.v1';

  const IBC2024_DEFAULTS = {
    name: 'IBC 2024 - Section 1017 Exit Access Travel Distance',
    units: 'ft',
    // null = "Not Permitted"
    rows: [
      { occupancy: 'A, E, F-1, M, R, S-1', unsprinklered: 200, sprinklered: 250, notes: 'e, b' },
      { occupancy: 'I-1', unsprinklered: null, sprinklered: 250, notes: 'b' },
      { occupancy: 'B', unsprinklered: 200, sprinklered: 300, notes: 'c' },
      { occupancy: 'F-2, S-2, U', unsprinklered: 300, sprinklered: 400, notes: 'c' },
      { occupancy: 'H-1', unsprinklered: null, sprinklered: 75, notes: 'd' },
      { occupancy: 'H-2', unsprinklered: null, sprinklered: 100, notes: 'd' },
      { occupancy: 'H-3', unsprinklered: null, sprinklered: 150, notes: 'd' },
      { occupancy: 'H-4', unsprinklered: null, sprinklered: 175, notes: 'd' },
      { occupancy: 'H-5', unsprinklered: null, sprinklered: 200, notes: 'c' },
      { occupancy: 'I-2, I-3', unsprinklered: null, sprinklered: 200, notes: 'c' },
      { occupancy: 'I-4', unsprinklered: 150, sprinklered: 200, notes: 'c' }
    ],
    footnotes: {
      a: 'See Sections 402.8, 407.4, 408.6.1, 408.8.1, 411.2, 412.6, 1006.2.2.2, 1006.2.2.3, 1006.3.4, 1017.2.2, 1017.2.3, 1030.7, 3103.4 and 3104.9 for modifications to exit access travel distance requirements.',
      b: 'Buildings equipped throughout with an automatic sprinkler system in accordance with Section 903.3.1.1 or 903.3.1.2.',
      c: 'Buildings equipped throughout with an automatic sprinkler system in accordance with Section 903.3.1.1.',
      d: 'Group H occupancies equipped throughout with an automatic sprinkler system in accordance with Section 903.2.5.1.',
      e: 'Group R-3 and R-4 buildings equipped throughout with an automatic sprinkler system in accordance with Section 903.3.1.3.'
    },
    modifiers: {
      balcony: {
        enabled: false, value: 100,
        label: '1017.2.1 Exterior egress balcony increase (+ft)',
        info: 'Travel distance may be increased up to an additional 100 ft where the last portion of the exit access leading to the exit occurs on an exterior egress balcony (Section 1021). Balcony length shall be not less than the increase taken.'
      },
      f1s1: {
        enabled: false, value: 400, appliesTo: ['F-1', 'S-1'], requiresSprinkler: true,
        label: '1017.2.2 Groups F-1 and S-1 increase (max ft)',
        info: 'Requires: one story; min. 24 ft from finished floor to bottom of ceiling/roof slab or deck; sprinklered per 903.3.1.1.'
      },
      h5: {
        enabled: false, value: 300, appliesTo: ['H-5'], requiresSprinkler: true,
        label: '1017.2.3 Group H-5 fabrication area increase (max ft)',
        info: 'Requires: fabrication area width >= 300 ft; area >= 220,000 sq ft; height >= 16 ft (raised metal floor to clean filter ceiling); supply ventilation >= 20 cfm/sq ft.'
      },
      atrium: {
        enabled: false, value: 200,
        label: '1017.3.2.3 Max. portion within atrium, not at level of exit discharge (ft)',
        info: 'Informational: this sample does not detect which portion of the path is inside an atrium.'
      }
    },
    measurement: {
      nearestExit: true,
      info: '1017.3: measured from the most remote point of each room, area or space along the natural and unobstructed path of horizontal and vertical egress travel to the entrance to an exit. Where more than one exit is required, measured to the nearest exit.'
    }
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function getDefaults() {
    return clone(IBC2024_DEFAULTS);
  }

  function load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return validate(JSON.parse(saved));
      }
    } catch (err) {
      console.warn('Could not read saved standards, using defaults.', err);
    }
    return getDefaults();
  }

  function save(standards) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(standards));
  }

  function reset() {
    localStorage.removeItem(STORAGE_KEY);
    return getDefaults();
  }

  // Fills missing fields with defaults so partially edited/imported files still work.
  function validate(std) {
    const def = getDefaults();
    if (!std || !Array.isArray(std.rows) || std.rows.length === 0) {
      throw new Error('Standards JSON must contain a non-empty "rows" array.');
    }
    const toLimit = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
    return {
      name: std.name || 'Custom standards',
      units: 'ft',
      rows: std.rows.map((r) => ({
        occupancy: String(r.occupancy || '?'),
        unsprinklered: toLimit(r.unsprinklered),
        sprinklered: toLimit(r.sprinklered),
        notes: r.notes || ''
      })),
      footnotes: Object.assign({}, def.footnotes, std.footnotes),
      modifiers: Object.keys(def.modifiers).reduce((acc, key) => {
        acc[key] = Object.assign({}, def.modifiers[key], std.modifiers && std.modifiers[key]);
        acc[key].value = Number(acc[key].value) || 0;
        return acc;
      }, {}),
      measurement: Object.assign({}, def.measurement, std.measurement)
    };
  }

  function rowApplies(row, groups) {
    const occ = row.occupancy.split(',').map((s) => s.trim());
    return groups.some((g) => occ.includes(g));
  }

  // Returns { limit (ft) | null, notPermitted, breakdown: [string] }
  function effectiveLimit(std, rowIndex, sprinklered) {
    const row = std.rows[rowIndex];
    const breakdown = [];
    if (!row) {
      return { limit: null, notPermitted: false, breakdown: ['No occupancy selected'] };
    }
    let limit = sprinklered ? row.sprinklered : row.unsprinklered;
    breakdown.push(`Table: ${row.occupancy}, ${sprinklered ? 'with' : 'without'} sprinkler = ${limit === null ? 'Not Permitted' : limit + ' ft'}`);
    if (limit === null) {
      return { limit: null, notPermitted: true, breakdown };
    }
    const m = std.modifiers;
    ['f1s1', 'h5'].forEach((key) => {
      const mod = m[key];
      if (!mod.enabled) return;
      if (!rowApplies(row, mod.appliesTo)) {
        breakdown.push(`${mod.label}: ignored (applies to ${mod.appliesTo.join('/')})`);
      } else if (mod.requiresSprinkler && !sprinklered) {
        breakdown.push(`${mod.label}: ignored (requires sprinkler system)`);
      } else if (mod.value > limit) {
        limit = mod.value;
        breakdown.push(`${mod.label}: max = ${limit} ft`);
      }
    });
    if (m.balcony.enabled && m.balcony.value > 0) {
      limit += m.balcony.value;
      breakdown.push(`${m.balcony.label}: +${m.balcony.value} ft`);
    }
    if (m.atrium.enabled) {
      breakdown.push(`Atrium portion must be <= ${m.atrium.value} ft (not verified)`);
    }
    return { limit, notPermitted: false, breakdown };
  }

  function exportJSON(std) {
    const blob = new Blob([JSON.stringify(std, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'egress-standards.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJSON(file) {
    return file.text().then((text) => validate(JSON.parse(text)));
  }

  global.EgressStandards = { getDefaults, load, save, reset, validate, effectiveLimit, exportJSON, importJSON };
})(window);
