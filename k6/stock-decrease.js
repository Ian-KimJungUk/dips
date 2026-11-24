// 락 없는 재고 차감 API에 동시 요청을 보내 오버셀링을 재현·검증한다.
// 실행: docker compose run --rm k6 run /scripts/stock-decrease.js
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://app:3000';
const STOCK_ID = __ENV.STOCK_ID || '1';
const INITIAL = Number(__ENV.INITIAL || 100);
const REQUESTS = Number(__ENV.REQUESTS || 1000);
const STRATEGY = __ENV.STRATEGY || 'naive';

const params = { headers: { 'Content-Type': 'application/json' } };

const sold = new Counter('sold');
const rejected = new Counter('rejected');
const unexpected = new Counter('unexpected'); // 201/409 외 응답

// 409(재고 부족)는 정상 거절이므로 실패로 집계하지 않는다. 200은 setup/teardown의 PUT·GET용.
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    decrease: {
      executor: 'shared-iterations',
      vus: REQUESTS,
      iterations: REQUESTS,
    },
  },
  thresholds: {
    // 재고보다 많이 팔렸으면 실패 (오버셀링 감지)
    sold: [`count<=${INITIAL}`],
    unexpected: ['count==0'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const res = http.put(
    `${BASE_URL}/stocks/${STOCK_ID}`,
    JSON.stringify({ quantity: INITIAL }),
    params,
  );
  if (res.status !== 200) {
    throw new Error(`재고 세팅 실패: ${res.status} ${res.body}`);
  }
}

export default function () {
  const res = http.post(
    `${BASE_URL}/stocks/${STOCK_ID}/decrease`,
    JSON.stringify({ quantity: 1 }),
    params,
  );
  if (res.status === 201) sold.add(1);
  else if (res.status === 409) rejected.add(1);
  else unexpected.add(1);
}

export function teardown() {
  const { quantity } = http.get(`${BASE_URL}/stocks/${STOCK_ID}`).json();
  // 기대값: 요청이 재고보다 많으면 최종 재고 0
  const expected = Math.max(INITIAL - REQUESTS, 0);
  console.log(
    `[${STRATEGY}] 초기 ${INITIAL} / 요청 ${REQUESTS} / 최종 재고 ${quantity} (기대 ${expected}) ${
      quantity === expected ? 'PASS' : 'FAIL'
    }`,
  );
}

export function handleSummary(data) {
  const m = data.metrics;
  const soldCount = m.sold ? m.sold.values.count : 0;
  const rejectedCount = m.rejected ? m.rejected.values.count : 0;

  const result = {
    strategy: STRATEGY,
    initial: INITIAL,
    requests: REQUESTS,
    sold: soldCount,
    rejected: rejectedCount,
    oversold: Math.max(soldCount - INITIAL, 0),
    tps: m.http_reqs.values.rate,
    p95_ms: m.http_req_duration.values['p(95)'],
    failed_rate: m.http_req_failed.values.rate,
  };

  return {
    stdout:
      textSummary(data, { indent: ' ', enableColors: true }) +
      '\n\n' +
      JSON.stringify(result, null, 2) +
      '\n',
    [`/results/${STRATEGY}-${Date.now()}.json`]: JSON.stringify(
      result,
      null,
      2,
    ),
  };
}
