#!/usr/bin/env python3
"""NOSC 위성NetCDF정보 API 요청/응답 점검 (서버 사이드).

브라우저는 NOSC WAF에 막히므로, 이 스크립트를 터미널에서 실행해 API가 실제로
동작하는지 확인한다. 두 호스트(http://nosc.go.kr, https://www.nosc.go.kr)를
모두 시험하고 상태코드/콘텐츠타입/본문 요약을 출력한다.

사용:
  python tools/check_nosc.py --key <ServiceKey> \
      --start 20211221 --end 20211222 --slot 2 --product RI
  # 키를 환경변수로:  export NOSC_KEY=...; python tools/check_nosc.py
"""
import argparse, json, os, sys, urllib.parse, urllib.request

# http://nosc.go.kr 는 301로 https://nosc.go.kr (www 없음)로 리다이렉트된다.
# urllib 은 리다이렉트를 자동으로 따라간다. 정규 호스트를 먼저 시험한다.
HOSTS = ["https://nosc.go.kr", "https://www.nosc.go.kr"]
PATH = "/openapi/GK2BNcMedia/search.do"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9",
}


def try_host(host, params):
    url = f"{host}{PATH}?{urllib.parse.urlencode(params)}"
    print(f"\n=== {host} ===")
    print("URL:", url.replace(params['ServiceKey'], "<KEY>"))
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            status, ctype, body = r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:
        status, ctype, body = e.code, e.headers.get("Content-Type", ""), e.read()
    except Exception as e:
        print("요청 실패:", e); return False
    text = body.decode("utf-8", "replace")
    print(f"HTTP {status} | Content-Type: {ctype}")
    looks_html = "<html" in text.lower() or "<body" in text.lower()
    if status == 200 and not looks_html:
        try:
            data = json.loads(text)
            print("✅ JSON 응답 OK")
            print(json.dumps(data, ensure_ascii=False, indent=2)[:1200])
            return True
        except json.JSONDecodeError:
            print("⚠️ 200이지만 JSON 아님. 본문 일부:"); print(text[:500]); return False
    print("❌ 비정상(차단/오류로 보임). 본문 일부:")
    print(text[:500].replace("\n", " "))
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default=os.environ.get("NOSC_KEY", ""))
    ap.add_argument("--start", default="20211221")
    ap.add_argument("--end", default="20211222")
    ap.add_argument("--slot", default="2")
    ap.add_argument("--product", default="")  # 빈값이면 전체 산출물
    args = ap.parse_args()
    if not args.key:
        sys.exit("ServiceKey 필요: --key <키> 또는 NOSC_KEY 환경변수")
    params = {"ServiceKey": args.key, "startDate": args.start,
              "endDate": args.end, "slot": args.slot, "ResultType": "json"}
    ok = False
    for host in HOSTS:
        if try_host(host, params):
            ok = True
            print(f"\n→ 이 호스트가 동작합니다: {host}")
            break
    if not ok:
        print("\n두 호스트 모두 정상 JSON을 주지 않았습니다. 위 본문(차단 페이지/오류 메시지)을 확인하세요.")


if __name__ == "__main__":
    main()
