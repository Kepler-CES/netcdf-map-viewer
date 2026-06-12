#!/usr/bin/env python3
"""Build a red-tide (or any GOCI-II L2 variable) time-lapse from a folder of
.nc files.

Outdir gets:
  frames/0000.png ...   transparent Web-Mercator overlays (one per file)
  timelapse.html        self-contained Leaflet player (real basemap + slider/play)
  timelapse.mp4         optional, only if `imageio[ffmpeg]` is installed

The overlay PNGs are spaced in Web Mercator Y so they register exactly with the
Leaflet basemap (same fix as the web app).

Usage:
  pip install netCDF4 numpy matplotlib pillow --break-system-packages
  python make_timelapse.py /path/to/nc_folder -o out --var RI --fps 6
"""
import argparse, glob, html, json, math, os, re, sys
import numpy as np
import netCDF4 as nc
import matplotlib
matplotlib.use("Agg")
from matplotlib import cm, colors
from PIL import Image

D2R = math.pi / 180
def mercY(a): return np.log(np.tan(np.pi / 4 + np.radians(a) / 2))


def find_path(group, pattern, prefix=""):
    """Recursively find first variable whose path matches a regex."""
    for k, v in group.variables.items():
        p = f"{prefix}/{k}" if prefix else k
        if re.search(pattern, p, re.I):
            return p
    for k, sub in group.groups.items():
        r = find_path(sub, pattern, f"{prefix}/{k}" if prefix else k)
        if r:
            return r
    return None


def get_var(ds, path):
    g = ds
    *groups, name = path.split("/")
    for gr in groups:
        g = g.groups[gr]
    return g.variables[name]


def parse_time(name, fallback):
    m = re.search(r"(\d{8})[_-](\d{6})", name)
    if not m:
        return fallback
    d, t = m.groups()
    return f"{d[:4]}-{d[4:6]}-{d[6:8]} {t[:2]}:{t[2:4]} UTC"


def load(path, varname):
    ds = nc.Dataset(path)
    vpath = find_path(ds, rf"(^|/){re.escape(varname)}$") or find_path(ds, varname)
    if not vpath:
        raise RuntimeError(f"변수 '{varname}' 없음: {path}")
    latp = find_path(ds, r"(^|/)(lat|latitude)$")
    lonp = find_path(ds, r"(^|/)(lon|longitude)$")
    v = get_var(ds, vpath); lat = get_var(ds, latp); lon = get_var(ds, lonp)
    arr = np.array(v[:], dtype="float32")
    fill = getattr(v, "_FillValue", None)
    if fill is not None:
        arr = np.where(arr == fill, np.nan, arr)
    vmin = getattr(v, "valid_min", None); vmax = getattr(v, "valid_max", None)
    if vmin is not None:
        arr = np.where(arr < vmin, np.nan, arr)
    if vmax is not None:
        arr = np.where(arr > vmax, np.nan, arr)
    la = np.array(lat[:], dtype="float32"); lo = np.array(lon[:], dtype="float32")
    # drop land if a flag variable is present
    flagp = find_path(ds, r"(^|/)flag$")
    if flagp:
        fl = np.array(get_var(ds, flagp)[:])
        arr = np.where((fl & 2) > 0, np.nan, arr)
    units = getattr(v, "units", "")
    long_name = getattr(v, "long_name", varname)
    ds.close()
    good = np.isfinite(la) & np.isfinite(lo) & (la > -90) & (la < 90)
    return arr, la, lo, good, units, long_name


