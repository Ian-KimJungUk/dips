import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Stock } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StockStrategy } from './stock-strategy.js';

@Injectable()
export class PessimisticLockStrategy implements StockStrategy {
  readonly name = 'pessimistic-lock';

  constructor(private readonly prisma: PrismaService) {}

  // 트랜잭션 안에서 SELECT ... FOR UPDATE로 행을 먼저 잠그고 확인·차감한다.
  // 같은 행을 잠그려는 요청은 앞 트랜잭션이 커밋될 때까지 기다리므로, 확인과 저장 사이에 다른 요청이 끼어들 수 없다.
  async decrease(id: number, quantity: number) {
    return this.prisma.$transaction(
      async (tx) => {
        const [stock] = await tx.$queryRaw<Stock[]>`
          SELECT * FROM "Stock" WHERE id = ${id} FOR UPDATE`;
        if (!stock) throw new NotFoundException(`stock ${id} not found`);
        if (stock.quantity < quantity) {
          throw new ConflictException(`not enough stock: ${stock.quantity}`);
        }
        return tx.stock.update({
          where: { id },
          data: { quantity: stock.quantity - quantity },
        });
      },
      // 기본값(maxWait 2초, timeout 5초)이면 커넥션 풀과 행 락 앞에 줄 선 요청이
      // 트랜잭션 시작·완료 제한을 넘겨 5xx가 날 수 있어 일부러 넉넉히 준다.
      { maxWait: 30_000, timeout: 30_000 },
    );
  }
}
