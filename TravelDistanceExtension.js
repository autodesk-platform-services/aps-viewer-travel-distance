// Egress travel distance extension (IBC 2024 Section 1017 by default, fully configurable).
//
// Workflow: Select walkable elements -> Build grid (cell boxes vs fragment geometry) -> Pick exits -> (optional) Pick start
// -> Compute. Without a start point, a multi-source Dijkstra from all exits finds the most
// remote point of the floor, and the selected algorithm traces the path from there.
// Paths are rendered with Autodesk.DataVisualization streamlines.
(function () {
  'use strict';

  const PF = window.EgressPathfinding;
  const GRID = window.EgressGrid;
  const STD = window.EgressStandards;
  const FT_TO_M = 0.3048;
  // Feet per unit for the unit strings returned by model.getDisplayUnit().
  const UNIT_TO_FT = {
    'ft': 1, 'ft-and-fractional-in': 1, 'ft-and-decimal-in': 1,
    'in': 1 / 12, 'decimal-in': 1 / 12, 'fractional-in': 1 / 12,
    'yd': 3, 'mi': 5280,
    'm': 1 / FT_TO_M, 'm-and-cm': 1 / FT_TO_M, 'cm': 0.01 / FT_TO_M, 'mm': 0.001 / FT_TO_M, 'km': 1000 / FT_TO_M
  };
  const METRIC_UNITS = ['m', 'm-and-cm', 'cm', 'mm', 'km'];
  // 3D: height of the cell boxes above the walking surface. 80 in = IBC minimum headroom
  // (1003.2 / 1003.3); ceilings and anything higher don't block the path.
  const HEADROOM_M = 2.032;

  const ALGORITHMS = {
    astar: { label: 'A*', color: 0x1e88e5 },
    dijkstra: { label: 'Dijkstra', color: 0x8e24aa },
    central: { label: 'Central Dijkstra', color: 0x00897b },
    theta: { label: 'Theta*', color: 0xfb8c00 }
  };

  // Tool that captures single clicks on the canvas while picking points.
  class PickTool extends Autodesk.Viewing.ToolInterface {
    constructor(onPick) {
      super();
      this.names = ['egress-pick-tool'];
      this.onPick = onPick;
      // ToolInterface defines these on the instance; remove them to use the class methods.
      delete this.getPriority;
      delete this.handleSingleClick;
    }
    getPriority() { return 100; }
    handleSingleClick(event, button) {
      if (button !== 0) return false;
      this.onPick(event.canvasX, event.canvasY);
      return true;
    }
  }

  class EgressPanel extends Autodesk.Viewing.UI.DockingPanel {
    constructor(viewer, id, title) {
      super(viewer.container, id, title);
      this.container.classList.add('egress-panel');
      this.container.style.left = '10px';
      this.container.style.top = '10px';
      this.container.style.width = '420px';
      this.container.style.height = 'calc(100% - 90px)';
      this.container.style.resize = 'none';
    }
    initialize() {
      this.title = this.createTitleBar(this.titleLabel || this.container.id);
      this.initializeMoveHandlers(this.title);
      this.container.appendChild(this.title);
      this.closer = this.createCloseButton();
      this.container.appendChild(this.closer);
      this.content = document.createElement('div');
      this.content.className = 'egress-content';
      this.container.appendChild(this.content);
    }
  }

  class TravelDistanceExtension extends Autodesk.Viewing.Extension {
    constructor(viewer, options) {
      super(viewer, options);
      this.panel = null;
      this.button = null;
      this.grid = null;
      this.exits = [];
      this.start = -1;
      this.field = null;
      this.results = [];
      this.streamLines = [];
      this.animation = null;
      this.pickMode = null;
      this.standards = STD.load();
      this.pickTool = new PickTool((x, y) => this.onPick(x, y));
    }

    load() {
      this.viewer.toolController.registerTool(this.pickTool);
      this.viewer.loadExtension('Autodesk.DataVisualization').then((ext) => { this.dataViz = ext; });
      return true;
    }

    unload() {
      this.clearAll();
      this.viewer.toolController.deregisterTool(this.pickTool);
      if (this.button) this.viewer.toolbar.getControl('egress-toolbar-group')?.removeControl(this.button);
      if (this.panel) { this.panel.setVisible(false); this.panel.uninitialize(); this.panel = null; }
      return true;
    }

    onToolbarCreated(toolbar) {
      const group = new Autodesk.Viewing.UI.ControlGroup('egress-toolbar-group');
      this.button = new Autodesk.Viewing.UI.Button('egress-button');
      this.button.setToolTip('Egress travel distance');
      this.button.icon.classList.add('glyphicon', 'glyphicon-road');
      this.button.onClick = () => this.togglePanel();
      group.addControl(this.button);
      toolbar.addControl(group);
    }

    togglePanel() {
      if (!this.panel) {
        this.panel = new EgressPanel(this.viewer, 'egress-panel', 'Egress travel distance');
        this.panel.content.innerHTML = this.panelHtml();
        this.bindUi();
        this.renderStandards();
        this.onModelChanged();
      }
      this.panel.setVisible(!this.panel.isVisible());
    }

    // Called by index.html when a different viewable is loaded.
    async onModelChanged() {
      this.clearAll();
      this.clearSelectionArea();
      const model = this.viewer.model;
      if (!model) return;
      const is2d = model.is2d();
      // Real-world scale and display units always come from the model itself.
      this.scaleInfo = is2d ? await this.scaleFromViewport2D() : {
        ftPerUnit: model.getUnitScale() / FT_TO_M,
        source: `model unit scale (${model.getUnitString()})`
      };
      this.applyModelUnits();
      if (!this.panel) return;
      this.el('eg-scale-info').textContent =
        `Model units: ${model.getDisplayUnit() || '?'} - 1 drawing unit = ${this.formatLength(this.scaleInfo.ftPerUnit)} (${this.scaleInfo.source})`;
      this.setStatus(is2d ? '2D sheet loaded.' : '3D model loaded.');
    }

    // ---------------------------------------------------------------- UI
    el(id) { return document.getElementById(id); }

    panelHtml() {
      return `
      <details open><summary>Standards</summary>
        <div class="form-group form-group-sm">
          <label>Occupancy (Table 1017.2 row)</label>
          <select id="eg-occupancy" class="form-control"></select>
        </div>
        <div class="checkbox"><label><input type="checkbox" id="eg-sprinklered" checked> Building equipped throughout with automatic sprinkler system</label></div>
        <details><summary>Edit limits table</summary>
          <div id="eg-std-name" class="text-muted small"></div>
          <table class="table table-condensed egress-table">
            <thead><tr><th>Occupancy</th><th>Without sprinkler (ft)</th><th>With sprinkler (ft)</th></tr></thead>
            <tbody id="eg-std-rows"></tbody>
          </table>
          <div class="small text-muted">Empty value = Not Permitted. Hover a row for its footnotes.</div>
        </details>
        <details><summary>Modifiers</summary><div id="eg-modifiers"></div></details>
        <div class="btn-group btn-group-xs egress-buttons">
          <button id="eg-std-reset" class="btn btn-default">Reset to IBC 2024</button>
          <button id="eg-std-export" class="btn btn-default">Export JSON</button>
          <button id="eg-std-import" class="btn btn-default">Import JSON</button>
        </div>
        <input type="file" id="eg-std-file" accept=".json" style="display:none">
        <div id="eg-limit" class="egress-limit"></div>
      </details>

      <details open><summary>Grid</summary>
        <div id="eg-scale-info" class="small text-muted"></div>
        <div class="small">1. Select the walkable elements (floors, rooms, stairs...): click one, hold <b>Ctrl</b> and click to add or remove more (or use the Model Browser).</div>
        <div class="btn-group btn-group-xs egress-buttons">
          <button id="eg-use-selection" class="btn btn-default">Use selection as walkable area</button>
          <button id="eg-clear-selection" class="btn btn-default">Clear</button>
        </div>
        <div id="eg-selection-info" class="small text-muted">No walkable area selected.</div>
        <div class="form-group form-group-sm"><label>2. Cell size (<span class="eg-unit"></span>)</label><input id="eg-cell" type="number" class="form-control" min="0.01" step="any"></div>
        <div class="btn-group btn-group-xs egress-buttons">
          <button id="eg-build" class="btn btn-primary">3. Build grid</button>
        </div>
        <div class="checkbox"><label><input type="checkbox" id="eg-showgrid" checked> Show grid</label></div>
        <div class="progress egress-progress"><div id="eg-progress" class="progress-bar" style="width:0%"></div></div>
      </details>

      <details open><summary>Path</summary>
        <div class="form-group form-group-sm"><label>Algorithm</label>
          <select id="eg-algo" class="form-control">
            <option value="theta">Theta* (any-angle)</option>
            <option value="astar">A* (8-connected, octile heuristic)</option>
            <option value="dijkstra">Dijkstra (distance field from exits)</option>
            <option value="central">Central Dijkstra (path counting, Goldstein et al. 2022)</option>
            <option value="compare">Compare all</option>
          </select></div>
        <div class="checkbox"><label><input type="checkbox" id="eg-smooth" checked> Smooth grid paths (line of sight)</label></div>
        <div class="checkbox"><label><input type="checkbox" id="eg-heatmap"> Show distance heatmap (most remote point search)</label></div>
        <div class="btn-group btn-group-xs egress-buttons">
          <button id="eg-pick-exits" class="btn btn-default">Pick exits</button>
          <button id="eg-pick-start" class="btn btn-default">Pick start</button>
          <button id="eg-clear-points" class="btn btn-default">Clear points</button>
        </div>
        <div class="btn-group btn-group-xs egress-buttons">
          <button id="eg-compute" class="btn btn-primary">Compute</button>
          <button id="eg-animate" class="btn btn-default">Animate</button>
          <button id="eg-clear" class="btn btn-default">Clear all</button>
        </div>
      </details>

      <details open><summary>Result</summary>
        <div id="eg-status" class="small text-muted"></div>
        <div id="eg-result"></div>
      </details>`;
    }

    bindUi() {
      const on = (id, evt, fn) => this.el(id).addEventListener(evt, fn);
      on('eg-occupancy', 'change', () => this.updateLimit());
      on('eg-sprinklered', 'change', () => this.updateLimit());
      on('eg-std-reset', 'click', () => { this.standards = STD.reset(); this.renderStandards(); });
      on('eg-std-export', 'click', () => STD.exportJSON(this.standards));
      on('eg-std-import', 'click', () => this.el('eg-std-file').click());
      on('eg-std-file', 'change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          this.standards = await STD.importJSON(file);
          STD.save(this.standards);
          this.renderStandards();
        } catch (err) {
          alert('Invalid standards file: ' + err.message);
        }
        e.target.value = '';
      });
      on('eg-use-selection', 'click', () => this.useSelection());
      on('eg-clear-selection', 'click', () => this.clearSelectionArea());
      on('eg-build', 'click', () => this.buildGrid());
      on('eg-showgrid', 'change', () => this.drawGrid());
      on('eg-heatmap', 'change', () => this.drawGrid());
      on('eg-pick-exits', 'click', () => this.startPick('exits'));
      on('eg-pick-start', 'click', () => this.startPick('start'));
      on('eg-clear-points', 'click', () => { this.exits = []; this.start = -1; this.field = null; this.clearPaths(); this.drawMarkers(); this.drawGrid(); });
      on('eg-compute', 'click', () => this.compute());
      on('eg-animate', 'click', () => this.animate());
      on('eg-clear', 'click', () => { this.clearAll(); this.setStatus('Cleared.'); });
    }

    renderStandards() {
      const std = this.standards;
      const occ = this.el('eg-occupancy');
      const selected = occ.selectedIndex >= 0 ? occ.selectedIndex : 2;
      occ.innerHTML = std.rows.map((r, i) => `<option value="${i}">${r.occupancy}</option>`).join('');
      occ.selectedIndex = Math.min(selected, std.rows.length - 1);
      this.el('eg-std-name').textContent = std.name;

      const footnote = (notes) => notes.split(',').map((n) => n.trim()).filter((n) => std.footnotes[n])
        .map((n) => `${n}. ${std.footnotes[n]}`).join('\n');
      this.el('eg-std-rows').innerHTML = std.rows.map((r, i) => `
        <tr title="${footnote(r.notes).replace(/"/g, '&quot;')}">
          <td>${r.occupancy}${r.notes ? ` <sup>${r.notes}</sup>` : ''}</td>
          <td><input type="number" min="0" class="form-control input-sm" data-row="${i}" data-col="unsprinklered" value="${r.unsprinklered ?? ''}" placeholder="NP"></td>
          <td><input type="number" min="0" class="form-control input-sm" data-row="${i}" data-col="sprinklered" value="${r.sprinklered ?? ''}" placeholder="NP"></td>
        </tr>`).join('');
      this.el('eg-std-rows').querySelectorAll('input').forEach((input) => {
        input.addEventListener('change', () => {
          const v = input.value.trim();
          std.rows[input.dataset.row][input.dataset.col] = v === '' ? null : Number(v);
          this.onStandardsEdited();
        });
      });

      this.el('eg-modifiers').innerHTML = Object.keys(std.modifiers).map((key) => {
        const m = std.modifiers[key];
        return `
          <div class="egress-modifier" title="${m.info.replace(/"/g, '&quot;')}">
            <label><input type="checkbox" data-mod="${key}" data-field="enabled" ${m.enabled ? 'checked' : ''}> ${m.label}</label>
            <input type="number" min="0" class="form-control input-sm" data-mod="${key}" data-field="value" value="${m.value}">
            <div class="small text-muted">${m.info}</div>
          </div>`;
      }).join('') + `<div class="small text-muted">${std.measurement.info}</div>`;
      this.el('eg-modifiers').querySelectorAll('input').forEach((input) => {
        input.addEventListener('change', () => {
          const m = std.modifiers[input.dataset.mod];
          if (input.dataset.field === 'enabled') m.enabled = input.checked;
          else m.value = Number(input.value) || 0;
          this.onStandardsEdited();
        });
      });
      this.updateLimit();
    }

    onStandardsEdited() {
      STD.save(this.standards);
      this.updateLimit();
    }

    getLimit() {
      return STD.effectiveLimit(this.standards, Number(this.el('eg-occupancy').value), this.el('eg-sprinklered').checked);
    }

    updateLimit() {
      const lim = this.getLimit();
      const text = lim.notPermitted ? 'Not Permitted' : this.formatLength(lim.limit);
      this.el('eg-limit').innerHTML = `<b>Maximum exit access travel distance: ${text}</b><br><span class="small text-muted">${lim.breakdown.join('<br>')}</span>`;
      this.renderResults();
      if (this.grid && this.el('eg-heatmap').checked) this.drawGrid();
    }

    setStatus(text) { if (this.panel) this.el('eg-status').textContent = text; }

    setProgress(fraction, text) {
      this.el('eg-progress').style.width = `${Math.round(fraction * 100)}%`;
      if (text) this.setStatus(text);
    }

    // Metric or imperial, following the display unit defined in the model.
    applyModelUnits() {
      const unit = this.viewer.model.getDisplayUnit();
      const metric = METRIC_UNITS.includes(unit);
      const changed = this.metric !== metric || !this.panel || this.el('eg-cell').value === '';
      this.metric = metric;
      if (!this.panel) return;
      this.panel.content.querySelectorAll('.eg-unit').forEach((s) => { s.textContent = this.unitLabel(); });
      if (changed) {
        // Default cell size: 1 ft / 0.3 m.
        this.el('eg-cell').value = metric ? 0.3 : 1;
      }
      this.updateLimit();
    }

    unitLabel() { return this.metric ? 'm' : 'ft'; }

    // Value typed in the panel (model display units) -> feet.
    inputFeet(id) {
      const v = Number(this.el(id).value) || 0;
      return this.metric ? v / FT_TO_M : v;
    }

    formatLength(ft) {
      if (ft === null || ft === undefined || !isFinite(ft)) return '-';
      return this.metric ? `${(ft * FT_TO_M).toFixed(2)} m` : `${ft.toFixed(1)} ft`;
    }

    // ---------------------------------------------------------------- units & levels
    feetPerUnit() {
      return this.scaleInfo ? this.scaleInfo.ftPerUnit : this.viewer.model.getUnitScale() / FT_TO_M;
    }

    // Real-world length of one sheet unit, calculated from the model (no user input):
    //  1. AEC viewport 2D->3D matrix (Autodesk.AEC.ViewportsExtension), the same transform used to map
    //     sheet points to 3D world coordinates. Revit model coordinates are in feet.
    //  2. Page-to-model transform of the sheet viewports, in the model units of the sheet.
    //  3. Sheet unit scale (paper units).
    async scaleFromViewport2D() {
      const viewer = this.viewer, model = viewer.model;
      const box = model.getBoundingBox();
      try {
        const vpExt = viewer.getExtension('Autodesk.AEC.ViewportsExtension') ||
          await viewer.loadExtension('Autodesk.AEC.ViewportsExtension');
        const area = this.walkableBounds || box;
        const candidates = [];
        for (let i = 1; i < 4; i++) {
          for (let j = 1; j < 4; j++) {
            candidates.push(new THREE.Vector2(
              area.min.x + (area.max.x - area.min.x) * i / 4,
              area.min.y + (area.max.y - area.min.y) * j / 4));
          }
        }
        candidates.unshift(candidates.splice(4, 1)[0]); // center first
        for (const p of candidates) {
          const vp = vpExt.findViewportAtPoint(model, p);
          if (!vp) continue;
          const matrix = vp.get2DTo3DMatrix(model.getUnitScale());
          if (!matrix) continue;
          const a = new THREE.Vector3(p.x, p.y, 0).applyMatrix4(matrix);
          const b = new THREE.Vector3(p.x + 1, p.y, 0).applyMatrix4(matrix);
          const ftPerUnit = a.distanceTo(b);
          if (ftPerUnit > 0 && isFinite(ftPerUnit)) {
            const name = vp.viewportRaw && (vp.viewportRaw.name || vp.viewportRaw.viewName);
            return { ftPerUnit, source: `viewport 2D->3D transform${name ? ' "' + name + '"' : ''}` };
          }
        }
      } catch (err) {
        console.warn('Viewport transform not available', err);
      }
      const viewports = (model.getData() && model.getData().viewports) || [];
      const unitFt = UNIT_TO_FT[model.getDisplayUnit()] || 1;
      for (let i = viewports.length - 1; i >= 0; i--) {
        const m = model.getPageToModelTransform(i);
        const scale = m && Math.hypot(m.elements[0], m.elements[1]);
        if (scale && Math.abs(scale - 1) > 1e-9) return { ftPerUnit: scale * unitFt, source: 'page-to-model transform' };
      }
      return { ftPerUnit: model.getUnitScale() / FT_TO_M, source: 'sheet unit scale (no viewport transform found)' };
    }

    // ---------------------------------------------------------------- walkable area (selection)
    // The current viewer selection (floors, rooms, stairs, ...) becomes the only walkable area.
    useSelection() {
      const model = this.viewer.model;
      const selected = this.viewer.getSelection();
      if (!selected.length) {
        alert('Select floors, rooms or stairs first (Ctrl+click or the Model Browser).');
        return;
      }
      const tree = model.getInstanceTree && model.getInstanceTree();
      const ids = new Set();
      selected.forEach((id) => {
        ids.add(id);
        if (tree) tree.enumNodeChildren(id, (child) => { ids.add(child); }, true);
      });
      const bounds = new THREE.Box3();
      const fragBox = new THREE.Box3();
      const frags = model.getFragmentList && model.getFragmentList();
      let levelZ = Infinity;
      const thin = 1 / model.getUnitScale(); // 1 m in model units
      if (tree && frags) {
        selected.forEach((id) => {
          const elementBox = new THREE.Box3();
          tree.enumNodeFragments(id, (fragId) => {
            frags.getWorldBounds(fragId, fragBox);
            elementBox.union(fragBox);
          }, true);
          if (elementBox.isEmpty()) return;
          bounds.union(elementBox);
          // Floors (thin): the walking surface is the top. Rooms/stairs (tall): the bottom.
          const height = elementBox.max.z - elementBox.min.z;
          levelZ = Math.min(levelZ, height < thin ? elementBox.max.z : elementBox.min.z);
        });
      }
      if (bounds.isEmpty()) {
        alert('Could not compute the extents of the selected elements.');
        return;
      }
      this.clearAll(true);
      this.walkableIds = [...ids];
      this.walkableSet = ids;
      this.walkableBounds = bounds;
      this.walkableLevelZ = isFinite(levelZ) ? levelZ : bounds.min.z;
      this.viewer.clearSelection();
      const ft = this.feetPerUnit();
      const size = `${this.formatLength((bounds.max.x - bounds.min.x) * ft)} x ${this.formatLength((bounds.max.y - bounds.min.y) * ft)}`;
      this.el('eg-selection-info').textContent = `${selected.length} element(s) selected as walkable area (${size}).`;
      this.drawArea();
      this.setStatus('Walkable area set. Click "Build grid".');
      if (model.is2d()) {
        // Recalculate the scale from the viewport under the selected area.
        this.scaleFromViewport2D().then((info) => {
          this.scaleInfo = info;
          this.el('eg-scale-info').textContent =
            `Model units: ${model.getDisplayUnit() || '?'} - 1 drawing unit = ${this.formatLength(info.ftPerUnit)} (${info.source})`;
        });
      }
    }

    clearSelectionArea() {
      this.walkableIds = null;
      this.walkableSet = null;
      this.walkableBounds = null;
      this.walkableLevelZ = null;
      this.removeScene('egress-area');
      if (this.panel) this.el('eg-selection-info').textContent = 'No walkable area selected.';
    }

    // Outline of the walkable area extents.
    drawArea() {
      this.removeScene('egress-area');
      const b = this.walkableBounds;
      if (!b) return;
      const z = this.viewer.model.is2d() ? 0 : this.walkableLevelZ + 0.1 / this.viewer.model.getUnitScale();
      const w = Math.max(b.max.x - b.min.x, b.max.y - b.min.y) * 0.004;
      const quads = [
        [b.min.x - w, b.min.y - w, b.max.x + w, b.min.y],
        [b.min.x - w, b.max.y, b.max.x + w, b.max.y + w],
        [b.min.x - w, b.min.y, b.min.x, b.max.y],
        [b.max.x, b.min.y, b.max.x + w, b.max.y]
      ];
      this.ensureScene('egress-area');
      this.quadMeshes(quads, z, 0x1e88e5, 0.9).forEach((m) => this.viewer.overlays.addMesh(m, 'egress-area'));
      this.viewer.impl.invalidate(false, false, true);
    }

    // ---------------------------------------------------------------- picking
    startPick(mode) {
      if (!this.grid) {
        alert('Build the grid first.');
        return;
      }
      this.pickMode = mode;
      if (mode === 'exits') this.exits = [];
      this.viewer.toolController.activateTool('egress-pick-tool');
      const hints = {
        exits: 'Click on the exits (entrance to an exit, e.g. exit doors). Press Esc or click "Pick exits" again to finish.',
        start: 'Click on the starting point.'
      };
      this.setStatus(hints[mode]);
      if (mode === 'exits') {
        this.escHandler = (e) => { if (e.key === 'Escape') this.endPick(); };
        document.addEventListener('keydown', this.escHandler);
      }
    }

    endPick() {
      this.viewer.toolController.deactivateTool('egress-pick-tool');
      if (this.escHandler) { document.removeEventListener('keydown', this.escHandler); this.escHandler = null; }
      if (this.pickMode === 'exits') this.setStatus(`${this.exits.length} exit(s) picked.`);
      this.pickMode = null;
    }

    // World point on the floor plane under the cursor (viewer camera ray / plane intersection).
    clientToFloor(x, y) {
      const z = this.grid ? this.grid.z : 0;
      const ray = new THREE.Ray();
      this.viewer.impl.viewportToRay(this.viewer.impl.clientToViewport(x, y), ray);
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
      const point = ray.intersectPlane(plane);
      return point || this.viewer.clientToWorld(x, y, true)?.point || null;
    }

    onPick(x, y) {
      const point = this.clientToFloor(x, y);
      if (!point) return;
      const mode = this.pickMode;
      const cell = GRID.worldToCell(this.grid, point);
      const snapped = cell >= 0 ? PF.nearestWalkable(this.grid, cell, 5) : -1;
      if (snapped < 0) {
        this.setStatus('No walkable cell near the picked point.');
        return;
      }
      if (mode === 'exits') {
        this.exits.push(snapped);
        this.setStatus(`${this.exits.length} exit(s) picked. Esc to finish.`);
      } else if (mode === 'start') {
        this.start = snapped;
        this.endPick();
        this.setStatus('Start point picked.');
      }
      this.field = null;
      this.drawMarkers();
    }

    // ---------------------------------------------------------------- grid
    async buildGrid() {
      const viewer = this.viewer, model = viewer.model;
      if (!this.walkableIds) {
        alert('Select the walkable elements (floors, rooms, stairs...) and click "Use selection as walkable area" first.');
        return;
      }
      const is2d = model.is2d();
      const ftPerUnit = this.feetPerUnit();
      const cellFt = this.inputFeet('eg-cell');
      if (!(cellFt > 0)) return alert('Invalid cell size.');
      this.clearAll(true);
      const levelZ = is2d ? 0 : this.walkableLevelZ;
      const btn = this.el('eg-build');
      btn.disabled = true;
      try {
        const t0 = performance.now();
        const builder = new EgressGridBuilder(viewer);
        this.grid = await builder.build({
          is2d,
          walkableIds: this.walkableIds,
          walkableSet: this.walkableSet,
          bounds: this.walkableBounds,
          levelZ,
          headroom: HEADROOM_M / model.getUnitScale(),
          cellSize: cellFt / ftPerUnit,
          onProgress: (f, text) => this.setProgress(f, text)
        });
        this.grid.ftPerUnit = ftPerUnit;
        const counts = [0, 0, 0];
        this.grid.cells.forEach((c) => counts[c]++);
        this.setProgress(1);
        this.setStatus(`Grid ${this.grid.cols} x ${this.grid.rows}: ${counts[1]} walkable, ${counts[2]} obstacle, ${counts[0]} void cells (${((performance.now() - t0) / 1000).toFixed(1)} s). ${this.grid.warnings.join(' ')}`);
        this.drawGrid();
        this.drawArea();
      } catch (err) {
        console.error(err);
        this.setStatus('Grid build failed: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    }

    overlayZ() {
      if (!this.grid) return 0;
      return this.viewer.model.is2d() ? 0 : this.grid.z + (0.1 / this.viewer.model.getUnitScale());
    }

    ensureScene(name) {
      if (!this.viewer.overlays.hasScene(name)) this.viewer.overlays.addScene(name);
    }

    removeScene(name) {
      if (this.viewer.overlays.hasScene(name)) this.viewer.overlays.removeScene(name);
    }

    drawGrid() {
      this.removeScene('egress-grid');
      if (!this.grid || !this.panel || !this.el('eg-showgrid').checked) { this.viewer.impl.invalidate(false, false, true); return; }
      const g = this.grid, cs = g.cellSize, z = this.overlayZ() - (this.viewer.model.is2d() ? 0 : cs * 0.01);
      const heat = this.el('eg-heatmap').checked && this.field;
      const limitFt = this.getLimit().limit;
      // One mesh per color bucket (plain colored materials, no vertex colors).
      const HEAT_BINS = 10;
      const buckets = new Map();
      const add = (key, hex, i) => {
        if (!buckets.has(key)) buckets.set(key, { hex, cells: [] });
        buckets.get(key).cells.push(i);
      };
      const color = new THREE.Color();
      for (let i = 0; i < g.cells.length; i++) {
        const c = g.cells[i];
        if (c === PF.VOID) continue;
        if (c === PF.OBSTACLE) add('obstacle', 0xe53935, i);
        else if (heat && isFinite(this.field.dist[i]) && limitFt) {
          const t = (this.field.dist[i] * cs * g.ftPerUnit) / limitFt;
          if (t > 1) add('over', 0x8e24aa, i);
          else {
            const bin = Math.min(HEAT_BINS - 1, Math.floor(t * HEAT_BINS));
            color.setHSL((1 - bin / (HEAT_BINS - 1)) * 0.33, 0.9, 0.5);
            add('heat' + bin, color.getHex(), i);
          }
        } else if (g.doors[i]) add('door', 0x1e88e5, i);
        else add('walk', 0x43a047, i);
      }
      this.ensureScene('egress-grid');
      const inset = cs * 0.04;
      buckets.forEach(({ hex, cells }) => {
        const quads = cells.map((i) => {
          const x0 = g.origin.x + (i % g.cols) * cs, y0 = g.origin.y + ((i / g.cols) | 0) * cs;
          return [x0 + inset, y0 + inset, x0 + cs - inset, y0 + cs - inset];
        });
        this.quadMeshes(quads, z, hex, 0.45).forEach((m) => this.viewer.overlays.addMesh(m, 'egress-grid'));
      });
      this.viewer.impl.invalidate(false, false, true);
    }

    // Overlay geometry built like Autodesk.DataVisualization does (Float32 positions with
    // bytesPerItem = 4 and a Uint16 index), split in chunks so indices fit in 16 bits.
    makeMesh(positions, indices, hex, opacity) {
      const geom = new THREE.BufferGeometry();
      const pos = new THREE.BufferAttribute(new Float32Array(positions), 3);
      pos.bytesPerItem = 4;
      geom.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
      geom.setAttribute('position', pos);
      geom.computeBoundingBox && geom.computeBoundingBox();
      geom.computeBoundingSphere && geom.computeBoundingSphere();
      const mat = new THREE.MeshBasicMaterial({
        color: hex, transparent: opacity < 1, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      return mesh;
    }

    quadMeshes(quads, z, hex, opacity) {
      const meshes = [];
      const MAX_QUADS = 16000; // 64000 vertices per mesh
      for (let start = 0; start < quads.length; start += MAX_QUADS) {
        const chunk = quads.slice(start, start + MAX_QUADS);
        const positions = new Array(chunk.length * 12), indices = new Array(chunk.length * 6);
        chunk.forEach(([x0, y0, x1, y1], q) => {
          positions.splice(q * 12, 12, x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
          const v = q * 4;
          indices.splice(q * 6, 6, v, v + 1, v + 2, v, v + 2, v + 3);
        });
        meshes.push(this.makeMesh(positions, indices, hex, opacity));
      }
      return meshes;
    }

    disc(center, radius, hex) {
      const seg = 24, positions = [center.x, center.y, center.z], indices = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        positions.push(center.x + Math.cos(a) * radius, center.y + Math.sin(a) * radius, center.z);
        indices.push(0, 1 + i, 1 + ((i + 1) % seg));
      }
      return this.makeMesh(positions, indices, hex, 1);
    }

    drawMarkers() {
      this.removeScene('egress-markers');
      if (!this.grid) return;
      this.ensureScene('egress-markers');
      const r = this.grid.cellSize * 1.2, z = this.overlayZ();
      const at = (idx) => { const p = GRID.cellCenter(this.grid, idx); p.z = z; return p; };
      this.exits.forEach((e) => this.viewer.overlays.addMesh(this.disc(at(e), r, 0x2e7d32), 'egress-markers'));
      const start = this.start >= 0 ? this.start : this.remote;
      if (start >= 0 && start !== undefined) this.viewer.overlays.addMesh(this.disc(at(start), r, 0xc62828), 'egress-markers');
      this.viewer.impl.invalidate(false, false, true);
    }

    // ---------------------------------------------------------------- path finding
    compute() {
      if (!this.grid) return alert('Build the grid first.');
      if (!this.exits.length) return alert('Pick at least one exit.');
      this.clearPaths();
      const g = this.grid;
      const selected = this.el('eg-algo').value;
      const algos = selected === 'compare' ? Object.keys(ALGORITHMS) : [selected];
      const smooth = this.el('eg-smooth').checked;

      // Distance field from all exits (nearest exit, IBC 1017.3).
      const tField = performance.now();
      this.field = PF.dijkstra(g, this.exits);
      const fieldMs = performance.now() - tField;
      let start = this.start;
      this.remote = -1;
      if (start < 0) {
        start = PF.argMaxFinite(this.field.dist);
        this.remote = start;
      }
      if (start < 0 || !isFinite(this.field.dist[start])) {
        this.setStatus('The start point cannot reach any exit.');
        this.drawGrid();
        return;
      }

      this.results = algos.map((key) => {
        const t0 = performance.now();
        let r;
        if (key === 'astar') r = PF.aStar(g, start, this.exits);
        else if (key === 'theta') r = PF.thetaStar(g, start, this.exits);
        else if (key === 'central') r = PF.centralPath(g, this.field, start);
        else r = PF.tracePath(this.field, start);
        let ms = performance.now() - t0 + (key === 'dijkstra' || key === 'central' ? fieldMs : 0);
        const raw = r.path;
        const path = (smooth && key !== 'theta') ? PF.smoothPath(g, raw) : raw;
        return {
          key, ms, expanded: r.expanded, cells: raw.length,
          rawFt: this.measure(raw), lengthFt: this.measure(path), path
        };
      });
      this.startIdx = start;
      this.drawGrid();
      this.drawMarkers();
      this.drawPaths();
      this.renderResults();
      this.setStatus(this.remote >= 0
        ? 'Start = most remote point from the nearest exit (Dijkstra distance field).'
        : 'Start = picked point.');
    }

    // Path length measured in world space with the viewer's model units, converted to feet.
    measure(path) {
      let len = 0;
      for (let i = 1; i < path.length; i++) {
        len += GRID.cellCenter(this.grid, path[i - 1]).distanceTo(GRID.cellCenter(this.grid, path[i]));
      }
      return len * this.grid.ftPerUnit;
    }

    pathPoints(path) {
      const z = this.overlayZ() + (this.viewer.model.is2d() ? 0 : this.grid.cellSize * 0.05);
      const pts = [];
      path.forEach((idx) => { const p = GRID.cellCenter(this.grid, idx); pts.push(p.x, p.y, z); });
      return pts;
    }

    drawPaths() {
      if (!this.dataViz) return;
      const builder = this.dataViz.streamLineBuilder;
      const limit = this.getLimit();
      const single = this.results.length === 1;
      this.results.forEach((r) => {
        if (r.path.length < 2) return;
        const pass = !limit.notPermitted && limit.limit !== null && r.lengthFt <= limit.limit;
        const hex = single ? (pass ? 0x2e7d32 : 0xc62828) : ALGORITHMS[r.key].color;
        const line = builder.createStreamLine({
          lineWidth: 8.0,
          lineColor: new THREE.Color(hex),
          opacity: 0.9,
          lineData: { points: new Float32Array(this.pathPoints(r.path)) }
        });
        this.streamLines.push(line);
      });
      this.viewer.impl.invalidate(false, false, true);
    }

    // Moving trail along the computed path (StreamLine.advance, as in the APS streamlines blog).
    animate() {
      if (!this.dataViz || !this.results.length) return;
      this.stopAnimation();
      const r = this.results[this.results.length - 1];
      const pts = this.pathPoints(r.path);
      const step = this.grid.cellSize * 0.5;
      const dense = [];
      for (let i = 3; i < pts.length; i += 3) {
        const ax = pts[i - 3], ay = pts[i - 2], bx = pts[i], by = pts[i + 1], z = pts[i + 2];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let k = 0; k < n; k++) dense.push({ x: ax + (bx - ax) * k / n, y: ay + (by - ay) * k / n, z });
      }
      dense.push({ x: pts[pts.length - 3], y: pts[pts.length - 2], z: pts[pts.length - 1] });
      const trail = 20;
      const init = [];
      for (let k = 0; k < trail; k++) init.push(dense[0].x, dense[0].y, dense[0].z);
      const builder = this.dataViz.streamLineBuilder;
      const line = builder.createStreamLine({
        lineWidth: 14.0, lineColor: new THREE.Color(0xffd600), opacity: 1.0,
        lineData: { points: new Float32Array(init) }
      });
      let i = 0;
      const total = dense.length + trail;
      this.animation = {
        line,
        timer: setInterval(() => {
          line.advance(dense[Math.min(i, dense.length - 1)]);
          this.viewer.impl.invalidate(false, false, true);
          if (++i > total) this.stopAnimation();
        }, 30)
      };
    }

    stopAnimation() {
      if (!this.animation) return;
      clearInterval(this.animation.timer);
      this.dataViz.streamLineBuilder.destroyStreamLine(this.animation.line);
      this.animation = null;
      this.viewer.impl.invalidate(false, false, true);
    }

    renderResults() {
      if (!this.panel) return;
      const out = this.el('eg-result');
      if (!this.results.length) { out.innerHTML = ''; return; }
      const limit = this.getLimit();
      const rows = this.results.map((r) => {
        const pass = !limit.notPermitted && limit.limit !== null && r.lengthFt <= limit.limit;
        const verdict = limit.notPermitted
          ? '<span class="label label-danger">Not Permitted</span>'
          : `<span class="label label-${pass ? 'success' : 'danger'}">${pass ? 'PASS' : 'FAIL'}</span>`;
        return `<tr>
          <td><span class="egress-swatch" style="background:#${ALGORITHMS[r.key].color.toString(16).padStart(6, '0')}"></span>${ALGORITHMS[r.key].label}</td>
          <td><b>${this.formatLength(r.lengthFt)}</b><br><span class="small text-muted">grid: ${this.formatLength(r.rawFt)}</span></td>
          <td>${r.expanded}</td><td>${r.ms.toFixed(1)}</td><td>${verdict}</td></tr>`;
      }).join('');
      out.innerHTML = `
        <table class="table table-condensed">
          <thead><tr><th>Algorithm</th><th>Distance</th><th>Expanded</th><th>ms</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="small">Limit: ${limit.notPermitted ? 'Not Permitted' : this.formatLength(limit.limit)} -
          ${this.exits.length} exit(s), cell ${this.formatLength(this.grid.cellSize * this.grid.ftPerUnit)}</div>`;
    }

    // ---------------------------------------------------------------- cleanup
    clearPaths() {
      this.stopAnimation();
      if (this.dataViz) this.streamLines.forEach((s) => this.dataViz.streamLineBuilder.destroyStreamLine(s));
      this.streamLines = [];
      this.results = [];
      this.renderResults();
      this.viewer.impl.invalidate(false, false, true);
    }

    clearAll(keepView) {
      if (this.pickMode) this.endPick();
      this.clearPaths();
      this.grid = null;
      this.field = null;
      this.exits = [];
      this.start = -1;
      this.remote = -1;
      this.removeScene('egress-grid');
      this.removeScene('egress-markers');
      if (!keepView && this.viewer.model && !this.viewer.model.is2d()) this.viewer.setCutPlanes([]);
      this.viewer.impl.invalidate(true, true, true);
    }
  }

  Autodesk.Viewing.theExtensionManager.registerExtension('TravelDistanceExtension', TravelDistanceExtension);
})();
