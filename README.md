# APS Viewer - Egress Travel Distance Sample

[![Viewer](https://img.shields.io/badge/Viewer-v7-green.svg)](http://developer.autodesk.com/)
[![License](http://img.shields.io/:license-MIT-blue.svg)](http://opensource.org/licenses/MIT)

Client-side only sample (no server), based on the structure of
[aps-labelscluster-sample](https://github.com/autodesk-platform-services/aps-labelscluster-sample), that
calculates the **exit access travel distance** of a floor plan, in 2D or 3D, and checks it against
configurable standards. The defaults come from
[IBC 2024 Section 1017](https://codes.iccsafe.org/content/IBC2024V2.0/chapter-10-means-of-egress#IBC2024V2.0_Ch10_Sec1017).

## Running

Serve the folder with any static server and open `index.html`:

```
npx http-server .
```

The viewer token comes from the same public endpoint used by the labels cluster sample. The default
model is the Revit `rac_basic_sample_project`. Use the dropdown in the navbar to switch between the
3D view and the 2D floor plans.

## Usage

1. Click the road icon in the toolbar to open the **Egress travel distance** panel.
2. **Standards**: choose the occupancy row and whether the building is sprinklered. You can edit:
   - every Table 1017.2 value (an empty value means *Not Permitted*);
   - the increases in 1017.2.1, 1017.2.2 and 1017.2.3, and the atrium limit in 1017.3.2.3.

   Edits are kept in `localStorage`. You can also reset to the IBC 2024 defaults, or export/import the
   standards as JSON to use other codes.
3. **Grid**:
   - In 3D, use the Levels toolbar button (`Autodesk.AEC.LevelsExtension`) to show a single level.
   - Select the walkable elements in the viewer (floors, rooms, stairs...), holding **Ctrl** to select
     multiple elements. This is provided by `MultipleSelectionExtension.js`, from the APS blog
     [Selecting multiple elements in the Viewer](https://aps.autodesk.com/blog/selecting-multiple-elements-viewer).
     You can also use the Model Browser. Then click *Use selection as walkable area*. Only these elements count as valid
     pathways, and their extents define the grid area. Doors are always passable.
   - Set the cell size (in the model display units, feet or meters) and click *Build grid*. The 2D
     scale and the 3D level elevation are calculated automatically.
4. **Path**: click *Pick exits* and click on the exit doors (Esc to finish). Optionally click
   *Pick start*. Then click *Compute*.
   - Without a start point, the sample searches for the **most remote point** from the nearest exit
     (IBC 1017.3).
   - *Compare all* runs A*, Dijkstra, Central Dijkstra and Theta* together.
   - *Animate* replays the walk along the path.

## How it works

### 1. Logical grid: cell boxes vs fragment geometry (`js/geometryGrid.js`)

The extents of the selected elements are divided into square cells. Each cell becomes a box that is
tested against the real fragment geometry of the elements in the view. Element bounding boxes are
only used as a quick pre-filter, never to classify a cell. Fragment geometry is read as shown in the
APS blog [Working with 2D and 3D scenes and geometry in Forge Viewer](https://aps.autodesk.com/blog/working-2d-and-3d-scenes-and-geometry-forge-viewer):

- **3D**:
  - Triangles come from `fragList.getVizmesh(fragId).geometry` with
    `Autodesk.Viewing.Private.VertexEnumerator.enumMeshTriangles()`, transformed by
    `fragList.getWorldMatrix()`.
  - A cell is **inside** the walkable area if a triangle of a selected element intersects its column box
    (walking surface − 0.15 m up to +80 in).
  - It's **blocked** if a triangle of any other visible element intersects its obstacle box (walking
    surface + 2 cm up to +80 in). 80 in is the IBC minimum headroom (§1003.2/§1003.3), so ceilings
    and anything above it never block.
  - Each test is an exact triangle–box separating-axis test (Akenine-Möller).
- **2D**: `Autodesk.Viewing.Private.VertexBufferReader(geometry).enumGeoms(filter, callbacks)` gives the
  line segments, arcs (tessellated), filled triangles and text quads of each element. Each is tested
  exactly against the cell rectangles.

Doors are always passable, and annotations, grids and rooms never block. Cells outside the selection
are void. The result doesn't depend on the camera, zoom or window size. Categories are read once per
element with `model.getBulkProperties(..., { propFilter: ['Category'] })`.

In 2D, the real-world scale is calculated from the model, with no user input. It uses the AEC viewport
2D->3D matrix (`Autodesk.AEC.ViewportsExtension`: `findViewportAtPoint()` + `get2DTo3DMatrix()`). If
that isn't available, it falls back to the page-to-model transform.

### 2. Path finding (`js/pathfinding.js`)

Based on the classic game AI options (see the
[gamedev.stackexchange discussion](https://gamedev.stackexchange.com/questions/28041/what-path-finding-algorithms-are-used-in-games-of-all-types)):

| Algorithm | Use in this sample |
|---|---|
| **A\*** | 8-connected grid with an octile heuristic (admissible). Finds the shortest grid path from the start to the nearest exit. |
| **Dijkstra** | Multi-source from all exits. One pass gives the distance from *every* cell to its nearest exit (a "flow field"). The maximum is the most remote point, which can be shown as a heatmap against the limit. |
| **Theta\*** | Any-angle variant of A*. It links a node to its grandparent when there's line of sight, so the path approximates the "natural and unobstructed path" (taut string) that the code requires. |
| **Central Dijkstra** | From *Path Counting for Grid-Based Navigation* (Goldstein et al., Autodesk Research, JAIR 74, 2022). It reuses the Dijkstra field (integer move costs 408/577) to count, in log2 space, the shortest grid paths through each cell. It then follows the cells with the highest traversal count (paths from the start × paths to the exit). The result is the most "central" shortest grid path, which hugs sightlines and smooths into a near-taut path. |
| Smoothing | Line-of-sight string pulling, applied to the grid paths (A*, Dijkstra, Central) for a fair comparison. |

Grid paths on 8 directions overestimate real distances by up to ~8%. Theta* and smoothing remove most
of that error.

Other techniques from that discussion that would fit large floors are Jump Point Search (faster A* on
uniform grids) and HPA* or navigation meshes. They aren't implemented, to keep the sample minimal.

### 3. Distance and verdict

- The path is converted to world points (model units) and measured with `THREE.Vector3.distanceTo`.
- It's then converted to feet:
  - 3D: `model.getUnitScale()`.
  - 2D: the drawing scale.
- The result is compared with the effective limit: the table value, any enabled increases, and the
  balcony addition.

### 4. Rendering

- Paths are drawn with the `Autodesk.DataVisualization` streamlines, following the
  [APS streamlines blog](https://aps.autodesk.com/blog/streamlines). The animation uses
  `StreamLine.advance()`.
- The grid, heatmap and markers are overlay meshes (`viewer.overlays`).

## Limitations

- It analyses one level at a time. Vertical travel on exit access stairways/ramps (1017.3.1) isn't
  computed.
- Atrium portions (1017.3.2) aren't detected, so the atrium limit is informational only.
- Accuracy depends on the cell size: any geometry touching a cell box marks the whole cell, so obstacles grow by up to one cell.
- The sample doesn't check the footnote conditions for the increases (one story, ceiling height, ...).
  Enable them only when the conditions are met.

## License

This sample is licensed under the terms of the [MIT License](http://opensource.org/licenses/MIT).
Please see the [LICENSE](LICENSE) file for full details.
