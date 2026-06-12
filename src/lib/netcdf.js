// NetCDF / HDF5 parsing in the browser via h5wasm, plus regridding and
// canvas rendering helpers. Works with NetCDF-4 files that use groups
// (e.g. GOCI-II L2 products with geophysical_data / navigation_data).
import * as hdf5 from "h5wasm";
import { COLORMAPS } from "./colormaps.js";

const D2R = Math.PI / 180;
// Web Mercator (EPSG:3857) latitude → y, in projection-radian units.
export function mercatorY(lat) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
}

let readyPromise = null;
async function ready() {
  if (!readyPromise) readyPromise = hdf5.ready;
  return readyPromise;
}

const LAT_RE = /(^|[_/])(lat|latitude)$/i;
const LON_RE = /(^|[_/])(lon|long|longitude)$/i;

function attrVal(obj, key) {
  try {
    const a = obj.attrs?.[key];
    if (a == null) return undefined;
    const v = a.value !== undefined ? a.value : a;
    return Array.isArray(v) || ArrayBuffer.isView(v) ? v[0] : v;
  } catch {
    return undefined;
  }
}

// Open a file (ArrayBuffer) and enumerate all numeric datasets recursively.
export async function openNetCDF(arrayBuffer) {
  await ready();
  const name = `upload_${Date.now()}.nc`;
  hdf5.FS.writeFile(name, new Uint8Array(arrayBuffer));
  const file = new hdf5.File(name, "r");

  const datasets = [];
  function walk(group, prefix) {
    for (const key of group.keys()) {
      const item = group.get(key);
      const path = prefix ? `${prefix}/${key}` : key;
      if (item instanceof hdf5.Group) {
        walk(item, path);
      } else if (item instanceof hdf5.Dataset) {
        datasets.push({
          path,
          name: key,
          shape: item.shape,
          long_name: attrVal(item, "long_name"),
          units: attrVal(item, "units"),
        });
      }
    }
  }
  walk(file, "");

  // 2D datasets are candidate map layers.
  const grids = datasets.filter((d) => d.shape && d.shape.length === 2);
  const latDs = datasets.find((d) => LAT_RE.test(d.path));
  const lonDs = datasets.find((d) => LON_RE.test(d.path));

  // Variables = 2D grids excluding the coordinate grids.
  const variables = grids.filter(
    (d) => d.path !== latDs?.path && d.path !== lonDs?.path
  );

  return { file, name, datasets, variables, latDs, lonDs };
}

// Release a parsed file from WASM memory (important when looping over many
// files for a time-lapse, so heap usage stays bounded).
export function closeDoc(doc) {
  try { doc.file.close(); } catch { /* noop */ }
  try { hdf5.FS.unlink(doc.name); } catch { /* noop */ }
}

function readDataset(file, path) {
  const ds = file.get(path);
  return {
    value: ds.value, // flat typed array, row-major
    shape: ds.shape,
    fill: attrVal(ds, "_FillValue"),
    scale: attrVal(ds, "scale_factor"),
    offset: attrVal(ds, "add_offset"),
    vmin: attrVal(ds, "valid_min"),
    vmax: attrVal(ds, "valid_max"),
    units: attrVal(ds, "units"),
    long_name: attrVal(ds, "long_name"),
  };
}

function applyScale(v, scale, offset, fill, vmin, vmax) {
  if (fill !== undefined && v === fill) return NaN;
  let x = v;
  if (scale !== undefined && scale !== 1) x *= scale;
  if (offset !== undefined && offset !== 0) x += offset;
  if (vmin !== undefined && x < vmin) return NaN;
  if (vmax !== undefined && x > vmax) return NaN;
  return x;
}

