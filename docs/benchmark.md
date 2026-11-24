# 재고 차감 동시성 벤치마크

재고 100개에 차감 요청 1000건을 동시에 보내, 동시성 제어 전략별로 정합성(오버셀링)과 성능을 비교한다.

## 시나리오

- 스크립트: `k6/stock-decrease.js` (`pnpm k6:stock`)
- executor: `shared-iterations`, VU 1000명, 반복 1000회 (VU당 1건)
- 요청: `POST /stocks/1/decrease` `{ "quantity": 1 }`
- 초기 재고 100 (setup에서 `PUT /stocks/1`로 매 실행마다 초기화)
- 판정: `sold > 100`이면 오버셀링 (threshold `sold: count<=100`)
- 결과 JSON: `k6/results/<strategy>-<timestamp>.json`

## 모니터링

부하 테스트 중 병목을 보려면 Prometheus + Grafana를 함께 띄운다.

```bash
pnpm dev          # app, postgres, redis
pnpm monitoring   # prometheus(:9090), grafana(:3001)
pnpm k6:stock
```

- Grafana: http://localhost:3001 (로그인 없음, 홈이 `dips app` 대시보드)
- 앱 메트릭: http://localhost:3000/metrics (Prometheus가 1초마다 수집)

| 패널 | 메트릭 | 볼 것 |
|---|---|---|
| 요청 수 | `http_request_duration_seconds_count` | 라우트·상태코드별 req/s |
| 응답시간 | `http_request_duration_seconds_bucket` | p50/p95/p99 |
| 에러율 | 위 count 중 `status_code=~"5.."` 비율 | 409(재고 부족)는 정상 거절이라 제외 |
| DB 커넥션 풀 | `db_pool_connections{state}`, `db_pool_waiting_requests`, `db_pool_max_connections` | active가 max에 붙고 waiting이 쌓이면 풀이 병목 |
| 이벤트 루프 지연 / CPU | `nodejs_eventloop_lag_p99_seconds`, `process_cpu_seconds_total` | 앱 프로세스 자체가 포화인지 |

모니터링 컨테이너도 같은 Docker VM 자원을 쓰므로, 수치 비교용 측정은 기존처럼 모니터링 없이 돌리고 병목 관찰용 실행과 구분한다.

## 실행 환경

| 항목 | 값 |
|---|---|
| CPU | AMD Ryzen 5 4500U (6코어 6스레드) |
| 메모리 | 11.4 GB |
| OS | Windows 11 Home |
| Docker | Docker Desktop 29.9.3 (WSL2, 커널 6.6.87.2) |
| Docker VM 자원 | vCPU 4개, 메모리 5.8 GB |
| 컨테이너 자원 제한 | 없음 (app, postgres, redis, k6가 VM 자원을 공유) |
| 앱 | NestJS 12, Node 26.13.1, `pnpm start:dev` (watch 모드) |
| DB | PostgreSQL 18.4 (alpine), `max_connections` 100 |
| ORM / 드라이버 | Prisma 7.10.1 + `@prisma/adapter-pg` (pg 8.23.1) |
| DB 커넥션 풀 | **10** (pg-pool 기본값 `max: 10`, 별도 설정 없음) |
| k6 | grafana/k6 1.3.0 (같은 Docker 네트워크에서 `http://app:3000`으로 호출) |

**주의**
- 부하 발생기(k6)와 앱, DB가 같은 VM에서 CPU를 나눠 쓴다. 절대 수치보다는 전략 간 상대 비교용으로 본다.
- 앱이 dev 모드(`start:dev`)로 실행된다. 프로덕션 빌드보다 느릴 수 있다.

## 결과: naive (락 없음)

조회 → JS에서 차감 → 저장 (`src/stock/stock.service.ts`의 `decrease`)

| 회차 | 결과 파일 | 판매(sold) | 거절(rejected) | 오버셀링 | TPS | p95 (ms) | 실패율 |
|---|---|---|---|---|---|---|---|
| 1 | `naive-1795485730558.json` | 1000 | 0 | 900 | 204.5 | 3336.9 | 0 |
| 2 | `naive-1795485795635.json` | 1000 | 0 | 900 | 300.7 | 2712.5 | 0 |
| 3 | `naive-1795485830638.json` | 1000 | 0 | 900 | 304.9 | 2607.0 | 0 |
| **평균** | | **1000** | **0** | **900** | **270.0** | **2885.5** | **0** |

- 측정일: 2026-11-24, 커밋 `7fbb52e` (`feat/stock-no-lock`)

<details>
<summary>원본 JSON</summary>

`naive-1795485730558.json`
```json
{
  "strategy": "naive",
  "initial": 100,
  "requests": 1000,
  "sold": 1000,
  "rejected": 0,
  "oversold": 900,
  "tps": 204.534048195427,
  "p95_ms": 3336.8788901499997,
  "failed_rate": 0
}
```

`naive-1795485795635.json`
```json
{
  "strategy": "naive",
  "initial": 100,
  "requests": 1000,
  "sold": 1000,
  "rejected": 0,
  "oversold": 900,
  "tps": 300.705273969505,
  "p95_ms": 2712.4939327,
  "failed_rate": 0
}
```

`naive-1795485830638.json`
```json
{
  "strategy": "naive",
  "initial": 100,
  "requests": 1000,
  "sold": 1000,
  "rejected": 0,
  "oversold": 900,
  "tps": 304.8969081630825,
  "p95_ms": 2606.989388,
  "failed_rate": 0
}
```

</details>

### 해석

- 3회 모두 1000건이 전부 판매되어 **오버셀링 900건**이 났다. 409(재고 부족)는 한 건도 없었다.
- 여러 요청이 같은 재고 값을 읽고 덮어써서(lost update) 재고가 0까지 내려가지 않는다. 그래서 거절이 생기지 않는다.
  - 최종 재고만 보면 오버셀링을 놓친다. 판매 건수(`sold`)로 판정해야 한다.
- p95 약 2.9초의 대부분은 커넥션 풀(10개) 대기 시간으로 보인다. 요청 1000건이 커넥션 10개를 기다리며 줄을 선다.
- 1회차 TPS(204.5)가 2·3회차(약 300)보다 낮다. 첫 실행의 워밍업 영향으로 추정한다.
