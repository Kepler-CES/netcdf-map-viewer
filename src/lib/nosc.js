// Client for the NOSC/KHOA "위성NetCDF정보 API" (GOCI-II NetCDF search).
// Docs: https://www.nosc.go.kr/boardContents/actionBoardContentsCons0011.do
//
// Endpoint: /openapi/GK2BNcMedia/search.do
//   ServiceKey, startDate(YYYYMMDD), endDate(YYYYMMDD), slot(0-11, 13=한반도 전체),
//   ResultType=json
// Returns a list of files: { Satellite, Sensor, Level, ObsArea, product, slot,
//   filePath(.nc URL), fileName, "ObsTime(UTC)", "ObsTime(KST)" }.
//
// All requests go through the dev proxy at /nosc (see vite.config.js) because
// the gov server is plain HTTP without CORS headers.

const API_BASE = "/nosc"; // dev-proxy prefix -> http://nosc.go.kr

// Case-insensitive field lookup that also tolerates the "ObsTime(UTC)" style keys.
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
    const hit = Object.keys(obj).find((kk) => kk.toLowerCase() === k.toLowerCase());
    if (hit && obj[hit] != null) return obj[hit];
  }
  return undefined;
}

// The response envelope isn't documented exactly, so find the record array
// wherever it sits — at any nesting depth (e.g. response.body.items). Collect
// every array, then prefer one whose elements look like records (objects).
function extractRows(data) {
  const arrays = [];
  const walk = (v) => {
    if (Array.isArray(v)) { arrays.push(v); return; }
    if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(data);
  return arrays.find((a) => a.length && typeof a[0] === "object")
    || arrays.find((a) => a.length)
    || [];
}

const ymd = (s) => String(s).replace(/-/g, ""); // 2025-09-25 -> 20250925

export async function searchNetcdf({ serviceKey, startDate, endDate, slot, product }) {
  if (!serviceKey) throw new Error("인증키(ServiceKey)를 입력하세요.");
  const qs = new URLSearchParams({
    ServiceKey: serviceKey,
    startDate: ymd(startDate),
    endDate: ymd(endDate),
    slot: String(slot),
    ResultType: "json",
  });
  const res = await fetch(`${API_BASE}/openapi/GK2BNcMedia/search.do?${qs}`);
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    throw new Error(`API 응답 오류 (HTTP ${res.status})${snippet ? " — " + snippet : ""}`);
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("JSON 파싱 실패 — 인증키가 유효한지, 프록시가 켜졌는지 확인하세요."); }

  let rows = extractRows(data).map((r) => ({
    satellite: pick(r, "Satellite"),
    level: pick(r, "Level"),
    product: product || pick(r, "product"), // requested code (RI…), for merge download
    slot: pick(r, "slot"),
    fileName: pick(r, "fileName"),
    filePath: pick(r, "filePath"),
    obsUTC: pick(r, "ObsTime(UTC)", "ObsTimeUTC", "ObsTime") || "",
  })).filter((r) => r.filePath && r.fileName);

  // The product is encoded ONLY in the fileName/filePath suffix
  // (..._<PRODUCT>[.nc]) — the same obsTime returns every product (RI, Chl, Kd,
  // LA, ...). The response's `product` field is unreliable/empty, so match the
  // suffix instead, or every product would load at once.
  if (product) {
    const safe = product.replace(/[^A-Za-z0-9]/g, "");
    const re = new RegExp(`_${safe}(?:\\.[A-Za-z0-9]+)?$`, "i");
    rows = rows.filter((r) => re.test(r.fileName) || re.test(r.filePath));
  }
  return [...rows].sort((a, b) => a.obsUTC.localeCompare(b.obsUTC));
}

// Rewrite an absolute nosc.go.kr file URL to go through the dev proxy.
export function toProxyUrl(filePath) {
  return filePath.replace(/^https?:\/\/(www\.)?nosc\.go\.kr/i, API_BASE);
}

// OPeNDAP serves the file UNcompressed (~1.45GB). For the 한반도 composite (LA)
// files, NOSC's web "합성영상 nc" endpoint serves the SAME file deflate-compressed
// (~130MB, ~10x faster), keyed by KST date+hour + product. Build that URL from
// the fileName's UTC timestamp (KST = UTC + 9h). Returns null for non-composite
// (tile) files, where the merge endpoint would give the wrong file.
function mergeUrl(r) {
  const m = String(r.fileName).match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m || !r.product || !/_LA_/i.test(r.fileName)) return null;
  const [, Y, Mo, D, h, mi, s] = m;
  const kst = new Date(Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s) + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())} `
    + `${p(kst.getUTCHours())}`;
  return `${API_BASE}/program/mergeNoscImgFile.do`
    + `?obs_date_kst=${encodeURIComponent(stamp)}&product_type=${encodeURIComponent(r.product)}`;
}

// Build a viewer "source" (same shape the upload path uses: { name, arrayBuffer })
// that lazily downloads the .nc through the proxy when processed.
const isHDF5 = (buf) => {
  const s = new Uint8Array(buf.slice(0, 4));
  return s[0] === 0x89 && s[1] === 0x48 && s[2] === 0x44 && s[3] === 0x46; // \x89HDF
};

// The API's fileName comes WITHOUT an extension (e.g. "GK2B_..._RI"). The
// viewer's upload filter only accepts names ending in .nc/.nc4/.h5/.hdf5, so
// derive a proper .nc name (also gives a nicer label).
function ncName(fileName, filePath) {
  if (fileName && /\.(nc|nc4|h5|hdf5)$/i.test(fileName)) return fileName;
  if (fileName) return fileName + ".nc";
  try { return decodeURIComponent(new URL(filePath).pathname.split("/").pop()); }
  catch { return "download.nc"; }
}

export function sourceFromResult(r) {
  if (!r.filePath) throw new Error("응답에 filePath가 없습니다 (응답 형식 확인 필요).");
  return {
    name: ncName(r.fileName, r.filePath),
    async arrayBuffer() {
      // Fast path: for older 한반도 composite files NOSC stores a compressed
      // copy (~130MB vs ~1.45GB); the 합성영상 nc endpoint serves it. Recent
      // files are uncompressed there too, so this is a best-effort speedup with
      // an OPeNDAP fallback when it fails or isn't compressed.
      const fast = mergeUrl(r);
      if (fast) {
        try {
          const res = await fetch(fast);
          if (res.ok) {
            const buf = await res.arrayBuffer();
            if (isHDF5(buf)) return buf;
          }
        } catch { /* fall through to OPeNDAP */ }
      }
      // Fallback: the raw OPeNDAP file (uncompressed, large, but always there).
      const res = await fetch(toProxyUrl(r.filePath));
      if (!res.ok)
        throw new Error(`${r.fileName}: 다운로드 실패 (HTTP ${res.status}). filePath=${r.filePath}`);
      const buf = await res.arrayBuffer();
      if (isHDF5(buf)) return buf;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      throw new Error(`${r.fileName}: NetCDF가 아닙니다 (${ct || "?"}). filePath=${r.filePath}`);
    },
  };
}
