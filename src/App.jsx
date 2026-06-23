import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleMarker,
  ImageOverlay,
  MapContainer,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import { COLORMAPS, gradientCss } from './lib/colormaps.js';
import {
  closeDoc,
  dataRange,
  mercatorY,
  openNetCDF,
  regrid,
  renderCanvas,
} from './lib/netcdf.js';
import { fetchRedtideDetail, fetchRedtideList } from './lib/nifs.js';
import { searchNetcdf, sourceFromResult } from './lib/nosc.js';
import { geocodeArea } from './lib/redtide-geocode.js';
import { BUOY_STATIONS, fetchBuoyLatest } from './lib/buoy.js';

// Gov OpenAPI service keys from .env (VITE_ prefix required for client exposure).
// Create a `.env` with: VITE_NOSC_SERVICE_KEY=… and VITE_NIFS_SERVICE_KEY=…
const ENV_KEY = import.meta.env.VITE_NOSC_SERVICE_KEY || '';
const NIFS_KEY = import.meta.env.VITE_NIFS_SERVICE_KEY || '';
const DATAGO_KEY = import.meta.env.VITE_DATAGO_KEY || '';

// 부이 마커 색: 수온(℃)을 jet 컬러맵 0–30℃ 선형으로 매핑.
function buoyTempColor(w, vmin = 0, vmax = 30) {
  if (!Number.isFinite(w)) return '#9aa6b8';
  let t = (w - vmin) / (vmax - vmin || 1);
  t = Math.min(1, Math.max(0, t));
  const [r, g, b] = COLORMAPS.jet.fn(t);
  return `rgb(${r},${g},${b})`;
}

// Marker color by peak algal density (개체/mL): higher = more severe.
function densityColor(d) {
  if (d == null) return '#9aa6b8';
  if (d >= 1000) return '#ff3b3b';
  if (d >= 100) return '#ff8a3b';
  return '#ffd23b';
}

// Pull an observation time out of a GOCI-style filename: ..._YYYYMMDD_HHMMSS_...
function parseTime(name, fallback) {
  const m = name.match(/(\d{8})[_-](\d{6})/);
  if (m) {
    const [, d, t] = m;
    return Date.UTC(
      +d.slice(0, 4),
      +d.slice(4, 6) - 1,
      +d.slice(6, 8),
      +t.slice(0, 2),
      +t.slice(2, 4),
      +t.slice(4, 6),
    );
  }
  return fallback; // keep upload order if no timestamp
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

// "20160814" -> "2016-08-14" (NIFS rdate is a bare YYYYMMDD string).
function fmtRdate(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(s || '');
}

// Fit the data extent, then lock min zoom so the bounds always fill the
// viewport (no zooming out into empty/repeated world), and clamp panning.
function FitBounds({ bounds }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds) return;
    const b = [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ];
    map.fitBounds(b);
    const z = map.getBoundsZoom(b, false);
    map.setMinZoom(z);
    map.setMaxBounds(b);
    map.options.maxBoundsViscosity = 1.0;
  }, [bounds, map]);
  return null;
}

// When red-tide markers are shown without any NetCDF data loaded, frame the map
// on the markers (data-layer FitBounds is inactive in that case).
function FitToPoints({ points, enabled }) {
  const map = useMap();
  useEffect(() => {
    if (!enabled || !points.length) return;
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [50, 50], maxZoom: 9 },
    );
  }, [points, enabled, map]);
  return null;
}

// Pan/zoom to the most recently fetched buoy so the new marker is in view.
function FlyTo({ target }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    map.setView(target, Math.max(map.getZoom(), 9), { animate: true });
  }, [target, map]);
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
      if (fy < 0 || fy >= 1 || fx < 0 || fx >= 1)
        return onValue(null, e.latlng);
      const r = Math.min(nrow - 1, Math.floor(fy * nrow));
      const c = Math.min(ncol - 1, Math.floor(fx * ncol));
      const v = grid[r * ncol + c];
      onValue(Number.isFinite(v) ? v : null, e.latlng);
    },
  });
  return null;
}

