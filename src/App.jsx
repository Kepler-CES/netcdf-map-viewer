import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer, TileLayer, ImageOverlay, useMap, useMapEvents,
} from "react-leaflet";
import {
  openNetCDF, closeDoc, regrid, dataRange, renderCanvas, mercatorY,
} from "./lib/netcdf.js";
import { COLORMAPS, gradientCss } from "./lib/colormaps.js";
import { searchNetcdf, sourceFromResult } from "./lib/nosc.js";

// NOSC service key from .env (VITE_ prefix required for client exposure).
// Create a `.env` with: VITE_NOSC_SERVICE_KEY=발급받은키
const ENV_KEY = import.meta.env.VITE_NOSC_SERVICE_KEY || "";

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
  const [fixedRange, setFixedRange] = useState([0, 30]); // KHOA default override
  const [preset, setPreset] = useState("khoa");
  const [dataUrls, setDataUrls] = useState([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(4);

  const [cmap, setCmap] = useState("jet");
  const [log, setLog] = useState(false);
  const [opacity, setOpacity] = useState(0.85);

  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState({ v: null, latlng: null });
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const runId = useRef(0); // cancels stale async passes
  // One-shot cache of the first file's buffer: loadFiles downloads it for
  // variable detection, the processing pass reuses it once, then releases it
  // (avoids a second network download while keeping memory bounded).
  const prefetched = useRef(null);

  // NOSC/KHOA open-API panel state. Local (not UTC) date so the picker default
  // matches the user's calendar day.
  const todayLocal = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const [showApi, setShowApi] = useState(false);
  const [apiStart, setApiStart] = useState(todayLocal);
  const [apiEnd, setApiEnd] = useState(todayLocal);
  const [apiSlot, setApiSlot] = useState("13");
  const [apiProduct, setApiProduct] = useState("RI");
  const [apiRows, setApiRows] = useState([]);
  const [apiBusy, setApiBusy] = useState(false);
  const [apiMsg, setApiMsg] = useState("");

  // Read a dropped/selected file list: grab variables from the first file,
  // pick a sensible default variable, and stash the list for processing.
  const loadFiles = useCallback(async (files) => {
    const arr = Array.from(files || []).filter((f) => /\.(nc|nc4|h5|hdf5)$/i.test(f.name));
    if (!arr.length) { setStatus("불러올 .nc 파일이 없습니다."); return; }
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
      prefetched.current = { src: arr[0], buf }; // reuse in the processing pass
      setVariables(doc.variables);
      setFileList(arr);
      setVariable(def.path); // triggers processing effect
    } catch (err) {
      setStatus(err.message || String(err));
      setBusy(false);
    }
  }, []);

  // Query the NOSC API for matching NetCDF files.
  const doSearch = useCallback(async () => {
    setApiBusy(true); setApiMsg("조회 중…"); setApiRows([]);
    try {
      const rows = await searchNetcdf({
        serviceKey: ENV_KEY, startDate: apiStart, endDate: apiEnd,
        slot: apiSlot, product: apiProduct,
      });
      setApiRows(rows);
      setApiMsg(rows.length ? `${rows.length}건 — 불러올 항목을 선택하세요` : "결과 없음");
    } catch (e) {
      setApiMsg(e.message || String(e));
    } finally {
      setApiBusy(false);
    }
  }, [apiStart, apiEnd, apiSlot, apiProduct]);

  // Turn API results into viewer sources and feed the normal load pipeline.
  const loadResults = useCallback((rows) => {
    if (rows.length) loadFiles(rows.map(sourceFromResult));
  }, [loadFiles]);

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
      let lastErr = null;
      for (let k = 0; k < fileList.length; k++) {
        if (cancelled || myRun !== runId.current) return;
        setStatus(`데이터 처리 중… ${k + 1}/${fileList.length}`);
        try {
          let buf;
          if (k === 0 && prefetched.current?.src === fileList[0]) {
            buf = prefetched.current.buf; // already downloaded for detection
            prefetched.current = null;    // release for GC after this pass
          } else {
            buf = await fileList[k].arrayBuffer();
          }
          const doc = await openNetCDF(buf);
          const rg = regrid(doc.file, variable, doc.latDs, doc.lonDs, target);
          closeDoc(doc);
          const [lo, hi] = dataRange(rg.grid);
          if (Number.isFinite(lo)) { gmin = Math.min(gmin, lo); gmax = Math.max(gmax, hi); }
          fr.push({ name: fileList[k].name, time: parseTime(fileList[k].name, k), regridded: rg });
        } catch (err) {
          lastErr = err;
          console.warn("skip", fileList[k].name, err);
        }
        await new Promise((r) => setTimeout(r, 0)); // yield to UI
      }
      if (cancelled || myRun !== runId.current) return;
      if (!fr.length) { // every file failed to download/parse — surface it
        setBusy(false);
        setStatus("불러오기 실패: " + (lastErr?.message || "다운로드/파싱 오류 (콘솔 확인)"));
        return;
      }
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

        <div className="apibox">
          <button className="apitoggle" onClick={() => setShowApi((s) => !s)}>
            {showApi ? "▾" : "▸"} NOSC API에서 불러오기
          </button>
          {showApi && (
            <div className="apibody">
              {ENV_KEY
                ? <div className="apinote">인증키: .env에서 불러옴</div>
                : <div className="status err">.env에 VITE_NOSC_SERVICE_KEY를 설정하세요</div>}
              <div className="row2">
                <label className="ap">시작일
                  <input type="date" value={apiStart} onChange={(e) => setApiStart(e.target.value)} /></label>
                <label className="ap">종료일
                  <input type="date" value={apiEnd} onChange={(e) => setApiEnd(e.target.value)} /></label>
              </div>
              <div className="row2">
                <label className="ap">슬롯
                  <select value={apiSlot} onChange={(e) => setApiSlot(e.target.value)}>
                    {[...Array(12).keys()].map((s) => <option key={s} value={s}>{s}</option>)}
                    <option value="13">13 (한반도 전체)</option>
                  </select></label>
                <label className="ap">산출물
                  <select value={apiProduct} onChange={(e) => setApiProduct(e.target.value)}>
                    {["RI", "Chl", "AC", "TSS", "CDOM", "Kd", "Zsd", "PP", "FA"].map((p) =>
                      <option key={p} value={p}>{p}</option>)}
                  </select></label>
              </div>
              <button className="apibtn" onClick={doSearch} disabled={apiBusy}>조회</button>
              {apiMsg && (
                <div className={`status${/오류|실패|없음|확인/i.test(apiMsg) ? " err" : ""}`}>
                  {apiBusy && <span className="spinner" />}{apiMsg}
                </div>
              )}
              {apiRows.length > 0 && (
                <>
                  <button className="apibtn alt" onClick={() => loadResults(apiRows)}>
                    전체 {apiRows.length}개 불러오기 (타임랩스)
                  </button>
                  <ul className="apilist">
                    {apiRows.map((r, i) => (
                      <li key={i}>
                        <span>{r.obsUTC || r.fileName || "시간 미상"} · S{r.slot}</span>
                        <button onClick={() => loadResults([r])}>불러오기</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <a className="apilink" href="https://www.nosc.go.kr/openapi/actionOpenApiIssue.do"
                target="_blank" rel="noreferrer">인증키 발급/약관 →</a>
            </div>
          )}
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
