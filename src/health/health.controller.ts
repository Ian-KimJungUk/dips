import {
  Controller,
  Get,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';

// 배포 헬스체크용: DB와 Redis에 실제로 붙는지 확인하고, 하나라도 실패하면 503
@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      commandTimeout: 1000,
      maxRetriesPerRequest: 1,
    });
    // 연결 실패는 /health 응답(503)으로 드러나므로, 재연결마다 찍히는 Unhandled error 로그는 막음
    this.redis.on('error', () => {});
  }

  @Get()
  async check() {
    const [db, redis] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
    ]);
    const result = {
      db: db.status === 'fulfilled' ? 'up' : 'down',
      redis: redis.status === 'fulfilled' ? 'up' : 'down',
    };
    if (result.db === 'down' || result.redis === 'down') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