export default function App() {
  const [fileList, setFileList] = useState([]); // browser File[]
  const [variables, setVariables] = useState([]); // from first file
  const [variable, setVariable] = useState('');
  const [frames, setFrames] = useState([]); // [{name,time,regridded}]
  const [range, setRange] = useState([0, 1]); // auto (data-derived) scale
  const [fixedRange, setFixedRange] = useState([0, 30]); // KHOA default override
  const [preset, setPreset] = useState('khoa');
  const [dataUrls, setDataUrls] = useState([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(4);

  const [cmap, setCmap] = useState('jet');
  const [log, setLog] = useState(false);
  const [opacity, setOpacity] = useState(0.85);

  const [status, setStatus] = useState('');
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
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const isoDaysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const [showApi, setShowApi] = useState(false);
  const [apiStart, setApiStart] = useState(todayLocal);
  const [apiEnd, setApiEnd] = useState(todayLocal);
  const [apiSlot, setApiSlot] = useState('13');
  const [apiProduct, setApiProduct] = useState('RI');
  const [apiRows, setApiRows] = useState([]);
  const [apiBusy, setApiBusy] = useState(false);
  const [apiMsg, setApiMsg] = useState('');

  // NIFS 적조정보 (red-tide alert) panel state. Default to the last 7 days.
  const [showRt, setShowRt] = useState(false);
  const [rtStart, setRtStart] = useState(() => isoDaysAgo(7));
  const [rtEnd, setRtEnd] = useState(todayLocal);
  const [rtRows, setRtRows] = useState([]); // [{srcode, rdate, events}]
  const [rtBusy, setRtBusy] = useState(false);
  const [rtMsg, setRtMsg] = useState('');
  const [rtOpen, setRtOpen] = useState(null); // expanded srcode
  const [rtDetail, setRtDetail] = useState(null); // detail for rtOpen
  const [rtDetailBusy, setRtDetailBusy] = useState(false);
  const [rtMarkersOn, setRtMarkersOn] = useState(true);
  const rtDetailRun = useRef(0); // cancels stale detail fetches (fast item switches)

  // 해양관측부이 패널 상태. 선택한 관측소만 조회해 마커로 누적 표시한다.
  const [showBuoy, setShowBuoy] = useState(false);
  const [buoyCode, setBuoyCode] = useState('TW_0089'); // 선택된 관측소
  const [buoyDate, setBuoyDate] = useState(''); // 빈값 = API 기본(당일)
  const [buoyBusy, setBuoyBusy] = useState(false);
  const [buoyMsg, setBuoyMsg] = useState('');
  const [buoyData, setBuoyData] = useState({}); // obsCode -> {name,lat,lon,...item}
  const [buoyFocus, setBuoyFocus] = useState(null); // [lat,lon] 최근 조회 → 지도 이동
  const buoyRun = useRef(0);

  // Read a dropped/selected file list: grab variables from the first file,
  // pick a sensible default variable, and stash the list for processing.
  const loadFiles = useCallback(async (files) => {
    const arr = Array.from(files || []).filter((f) =>
      /\.(nc|nc4|h5|hdf5)$/i.test(f.name),
    );
    if (!arr.length) {
      setStatus('불러올 .nc 파일이 없습니다.');
      return;
    }
    setBusy(true);
    setStatus('파일 확인 중…');
    setFrames([]);
    setDataUrls([]);
    setIdx(0);
    setPlaying(false);
    try {
      const buf = await arr[0].arrayBuffer();
      const doc = await openNetCDF(buf);
      if (!doc.latDs || !doc.lonDs)
        throw new Error('위도/경도 좌표 변수를 찾지 못했습니다.');
      if (!doc.variables.length)
        throw new Error('표시할 2차원 변수를 찾지 못했습니다.');
      closeDoc(doc);
      const def =
        doc.variables.find((v) => !/flag|mask/i.test(v.name)) ||
        doc.variables[0];
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
    setApiBusy(true);
    setApiMsg('조회 중…');
    setApiRows([]);
    try {
      const rows = await searchNetcdf({
        serviceKey: ENV_KEY,
        startDate: apiStart,
        endDate: apiEnd,
        slot: apiSlot,
        product: apiProduct,
      });
      setApiRows(rows);
      setApiMsg(
        rows.length
          ? `${rows.length}건 — 불러올 항목을 선택하세요`
          : '결과 없음',
      );
    } catch (e) {
      setApiMsg(e.message || String(e));
    } finally {
      setApiBusy(false);
    }
  }, [apiStart, apiEnd, apiSlot, apiProduct]);

  // Turn API results into viewer sources and feed the normal load pipeline.
  const loadResults = useCallback(
    (rows) => {
      if (rows.length) loadFiles(rows.map(sourceFromResult));
    },
    [loadFiles],
  );

  // Query the NIFS 적조정보 API for the selected date range.
  const doRtSearch = useCallback(async () => {
    setRtBusy(true);
    setRtMsg('조회 중…');
    setRtRows([]);
    setRtOpen(null);
    setRtDetail(null);
    try {
      const rows = await fetchRedtideList({
        serviceKey: NIFS_KEY,
        sdate: rtStart,
        edate: rtEnd,
      });
      setRtRows(rows);
      const events = rows.reduce((n, r) => n + r.events.length, 0);
      setRtMsg(
        rows.length
          ? `적조 속보 ${rows.length}건 · 발생 ${events}건`
          : '해당 기간 적조 정보 없음',
      );
    } catch (e) {
      setRtMsg(e.message || String(e));
    } finally {
      setRtBusy(false);
    }
  }, [rtStart, rtEnd]);

  // Expand/collapse a 속보; fetch its detail (진행상황/특보/전망/당부사항) on open.
  const toggleRtDetail = useCallback(
    async (srcode) => {
      if (rtOpen === srcode) {
        setRtOpen(null);
        setRtDetail(null);
        return;
      }
      const myRun = ++rtDetailRun.current; // ignore results from earlier clicks
      setRtOpen(srcode);
      setRtDetail(null);
      setRtDetailBusy(true);
      try {
        const d = await fetchRedtideDetail({ serviceKey: NIFS_KEY, srcode });
        if (myRun === rtDetailRun.current) setRtDetail(d);
      } catch (e) {
        if (myRun === rtDetailRun.current)
          setRtDetail({ error: e.message || String(e) });
      } finally {
        if (myRun === rtDetailRun.current) setRtDetailBusy(false);
      }
    },
    [rtOpen],
  );

  // Geocode each observation's 조사해역 to an approximate marker.
  const rtMarkers = useMemo(() => {
    const pts = [];
    for (const row of rtRows) {
      for (const ev of row.events) {
        const g = geocodeArea(ev.oarea);
        if (g) pts.push({ ...g, ...ev, rdate: row.rdate, srcode: row.srcode });
      }
    }
    return pts;
  }, [rtRows]);

  // 선택한 관측소의 최신 부이 관측을 조회해 마커 목록에 추가/갱신한다.
  const doBuoySearch = useCallback(async () => {
    const myRun = ++buoyRun.current;
    setBuoyBusy(true);
    setBuoyMsg('부이 관측 조회 중…');
    try {
      const reqDate = buoyDate ? buoyDate.replace(/-/g, '') : '';
      const { item, count } = await fetchBuoyLatest({
        serviceKey: DATAGO_KEY,
        obsCode: buoyCode,
        reqDate,
      });
      if (myRun !== buoyRun.current) return;
      if (!item) {
        setBuoyMsg(
          count
            ? '좌표가 있는 관측이 없습니다.'
            : '해당 조건의 관측 데이터가 없습니다.',
        );
        return;
      }
      const name =
        BUOY_STATIONS.find((s) => s.code === buoyCode)?.name ||
        item.obsvtrNm ||
        buoyCode;
      setBuoyData((d) => ({ ...d, [buoyCode]: { code: buoyCode, name, ...item } }));
      setBuoyFocus([item.lat, item.lon]);
      setBuoyMsg(
        `${name}: 수온 ${Number.isFinite(item.wtem) ? item.wtem.toFixed(2) + '℃' : '—'} · ${item.obsrvnDt}`,
      );
    } catch (e) {
      if (myRun === buoyRun.current) setBuoyMsg(e.message || String(e));
    } finally {
      if (myRun === buoyRun.current) setBuoyBusy(false);
    }
  }, [buoyCode, buoyDate]);

  const buoyMarkers = useMemo(() => Object.values(buoyData), [buoyData]);

  // Process every file for the selected variable (sequential, memory-bounded).
  useEffect(() => {
    if (!fileList.length || !variable) return;
    const myRun = ++runId.current;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setPlaying(false);
      const target = fileList.length > 1 ? 1200 : 1600;
      const fr = [];
      let gmin = Infinity,
        gmax = -Infinity;
      let lastErr = null;
      for (let k = 0; k < fileList.length; k++) {
        if (cancelled || myRun !== runId.current) return;
        setStatus(`데이터 처리 중… ${k + 1}/${fileList.length}`);
        try {
          let buf;
          if (k === 0 && prefetched.current?.src === fileList[0]) {
            buf = prefetched.current.buf; // already downloaded for detection
            prefetched.current = null; // release for GC after this pass
          } else {
            buf = await fileList[k].arrayBuffer();
          }
          const doc = await openNetCDF(buf);
          const rg = regrid(doc.file, variable, doc.latDs, doc.lonDs, target);
          closeDoc(doc);
          const [lo, hi] = dataRange(rg.grid);
          if (Number.isFinite(lo)) {
            gmin = Math.min(gmin, lo);
            gmax = Math.max(gmax, hi);
          }
          fr.push({
            name: fileList[k].name,
            time: parseTime(fileList[k].name, k),
            regridded: rg,
          });
        } catch (err) {
          lastErr = err;
          console.warn('skip', fileList[k].name, err);
        }
        await new Promise((r) => setTimeout(r, 0)); // yield to UI
      }
      if (cancelled || myRun !== runId.current) return;
      if (!fr.length) {
        // every file failed to download/parse — surface it
        setBusy(false);
        setStatus(
          '불러오기 실패: ' +
            (lastErr?.message || '다운로드/파싱 오류 (콘솔 확인)'),
        );
        return;
      }
      fr.sort((a, b) => a.time - b.time);
      if (!Number.isFinite(gmin)) {
        gmin = 0;
        gmax = 1;
      }
      setFrames(fr);
      setRange([gmin, gmax === gmin ? gmin + 1 : gmax]);
      setIdx(0);
      setStatus(fr.length > 1 ? `${fr.length}개 프레임` : '');
    })();
    return () => {
      cancelled = true;
    };
  }, [fileList, variable]);

  // Render every frame to a colored PNG whenever the shared scale or style
  // changes. Grids are kept in memory so this needs no re-parsing.
  useEffect(() => {
    if (!frames.length) {
      setDataUrls([]);
      return;
    }
    const myRun = ++runId.current;
    let cancelled = false;
    (async () => {
      setBusy(true);
      if (frames.length > 1) setStatus('프레임 렌더링…');
      const eff = fixedRange || range;
      const urls = [];
      for (let k = 0; k < frames.length; k++) {
        if (cancelled || myRun !== runId.current) return;
        urls.push(
          renderCanvas(frames[k].regridded, {
            cmap,
            vmin: eff[0],
            vmax: eff[1],
            log,
            opacity,
          }),
        );
        if (k % 4 === 3) await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled || myRun !== runId.current) return;
      setDataUrls(urls);
      setBusy(false);
      setStatus(frames.length > 1 ? `${frames.length}개 프레임` : '');
    })();
    return () => {
      cancelled = true;
    };
  }, [frames, cmap, log, opacity, range, fixedRange]);

  // Playback timer.
  useEffect(() => {
    if (!playing || dataUrls.length < 2) return;
    const t = setInterval(
      () => setIdx((i) => (i + 1) % dataUrls.length),
      1000 / fps,
    );
    return () => clearInterval(t);
  }, [playing, fps, dataUrls.length]);

  const cur = frames[idx];
  const effRange = fixedRange || range; // preset overrides the auto scale
  const bounds = cur?.regridded.bounds;
  const overlayBounds = bounds
    ? [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ]
    : null;
  const fitB = frames[0]?.regridded.bounds; // stable extent for FitBounds

  const ticks = useMemo(() => {
    const [lo, hi] = effRange;
    return [0, 1, 2, 3, 4].map((i) => {
      const f = i / 4;
      const val =
        log && lo > 0
          ? Math.pow(10, Math.log10(lo) + f * (Math.log10(hi) - Math.log10(lo)))
          : lo + f * (hi - lo);
      return { f, val };
    });
  }, [effRange, log]);

  const fmt = (x) =>
    Math.abs(x) >= 100
      ? x.toFixed(0)
      : Math.abs(x) >= 1
        ? x.toFixed(1)
        : x.toFixed(2);
  const curVar = variables.find((v) => v.path === variable);
  const unit = cur?.regridded.units || curVar?.units || '';
  const multi = frames.length > 1;

  // Presets bundle scale type + range + colormap. "khoa" matches the KHOA/NOSC
  // preview: linear 0–30 on a jet ramp. "auto" = data-driven log + turbo.
  function applyPreset(p) {
    setPreset(p);
    if (p === 'khoa') {
      setCmap('jet');
      setLog(false);
      setFixedRange([0, 30]);
    } else {
      setCmap('turbo');
      setLog(true);
      setFixedRange(null);
    }
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
          className={`drop${over ? ' over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            loadFiles(e.dataTransfer.files);
          }}
        >
          {fileList.length ? (
            <>
              <strong>{fileList.length}개 파일</strong>
              <br />
              다른 파일을 올리려면 클릭
            </>
          ) : (
            <>
              <strong>.nc 파일 선택 (여러 개 가능)</strong>
              <br />
              또는 여기로 끌어다 놓기
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".nc,.nc4,.h5,.hdf5"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => loadFiles(e.target.files)}
          />
        </div>

        <div className="apibox">
          <button className="apitoggle" onClick={() => setShowApi((s) => !s)}>
            {showApi ? '▾' : '▸'} NOSC API에서 불러오기
          </button>
          {showApi && (
            <div className="apibody">
              {ENV_KEY ? (
                <div className="apinote">인증키: .env에서 불러옴</div>
              ) : (
                <div className="status err">
                  .env에 VITE_NOSC_SERVICE_KEY를 설정하세요
                </div>
              )}
              <div className="row2">
                <label className="ap">
                  시작일
                  <input
                    type="date"
                    value={apiStart}
                    onChange={(e) => setApiStart(e.target.value)}
                  />
                </label>
                <label className="ap">
                  종료일
                  <input
                    type="date"
                    value={apiEnd}
                    onChange={(e) => setApiEnd(e.target.value)}
                  />
                </label>
              </div>
              <div className="row2">
                <label className="ap">
                  슬롯
                  <select
                    value={apiSlot}
                    onChange={(e) => setApiSlot(e.target.value)}
                  >
                    {[...Array(12).keys()].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                    <option value="13">13 (한반도 전체)</option>
                  </select>
                </label>
                <label className="ap">
                  산출물
                  <select
                    value={apiProduct}
                    onChange={(e) => setApiProduct(e.target.value)}
                  >
                    {[
                      'RI',
                      'Chl',
                      'AC',
                      'TSS',
                      'CDOM',
                      'Kd',
                      'Zsd',
                      'PP',
                      'FA',
                    ].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button className="apibtn" onClick={doSearch} disabled={apiBusy}>
                조회
              </button>
              {apiMsg && (
                <div
                  className={`status${/오류|실패|없음|확인/i.test(apiMsg) ? ' err' : ''}`}
                >
                  {apiBusy && <span className="spinner" />}
                  {apiMsg}
                </div>
              )}
              {apiRows.length > 0 && (
                <>
                  <button
                    className="apibtn alt"
                    onClick={() => loadResults(apiRows)}
                  >
                    전체 {apiRows.length}개 불러오기 (타임랩스)
                  </button>
                  <ul className="apilist">
                    {apiRows.map((r, i) => (
                      <li key={i}>
                        <span>
                          {r.obsUTC || r.fileName || '시간 미상'} · S{r.slot}
                        </span>
                        <button onClick={() => loadResults([r])}>
                          불러오기
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <a
                className="apilink"
                href="https://www.nosc.go.kr/openapi/actionOpenApiIssue.do"
                target="_blank"
                rel="noreferrer"
              >
                인증키 발급/약관 →
              </a>
            </div>
          )}
        </div>

        <div className="apibox">
          <button className="apitoggle" onClick={() => setShowRt((s) => !s)}>
            {showRt ? '▾' : '▸'} 적조 정보 / 알림
            {rtRows.length > 0 && (
              <span className="rtbadge">🔴 {rtRows.length}</span>
            )}
          </button>
          {showRt && (
            <div className="apibody">
              {NIFS_KEY ? (
                <div className="apinote">인증키: .env에서 불러옴</div>
              ) : (
                <div className="status err">
                  .env에 VITE_NIFS_SERVICE_KEY를 설정하세요
                </div>
              )}
              <div className="row2">
                <label className="ap">
                  시작일
                  <input
                    type="date"
                    value={rtStart}
                    onChange={(e) => setRtStart(e.target.value)}
                  />
                </label>
                <label className="ap">
                  종료일
                  <input
                    type="date"
                    value={rtEnd}
                    onChange={(e) => setRtEnd(e.target.value)}
                  />
                </label>
              </div>
              <button className="apibtn" onClick={doRtSearch} disabled={rtBusy}>
                적조 정보 조회
              </button>
              {rtMsg && (
                <div
                  className={`status${/오류|실패|없음|확인|설정/i.test(rtMsg) ? ' err' : ''}`}
                >
                  {rtBusy && <span className="spinner" />}
                  {rtMsg}
                </div>
              )}
              {rtMarkers.length > 0 && (
                <label
                  className="apinote"
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <input
                    type="checkbox"
                    checked={rtMarkersOn}
                    onChange={(e) => setRtMarkersOn(e.target.checked)}
                  />
                  지도에 발생 위치 표시 ({rtMarkers.length}개 · 시·군 근사)
                </label>
              )}
              {rtRows.length > 0 && (
                <ul className="rtlist">
                  {rtRows.map((row) => (
                    <li key={row.srcode} className="rtitem">
                      <button
                        className="rthead"
                        onClick={() => toggleRtDetail(row.srcode)}
                      >
                        <span className="rtdate">{fmtRdate(row.rdate)}</span>
                        <span className="rtareas">
                          {row.events
                            .map((e) => e.oarea)
                            .filter(Boolean)
                            .slice(0, 2)
                            .join(' / ') || '조사해역 미상'}
                          {row.events.length > 2
                            ? ` 외 ${row.events.length - 2}`
                            : ''}
                        </span>
                        <span className="rtchev">
                          {rtOpen === row.srcode ? '▾' : '▸'}
                        </span>
                      </button>
                      {rtOpen === row.srcode && (
                        <div className="rtdetail">
                          <table className="rttable">
                            <tbody>
                              {row.events.map((e, i) => (
                                <tr key={i}>
                                  <td>{e.oarea}</td>
                                  <td className="rtsp">{e.dname}</td>
                                  <td className="rtnum">
                                    {e.sdensity != null
                                      ? `${fmt(e.sdensity)}~${fmt(e.edensity)}`
                                      : '—'}
                                    <span className="rtu"> cells/mL</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {rtDetailBusy && (
                            <div className="status">
                              <span className="spinner" />
                              상세 불러오는 중…
                            </div>
                          )}
                          {rtDetail?.error && (
                            <div className="status err">{rtDetail.error}</div>
                          )}
                          {rtDetail && !rtDetail.error && (
                            <div className="rttext">
                              {[
                                ['진행상황', rtDetail.pstate],
                                ['특보상황', rtDetail.sreport],
                                ['금후전망', rtDetail.aview],
                                ['당부사항', rtDetail.rmatter],
                                ['기타', rtDetail.etc],
                              ]
                                .filter(([, v]) => v && v.trim())
                                .map(([k, v]) => (
                                  <div key={k} className="rtsect">
                                    <div className="rtk">{k}</div>
                                    <div className="rtv">{v.trim()}</div>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <a
                className="apilink"
                href="https://www.nifs.go.kr/main.do"
                target="_blank"
                rel="noreferrer"
              >
                국립수산과학원 적조속보 →
              </a>
            </div>
          )}
        </div>

        <div className="apibox">
          <button className="apitoggle" onClick={() => setShowBuoy((s) => !s)}>
            {showBuoy ? '▾' : '▸'} 해양관측부이 (수온)
            {buoyMarkers.length > 0 && (
              <span className="rtbadge">🌡 {buoyMarkers.length}</span>
            )}
          </button>
          {showBuoy && (
            <div className="apibody">
              {DATAGO_KEY ? (
                <div className="apinote">인증키: .env에서 불러옴</div>
              ) : (
                <div className="status err">
                  .env에 VITE_DATAGO_KEY를 설정하세요 (data.go.kr 키)
                </div>
              )}
              <div className="field">
                <label>관측소</label>
                <select
                  value={buoyCode}
                  onChange={(e) => setBuoyCode(e.target.value)}
                >
                  {BUOY_STATIONS.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="row2">
                <label className="ap">
                  요청일자(선택)
                  <input
                    type="date"
                    value={buoyDate}
                    onChange={(e) => setBuoyDate(e.target.value)}
                  />
                </label>
              </div>
              <button
                className="apibtn"
                onClick={doBuoySearch}
                disabled={buoyBusy}
              >
                관측소 조회·지도에 추가
              </button>
              {buoyMsg && (
                <div
                  className={`status${/오류|실패|없음|설정/i.test(buoyMsg) ? ' err' : ''}`}
                >
                  {buoyBusy && <span className="spinner" />}
                  {buoyMsg}
                </div>
              )}
              {buoyMarkers.length > 0 && (
                <>
                  <div className="apinote" style={{ marginTop: 6 }}>
                    표시 중 ({buoyMarkers.length}) · 마커색 = 수온(0–30℃, jet)
                  </div>
                  <ul className="apilist">
                    {buoyMarkers.map((m) => (
                      <li key={m.code}>
                        <span>
                          <span
                            style={{
                              display: 'inline-block',
                              width: 10,
                              height: 10,
                              borderRadius: '50%',
                              background: buoyTempColor(m.wtem),
                              marginRight: 6,
                              verticalAlign: -1,
                            }}
                          />
                          {m.name} ·{' '}
                          {Number.isFinite(m.wtem)
                            ? `${m.wtem.toFixed(1)}℃`
                            : '—'}
                        </span>
                        <button
                          onClick={() =>
                            setBuoyData(
                              ({ [m.code]: _removed, ...rest }) => rest,
                            )
                          }
                        >
                          제거
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    className="apibtn alt"
                    onClick={() => setBuoyData({})}
                  >
                    전체 지우기
                  </button>
                </>
              )}
              <a
                className="apilink"
                href="https://www.data.go.kr/data/15146883/openapi.do"
                target="_blank"
                rel="noreferrer"
              >
                공공데이터포털 해양관측부이 →
              </a>
            </div>
          )}
        </div>

        {variables.length > 0 && (
          <>
            <div className="field">
              <label>표현 프리셋</label>
              <select
                value={preset}
                onChange={(e) => applyPreset(e.target.value)}
              >
                <option value="auto">자동 (데이터 기준 · 로그 · turbo)</option>
                <option value="khoa">KHOA 기준 (선형 0–30 · jet)</option>
              </select>
            </div>
            <div className="field">
              <label>변수</label>
              <select
                value={variable}
                onChange={(e) => setVariable(e.target.value)}
              >
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
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={log}
                  onChange={(e) => setLog(e.target.checked)}
                  style={{ marginRight: 6, verticalAlign: -1 }}
                />
                로그 스케일
              </label>
            </div>
            <div className="field">
              <label>투명도 {(opacity * 100).toFixed(0)}%</label>
              <input
                type="range"
                min="0"
                max="100"
                value={opacity * 100}
                onChange={(e) => setOpacity(e.target.value / 100)}
              />
            </div>
          </>
        )}

        {status && (
          <div
            className={`status${/못했|오류|실패|Error/i.test(status) ? ' err' : ''}`}
          >
            {busy && <span className="spinner" />}
            {status}
          </div>
        )}

        {cur && (
          <div className="meta">
            범위: {fmt(effRange[0])} ~ {fmt(effRange[1])} {unit}
            {fixedRange ? ' (KHOA 고정)' : ' (자동)'}
            <br />
            격자: {cur.regridded.ncol} × {cur.regridded.nrow}
            {multi && (
              <>
                <br />
                프레임 {idx + 1}/{frames.length}
              </>
            )}
          </div>
        )}
      </aside>

      <div className="map-wrap">
        <MapContainer center={[27, 140]} zoom={6} preferCanvas worldCopyJump>
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            attribution="&copy; OpenStreetMap, &copy; CARTO"
            subdomains="abcd"
            noWrap
          />
          {dataUrls[idx] && overlayBounds && (
            <ImageOverlay
              url={dataUrls[idx]}
              bounds={overlayBounds}
              opacity={1}
            />
          )}
          {fitB && <FitBounds bounds={fitB} />}
          {rtMarkersOn &&
            rtMarkers.map((p, i) => (
              <CircleMarker
                key={`${p.srcode}-${i}`}
                center={[p.lat, p.lon]}
                radius={7}
                pathOptions={{
                  color: densityColor(p.edensity),
                  fillColor: densityColor(p.edensity),
                  fillOpacity: 0.6,
                  weight: 1.5,
                }}
              >
                <Popup>
                  <div className="rtpop">
                    <strong>{p.oarea}</strong>
                    <br />
                    원인생물: {p.dname || '—'}
                    <br />
                    생물밀도:{' '}
                    {p.sdensity != null
                      ? `${fmt(p.sdensity)}~${fmt(p.edensity)} cells/mL`
                      : '—'}
                    <br />
                    수온:{' '}
                    {p.swt != null ? `${fmt(p.swt)}~${fmt(p.ewt)} ℃` : '—'}
                    <br />
                    조사일시: {fmtRdate(p.rdate)}
                    <br />
                    <span className="rtpopnote">
                      ※ 위치는 {p.matched} 기준 근사
                    </span>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          <FitToPoints
            points={rtMarkers}
            enabled={rtMarkersOn && !frames.length}
          />
          {buoyMarkers.map((m) => (
            <CircleMarker
              key={m.code}
              center={[m.lat, m.lon]}
              radius={9}
              pathOptions={{
                color: '#222',
                weight: 1.5,
                fillColor: buoyTempColor(m.wtem),
                fillOpacity: 0.9,
              }}
            >
              <Popup>
                <div className="rtpop">
                  <strong>
                    {m.name} ({m.code})
                  </strong>
                  <br />
                  관측일시: {m.obsrvnDt || '—'}
                  <br />
                  수온:{' '}
                  {Number.isFinite(m.wtem) ? `${m.wtem.toFixed(2)} ℃` : '—'}
                  <br />
                  염분:{' '}
                  {Number.isFinite(m.slnty) ? `${m.slnty.toFixed(2)} psu` : '—'}
                  <br />
                  기온:{' '}
                  {Number.isFinite(m.artmp) ? `${m.artmp.toFixed(1)} ℃` : '—'}
                  {' · '}기압:{' '}
                  {Number.isFinite(m.atmpr) ? `${m.atmpr.toFixed(1)} hPa` : '—'}
                  <br />
                  풍향/풍속:{' '}
                  {Number.isFinite(m.wndrct) ? `${m.wndrct.toFixed(0)}°` : '—'}
                  {' / '}
                  {Number.isFinite(m.wspd) ? `${m.wspd.toFixed(1)} m/s` : '—'}
                  <br />
                  파고:{' '}
                  {Number.isFinite(m.wvhgt) ? `${m.wvhgt.toFixed(1)} m` : '—'}
                  {' · '}유속:{' '}
                  {Number.isFinite(m.crsp) ? `${m.crsp.toFixed(1)} cm/s` : '—'}
                  <br />
                  <span className="rtpopnote">
                    {m.lat.toFixed(4)}°N, {m.lon.toFixed(4)}°E
                  </span>
                </div>
              </Popup>
            </CircleMarker>
          ))}
          <FlyTo target={buoyFocus} />
          <Hover
            regridded={cur?.regridded}
            onValue={(v, latlng) => setHover({ v, latlng })}
          />
        </MapContainer>

        {cur && (
          <>
            <div className="overlay-panel readout">
              <div className="u">{curVar?.long_name || curVar?.name}</div>
              <div className="v">{hover.v == null ? '—' : fmt(hover.v)}</div>
              <div className="u">
                {hover.latlng
                  ? `${hover.latlng.lat.toFixed(3)}°N, ${hover.latlng.lng.toFixed(3)}°E`
                  : '지도 위로 마우스를 올리세요'}
                {unit ? ` · ${unit}` : ''}
              </div>
            </div>

            {multi && (
              <div className="overlay-panel timeline">
                <button className="play" onClick={() => setPlaying((p) => !p)}>
                  {playing ? '⏸' : '▶'}
                </button>
                <input
                  className="scrub"
                  type="range"
                  min="0"
                  max={frames.length - 1}
                  value={idx}
                  onChange={(e) => {
                    setPlaying(false);
                    setIdx(+e.target.value);
                  }}
                />
                <span className="tlabel">{fmtTime(cur.time)}</span>
                <select
                  className="spd"
                  value={fps}
                  onChange={(e) => setFps(+e.target.value)}
                >
                  <option value={2}>2 fps</option>
                  <option value={4}>4 fps</option>
                  <option value={8}>8 fps</option>
                  <option value={15}>15 fps</option>
                </select>
              </div>
            )}

            <div className="overlay-panel legend">
              <div className="cap">
                {curVar?.long_name || curVar?.name}
                {unit ? ` (${unit})` : ''}
                {log && effRange[0] > 0 ? ' · 로그' : ''}
              </div>
              <div className="lgbody">
                <div
                  className="bar"
                  style={{
                    background: gradientCss(cmap).replace('90deg', 'to top'),
                  }}
                />
                <div className="vticks">
                  {ticks.map((t, i) => (
                    <span key={i} style={{ bottom: `${t.f * 100}%` }}>
                      {fmt(t.val)}
                    </span>
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
