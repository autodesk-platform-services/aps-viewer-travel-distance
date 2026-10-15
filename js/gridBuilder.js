// Builds a logical occupancy grid over the selected walkable elements, using exact geometry tests.
//
// The grid covers the extents of the selected elements (floors, rooms, stairs, ...). Each grid
// rectangle becomes a box that is tested against the real fragment geometry (js/geometryGrid.js):
//  - 3D: the cell box goes from the walking surface up to the code headroom (80 in). A cell is
//        inside the walkable area if a triangle of a selected element intersects its column box,
//        and blocked if a triangle of any other visible element intersects its obstacle box
//        (starting just above the walking surface).
//  - 2D: line segments, arcs and filled triangles of the sheet are tested against the rectangles.
// Doors are always passable; rooms, annotations, grids, ... never block. In 2D, text, tags, detail
// items and elements without a resolved category never block either.
(function (global) {
  'use strict';

  const { VOID, WALK, OBSTACLE } = global.EgressPathfinding;
  const GEO = global.EgressGeometry;

  // Built-in categories that never block a path (not user-configurable).
  const IGNORED_3D = ['lines', 'levels', 'grids', 'mass', 'areas', 'spaces', 'rooms'];
  const IGNORED_2D = ['tag', 'text', 'note', 'label', 'detail', 'lines', 'region', 'insulation', 'revision',
    'keynote', 'symbol', 'break', 'legend', 'title', 'view', 'raster', 'image', 'schedule',
    'dimensions', 'grids', 'levels', 'section', 'elevation', 'callout', 'reference', 'spot', 'matchline',
    'scope box', 'annotation', 'rooms', 'areas'];
  const FLOOR_OFFSET_M = 0.02; // obstacle box starts this far above the walking surface
  const BELOW_FLOOR_M = 0.15;  // walkable column box starts this far below the walking surface

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  function matchesAny(category, keywords) {
    if (!category) return false;
    const c = category.toLowerCase();
    return keywords.some((k) => k && c.includes(k));
  }

  // Resolves the Revit "Category" of each dbId, walking up the instance tree when a leaf has none.
  function getCategories(model, dbIds) {
    const result = new Map();
    const tree = model.getInstanceTree && model.getInstanceTree();
    const query = (ids) => new Promise((resolve) => {
      if (!ids.length) return resolve([]);
      model.getBulkProperties(ids, { propFilter: ['Category'], ignoreHidden: false }, resolve, () => resolve([]));
    });
    const run = async (ids) => {
      const props = await query(ids);
      const found = new Map();
      props.forEach((p) => {
        const cat = p.properties.find((prop) => prop.displayName === 'Category');
        if (cat && cat.displayValue) found.set(p.dbId, String(cat.displayValue));
      });
      return found;
    };
    return (async () => {
      let pending = dbIds.map((id) => ({ id, current: id }));
      for (let depth = 0; depth < 4 && pending.length; depth++) {
        const found = await run([...new Set(pending.map((p) => p.current))]);
        const next = [];
        pending.forEach((p) => {
          if (found.has(p.current)) {
            result.set(p.id, found.get(p.current));
          } else if (tree) {
            const parent = tree.getNodeParentId(p.current);
            if (parent && parent > 0 && parent !== tree.getRootId()) next.push({ id: p.id, current: parent });
          }
        });
        pending = next;
      }
      return result;
    })();
  }

  class EgressGridBuilder {
    constructor(viewer) {
      this.viewer = viewer;
    }

    // options: {
    //   is2d, walkableIds: number[] (selected elements + descendants), walkableSet: Set<number>,
    //   bounds: THREE.Box3 (x/y used), levelZ, headroom (model units), cellSize (model units),
    //   maxCells, onProgress(fraction, text)
    // }
    async build(o) {
      const viewer = this.viewer;
      const model = viewer.model;
      const progress = o.onProgress || (() => { });
      const min = o.bounds.min, max = o.bounds.max;
      const cs = o.cellSize;
      const cols = Math.max(1, Math.ceil((max.x - min.x) / cs));
      const rows = Math.max(1, Math.ceil((max.y - min.y) / cs));
      const N = cols * rows;
      if (N > (o.maxCells || 250000)) {
        throw new Error(`Grid would have ${N} cells (${cols} x ${rows}). Increase the cell size or select a smaller area.`);
      }
      const z = o.is2d ? 0 : o.levelZ;
      viewer.show(o.walkableIds); // rooms are often hidden; hidden fragments are skipped
      this.showTopView(o, z);

      const ctx = { ox: min.x, oy: min.y, cs, cols, rows };
      const inside = new Uint8Array(N);
      const blocked = new Uint8Array(N);
      const doors = new Uint8Array(N);
      const marks = {
        walk: { mark: (i) => { inside[i] = 1; }, skip: (i) => inside[i] === 1 },
        door: { mark: (i) => { doors[i] = 1; }, skip: (i) => doors[i] === 1 },
        block: { mark: (i) => { blocked[i] = 1; }, skip: (i) => blocked[i] === 1 }
      };
      const frags = model.getFragmentList();
      const fragCount = frags.getCount();
      const warnings = [];
      let last = performance.now();
      const maybeYield = async (k, label) => {
        if (performance.now() - last > 30) {
          progress(k / fragCount, `${label} ${k}/${fragCount} fragments...`);
          await nextFrame();
          last = performance.now();
        }
      };

      if (o.is2d) {
        // Pass A: collect the dbIds used by each fragment to resolve their categories.
        const ids = new Set();
        for (let f = 0; f < fragCount; f++) {
          GEO.enumFragment2D(frags, f, (raw) => { ids.add(model.remapDbIdFor2D(raw)); return false; }, {}, cs);
        }
        ids.delete(0);
        const others = [...ids].filter((id) => id > 0 && !o.walkableSet.has(id));
        progress(0, `Reading categories of ${others.length} elements...`);
        const categories = await getCategories(model, others);
        const roleOf = new Map();
        const roleOfId = (id) => {
          if (!roleOf.has(id)) {
            const cat = categories.get(id);
            // Ignored categories are tested before doors so "Door Tags" are not treated as doors.
            roleOf.set(id, id <= 0 ? null : o.walkableSet.has(id) ? 'walk'
              : !cat || matchesAny(cat, IGNORED_2D) ? null : matchesAny(cat, ['door']) ? 'door' : 'block');
          }
          return roleOf.get(id);
        };
        const role = (raw) => roleOfId(model.remapDbIdFor2D(raw));
        const summary = {};
        others.forEach((id) => {
          const key = `${categories.get(id) || '(no category)'} -> ${roleOfId(id) || 'ignored'}`;
          summary[key] = (summary[key] || 0) + 1;
        });
        console.debug('Egress 2D category roles:', summary);
        // Pass B: test every primitive against the grid rectangles.
        for (let f = 0; f < fragCount; f++) {
          let current = null;
          GEO.enumFragment2D(frags, f, (raw) => { current = role(raw); return current !== null; }, {
            segment: (ax, ay, bx, by) => GEO.markSegment2D(ctx, ax, ay, bx, by, marks[current].mark, marks[current].skip),
            triangle: (ax, ay, bx, by, cx, cy) => GEO.markTriangle2D(ctx, ax, ay, bx, by, cx, cy, marks[current].mark, marks[current].skip)
          }, cs * 0.5);
          await maybeYield(f, 'Testing');
        }
      } else {
        const unit = model.getUnitScale(); // meters per model unit
        const walkBand = [z - BELOW_FLOOR_M / unit, z + o.headroom];
        const blockBand = [z + FLOOR_OFFSET_M / unit, z + o.headroom];
        // Candidate fragments: visible (or selected), overlapping the area and the height band.
        // Fragment world bounds are only a cheap pre-filter; classification uses the triangles.
        const area = new THREE.Box3(
          new THREE.Vector3(min.x, min.y, walkBand[0]), new THREE.Vector3(max.x, max.y, walkBand[1]));
        const fragBox = new THREE.Box3();
        const fragId2dbId = model.getData().fragments.fragId2dbId;
        const candidates = [];
        for (let f = 0; f < fragCount; f++) {
          const dbId = fragId2dbId[f];
          const selected = o.walkableSet.has(dbId);
          if (!selected && !frags.isFragVisible(f)) continue;
          frags.getWorldBounds(f, fragBox);
          if (!fragBox.intersectsBox(area)) continue;
          candidates.push({ f, dbId, selected });
        }
        const others = [...new Set(candidates.filter((c) => !c.selected).map((c) => c.dbId))];
        progress(0, `Reading categories of ${others.length} elements...`);
        const categories = await getCategories(model, others);
        for (let k = 0; k < candidates.length; k++) {
          const c = candidates[k];
          const cat = categories.get(c.dbId);
          const kind = c.selected ? 'walk' : matchesAny(cat, IGNORED_3D) ? null : matchesAny(cat, ['door']) ? 'door' : 'block';
          if (kind) {
            const band = kind === 'walk' ? walkBand : blockBand;
            const m = marks[kind];
            GEO.enumFragmentTriangles(frags, c.f, (a, b, t) => GEO.markTriangle3D(ctx, a, b, t, band[0], band[1], m.mark, m.skip));
          }
          if (performance.now() - last > 30) {
            progress(k / candidates.length, `Testing ${k}/${candidates.length} fragments...`);
            await nextFrame();
            last = performance.now();
          }
        }
      }

      // Classify.
      const cells = new Uint8Array(N);
      let insideCount = 0;
      for (let i = 0; i < N; i++) {
        if (inside[i]) insideCount++;
        // Doors are always passable so the selected spaces connect through door openings.
        if (doors[i]) cells[i] = WALK;
        else if (!inside[i]) cells[i] = VOID;
        else cells[i] = blocked[i] ? OBSTACLE : WALK;
      }
      if (!insideCount) {
        warnings.push('No geometry of the selection was found in the grid. Select elements with geometry (floors, room fills, stairs).');
      }
      return {
        cols, rows, cellSize: cs, cells, doors, warnings,
        origin: { x: min.x, y: min.y }, z
      };
    }

    // Orthographic top view of the area so the user can see the grid (nothing is sampled from screen).
    showTopView(o, z) {
      const viewer = this.viewer, nav = viewer.navigation;
      const min = o.bounds.min, max = o.bounds.max;
      if (!o.is2d) {
        viewer.setCutPlanes([new THREE.Vector4(0, 0, 1, -(z + o.headroom))]);
        nav.toOrthographic();
        const cx = (min.x + max.x) / 2, cy = (min.y + max.y) / 2;
        const size = Math.max(max.x - min.x, max.y - min.y);
        nav.setView(new THREE.Vector3(cx, cy, z + o.headroom + size), new THREE.Vector3(cx, cy, z), new THREE.Vector3(0, 1, 0));
      }
      nav.fitBounds(true, new THREE.Box3(
        new THREE.Vector3(min.x, min.y, z),
        new THREE.Vector3(max.x, max.y, o.is2d ? 0 : z + o.headroom)));
    }
  }

  function cellCenter(grid, idx) {
    return new THREE.Vector3(
      grid.origin.x + ((idx % grid.cols) + 0.5) * grid.cellSize,
      grid.origin.y + (((idx / grid.cols) | 0) + 0.5) * grid.cellSize,
      grid.z);
  }

  function worldToCell(grid, point) {
    const x = Math.floor((point.x - grid.origin.x) / grid.cellSize);
    const y = Math.floor((point.y - grid.origin.y) / grid.cellSize);
    if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return -1;
    return y * grid.cols + x;
  }

  global.EgressGridBuilder = EgressGridBuilder;
  global.EgressGrid = { cellCenter, worldToCell, getCategories };
})(window);
