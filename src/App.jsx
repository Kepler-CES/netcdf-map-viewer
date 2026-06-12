import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer, TileLayer, ImageOverlay, useMap, useMapEvents,
} from "react-leaflet";
import {
  openNetCDF, closeDoc, regrid, dataRange, renderCanvas, mercatorY,
} from "./lib/netcdf.js";
import { COLORMAPS, gradientCss } from "./lib/colormaps.js";

// Pull an observation time out of a GOCI-style filename: ..._YYYYMMDD_HHMMSS_...
function parseTime(name, fallback) {
  const m = name.match(/(\d{8})[_-](\d{6})/);
  if (m) {
    const [, d, t] = m;
    return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8),
      +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
  }
  return fallback; // keep upload order if no timestamp
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// Fit the data extent, then lock min zoom so the bounds always fill the
// viewport (no zooming out into empty/repeated world), and clamp panning.
function FitBounds({ bounds }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds) return;
    const b = [[bounds[0], bounds[1]], [bounds[2], bounds[3]]];
    map.fitBounds(b);
    const z = map.getBoundsZoom(b, false);
    map.setMinZoom(z);
    map.setMaxBounds(b);
    map.options.maxBoundsViscosity = 1.0;
  }, [bounds, map]);
  return null;
}

function Hover({ regridded, onValue }) {
  useMapEvents({
    mousemove(e) {
      if (!regridded) return;
      const { grid, nrow, ncol, bounds, ymin, ymax } = regridded;
      const [latmin, lonmin, latmax, lonmax] = bounds;
      const fy = (ymax - mercatorY(e.latlng.lat)) / (ymax - ymin);
      const fx = (e.latlng.lng - lonmin) / (lonmax - lonmin);
      if (fy < 0 || fy >= 1 || fx < 0 || fx >= 1) return onValue(null, e.latlng);
      const r = Math.min(nrow - 1, Math.floor(fy * nrow));
      const c = Math.min(ncol - 1, Math.floor(fx * ncol));
      const v = grid[r * ncol + c];
      onValue(Number.isFinite(v) ? v : null, e.latlng);
    },
  });
  return null;
}

