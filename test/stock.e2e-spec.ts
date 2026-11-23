import { Agent } from 'node:http';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const INITIAL = 100;
const REQUESTS = Number(process.env.REQUESTS ?? 1000);

describe('StockController (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
  });

  // 락 없는 baseline: 오버셀링 여부는 타이밍에 따라 달라지므로 단언하지 않고 결과만 출력한다
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
    const { quantity } = await prisma.stock.findUniqueOrThrow({
      where: { id },
    });
    console.log(
      `[no-lock] 초기 재고 ${INITIAL} / 판매 ${sold} / 거절 ${rejected} / 최종 재고 ${quantity} / 오버셀링 ${sold - INITIAL}건`,
    );

    expect(sold + rejected).toBe(REQUESTS);
    agent.destroy();
  });
});
