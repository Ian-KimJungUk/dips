import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StockStrategy } from './stock-strategy.js';

@Injectable()
export class OptimisticLockStrategy implements StockStrategy {
  readonly name = 'optimistic-lock';
  private readonly maxRetries: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    // 재시도 상한이 결과를 좌우하므로 잘못된 값이 조용히 기본값으로 바뀌지 않게 시작을 막는다
    const raw = config.get<string>('STOCK_OPTIMISTIC_MAX_RETRIES') ?? '10';
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `invalid STOCK_OPTIMISTIC_MAX_RETRIES: ${raw} (0 이상의 정수)`,
      );
    }
    this.maxRetries = Number(raw);
    new Logger('OptimisticLockStrategy').log(
      `optimistic lock max retries: ${this.maxRetries}`,
    );
  }

  // 락 없이 읽은 version이 그대로일 때만 갱신한다. 그 사이 다른 요청이 먼저 바꿨으면 갱신 0건이므로 다시 읽어 재시도한다.
  // 트랜잭션 없이 시도마다 SELECT 1 + UPDATE 1. 백오프·지터 비교의 baseline이라 즉시 재시도한다.
  // version은 이 전략만 올린다. 전략은 기동 시 하나만 선택되므로 다른 전략이 version을 건드리지 않아도 된다.
  async decrease(id: number, quantity: number) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) this.metrics.optimisticRetries.inc();
      const stock = await this.prisma.stock.findUnique({ where: { id } });
      if (!stock) throw new NotFoundException(`stock ${id} not found`);
      if (stock.quantity < quantity) {
        throw new ConflictException(`not enough stock: ${stock.quantity}`);
      }
      const { count } = await this.prisma.stock.updateMany({
        where: { id, version: stock.version },
        data: {
          quantity: stock.quantity - quantity,
          version: { increment: 1 },
        },
      });
      // updateMany는 행을 돌려주지 않는다. version이 일치해 갱신됐으므로 결과 행은 읽은 값에서 계산할 수 있다
      if (count === 1) {
        return {
          ...stock,
          quantity: stock.quantity - quantity,
          version: stock.version + 1,
        };
      }
    }
    // 재고 부족(409)과 구분한다. 재고가 남아 있어도 경쟁 때문에 팔지 못한 것이므로 서버 측 실패(503)로 본다
    this.metrics.optimisticExhausted.inc();
    throw new ServiceUnavailableException('optimistic lock retries exhausted');
  }
}
