import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Stock } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StockStrategy } from './stock-strategy.js';

@Injectable()
export class AtomicUpdateStrategy implements StockStrategy {
  readonly name = 'atomic-update';

  constructor(private readonly prisma: PrismaService) {}

  // 재고 확인과 차감을 UPDATE 한 문장으로 처리한다. 같은 행을 갱신하려는 요청은
  // Postgres 행 락으로 줄을 서고, 앞 요청이 커밋된 값으로 WHERE를 다시 평가하므로 오버셀링이 없다.
  // 측정 대상 SQL이 코드에 그대로 보이도록 Prisma의 { decrement } 대신 raw 쿼리를 쓴다.
  async decrease(id: number, quantity: number) {
    const [stock] = await this.prisma.$queryRaw<Stock[]>`
      UPDATE "Stock" SET quantity = quantity - ${quantity}
      WHERE id = ${id} AND quantity >= ${quantity}
      RETURNING *`;
    if (stock) return stock;

    // 갱신된 행이 없으면 재고 부족(409)인지 없는 재고(404)인지 구분한다. 거절 경로에서만 쿼리가 하나 더 나간다.
    const current = await this.prisma.stock.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`stock ${id} not found`);
    throw new ConflictException(`not enough stock: ${current.quantity}`);
  }
}
