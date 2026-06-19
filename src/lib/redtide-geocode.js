// Approximate geocoding for NIFS red-tide "조사해역" (survey area) strings.
//
// The API returns areas as free text (e.g. "전남 완도군 금일 해역"), not
// coordinates. Red tide is a 남해안(south-coast) phenomenon, so a small lookup
// of the relevant 시·군 plus a few well-known islands/bays is enough to drop an
// approximate marker. Accuracy is 시·군 level — good enough to show "where",
// not an exact bloom outline.

// Detailed spots (islands, bays) — matched FIRST so a specific place wins over
// the broader 시·군 it sits in.
const SPOTS = {
  거금도: [34.50, 127.25], 거금: [34.50, 127.25], 소록도: [34.52, 127.13],
  백야도: [34.62, 127.65], 득량만: [34.62, 127.05], 여자만: [34.78, 127.45],
  가막만: [34.68, 127.70], 광양만: [34.90, 127.75], 진해만: [35.05, 128.60],
  청산도: [34.17, 126.86], 금일: [34.30, 127.05], 노도: [34.78, 127.94],
  외나로도: [34.47, 127.45], 나로도: [34.50, 127.45], 돌산: [34.66, 127.74],
};

// 시·군 fallback (longest key matched first within each tier).
const SIGUN = {
  신안: [34.70, 126.10], 진도: [34.49, 126.26], 완도: [34.31, 126.76],
  해남: [34.57, 126.60], 강진: [34.64, 126.77], 장흥: [34.62, 126.95],
  보성: [34.77, 127.08], 고흥: [34.61, 127.28], 여수: [34.74, 127.66],
  광양: [34.94, 127.70], 목포: [34.79, 126.39],
  남해: [34.84, 127.89], 하동: [34.92, 127.85], 사천: [34.93, 128.07],
  통영: [34.85, 128.43], 거제: [34.88, 128.62], 고성: [34.97, 128.32],
  창원: [35.10, 128.57], 마산: [35.10, 128.57], 진해: [35.13, 128.70],
  부산: [35.10, 129.03], 울산: [35.50, 129.38], 포항: [36.04, 129.40],
};

// Pre-sort keys by length (desc) so longer, more specific names match first.
const byLenDesc = (table) =>
  Object.keys(table).sort((a, b) => b.length - a.length);
const SPOT_KEYS = byLenDesc(SPOTS);
const SIGUN_KEYS = byLenDesc(SIGUN);

const findIn = (table, keys, area) => {
  const key = keys.find((k) => area.includes(k));
  return key ? { lat: table[key][0], lon: table[key][1], matched: key } : null;
};

// Resolve a survey-area string to { lat, lon, matched } or null if no known
// place name is found.
export function geocodeArea(oarea) {
  if (!oarea) return null;
  const area = String(oarea);
  return findIn(SPOTS, SPOT_KEYS, area) || findIn(SIGUN, SIGUN_KEYS, area);
}