export default function App() {
  const [fileList, setFileList] = useState([]);   // browser File[]
  const [variables, setVariables] = useState([]); // from first file
  const [variable, setVariable] = useState("");
  const [frames, setFrames] = useState([]);       // [{name,time,regridded}]
  const [range, setRange] = useState([0, 1]);     // auto (data-derived) scale
  const [fixedRange, setFixedRange] = useState(null); // preset override, or null
  const [preset, setPreset] = useState("auto");
  const [dataUrls, setDataUrls] = useState([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(4);

  const [cmap, setCmap] = useState("turbo");
  const [log, setLog] = useState(true);
  const [opacity, setOpacity] = useState(0.85);

  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState({ v: null, latlng: null });
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const runId = useRef(0); // cancels stale async passes

  // Read a dropped/selected file list: grab variables from the first file,
  // pick a sensible default variable, and stash the list for processing.
  const loadFiles = useCallback(async (files) => {
    const arr = Array.from(files || []).filter((f) => /\.(nc|nc4|h5|hdf5)$/i.test(f.name));
    if (!arr.length) return;
    setBusy(true);
    setStatus("파일 확인 중…");
    setFrames([]); setDataUrls([]); setIdx(0); setPlaying(false);
    try {
      const buf = await arr[0].arrayBuffer();
      const doc = await openNetCDF(buf);
      if (!doc.latDs || !doc.lonDs)
        throw new Error("위도/경도 좌표 변수를 찾지 못했습니다.");
      if (!doc.variables.length)
        throw new Error("표시할 2차원 변수를 찾지 못했습니다.");
      closeDoc(doc);
      const def = doc.variables.find((v) => !/flag|mask/i.test(v.name)) || doc.variables[0];
      setVariables(doc.variables);
      setFileList(arr);
      setVariable(def.path); // triggers processing effect
    } catch (err) {
      setStatus(err.message || String(err));
      setBusy(false);
    }
  }, []);

  // Process every file for the selected variable (sequential, memory-bounded).
  useEffect(() => {
    if (!fileList.length || !variable) return;
    const myRun = ++runId.current;
    let cancelled = false;
    (async () => {
      setBusy(true); setPlaying(false);
      const target = fileList.length > 1 ? 1200 : 1600;
      const fr = [];
      let gmin = Infinity, gmax = -Infinity;
      for (let k = 0; k < fileList.length; k++) {
        if (cancelled || myRun !== runId.current) return;
        setStatus(`데이터 처리 중… ${k + 1}/${fileList.length}`);
        try {
          const buf = await fileList[k].arrayBuffer();
          const doc = await openNetCDF(buf);
          const rg = regrid(doc.file, variable, doc.latDs, doc.lonDs, target);
          closeDoc(doc);
          const [lo, hi] = dataRange(rg.grid);
          if (Number.isFinite(lo)) { gmin = Math.min(gmin, lo); gmax = Math.max(gmax, hi); }
          fr.push({ name: fileList[k].name, time: parseTime(fileList[k].name, k), regridded: rg });
        } catch (err) {
          console.warn("skip", fileList[k].name, err);
        }
        await new Promise((r) => setTimeout(r, 0)); // yield to UI
      }
      if (cancelled || myRun !== runId.current) return;
      fr.sort((a, b) => a.time - b.time);
      if (!Number.isFinite(gmin)) { gmin = 0; gmax = 1; }
      setFrames(fr);
      setRange([gmin, gmax === gmin ? gmin + 1 : gmax]);
      setIdx(0);
      setStatus(fr.length > 1 ? `${fr.length}개 프레임` : "");
    })();
    return () => { cancelled = true; };
  }, [fileList, variable]);

  // Render every frame to a colored PNG whenever the shared scale or style
  // changes. Grids are kept in memory so this needs no re-parsing.
  useEffect(() => {
    if (!frames.length) { setDataUrls([]); return; }
    const myRun = ++runId.current;
    let cancelled = false;
    (async () => {
      setBusy(true);
      if (frames.length > 1) setStatus("프레임 렌더링…");
      const eff = fixedRange || range;
      const urls = [];
      for (let k = 0; k < frames.length; k++) {
        if (cancelled || myRun !== runId.current) return;
        urls.push(renderCanvas(frames[k].regridded, {
          cmap, vmin: eff[0], vmax: eff[1], log, opacity,
        }));
        if (k % 4 === 3) await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled || myRun !== runId.current) return;
      setDataUrls(urls);
      setBusy(false);
      setStatus(frames.length > 1 ? `${frames.length}개 프레임` : "");
    })();
    return () => { cancelled = true; };
  }, [frames, cmap, log, opacity, range, fixedRange]);

  // Playback timer.
  useEffect(() => {
    if (!playing || dataUrls.length < 2) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % dataUrls.length), 1000 / fps);
    return () => clearInterval(t);
  }, [playing, fps, dataUrls.length]);

  const cur = frames[idx];
  const effRange = fixedRange || range; // preset overrides the auto scale
  const bounds = cur?.regridded.bounds;
  const overlayBounds = bounds
    ? [[bounds[0], bounds[1]], [bounds[2], bounds[3]]] : null;
  const fitB = frames[0]?.regridded.bounds; // stable extent for FitBounds

  const ticks = useMemo(() => {
    const [lo, hi] = effRange;
    return [0, 1, 2, 3, 4].map((i) => {
      const f = i / 4;
      const val = log && lo > 0
        ? Math.pow(10, Math.log10(lo) + f * (Math.log10(hi) - Math.log10(lo)))
        : lo + f * (hi - lo);
      return { f, val };
    });
  }, [effRange, log]);

  const fmt = (x) =>
    Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(1) : x.toFixed(2);
  const curVar = variables.find((v) => v.path === variable);
  const unit = cur?.regridded.units || curVar?.units || "";
  const multi = frames.length > 1;

  // Presets bundle scale type + range + colormap. "khoa" matches the KHOA/NOSC
  // preview: linear 0–30 on a jet ramp. "auto" = data-driven log + turbo.
  function applyPreset(p) {
    setPreset(p);
    if (p === "khoa") { setCmap("jet"); setLog(false); setFixedRange([0, 30]); }
    else { setCmap("turbo"); setLog(true); setFixedRange(null); }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>NetCDF 지도 뷰어</h1>
        <p className="tagline">
          .nc 파일을 올리면 지도에 표시합니다. 여러 개를 올리면 시간순
          타임랩스로 재생됩니다. NetCDF-4(그룹) 지원.
        </p>

        <div
          className={`drop${over ? " over" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); loadFiles(e.dataTransfer.files); }}
        >
          {fileList.length ? (
            <><strong>{fileList.length}개 파일</strong><br />다른 파일을 올리려면 클릭</>
          ) : (
            <><strong>.nc 파일 선택 (여러 개 가능)</strong><br />또는 여기로 끌어다 놓기</>
          )}
          <input
            ref={inputRef} type="file" accept=".nc,.nc4,.h5,.hdf5" multiple
            style={{ display: "none" }}
            onChange={(e) => loadFiles(e.target.files)}
          />
        </div>

        {variables.length > 0 && (
          <>
            <div className="field">
              <label>표현 프리셋</label>
              <select value={preset} onChange={(e) => applyPreset(e.target.value)}>
                <option value="auto">자동 (데이터 기준 · 로그 · turbo)</option>
                <option value="khoa">KHOA 기준 (선형 0–30 · jet)</option>
              </select>
            </div>
            <div className="field">
              <label>변수</label>
              <select value={variable} onChange={(e) => setVariable(e.target.value)}>
                {variables.map((v) => (
                  <option key={v.path} value={v.path}>
                    {v.long_name ? `${v.long_name} (${v.name})` : v.path}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>컬러맵</label>
              <select value={cmap} onChange={(e) => setCmap(e.target.value)}>
                {Object.entries(COLORMAPS).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>
                <input type="checkbox" checked={log}
                  onChange={(e) => setLog(e.target.checked)}
                  style={{ marginRight: 6, verticalAlign: -1 }} />
                로그 스케일
              </label>
            </div>
            <div className="field">
              <label>투명도 {(opacity * 100).toFixed(0)}%</label>
              <input type="range" min="0" max="100" value={opacity * 100}
                onChange={(e) => setOpacity(e.target.value / 100)} />
            </div>
          </>
        )}

        {status && (
          <div className={`status${/못했|오류|실패|Error/i.test(status) ? " err" : ""}`}>
            {busy && <span className="spinner" />}{status}
          </div>
        )}

        {cur && (
          <div className="meta">
            범위: {fmt(effRange[0])} ~ {fmt(effRange[1])} {unit}
            {fixedRange ? " (KHOA 고정)" : " (자동)"}<br />
            격자: {cur.regridded.ncol} × {cur.regridded.nrow}
            {multi && <><br />프레임 {idx + 1}/{frames.length}</>}
          </div>
        )}
      </aside>

      <div className="map-wrap">
        <MapContainer center={[27, 140]} zoom={6} preferCanvas worldCopyJump>
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; OpenStreetMap, &copy; CARTO'
            subdomains="abcd" noWrap
          />
          {dataUrls[idx] && overlayBounds && (
            <ImageOverlay url={dataUrls[idx]} bounds={overlayBounds} opacity={1} />
          )}
          {fitB && <FitBounds bounds={fitB} />}
          <Hover regridded={cur?.regridded}
            onValue={(v, latlng) => setHover({ v, latlng })} />
        </MapContainer>

        {cur && (
          <>
            <div className="overlay-panel readout">
              <div className="u">{curVar?.long_name || curVar?.name}</div>
              <div className="v">{hover.v == null ? "—" : fmt(hover.v)}</div>
              <div className="u">
                {hover.latlng
                  ? `${hover.latlng.lat.toFixed(3)}°N, ${hover.latlng.lng.toFixed(3)}°E`
                  : "지도 위로 마우스를 올리세요"}
                {unit ? ` · ${unit}` : ""}
              </div>
            </div>

            {multi && (
              <div className="overlay-panel timeline">
                <button className="play" onClick={() => setPlaying((p) => !p)}>
                  {playing ? "⏸" : "▶"}
                </button>
                <input className="scrub" type="range" min="0" max={frames.length - 1}
                  value={idx} onChange={(e) => { setPlaying(false); setIdx(+e.target.value); }} />
                <span className="tlabel">{fmtTime(cur.time)}</span>
                <select className="spd" value={fps} onChange={(e) => setFps(+e.target.value)}>
                  <option value={2}>2 fps</option>
                  <option value={4}>4 fps</option>
                  <option value={8}>8 fps</option>
                  <option value={15}>15 fps</option>
                </select>
              </div>
            )}

            <div className="overlay-panel legend">
              <div className="cap">
                {curVar?.long_name || curVar?.name}{unit ? ` (${unit})` : ""}
                {log && effRange[0] > 0 ? " · 로그" : ""}
              </div>
              <div className="lgbody">
                <div className="bar"
                  style={{ background: gradientCss(cmap).replace("90deg", "to top") }} />
                <div className="vticks">
                  {ticks.map((t, i) => (
                    <span key={i} style={{ bottom: `${t.f * 100}%` }}>{fmt(t.val)}</span>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
