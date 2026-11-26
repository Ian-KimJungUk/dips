import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS } from '../redis/redis.module.js';

// DB와 Redis에 실제로 붙는지 확인하고, 하나라도 실패하면 503
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

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
}