def regrid_merc(arr, la, lo, good, bounds, target=1400):
    latmin, lonmin, latmax, lonmax = bounds
    ymin, ymax = mercY(latmin), mercY(latmax)
    ySpan = ymax - ymin
    lonRad = (lonmax - lonmin) * D2R
    denom = max(lonRad, ySpan)
    ncol = max(1, round(target * lonRad / denom))
    nrow = max(1, round(target * ySpan / denom))
    grid = np.full((nrow, ncol), np.nan, "float32")
    m = good & np.isfinite(arr)
    r = ((ymax - mercY(la[m])) / ySpan * nrow).astype(int)
    c = ((lo[m] - lonmin) / (lonmax - lonmin) * ncol).astype(int)
    v = arr[m]
    ok = (r >= 0) & (r < nrow) & (c >= 0) & (c < ncol)
    grid[r[ok], c[ok]] = v[ok]
    return grid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("indir", help="folder containing .nc files")
    ap.add_argument("-o", "--out", default="timelapse_out")
    ap.add_argument("--var", default="RI", help="variable name (default RI)")
    ap.add_argument("--cmap", default="turbo")
    ap.add_argument("--vmin", type=float, default=None)
    ap.add_argument("--vmax", type=float, default=None)
    ap.add_argument("--log", action="store_true", default=True)
    ap.add_argument("--linear", dest="log", action="store_false")
    ap.add_argument("--fps", type=int, default=6, help="mp4 frame rate")
    ap.add_argument("--target", type=int, default=1400, help="grid long side (px)")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.indir, "*.nc")))
    if not files:
        sys.exit(f"no .nc files in {args.indir}")
    files.sort(key=lambda f: parse_time(os.path.basename(f), f))
    print(f"{len(files)} files")

    os.makedirs(os.path.join(args.out, "frames"), exist_ok=True)

    # Pass 1: shared extent + color scale.
    latmin = lonmin = math.inf; latmax = lonmax = -math.inf
    samples = []
    meta = []
    for f in files:
        arr, la, lo, good, units, long_name = load(f, args.var)
        latmin = min(latmin, float(la[good].min())); latmax = max(latmax, float(la[good].max()))
        lonmin = min(lonmin, float(lo[good].min())); lonmax = max(lonmax, float(lo[good].max()))
        s = arr[np.isfinite(arr)]
        if s.size:
            samples.append(s[:: max(1, s.size // 20000)])
        meta.append((f, units, long_name))
    bounds = (latmin, lonmin, latmax, lonmax)
    allv = np.concatenate(samples)
    vmin = args.vmin if args.vmin is not None else float(np.percentile(allv, 2))
    vmax = args.vmax if args.vmax is not None else float(np.percentile(allv, 98))
    if args.log:
        vmin = max(vmin, 1e-4)
    print(f"bounds {bounds}\nscale vmin={vmin:.3g} vmax={vmax:.3g} log={args.log}")

    norm = (colors.LogNorm(vmin, vmax, clip=True) if args.log
            else colors.Normalize(vmin, vmax, clip=True))
    cmap = cm.get_cmap(args.cmap)
    units = meta[0][1]; long_name = meta[0][2]

    # Pass 2: render each frame.
    frame_info = []
    mp4_frames = []
    for i, f in enumerate(files):
        arr, la, lo, good, _, _ = load(f, args.var)
        grid = regrid_merc(arr, la, lo, good, bounds, args.target)
        rgba = cmap(norm(grid)); rgba[..., 3] = np.where(np.isfinite(grid), 0.9, 0.0)
        img = (rgba * 255).astype("uint8")
        fn = f"frames/{i:04d}.png"
        Image.fromarray(img, "RGBA").save(os.path.join(args.out, fn))
        ts = parse_time(os.path.basename(f), os.path.basename(f))
        frame_info.append({"src": fn, "time": ts})
        mp4_frames.append((grid.copy(), ts))
        print(f"  [{i+1}/{len(files)}] {fn}  {ts}")

    write_html(args.out, bounds, frame_info, long_name, units, args.cmap,
               vmin, vmax, args.log)
    try_mp4(args.out, mp4_frames, cmap, norm, long_name, units, args.fps, bounds)
    print(f"\n완료 → {os.path.abspath(args.out)}/timelapse.html")


def grad_css(cmap_name):
    c = cm.get_cmap(cmap_name)
    return ", ".join(
        "rgb(%d,%d,%d) %d%%" % (*[int(x * 255) for x in c(i / 10)[:3]], i * 10)
        for i in range(11))


def write_html(out, bounds, frames, long_name, units, cmap, vmin, vmax, log):
    latmin, lonmin, latmax, lonmax = bounds
    # Escape values that come from the .nc file's attributes before embedding
    # them in HTML, so a crafted long_name/units can't inject markup or script.
    long_name = html.escape(str(long_name)); units = html.escape(str(units))
    ticks = ""
    tv = ([vmin * (vmax / vmin) ** (i / 4) for i in range(5)] if log
          else [vmin + (vmax - vmin) * i / 4 for i in range(5)])
    for i, t in enumerate(tv):
        s = f"{t:.0f}" if t >= 100 else f"{t:.1f}" if t >= 1 else f"{t:.2f}"
        ticks += f'<span style="left:{i*25}%">{s}</span>'
    page = f"""<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<title>{long_name} 타임랩스</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body{{margin:0;height:100%;font-family:sans-serif}}#map{{position:absolute;inset:0}}
.p{{position:absolute;z-index:1000;background:rgba(20,24,33,.9);color:#eaeef5;border-radius:10px;padding:10px 12px;font-size:12px;box-shadow:0 4px 18px rgba(0,0,0,.4)}}
#tl{{bottom:54px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;width:460px}}
#tl button{{background:#4a9eff;border:none;color:#04121f;border-radius:6px;width:30px;height:26px;cursor:pointer}}
#tl input{{flex:1}} #tl .t{{white-space:nowrap;font-variant-numeric:tabular-nums}}
#lg{{bottom:14px;left:50%;transform:translateX(-50%);width:320px}}
#lg .b{{height:13px;border-radius:7px;background:linear-gradient(90deg,{grad_css(cmap)})}}
#lg .tk{{position:relative;height:15px;margin-top:2px}}#lg .tk span{{position:absolute;transform:translateX(-50%);font-size:10px}}</style>
</head><body><div id="map"></div>
<div class="p" id="tl"><button id="pp">▶</button><input id="sc" type="range" min="0" max="{len(frames)-1}" value="0">
<span class="t" id="lab"></span><select id="spd"><option value="2">2 fps</option><option value="6" selected>6 fps</option><option value="12">12 fps</option></select></div>
<div class="p" id="lg"><div style="text-align:center;margin-bottom:5px">{long_name} ({units}){' · 로그' if log else ''}</div><div class="b"></div><div class="tk">{ticks}</div></div>
<script>
const F={json.dumps(frames)};
const B=[{latmin},{lonmin},{latmax},{lonmax}];
const map=L.map('map');
L.tileLayer('https://{{s}}.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}{{r}}.png',{{subdomains:'abcd',noWrap:true,attribution:'© OSM, © CARTO · KIOST/KOSC'}}).addTo(map);
const bd=[[B[0],B[1]],[B[2],B[3]]];
map.fitBounds(bd); map.setMinZoom(map.getBoundsZoom(bd,false)); map.setMaxBounds(bd); map.options.maxBoundsViscosity=1;
let ov=L.imageOverlay(F[0].src,bd,{{opacity:0.9}}).addTo(map);
let i=0,playing=false,timer=null;
const sc=document.getElementById('sc'),lab=document.getElementById('lab'),pp=document.getElementById('pp'),spd=document.getElementById('spd');
function show(k){{i=(k+F.length)%F.length;ov.setUrl(F[i].src);sc.value=i;lab.textContent=F[i].time;}}
function step(){{show(i+1);}}
function play(){{playing=!playing;pp.textContent=playing?'⏸':'▶';if(timer)clearInterval(timer);if(playing)timer=setInterval(step,1000/ +spd.value);}}
pp.onclick=play; sc.oninput=e=>{{if(playing)play();show(+e.target.value);}};
spd.onchange=()=>{{if(playing){{clearInterval(timer);timer=setInterval(step,1000/+spd.value);}}}};
show(0);
</script></body></html>"""
    with open(os.path.join(out, "timelapse.html"), "w") as fh:
        fh.write(page)


def try_mp4(out, frames, cmap, norm, long_name, units, fps, bounds):
    try:
        import imageio.v2 as imageio
    except Exception:
        print("(imageio 없음 — mp4 건너뜀. `pip install imageio[ffmpeg]`로 설치)")
        return
    import matplotlib.pyplot as plt
    latmin, lonmin, latmax, lonmax = bounds
    imgs = []
    for grid, ts in frames:
        fig, ax = plt.subplots(figsize=(7, 6.5))
        ax.set_facecolor("#0d1017")
        ax.imshow(grid, extent=[lonmin, lonmax, latmin, latmax], origin="upper",
                  cmap=cmap, norm=norm, aspect="auto")
        ax.set_title(f"{long_name}  ({units})\n{ts}", color="w")
        ax.tick_params(colors="w"); [s.set_color("w") for s in ax.spines.values()]
        fig.patch.set_facecolor("#0d1017"); fig.tight_layout()
        fig.canvas.draw()
        w, h = fig.canvas.get_width_height()
        buf = np.frombuffer(fig.canvas.buffer_rgba(), dtype="uint8").reshape(h, w, 4)
        imgs.append(buf[..., :3].copy()); plt.close(fig)
    path = os.path.join(out, "timelapse.mp4")
    imageio.mimsave(path, imgs, fps=fps)
    print(f"mp4 → {path}")


if __name__ == "__main__":
    main()
