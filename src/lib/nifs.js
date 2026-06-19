// Client for the NIFS(국립수산과학원) 적조정보 Open API.
// Docs: 적조 정보 Open API 활용 (redtideList / redtideDetail)
//
//   list:   /api/OpenAPI_json?id=redtideList&key=KEY&sdate=YYYYMMDD&edate=YYYYMMDD
//   detail: /api/OpenAPI_json?id=redtideDetail&key=KEY&cod_news=속보코드
//
// NOTE: the live JSON field names differ from the PDF spec (the PDF is stale).
// Verified against the live API, the real keys are:
//   item:  cod_news(속보코드), day_report(조사일시),
//          + detail-only: txt_progress(진행상황), txt_breaking(특보상황),
//            txt_afterview(금후전망), txt_request(당부사항), txt_reference(기타)
//   item2: nam_biology(원인생물), txt_seas(조사해역),
//          min_density/max_density(생물밀도), min_watertemp/max_watertemp(수온),
//          min_salt/max_salt(염분)
// The detail endpoint takes cod_news (NOT srcode). The /OpenAPI_json path 302s
// to /api/OpenAPI_json — we hit /api directly to skip the redirect hop.
//
// Like the NOSC client, all requests go through the dev proxy at /nifs (see
// vite.config.js): the gov server is plain HTTP without CORS headers.

const API_BASE = "/nifs"; // dev-proxy prefix -> https://www.nifs.go.kr

const ymd = (s) => String(s).replace(/-/g, ""); // 2025-09-25 -> 20250925

// Always treat single/array uniformly: a one-element result arrives as a bare
// object, multiple as an array.
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// The live API serves UTF-8 JSON, but the NIFS server is EUC-KR elsewhere.
// Decode UTF-8 first; if it produced replacement chars (mojibake), fall back
// to EUC-KR.
function decodeKorean(buf) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    return utf8; // EUC-KR unsupported in this runtime — best effort
  }
}

const num = (x) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
};

// One algal-bloom observation row (shared by list and detail), normalized to a
// stable shape regardless of the API's underlying field names.
const normalizeEvent = (e) => ({
  dname: e.nam_biology || "",        // 원인생물
  oarea: e.txt_seas || "",           // 조사해역
  sdensity: num(e.min_density),      // 생물밀도 min (cells/mL)
  edensity: num(e.max_density),      // 생물밀도 max
  swt: num(e.min_watertemp),         // 수온 min (℃)
  ewt: num(e.max_watertemp),         // 수온 max
  ssalt: num(e.min_salt),            // 염분 min (psu)
  esalt: num(e.max_salt),            // 염분 max
});

async function fetchJson(params) {
  const qs = new URLSearchParams(params);
  let res;
  try {
    res = await fetch(`${API_BASE}/api/OpenAPI_json?${qs}`);
  } catch {
    throw new Error("적조 API 연결 실패 — 개발 서버(프록시)가 켜져 있는지 확인하세요.");
  }
  const buf = await res.arrayBuffer();
  const text = decodeKorean(buf);
  if (!res.ok) {
    const snippet = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`적조 API 응답 오류 (HTTP ${res.status})${snippet ? " — " + snippet : ""}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("적조 API 응답 파싱 실패 — 인증키가 유효한지, 프록시가 켜졌는지 확인하세요.");
  }
  const root = data.response || data; // some gov APIs wrap in `response`
  const code = root.header?.resultCode;
  if (code != null && String(code) !== "00") {
    const msg = root.header?.resultMsg || root.header?.resultMng || `코드 ${code}`;
    throw new Error(`적조 API 오류: ${msg}`);
  }
  return root.body || {};
}

// 적조 정보 목록: 기간 내 발생 속보 목록.
// Returns [{ srcode, rdate, events: [event...] }] sorted newest first.
export async function fetchRedtideList({ serviceKey, sdate, edate }) {
  if (!serviceKey)
    throw new Error("인증키가 없습니다. .env의 VITE_NIFS_SERVICE_KEY를 설정하세요.");
  const body = await fetchJson({
    id: "redtideList", key: serviceKey, sdate: ymd(sdate), edate: ymd(edate),
  });
  const rows = asArray(body.item).map((it) => ({
    srcode: it.cod_news || "",
    rdate: it.day_report || "",
    events: asArray(it.item2).map(normalizeEvent),
  }));
  return [...rows].sort((a, b) => String(b.rdate).localeCompare(String(a.rdate)));
}

// 적조 상세 정보: 특정 속보의 진행상황/특보/전망/당부사항.
export async function fetchRedtideDetail({ serviceKey, srcode }) {
  if (!serviceKey)
    throw new Error("인증키가 없습니다. .env의 VITE_NIFS_SERVICE_KEY를 설정하세요.");
  if (!srcode) throw new Error("속보코드(cod_news)가 없습니다.");
  const body = await fetchJson({ id: "redtideDetail", key: serviceKey, cod_news: srcode });
  const it = asArray(body.item)[0];
  if (!it) return null;
  return {
    srcode: it.cod_news || srcode,
    rdate: it.day_report || "",
    pstate: it.txt_progress || "",    // 진행상황
    sreport: it.txt_breaking || "",   // 특보상황
    aview: it.txt_afterview || "",    // 금후전망
    rmatter: it.txt_request || "",    // 당부사항
    etc: it.txt_reference || "",      // 기타
    events: asArray(it.item2).map(normalizeEvent),
  };
}
