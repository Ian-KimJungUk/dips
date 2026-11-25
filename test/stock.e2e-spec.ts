import { Agent } from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AtomicUpdateStrategy } from './../src/stock/strategies/atomic-update.strategy.js';
import { NaiveStrategy } from './../src/stock/strategies/naive.strategy.js';
import { OptimisticLockStrategy } from './../src/stock/strategies/optimistic-lock.strategy.js';
import { PessimisticLockStrategy } from './../src/stock/strategies/pessimistic-lock.strategy.js';
import { RedisLuaStrategy } from './../src/stock/strategies/redis-lua.strategy.js';
import {
  STOCK_STRATEGY,
  type StockStrategy,
} from './../src/stock/strategies/stock-strategy.js';

const INITIAL = 100;
const REQUESTS = Number(process.env.REQUESTS ?? 1000);

// baseline: 결과만 출력 / exact: 재고만큼 정확히 판매 /
// no-oversell: 재시도 소진(503)으로 재고가 남을 수 있으므로 오버셀링이 없고 응답 수와 재고가 맞는지만 본다 /
// redis: 재고만큼 정확히 판매하고, DB는 비동기로 반영되므로 일정 시간 안에 수렴하는지 본다
describe.each<{
  label: string;
  strategy: Type<StockStrategy>;
  mode: 'baseline' | 'exact' | 'no-oversell' | 'redis';
  maxRetries?: string;
}>([
  // 락 없는 baseline: 오버셀링 여부는 타이밍에 따라 달라지므로 단언하지 않고 결과만 출력한다
  { label: 'NaiveStrategy', strategy: NaiveStrategy, mode: 'baseline' },
  {
    label: 'AtomicUpdateStrategy',
    strategy: AtomicUpdateStrategy,
    mode: 'exact',
  },
  {
    label: 'PessimisticLockStrategy',
    strategy: PessimisticLockStrategy,
    mode: 'exact',
  },
  {
    label: 'OptimisticLockStrategy',
    strategy: OptimisticLockStrategy,
    mode: 'no-oversell',
  },
  // 상한을 낮춰 소진(503)이 나기 쉬운 상황에서도 불변식이 유지되는지 본다. 503 건수는 타이밍에 달려 있어 단언하지 않는다
  {
    label: 'OptimisticLockStrategy (재시도 상한 1)',
    strategy: OptimisticLockStrategy,
    mode: 'no-oversell',
    maxRetries: '1',
  },
  { label: 'RedisLuaStrategy', strategy: RedisLuaStrategy, mode: 'redis' },
])('StockController (e2e) - $label', ({ strategy, mode, maxRetries }) => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    // 전략 생성자가 ConfigService로 읽으므로 모듈을 만들기 전에 넣는다
    if (maxRetries) process.env.STOCK_OPTIMISTIC_MAX_RETRIES = maxRetries;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STOCK_STRATEGY)
      .useClass(strategy)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    // supertest가 요청마다 서버를 열고 닫지 않도록 한 번만 listen
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    if (maxRetries) delete process.env.STOCK_OPTIMISTIC_MAX_RETRIES;
  });

  it(`재고 ${INITIAL}개에 ${REQUESTS}건 동시 차감`, async () => {
    const { id } = await prisma.stock.create({ data: { quantity: INITIAL } });
    const url = await app.getUrl();
    // 동시 연결 수가 listen backlog(Windows는 약 200)를 넘으면 ECONNREFUSED가 나므로 소켓을 재사용한다
    const agent = new Agent({ keepAlive: true, maxSockets: 100 });

    const responses = await Promise.all(
      Array.from({ length: REQUESTS }, () =>
        request(url)
          .post(`/stocks/${id}/decrease`)
          .agent(agent)
          .send({ quantity: 1 }),
      ),
    );

    const sold = responses.filter((r) => r.status === 201).length;
    const rejected = responses.filter((r) => r.status === 409).length;
    const exhausted = responses.filter((r) => r.status === 503);
    const { quantity } = await prisma.stock.findUniqueOrThrow({
      where: { id },
    });
    console.log(
      `[${app.get<StockStrategy>(STOCK_STRATEGY).name}${maxRetries ? ` 재시도 상한 ${maxRetries}` : ''}] 초기 재고 ${INITIAL} / 판매 ${sold} / 거절 ${rejected} / 소진 ${exhausted.length} / 최종 재고 ${quantity} / 오버셀링 ${sold - INITIAL}건`,
    );

    if (mode === 'no-oversell') {
      // 201·409·503 외 상태 코드(500 등)가 있으면 합이 맞지 않아 실패한다
      expect(sold + rejected + exhausted.length).toBe(REQUESTS);
      expect(sold).toBeLessThanOrEqual(INITIAL);
      expect(quantity).toBe(INITIAL - sold);
      for (const r of exhausted) {
        expect((r.body as { message: string }).message).toBe(
          'optimistic lock retries exhausted',
        );
      }
    } else {
      expect(sold + rejected).toBe(REQUESTS);
    }
    if (mode === 'exact') {
      expect(sold).toBe(Math.min(INITIAL, REQUESTS));
      expect(quantity).toBe(Math.max(INITIAL - REQUESTS, 0));
    }
    if (mode === 'redis') {
      const expected = Math.max(INITIAL - REQUESTS, 0);
      expect(sold).toBe(Math.min(INITIAL, REQUESTS));
      expect(rejected).toBe(Math.max(REQUESTS - INITIAL, 0));
      const live = await request(url).get(`/stocks/${id}`).expect(200);
      expect((live.body as { quantity: number }).quantity).toBe(expected);
      // 강제 플러시 없이 플러셔가 실제로 DB를 따라잡는지 본다 (100ms 간격, 최대 5초)
      let dbQuantity: number | undefined;
      for (let i = 0; i < 50; i++) {
        ({ quantity: dbQuantity } = await prisma.stock.findUniqueOrThrow({
          where: { id },
        }));
        if (dbQuantity === expected) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(dbQuantity).toBe(expected);
    }
    agent.destroy();
    // 기본 5초는 naive·pessimistic-lock도 경계(4~5초)이고, optimistic-lock은 재시도로 쿼리가 늘어 넘긴다
  }, 60_000);

  it('없는 재고를 차감하면 404', async () => {
    // Int 최대값이라 시퀀스로 만들어진 id와 겹치지 않는다
    const res = await request(app.getHttpServer())
      .post('/stocks/2147483647/decrease')
      .send({ quantity: 1 });

    expect(res.status).toBe(404);
  });

  it.runIf(mode === 'redis')(
    'PUT으로 재고를 다시 맞추면 이후 차감은 새 값 기준',
    async () => {
      const { id } = await prisma.stock.create({ data: { quantity: INITIAL } });
      const server = app.getHttpServer();
      // 한 번 차감해 Redis 키를 올려 둔다 (INITIAL - 1)
      await request(server)
        .post(`/stocks/${id}/decrease`)
        .send({ quantity: 1 })
        .expect(201);

      await request(server)
        .put(`/stocks/${id}`)
        .send({ quantity: 5 })
        .expect(200);

      // 낡은 키(99)가 남아 있으면 6개 차감이 성공한다
      const over = await request(server)
        .post(`/stocks/${id}/decrease`)
        .send({ quantity: 6 })
        .expect(409);
      expect((over.body as { message: string }).message).toBe(
        'not enough stock: 5',
      );
      const ok = await request(server)
        .post(`/stocks/${id}/decrease`)
        .send({ quantity: 5 })
        .expect(201);
      expect(ok.body).toEqual({ id, quantity: 0 });
    },
  );
});
