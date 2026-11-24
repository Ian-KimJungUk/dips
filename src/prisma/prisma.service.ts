import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  // 커넥션 풀 상태(사용 중/유휴/대기)를 메트릭으로 노출하려고 풀을 직접 만들어 넘긴다
  readonly pool: Pool;

  constructor(config: ConfigService) {
    const pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      // 동시성 전략 비교 결과를 좌우하므로 환경변수로 조정한다. 실제 적용값은 db_pool_max_connections로 확인
      max: Number(config.get<string>('DATABASE_POOL_MAX') ?? 10),
    });
    super({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