// Regrid a (possibly curvilinear) variable onto a regular lat/lon grid by
// nearest-cell binning. Returns { grid, nrow, ncol, bounds:[latmin,lonmin,latmax,lonmax] }.
// onProgress(frac) is optional.
export function regrid(file, variablePath, latDs, lonDs, targetMax = 1600) {
  const lat = readDataset(file, latDs.path);
  const lon = readDataset(file, lonDs.path);
  const v = readDataset(file, variablePath);
  const N = v.value.length;

  // Find geographic extent from valid coordinates.
  let latmin = Infinity, latmax = -Infinity, lonmin = Infinity, lonmax = -Infinity;
  const latRaw = lat.value, lonRaw = lon.value;
  const latFill = lat.fill, lonFill = lon.fill;
  for (let i = 0; i < N; i++) {
    const la = latRaw[i], lo = lonRaw[i];
    if (la === latFill || lo === lonFill) continue;
    if (la < -90 || la > 90 || lo < -180 || lo > 180) continue;
    if (la < latmin) latmin = la;
    if (la > latmax) latmax = la;
    if (lo < lonmin) lonmin = lo;
    if (lo > lonmax) lonmax = lo;
  }
  if (!isFinite(latmin)) throw new Error("좌표(위경도)에서 유효한 값을 찾지 못했습니다.");

  // Build the output grid in WEB MERCATOR (EPSG:3857) vertical spacing, NOT in
  // equal-latitude spacing. Leaflet's ImageOverlay does not reproject — it
  // stretches the image linearly between the Mercator-projected corners. If the
  // rows were equal-latitude, features would drift up to several km north of
  // their true position. Spacing rows by equal Mercator-y makes the overlay
  // register exactly with the Web Mercator basemap. Columns stay linear in
  // longitude (Mercator x is linear in longitude, so that is already correct).
  const ymin = mercatorY(latmin), ymax = mercatorY(latmax);
  const ySpan = ymax - ymin;
  const lonRad = (lonmax - lonmin) * D2R; // x extent in Mercator units
  const denom = Math.max(lonRad, ySpan);
  const ncol = Math.max(1, Math.round((targetMax * lonRad) / denom));
  const nrow = Math.max(1, Math.round((targetMax * ySpan) / denom));

  const grid = new Float32Array(nrow * ncol).fill(NaN);
  const step = Math.max(1, Math.floor(N / 4_000_000)); // cap work for huge files
  for (let i = 0; i < N; i += step) {
    const la = latRaw[i], lo = lonRaw[i];
    if (la === latFill || lo === lonFill) continue;
    const val = applyScale(v.value[i], v.scale, v.offset, v.fill, v.vmin, v.vmax);
    if (Number.isNaN(val)) continue;
    const r = Math.floor(((ymax - mercatorY(la)) / ySpan) * nrow); // row 0 = north
    const c = Math.floor(((lo - lonmin) / (lonmax - lonmin)) * ncol);
    if (r < 0 || r >= nrow || c < 0 || c >= ncol) continue;
    grid[r * ncol + c] = val;
  }

  return {
    grid, nrow, ncol,
    bounds: [latmin, lonmin, latmax, lonmax],
    ymin, ymax, // Mercator-y extent, used for hover inverse-mapping
    units: v.units,
    long_name: v.long_name,
  };
}

// Robust value range (2nd/98th percentile) over finite cells.
export function dataRange(grid) {
  const vals = [];
  for (let i = 0; i < grid.length; i += 7) {
    const x = grid[i];
    if (Number.isFinite(x)) vals.push(x);
  }
  if (!vals.length) return [0, 1];
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)];
  const hi = vals[Math.floor(vals.length * 0.98)];
  return [lo, hi === lo ? lo + 1 : hi];
}

// Render the regular grid to a canvas (returns dataURL) using a colormap.
export function renderCanvas(regridded, { cmap, vmin, vmax, log, opacity }) {
  const { grid, nrow, ncol } = regridded;
  const fn = COLORMAPS[cmap].fn;
  const canvas = document.createElement("canvas");
  canvas.width = ncol;
  canvas.height = nrow;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(ncol, nrow);
  const data = img.data;

  const useLog = log && vmin > 0;
  const lvmin = useLog ? Math.log10(Math.max(vmin, 1e-9)) : vmin;
  const lvmax = useLog ? Math.log10(Math.max(vmax, 1e-9)) : vmax;
  const span = lvmax - lvmin || 1;
  const alpha = Math.round(opacity * 255);

  for (let i = 0; i < grid.length; i++) {
    const x = grid[i];
    const o = i * 4;
    if (!Number.isFinite(x)) { data[o + 3] = 0; continue; }
    let t = ((useLog ? Math.log10(Math.max(x, 1e-9)) : x) - lvmin) / span;
    t = Math.min(1, Math.max(0, t));
    const [r, g, b] = fn(t);
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = alpha;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
