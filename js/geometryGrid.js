// Exact grid cell vs fragment geometry tests (no screen hit tests, no element bounding boxes).
//
// Each grid rectangle becomes a box (THREE.Box3 in 3D, a rectangle in 2D) that is tested against
// the real fragment geometry, read as described in the APS blog "Working with 2D and 3D scenes and
// geometry in Forge Viewer":
//  - 3D: frags.getVizmesh(fragId).geometry + frags.getWorldMatrix(fragId, m), triangles enumerated
//        with Autodesk.Viewing.Private.VertexEnumerator.enumMeshTriangles.
//  - 2D: Autodesk.Viewing.Private.VertexBufferReader(geometry).enumGeoms(filter, callbacks).
// The loops are driven by primitives: each triangle/segment only visits the cells under its own
// bounding rectangle, and an exact separating-axis test decides the overlap.
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 3D: triangle vs box (SAT)
  // Box given by center (cx, cy, cz) and half sizes (hx, hy, hz); triangle by 3 points.
  const v0 = [0, 0, 0], v1 = [0, 0, 0], v2 = [0, 0, 0];
  const e0 = [0, 0, 0], e1 = [0, 0, 0], e2 = [0, 0, 0];

  // Projects the triangle on axis (ax, ay, az) and compares it with the box projection radius.
  function separated(ax, ay, az, hx, hy, hz) {
    const p0 = ax * v0[0] + ay * v0[1] + az * v0[2];
    const p1 = ax * v1[0] + ay * v1[1] + az * v1[2];
    const p2 = ax * v2[0] + ay * v2[1] + az * v2[2];
    const r = hx * Math.abs(ax) + hy * Math.abs(ay) + hz * Math.abs(az);
    return Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r;
  }

  function triBoxOverlap(cx, cy, cz, hx, hy, hz, a, b, c) {
    v0[0] = a.x - cx; v0[1] = a.y - cy; v0[2] = a.z - cz;
    v1[0] = b.x - cx; v1[1] = b.y - cy; v1[2] = b.z - cz;
    v2[0] = c.x - cx; v2[1] = c.y - cy; v2[2] = c.z - cz;
    // Box face normals (the triangle AABB vs box).
    if (separated(1, 0, 0, hx, hy, hz) || separated(0, 1, 0, hx, hy, hz) || separated(0, 0, 1, hx, hy, hz)) return false;
    for (let k = 0; k < 3; k++) { e0[k] = v1[k] - v0[k]; e1[k] = v2[k] - v1[k]; e2[k] = v0[k] - v2[k]; }
    // Triangle normal.
    const nx = e0[1] * e1[2] - e0[2] * e1[1];
    const ny = e0[2] * e1[0] - e0[0] * e1[2];
    const nz = e0[0] * e1[1] - e0[1] * e1[0];
    if (separated(nx, ny, nz, hx, hy, hz)) return false;
    // 9 cross products: box axes x triangle edges.
    const edges = [e0, e1, e2];
    for (let k = 0; k < 3; k++) {
      const e = edges[k];
      if (separated(0, -e[2], e[1], hx, hy, hz)) return false; // X x e
      if (separated(e[2], 0, -e[0], hx, hy, hz)) return false; // Y x e
      if (separated(-e[1], e[0], 0, hx, hy, hz)) return false; // Z x e
    }
    return true;
  }

  // ---------------------------------------------------------------- 2D: segment / triangle vs rectangle
  // Liang-Barsky clipping of segment p0-p1 against [x0,x1] x [y0,y1].
  function segRectOverlap(ax, ay, bx, by, x0, y0, x1, y1) {
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    const p = [-dx, dx, -dy, dy];
    const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) return false;
      } else {
        const t = q[k] / p[k];
        if (p[k] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
      }
    }
    return true;
  }

  function triRectOverlap2D(ax, ay, bx, by, cx, cy, x0, y0, x1, y1) {
    if (Math.max(ax, bx, cx) < x0 || Math.min(ax, bx, cx) > x1) return false;
    if (Math.max(ay, by, cy) < y0 || Math.min(ay, by, cy) > y1) return false;
    const pts = [[ax, ay], [bx, by], [cx, cy]];
    const rect = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (let k = 0; k < 3; k++) {
      const p = pts[k], q = pts[(k + 1) % 3];
      const nx = q[1] - p[1], ny = p[0] - q[0]; // edge normal
      let tmin = Infinity, tmax = -Infinity;
      pts.forEach((v) => { const d = nx * v[0] + ny * v[1]; tmin = Math.min(tmin, d); tmax = Math.max(tmax, d); });
      let rmin = Infinity, rmax = -Infinity;
      rect.forEach((v) => { const d = nx * v[0] + ny * v[1]; rmin = Math.min(rmin, d); rmax = Math.max(rmax, d); });
      if (tmax < rmin || rmax < tmin) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- grid marking
  // ctx: { ox, oy, cs, cols, rows }. mark(i) is called for every overlapped cell; skip(i) avoids
  // re-testing cells that are already decided.
  function cellRange(ctx, minX, minY, maxX, maxY) {
    const c0 = Math.max(0, Math.floor((minX - ctx.ox) / ctx.cs));
    const r0 = Math.max(0, Math.floor((minY - ctx.oy) / ctx.cs));
    const c1 = Math.min(ctx.cols - 1, Math.floor((maxX - ctx.ox) / ctx.cs));
    const r1 = Math.min(ctx.rows - 1, Math.floor((maxY - ctx.oy) / ctx.cs));
    return [c0, r0, c1, r1];
  }

  // 3D: the cell box is [cell rectangle] x [zMin, zMax].
  function markTriangle3D(ctx, a, b, c, zMin, zMax, mark, skip) {
    if (Math.max(a.z, b.z, c.z) < zMin || Math.min(a.z, b.z, c.z) > zMax) return;
    const [c0, r0, c1, r1] = cellRange(ctx,
      Math.min(a.x, b.x, c.x), Math.min(a.y, b.y, c.y), Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y));
    const h = ctx.cs / 2, cz = (zMin + zMax) / 2, hz = (zMax - zMin) / 2;
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const i = r * ctx.cols + col;
        if (skip(i)) continue;
        const cx = ctx.ox + (col + 0.5) * ctx.cs, cy = ctx.oy + (r + 0.5) * ctx.cs;
        if (triBoxOverlap(cx, cy, cz, h, h, hz, a, b, c)) mark(i);
      }
    }
  }

  function markSegment2D(ctx, ax, ay, bx, by, mark, skip) {
    const [c0, r0, c1, r1] = cellRange(ctx, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const i = r * ctx.cols + col;
        if (skip(i)) continue;
        const x0 = ctx.ox + col * ctx.cs, y0 = ctx.oy + r * ctx.cs;
        if (segRectOverlap(ax, ay, bx, by, x0, y0, x0 + ctx.cs, y0 + ctx.cs)) mark(i);
      }
    }
  }

  function markTriangle2D(ctx, ax, ay, bx, by, cx, cy, mark, skip) {
    const [c0, r0, c1, r1] = cellRange(ctx,
      Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.max(ax, bx, cx), Math.max(ay, by, cy));
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const i = r * ctx.cols + col;
        if (skip(i)) continue;
        const x0 = ctx.ox + col * ctx.cs, y0 = ctx.oy + r * ctx.cs;
        if (triRectOverlap2D(ax, ay, bx, by, cx, cy, x0, y0, x0 + ctx.cs, y0 + ctx.cs)) mark(i);
      }
    }
  }

  // ---------------------------------------------------------------- fragment geometry access
  const _m = typeof THREE !== 'undefined' ? new THREE.Matrix4() : null;

  // Calls cb(a, b, c) with every triangle of a 3D fragment in world coordinates.
  function enumFragmentTriangles(frags, fragId, cb) {
    const mesh = frags.getVizmesh(fragId);
    const geom = mesh && mesh.geometry;
    if (!geom || geom.isLines || geom.isWideLines || geom.isPoints) return;
    frags.getWorldMatrix(fragId, _m);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    Autodesk.Viewing.Private.VertexEnumerator.enumMeshTriangles(geom, (vA, vB, vC) => {
      a.set(vA.x, vA.y, vA.z).applyMatrix4(_m);
      b.set(vB.x, vB.y, vB.z).applyMatrix4(_m);
      c.set(vC.x, vC.y, vC.z).applyMatrix4(_m);
      cb(a, b, c);
    });
  }

  // Enumerates the 2D primitives of a fragment. filter(dbId) returns false to skip a primitive;
  // callbacks receive world coordinates. Arcs are tessellated into segments of at most maxChord.
  function enumFragment2D(frags, fragId, filter, cb, maxChord) {
    const mesh = frags.getVizmesh(fragId);
    const geom = mesh && mesh.geometry;
    if (!geom || !geom.vb) return;
    let m = null;
    try { frags.getWorldMatrix(fragId, _m); m = _m.elements; } catch (e) { m = null; }
    const tx = (x, y) => (m ? m[0] * x + m[4] * y + m[12] : x);
    const ty = (x, y) => (m ? m[1] * x + m[5] * y + m[13] : y);
    const segment = (x0, y0, x1, y1) => cb.segment(tx(x0, y0), ty(x0, y0), tx(x1, y1), ty(x1, y1));
    const triangle = (x0, y0, x1, y1, x2, y2) =>
      cb.triangle(tx(x0, y0), ty(x0, y0), tx(x1, y1), ty(x1, y1), tx(x2, y2), ty(x2, y2));
    const arc = (cx, cy, start, end, major, minor, tilt) => {
      let sweep = end - start;
      if (sweep <= 0) sweep += Math.PI * 2;
      const n = Math.max(2, Math.min(256, Math.ceil(sweep * Math.max(major, minor) / maxChord)));
      const cos = Math.cos(tilt), sin = Math.sin(tilt);
      let px, py;
      for (let k = 0; k <= n; k++) {
        const t = start + sweep * k / n;
        const ex = major * Math.cos(t), ey = minor * Math.sin(t);
        const x = cx + ex * cos - ey * sin, y = cy + ex * sin + ey * cos;
        if (k > 0) segment(px, py, x, y);
        px = x; py = y;
      }
    };
    const vbr = new Autodesk.Viewing.Private.VertexBufferReader(geom);
    vbr.enumGeoms((dbId) => filter(dbId), {
      onLineSegment: (x0, y0, x1, y1) => segment(x0, y0, x1, y1),
      onCircularArc: (cx, cy, start, end, radius) => arc(cx, cy, start, end, radius, radius, 0),
      onEllipticalArc: (cx, cy, start, end, major, minor, tilt) => arc(cx, cy, start, end, major, minor, tilt),
      onOneTriangle: (x0, y0, x1, y1, x2, y2) => triangle(x0, y0, x1, y1, x2, y2),
      onTexQuad: (cx, cy, w, h, rot) => {
        const c = Math.cos(rot), s = Math.sin(rot);
        const p = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
          .map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
        triangle(p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1]);
        triangle(p[0][0], p[0][1], p[2][0], p[2][1], p[3][0], p[3][1]);
      }
    });
  }

  global.EgressGeometry = {
    triBoxOverlap, segRectOverlap, triRectOverlap2D,
    markTriangle3D, markSegment2D, markTriangle2D,
    enumFragmentTriangles, enumFragment2D
  };
})(typeof window !== 'undefined' ? window : global);
