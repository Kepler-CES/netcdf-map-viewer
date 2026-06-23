// 해양관측부이 최신 관측데이터 — 공공데이터포털(data.go.kr) OpenAPI 클라이언트.
//
// 엔드포인트(원본): https://apis.data.go.kr/1192136/twRecent/GetTWRecentApiService
// 개발 중에는 Vite 프록시(/dataportal -> https://apis.data.go.kr)를 통해 호출해
// 정부 WAF의 "deceptive request" 400을 우회한다. (vite.config.js 참고)
//
// 이전 수온(15분) API와 달리 응답 item 이 좌표(lot=경도, lat=위도)를 직접
// 포함하므로, 격자코드 디코딩 없이 점 마커로 바로 지도에 찍을 수 있다.
//
// 요청 파라미터:
//   serviceKey (필수, URL-encoded)  obsCode (필수, 관측소 코드 예: TW_0089)
//   reqDate (선택, YYYYMMDD, 기본 당일)  min (선택, 시간간격 분, 기본1·최대60)
//   numOfRows / pageNo / type
// 응답 item: { obsvtrNm, lot, lat, obsrvnDt, wndrct, wspd, maxMmntWspd,
//              artmp, atmpr, wvhgt, wvpd, crdir, crsp, wtem, slnty }

const BASE = "/dataportal/1192136/twRecent/GetTWRecentApiService";

// 문서의 관측소 코드 목록(obsCode -> 관측소명).
export const BUOY_STATIONS = [
  { code: "HB_0001", name: "한수원_기장" },
  { code: "HB_0002", name: "한수원_고리" },
  { code: "HB_0003", name: "한수원_진하" },
  { code: "HB_0007", name: "한수원_온양" },
  { code: "HB_0008", name: "한수원_덕천" },
  { code: "HB_0009", name: "한수원_나곡" },
  { code: "KG_0021", name: "제주남부" },
  { code: "KG_0024", name: "대한해협" },
  { code: "KG_0025", name: "남해동부" },
  { code: "KG_0028", name: "제주해협" },
  { code: "KG_0101", name: "울릉도북동" },
  { code: "KG_0102", name: "울릉도북서" },
  { code: "TW_0062", name: "해운대해수욕장" },
  { code: "TW_0069", name: "대천해수욕장" },
  { code: "TW_0070", name: "평택당진항" },
  { code: "TW_0072", name: "군산항" },
  { code: "TW_0074", name: "광양항" },
  { code: "TW_0075", name: "중문해수욕장" },
  { code: "TW_0076", name: "인천항" },
  { code: "TW_0077", name: "경인항" },
  { code: "TW_0078", name: "완도항" },
  { code: "TW_0079", name: "상왕등도" },
  { code: "TW_0080", name: "우이도" },
  { code: "TW_0081", name: "생일도" },
  { code: "TW_0082", name: "태안항" },
  { code: "TW_0083", name: "여수항" },
  { code: "TW_0084", name: "통영항" },
  { code: "TW_0085", name: "마산항" },
  { code: "TW_0086", name: "부산항신항" },
  { code: "TW_0087", name: "부산항" },
  { code: "TW_0088", name: "감천항" },
  { code: "TW_0089", name: "경포대해수욕장" },
  { code: "TW_0090", name: "송정해수욕장" },
  { code: "TW_0091", name: "낙산해수욕장" },
  { code: "TW_0092", name: "임랑해수욕장" },
  { code: "TW_0093", name: "속초해수욕장" },
  { code: "TW_0094", name: "망상해수욕장" },
  { code: "TW_0095", name: "고래불해수욕장" },
];

// data.go.kr 키는 디코딩 키(원문)/인코딩 키(%2B 등) 두 형태로 발급된다.
// 이미 %로 인코딩된 것처럼 보이면 그대로, 아니면 encodeURIComponent.
function encodeKey(key) {
  return /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
}

function buildUrl({ serviceKey, obsCode, reqDate, min, numOfRows, pageNo, type }) {
  const p = new URLSearchParams();
  p.set("obsCode", obsCode);
  if (reqDate) p.set("reqDate", reqDate);
  if (min != null) p.set("min", String(min));
  p.set("numOfRows", String(numOfRows));
  p.set("pageNo", String(pageNo));
  if (type) p.set("type", type);
  // serviceKey 는 직접 붙여 이중 인코딩 방지.
  return `${BASE}?serviceKey=${encodeKey(serviceKey)}&${p.toString()}`;
}

const NUM = (x) => (x == null || x === "" ? NaN : Number(x));

function normItem(it) {
  return {
    obsvtrNm: it.obsvtrNm != null ? String(it.obsvtrNm) : "",
    lon: NUM(it.lot),
    lat: NUM(it.lat),
    obsrvnDt: it.obsrvnDt != null ? String(it.obsrvnDt) : "",
    wndrct: NUM(it.wndrct),
    wspd: NUM(it.wspd),
    maxMmntWspd: NUM(it.maxMmntWspd),
    artmp: NUM(it.artmp),
    atmpr: NUM(it.atmpr),
    wvhgt: NUM(it.wvhgt),
    wvpd: NUM(it.wvpd),
    crdir: NUM(it.crdir),
    crsp: NUM(it.crsp),
    wtem: NUM(it.wtem),
    slnty: NUM(it.slnty),
  };
}

