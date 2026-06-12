# NetCDF 지도 뷰어 (React)

`.nc` 파일을 브라우저에서 업로드하면, 위경도 좌표를 가진 변수를 인터랙티브 지도 위에 표시합니다. GOCI-II L2(적조 지수 등)처럼 **그룹 구조를 가진 NetCDF-4(HDF5)** 파일을 지원합니다.

## 실행 방법

```bash
cd netcdf-map-viewer
npm install
npm run dev
```

터미널에 표시되는 주소(보통 http://localhost:5173)를 브라우저로 엽니다.

프로덕션 빌드:

```bash
npm run build    # dist/ 폴더 생성
npm run preview  # 빌드 결과 미리보기
```

## 기능

- **드래그&드롭 / 클릭 업로드** — `.nc`, `.nc4`, `.h5`, `.hdf5` (여러 개 가능)
- **타임랩스** — 여러 파일을 올리면 파일명의 `YYYYMMDD_HHMMSS`로 시간 정렬해 슬라이더+재생(▶/⏸, 2~15 fps). 모든 프레임이 **공유 색상 스케일**을 써서 시간에 따른 변화를 비교할 수 있습니다.
- **표현 프리셋** — 기본값은 `KHOA 기준`(선형 0–30 · jet)으로, NOSC/KHOA 미리보기와 동일한 색 스케일입니다. `자동`(데이터 기준 · 로그 · turbo)으로 전환하면 값 분포에 맞춰 대비를 키워 볼 수 있습니다.
- **변수 자동 탐지** — 2차원 변수 목록에서 선택, `latitude`/`longitude`를 좌표로 자동 인식
- **컬러맵** — Turbo / Viridis / Jet, **로그·선형** 전환, **투명도** 조절
- **마우스 호버 값 표시** — 해당 지점의 위경도와 변수 값
- 다크 베이스맵(CARTO) 위에 오버레이, 데이터 영역으로 자동 줌
- **줌·이동 제한** — 데이터 영역이 화면을 꽉 채우는 줌을 `minZoom`으로 고정하고 `maxBounds`로 영역 밖 이동을 막습니다. 타일은 `noWrap`으로 가로 반복을 끕니다.

## 메모리 / 성능

파일 하나는 순차적으로 읽고, 재격자한 격자만 메모리에 남기고 원본 배열은 즉시 해제합니다(`closeDoc`). 파일당 브라우저에서 약 2~5초가 걸리므로 한 달치(하루 1프레임 ≈ 30장)는 1~3분이면 처리됩니다. 수백 장 규모거나 고화질 영상이 필요하면 아래 오프라인 스크립트를 권장합니다.

## 오프라인 타임랩스 생성 (`tools/make_timelapse.py`)

폴더 안의 모든 `.nc`를 읽어 Web Mercator 프레임 PNG와, 실제 베이스맵 위에서 재생되는 `timelapse.html` 플레이어를 만듭니다. `imageio[ffmpeg]`가 설치돼 있으면 `timelapse.mp4`도 같이 만듭니다.

```bash
pip install netCDF4 numpy matplotlib pillow --break-system-packages
# (선택) mp4까지: pip install imageio imageio-ffmpeg --break-system-packages
python tools/make_timelapse.py /path/to/nc_folder -o out --var RI --fps 6
# 결과: out/timelapse.html (더블클릭), out/frames/*.png, out/timelapse.mp4
```

옵션: `--var`(변수명, 기본 RI), `--cmap`(turbo/viridis/jet), `--vmin/--vmax`(스케일 고정), `--linear`(로그 끄기), `--target`(격자 한 변 픽셀 수), `--fps`(mp4 프레임레이트).

## 동작 원리

1. `h5wasm`(HDF5의 WebAssembly 빌드)로 파일을 브라우저 메모리에서 직접 파싱합니다. 별도 서버가 필요 없습니다.
2. 곡선격자(2D lat/lon)를 최근접 비닝으로 재격자합니다. 이때 **세로 방향을 위도 등간격이 아니라 Web Mercator(EPSG:3857) Y 등간격**으로 둡니다. Leaflet `ImageOverlay`는 이미지를 재투영하지 않고 Mercator 모서리에 맞춰 늘리기 때문에, 등간격(EPSG:4326)으로 만들면 이 위도대(약 23~31°N)에서 최대 ~6km 북쪽으로 어긋나 해안 적조가 육지 위로 보입니다. Mercator Y 간격으로 격자화하면 베이스맵과 정확히 정합됩니다.
3. 재격자 결과를 `<canvas>`에 컬러매핑해 Leaflet `ImageOverlay`로 띄웁니다.
4. `_FillValue`, `scale_factor`, `add_offset`, `valid_min/max` 속성을 반영해 결측·범위 밖 값을 처리합니다.

## 구조

```
src/
  main.jsx           진입점
  App.jsx            UI + 지도 + 상태 관리 (react-leaflet)
  index.css          스타일
  lib/
    netcdf.js        h5wasm 파싱 · 재격자 · canvas 렌더링
    colormaps.js     Turbo/Viridis/Jet 컬러맵, 범례 그라데이션
```

## 참고 / 한계

- 좌표 변수 이름은 `lat`/`latitude`, `lon`/`longitude` 패턴으로 탐지합니다. 다른 이름이면 `src/lib/netcdf.js`의 `LAT_RE`/`LON_RE`를 수정하세요.
- 매우 큰 파일은 성능을 위해 소스 픽셀을 솎아내 재격자합니다(최대 약 400만 점). 최근접 비닝 특성상 격자 사이에 미세한 빈틈이 생길 수 있습니다.
- 1D 좌표(규칙 격자)만 있는 일반 NetCDF는 현재 2D 좌표 기준으로 처리합니다. 필요하면 1D 좌표 분기를 추가할 수 있습니다.
- 정확한 지리 정합이 중요하면 곡선격자 보간(예: 역거리 가중)이나 서버측 재투영(`xarray`+`pyresample`)을 고려하세요.
