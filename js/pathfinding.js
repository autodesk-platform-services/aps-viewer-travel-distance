// Grid path finding algorithms (viewer agnostic).
//
// Grid format: { cols, rows, cells: Uint8Array } where cells[y * cols + x] is
//   0 = void (outside / no floor), 1 = walkable, 2 = obstacle.
// Nodes are cell indices. Costs are expressed in "cells" (multiply by cell size).
//
// Algorithms:
//  - A*        : single source -> nearest of several goals, octile heuristic (8-connected).
//  - Dijkstra  : multi-source from all exits; one pass yields the travel distance from every
//                cell to its nearest exit (distance field), so the most remote point is its max.
//  - Theta*    : any-angle A* variant; a node may take its grandparent as parent when there is
//                line of sight, giving paths close to the "natural" (taut) walking path.
//  - Central  : Central Dijkstra (Goldstein et al., JAIR 2022). Path counting over the Dijkstra
//                field selects the most "central" shortest grid path, which hugs sightlines.
//  - smoothPath: line-of-sight string pulling applied to A*/Dijkstra/Central results.
(function (global) {
  'use strict';

  const VOID = 0, WALK = 1, OBSTACLE = 2;
  const SQRT2 = Math.SQRT2;
  // dx, dy, cost
  const DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]
  ];

  // Binary min-heap keyed by priority.
  class MinHeap {
    constructor() { this.nodes = []; this.prios = []; }
    get size() { return this.nodes.length; }
    push(node, prio) {
      const n = this.nodes, p = this.prios;
      let i = n.length;
      n.push(node); p.push(prio);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (p[parent] <= prio) break;
        n[i] = n[parent]; p[i] = p[parent];
        i = parent;
      }
      n[i] = node; p[i] = prio;
    }
    pop() {
      const n = this.nodes, p = this.prios;
      const top = n[0];
      const lastN = n.pop(), lastP = p.pop();
      if (n.length > 0) {
        let i = 0;
        const len = n.length;
        while (true) {
          const l = 2 * i + 1, r = l + 1;
          let m = i, mp = lastP;
          if (l < len && p[l] < mp) { m = l; mp = p[l]; }
          if (r < len && p[r] < mp) { m = r; mp = p[r]; }
          if (m === i) break;
          n[i] = n[m]; p[i] = p[m];
          i = m;
        }
        n[i] = lastN; p[i] = lastP;
      }
      return top;
    }
  }

  function isWalkable(grid, x, y) {
    return x >= 0 && y >= 0 && x < grid.cols && y < grid.rows && grid.cells[y * grid.cols + x] === WALK;
  }

  // Calls fn(neighborIndex, stepCost) for each 8-connected neighbor. Diagonal moves are
  // only allowed if both adjacent orthogonal cells are walkable (no corner cutting).
  function forEachNeighbor(grid, idx, fn) {
    const x = idx % grid.cols, y = (idx / grid.cols) | 0;
    for (let i = 0; i < 8; i++) {
      const dx = DIRS[i][0], dy = DIRS[i][1];
      const nx = x + dx, ny = y + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!isWalkable(grid, x + dx, y) || !isWalkable(grid, x, y + dy))) continue;
      fn(ny * grid.cols + nx, DIRS[i][2]);
    }
  }

  function octile(grid, a, b) {
    const dx = Math.abs(a % grid.cols - b % grid.cols);
    const dy = Math.abs(((a / grid.cols) | 0) - ((b / grid.cols) | 0));
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  }

  function euclid(grid, a, b) {
    const dx = a % grid.cols - b % grid.cols;
    const dy = ((a / grid.cols) | 0) - ((b / grid.cols) | 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Supercover line traversal between cell centers. Fails if any traversed cell is not
  // walkable; when the line passes exactly through a corner both side cells must be free.
  function lineOfSight(grid, a, b) {
    let x = a % grid.cols, y = (a / grid.cols) | 0;
    const x1 = b % grid.cols, y1 = (b / grid.cols) | 0;
    let dx = Math.abs(x1 - x), dy = Math.abs(y1 - y);
    const sx = x1 > x ? 1 : -1, sy = y1 > y ? 1 : -1;
    let n = 1 + dx + dy;
    let err = dx - dy;
    dx *= 2; dy *= 2;
    for (; n > 0; n--) {
      if (!isWalkable(grid, x, y)) return false;
      if (err > 0) { x += sx; err -= dy; }
      else if (err < 0) { y += sy; err += dx; }
      else {
        if (!isWalkable(grid, x + sx, y) || !isWalkable(grid, x, y + sy)) return false;
        x += sx; y += sy; err += dx - dy; n--;
      }
    }
    return true;
  }

  function reconstruct(parent, idx) {
    const path = [];
    while (idx !== -1) { path.push(idx); idx = parent[idx]; }
    return path.reverse();
  }

  function minTo(grid, idx, goals, metric) {
    let best = Infinity;
    for (let i = 0; i < goals.length; i++) best = Math.min(best, metric(grid, idx, goals[i]));
    return best;
  }

  function aStar(grid, start, goals) {
    const N = grid.cols * grid.rows;
    const g = new Float64Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const goalSet = new Set(goals);
    const open = new MinHeap();
    let expanded = 0;
    g[start] = 0;
    open.push(start, minTo(grid, start, goals, octile));
    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      expanded++;
      if (goalSet.has(cur)) {
        return { path: reconstruct(parent, cur), cost: g[cur], expanded };
      }
      forEachNeighbor(grid, cur, (nb, step) => {
        const ng = g[cur] + step;
        if (ng < g[nb]) {
          g[nb] = ng; parent[nb] = cur;
          open.push(nb, ng + minTo(grid, nb, goals, octile));
        }
      });
    }
    return { path: [], cost: Infinity, expanded };
  }

  // Integer move costs (Goldstein et al. 2022): 577/408 ~ sqrt(2), so equally short paths have
  // exactly equal costs and the shortest-path DAG used by path counting is exact.
  const ORTH = 408, DIAG = 577;

  // Multi-source Dijkstra from all sources (exits). parent[] points towards the nearest source.
  // dist is in cells; idist keeps the exact integer distance (ORTH units).
  function dijkstra(grid, sources) {
    const N = grid.cols * grid.rows;
    const idist = new Float64Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open = new MinHeap();
    let expanded = 0;
    sources.forEach((s) => { idist[s] = 0; open.push(s, 0); });
    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      expanded++;
      forEachNeighbor(grid, cur, (nb, step) => {
        const nd = idist[cur] + (step === 1 ? ORTH : DIAG);
        if (nd < idist[nb]) { idist[nb] = nd; parent[nb] = cur; open.push(nb, nd); }
      });
    }
    const dist = new Float64Array(N);
    for (let i = 0; i < N; i++) dist[i] = idist[i] / ORTH;
    return { dist, idist, parent, expanded };
  }

  // log2(2^a + 2^b) without overflow (paper, eq. 5).
  function logAdd(a, b) {
    if (a === -Infinity) return b;
    if (b === -Infinity) return a;
    if (a < b) { const t = a; a = b; b = t; }
    return a + Math.log2(1 + Math.pow(2, b - a));
  }

  // Central Dijkstra ("Path Counting for Grid-Based Navigation", Goldstein et al., JAIR 2022).
  // Uses the multi-source Dijkstra field from the exits. Among all shortest grid paths from
  // `start` to its nearest exit, it follows the cells crossed by the most shortest paths:
  //   traversal(v) = paths(start -> v) * paths(v -> exits), computed with log2 counts.
  // The result is a shortest grid path that stays close to sightlines (much more direct than an
  // arbitrary tie-broken A*/Dijkstra path), and smooths into a near-taut path.
  function centralPath(grid, field, start) {
    const { idist } = field;
    if (!isFinite(idist[start])) return { path: [], cost: Infinity, expanded: field.expanded };
    const N = grid.cols * grid.rows;
    // DAG edge v -> w (towards the exits) iff idist[v] = idist[w] + move cost.
    const downhill = (v, fn) => forEachNeighbor(grid, v, (w, step) => {
      if (idist[w] + (step === 1 ? ORTH : DIAG) === idist[v]) fn(w);
    });

    // 1. Cells reachable from start along the DAG, sorted by decreasing distance.
    const seen = new Uint8Array(N);
    const order = [start];
    seen[start] = 1;
    for (let i = 0; i < order.length; i++) {
      downhill(order[i], (w) => { if (!seen[w]) { seen[w] = 1; order.push(w); } });
    }
    order.sort((a, b) => idist[b] - idist[a]);

    // 2. log2 path counts from start (forward) and to the exits (backward), restricted to the sub-DAG.
    const fromStart = new Float64Array(N).fill(-Infinity);
    const toExit = new Float64Array(N).fill(-Infinity);
    fromStart[start] = 0;
    for (const v of order) {
      downhill(v, (w) => { fromStart[w] = logAdd(fromStart[w], fromStart[v]); });
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const v = order[i];
      if (idist[v] === 0) { toExit[v] = 0; continue; }
      downhill(v, (w) => { toExit[v] = logAdd(toExit[v], toExit[w]); });
    }

    // 3. Greedy walk from start choosing the successor with the highest log traversal count.
    const path = [start];
    let cur = start;
    while (idist[cur] > 0) {
      let best = -1, bestCount = -Infinity;
      downhill(cur, (w) => {
        const c = fromStart[w] + toExit[w];
        if (c > bestCount) { bestCount = c; best = w; }
      });
      if (best < 0) break;
      path.push(best);
      cur = best;
    }
    return { path, cost: field.dist[start], expanded: field.expanded + order.length };
  }

  // Path from a cell to its nearest source using a Dijkstra field (start -> exit order).
  function tracePath(field, idx) {
    if (!isFinite(field.dist[idx])) return { path: [], cost: Infinity, expanded: field.expanded };
    const path = [];
    while (idx !== -1) { path.push(idx); idx = field.parent[idx]; }
    return { path, cost: field.dist[path[0]], expanded: field.expanded };
  }

  // Index of the reachable cell with the largest distance (most remote point).
  function argMaxFinite(dist) {
    let best = -1, bestVal = -1;
    for (let i = 0; i < dist.length; i++) {
      if (isFinite(dist[i]) && dist[i] > bestVal) { bestVal = dist[i]; best = i; }
    }
    return best;
  }

  function thetaStar(grid, start, goals) {
    const N = grid.cols * grid.rows;
    const g = new Float64Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const goalSet = new Set(goals);
    const open = new MinHeap();
    let expanded = 0;
    g[start] = 0;
    open.push(start, minTo(grid, start, goals, euclid));
    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      expanded++;
      if (goalSet.has(cur)) {
        return { path: reconstruct(parent, cur), cost: g[cur], expanded };
      }
      const pp = parent[cur];
      forEachNeighbor(grid, cur, (nb, step) => {
        if (closed[nb]) return;
        let from = cur, ng = g[cur] + step;
        // Path 2: connect straight from the grandparent when visible.
        if (pp !== -1 && lineOfSight(grid, pp, nb)) {
          const alt = g[pp] + euclid(grid, pp, nb);
          if (alt <= ng) { from = pp; ng = alt; }
        }
        if (ng < g[nb]) {
          g[nb] = ng; parent[nb] = from;
          open.push(nb, ng + minTo(grid, nb, goals, euclid));
        }
      });
    }
    return { path: [], cost: Infinity, expanded };
  }

  // Greedy string pulling: keeps only the turning points visible from each other.
  function smoothPath(grid, path) {
    if (path.length < 3) return path.slice();
    const out = [path[0]];
    let anchor = 0;
    while (anchor < path.length - 1) {
      let next = anchor + 1;
      for (let j = path.length - 1; j > anchor + 1; j--) {
        if (lineOfSight(grid, path[anchor], path[j])) { next = j; break; }
      }
      out.push(path[next]);
      anchor = next;
    }
    return out;
  }

  // Euclidean polyline length in cells.
  function pathLength(grid, path) {
    let len = 0;
    for (let i = 1; i < path.length; i++) len += euclid(grid, path[i - 1], path[i]);
    return len;
  }

  // Marks walkable cells within `radius` cells of an obstacle as obstacles (clearance).
  // Cells flagged in `keep` (e.g. doors) stay walkable so openings don't close.
  function inflate(grid, radius, keep) {
    if (radius <= 0) return;
    const src = grid.cells.slice();
    const { cols, rows } = grid;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (src[i] !== WALK || (keep && keep[i])) continue;
        search:
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy > radius * radius) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (src[ny * cols + nx] === OBSTACLE) { grid.cells[i] = OBSTACLE; break search; }
          }
        }
      }
    }
  }

  // Nearest walkable cell to idx (BFS ring search), or -1.
  function nearestWalkable(grid, idx, maxRadius) {
    const x0 = idx % grid.cols, y0 = (idx / grid.cols) | 0;
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= maxRadius && best === -1; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = x0 + dx, y = y0 + dy;
          if (!isWalkable(grid, x, y)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = y * grid.cols + x; }
        }
      }
    }
    return best;
  }

  global.EgressPathfinding = {
    VOID, WALK, OBSTACLE,
    aStar, dijkstra, centralPath, thetaStar, tracePath, argMaxFinite, smoothPath,
    pathLength, lineOfSight, inflate, nearestWalkable, MinHeap
  };
})(window);
