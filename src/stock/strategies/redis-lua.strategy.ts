import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { MetricsService } from '../../metrics/metrics.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StockStrategy } from './stock-strategy.js';

// 재고 확인과 차감을 한 스크립트로 실행한다. Redis는 스크립트를 하나씩 실행하므로 그 사이에 다른 차감이 끼어들 수 없다.
// 반환: {-1, 0} 키 없음 / {0, 현재재고} 재고 부족 / {1, 차감 후 재고} 성공
const DECREASE_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then return {-1, 0} end
local current = tonumber(v)
local n = tonumber(ARGV[1])
if current < n then return {0, current} end
return {1, redis.call('DECRBY', KEYS[1], n)}
`;

type RedisWithStock = Redis & {
  decreaseStock(key: string, quantity: number): Promise<[number, number]>;
};

const key = (id: number) => `stock:${id}`;

@Injectable()
export class RedisLuaStrategy implements StockStrategy, OnModuleDestroy {
  readonly name = 'redis-lua';
  private readonly logger = new Logger(RedisLuaStrategy.name);
  private readonly redis: RedisWithStock;
  private readonly flushIntervalMs: number;
  private readonly dirty = new Set<number>();
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    // 반영 주기가 DB 지연과 쓰기 횟수를 좌우하므로 잘못된 값이 조용히 기본값으로 바뀌지 않게 시작을 막는다
    const raw = config.get<string>('STOCK_REDIS_FLUSH_INTERVAL_MS') ?? '100';
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new Error(
        `invalid STOCK_REDIS_FLUSH_INTERVAL_MS: ${raw} (양의 정수)`,
      );
    }
    this.flushIntervalMs = Number(raw);

    // 모든 전략이 시작 시 생성되므로, 다른 전략으로 띄울 때 Redis에 붙지 않도록 첫 사용 때 연결한다
    const redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    // 연결 실패는 요청 응답(503)으로 드러나므로 재연결마다 찍히는 Unhandled error 로그는 막는다
    redis.on('error', () => {});
    redis.defineCommand('decreaseStock', {
      numberOfKeys: 1,
      lua: DECREASE_LUA,
    });
    this.redis = redis as RedisWithStock;
  }

  // Redis를 재고의 기준으로 쓰고 DB에는 인터벌마다 현재값을 덮어쓴다(write-behind)
  async decrease(id: number, quantity: number) {
    let [status, current] = await this.cache(() =>
      this.redis.decreaseStock(key(id), quantity),
    );
    if (status === -1) {
      // 키가 없으면 DB 값으로 한 번만 올린다. NX라 동시에 올리려는 요청 중 하나만 쓰고, 이미 차감된 값을 덮지 않는다
      const stock = await this.prisma.stock.findUnique({ where: { id } });
      if (!stock) throw new NotFoundException(`stock ${id} not found`);
      await this.cache(() => this.redis.set(key(id), stock.quantity, 'NX'));
      [status, current] = await this.cache(() =>
        this.redis.decreaseStock(key(id), quantity),
      );
    }
    if (status === 1) {
      this.markDirty(id);
      return { id, quantity: current };
    }
    if (status === 0) {
      throw new ConflictException(`not enough stock: ${current}`);
    }
    // 올린 직후 키가 다시 사라졌다(외부에서 삭제 등). 재시도는 한 번뿐이므로 캐시 이상으로 본다
    throw new ServiceUnavailableException('stock cache unavailable');
  }

  // 재고 재설정 시 낡은 Redis 값이 남아 이후 차감이 옛 값 기준으로 동작하지 않게 덮어쓴다.
  // 진행 중인 플러시가 재설정 전 값을 DB에 덮어쓸 수 있으므로 dirty로 표시해 다음 틱에 다시 맞춘다
  async reset(id: number, quantity: number) {
    await this.cache(() => this.redis.set(key(id), quantity));
    this.markDirty(id);
  }

  // DB는 플러시 전까지 뒤처지므로 조회는 Redis 값을 기준으로 한다
  async liveQuantity(id: number) {
    const value = await this.cache(() => this.redis.get(key(id)));
    return value === null ? null : Number(value);
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.flushing;
    await this.flush();
    // 한 번도 연결하지 않았으면 quit()이 연결부터 시도하므로 바로 끊는다
    if (this.redis.status === 'wait') this.redis.disconnect();
    else await this.redis.quit();
  }

  // Redis 오류 시 DB로 폴백하지 않는다. Redis에서 이미 차감된 수량이 DB에는 아직 없어서,
  // 두 저장소를 섞어 차감하면 같은 재고를 두 번 팔 수 있다(오버셀링).
  private async cache<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new ServiceUnavailableException('stock cache unavailable', {
        cause: err,
      });
    }
  }

  private markDirty(id: number) {
    this.dirty.add(id);
    // 다른 전략으로 띄웠을 때 타이머가 돌지 않도록 첫 차감 때 시작한다
    this.timer ??= setInterval(() => {
      // 이전 플러시가 끝나지 않았으면 겹치지 않게 이번 틱은 건너뛴다
      if (!this.flushing) void this.flush();
    }, this.flushIntervalMs);
  }

  private flush() {
    this.flushing = this.flushDirty().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  // 읽기 전에 dirty를 먼저 비워서, 읽은 뒤에 들어온 차감이 dirty를 다시 켜 다음 틱에 반영되게 한다.
  // 차감량이 아니라 Redis 현재값을 그대로 쓰므로 같은 값을 여러 번 써도 결과가 같다(멱등).
  private async flushDirty() {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      try {
        const value = await this.redis.get(key(id));
        if (value === null) continue;
        await this.prisma.$executeRaw`
          UPDATE "Stock" SET quantity = ${Number(value)} WHERE id = ${id}`;
        this.metrics.stockRedisFlushWrites.inc();
      } catch (err) {
        this.dirty.add(id);
        this.logger.error(`stock ${id} flush failed`, err);
      }
    }
  }
}
