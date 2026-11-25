import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class MetricsService {
  // 전역 레지스트리 대신 인스턴스별로 둬서, 테스트에서 앱을 여러 번 띄워도 중복 등록 에러가 나지 않게 한다
  readonly registry = new Registry();

  // 요청 수·에러율은 이 히스토그램의 _count를 status_code별로 집계해서 구한다
  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP 요청 처리 시간',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  // optimistic-lock 전략: version 충돌로 다시 시도한 횟수와 상한을 넘겨 503으로 끝난 횟수
  readonly optimisticRetries = new Counter({
    name: 'stock_optimistic_retries_total',
    help: 'optimistic-lock 전략의 재시도 횟수 합',
    registers: [this.registry],
  });

  readonly optimisticExhausted = new Counter({
    name: 'stock_optimistic_exhausted_total',
    help: 'optimistic-lock 전략에서 재시도 상한을 넘긴 횟수 합',
    registers: [this.registry],
  });

  // redis-lua 전략: 플러셔가 Redis 현재값을 DB에 덮어쓴 UPDATE 횟수
  readonly stockRedisFlushWrites = new Counter({
    name: 'stock_redis_flush_writes_total',
    help: 'redis-lua 전략의 플러시로 DB에 쓴 UPDATE 횟수 합',
    registers: [this.registry],
  });

  constructor(prisma: PrismaService) {
    collectDefaultMetrics({ register: this.registry });

    const { pool } = prisma;
    new Gauge({
      name: 'db_pool_connections',
      help: 'DB 커넥션 풀의 커넥션 수 (active: 쿼리 실행 중, idle: 유휴)',
      labelNames: ['state'] as const,
      registers: [this.registry],
      collect() {
        this.set({ state: 'active' }, pool.totalCount - pool.idleCount);
        this.set({ state: 'idle' }, pool.idleCount);
      },
    });
    new Gauge({
      name: 'db_pool_waiting_requests',
      help: '커넥션을 얻지 못해 풀에서 대기 중인 요청 수',
      registers: [this.registry],
      collect() {
        this.set(pool.waitingCount);
      },
    });
    new Gauge({
      name: 'db_pool_max_connections',
      help: 'DB 커넥션 풀 최대 크기',
      registers: [this.registry],
      collect() {
        this.set(pool.options.max);
      },
    });
  }
}