function parseResponse(text) {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) return fromJson(JSON.parse(t));
  return fromXml(t);
}

function fromJson(j) {
  const resp = j.response || j;
  const header = resp.header || {};
  const body = resp.body || {};
  const code = header.resultCode ?? body.resultCode;
  const msg = header.resultMsg ?? body.resultMsg;
  let items = body.items?.item ?? body.items ?? [];
  if (items && !Array.isArray(items)) items = [items];
  return {
    code: code != null ? String(code) : "00",
    msg: msg || "",
    items: (items || []).map(normItem),
  };
}

function fromXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const perr = doc.querySelector("parsererror");
  if (perr) throw new Error("응답 XML 파싱 실패: " + perr.textContent.slice(0, 120));
  const text = (el, tag) => el.querySelector(tag)?.textContent?.trim() ?? "";
  // 정상 응답은 resultCode/resultMsg, 게이트웨이 오류는 cmmMsgHeader 의
  // returnReasonCode/returnAuthMsg 로 온다.
  const code =
    text(doc, "resultCode") || text(doc, "returnReasonCode") || "00";
  const msg =
    text(doc, "resultMsg") ||
    text(doc, "returnAuthMsg") ||
    text(doc, "errMsg") ||
    "";
  const items = Array.from(doc.querySelectorAll("item")).map((el) => {
    const o = {};
    for (const tag of [
      "obsvtrNm", "lot", "lat", "obsrvnDt", "wndrct", "wspd", "maxMmntWspd",
      "artmp", "atmpr", "wvhgt", "wvpd", "crdir", "crsp", "wtem", "slnty",
    ]) {
      o[tag] = text(el, tag);
    }
    return normItem(o);
  });
  return { code, msg, items };
}

function isOk(code) {
  return code === "00" || code === "0" || code === "0000";
}

// data.go.kr 표준 오류코드를 한국어 안내로 매핑.
function explainReason(code, msg) {
  const m = {
    "30": "등록되지 않은 서비스키입니다. 이 키가 ‘해양관측부이 최신 관측데이터’ 서비스에 활용신청·승인되어 있는지 확인하세요(키는 서비스별로 따로 승인됩니다).",
    "31": "서비스키 사용기한이 만료되었습니다.",
    "22": "요청 제한 횟수를 초과했습니다(일일 트래픽 초과).",
    "20": "서비스 접근이 거부되었습니다.",
    "21": "일시적으로 사용할 수 없는 서비스키입니다.",
    "32": "등록되지 않은 IP에서의 호출입니다.",
    "10": "잘못된 요청 파라미터입니다.",
    "11": "필수 요청 파라미터가 누락되었습니다.",
    "12": "해당 오픈API 서비스가 없거나 폐기되었습니다.",
  };
  return m[String(code)] || msg || `오류코드 ${code}`;
}

// 한 관측소의 최신 관측 1건을 돌려준다.
// reqDate(YYYYMMDD) 미지정 시 API 기본값(당일)을 사용한다.
export async function fetchBuoyLatest({
  serviceKey,
  obsCode,
  reqDate = "",
  min = 60,
  numOfRows = 300,
} = {}) {
  if (!serviceKey) throw new Error("data.go.kr 서비스 키가 없습니다. .env 의 VITE_DATAGO_KEY 를 확인하세요.");
  if (!obsCode) throw new Error("관측소 코드(obsCode)가 필요합니다.");

  const url = buildUrl({ serviceKey, obsCode, reqDate, min, numOfRows, pageNo: 1, type: "json" });
  // data.go.kr 게이트웨이는 키 오류를 HTTP 403/200 + 본문(returnReasonCode)으로
  // 돌려준다. 상태코드와 무관하게 본문을 먼저 읽어 실제 사유를 해석한다.
  const res = await fetch(url, { headers: { Accept: "*/*" } });
  const bodyText = await res.text().catch(() => "");

  let parsed;
  try {
    parsed = parseResponse(bodyText);
  } catch {
    // XML/JSON 이 아니면(WAF HTML 등) 상태코드로 안내.
    if (res.status === 403) {
      throw new Error(
        "HTTP 403 — 서비스키가 이 API에 등록/승인되지 않았을 가능성이 큽니다. data.go.kr에서 ‘해양관측부이 최신 관측데이터’ 활용신청 승인 여부와 키를 확인하세요.",
      );
    }
    throw new Error(`HTTP ${res.status} — ${bodyText.slice(0, 160) || "응답 본문 없음"}`);
  }

  if (!isOk(parsed.code)) {
    throw new Error(`API 오류 ${parsed.code}: ${explainReason(parsed.code, parsed.msg)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} — ${explainReason(parsed.code, parsed.msg)}`);
  }
  // 좌표가 유효한 관측 중 가장 최근(obsrvnDt 최대) 1건.
  const valid = parsed.items.filter(
    (it) => Number.isFinite(it.lat) && Number.isFinite(it.lon)
  );
  if (!valid.length) return { obsCode, item: null, count: parsed.items.length };
  valid.sort((a, b) => b.obsrvnDt.localeCompare(a.obsrvnDt));
  return { obsCode, item: valid[0], count: parsed.items.length };
}
