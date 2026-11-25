import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  STOCK_STRATEGY,
  type StockStrategy,
} from './strategies/stock-strategy.js';

@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STOCK_STRATEGY) private readonly strategy: StockStrategy,
  ) {}

  async get(id: number) {
    const stock = await this.prisma.stock.findUnique({ where: { id } });
    if (!stock) throw new NotFoundException(`stock ${id} not found`);
    return stock;
  }

  // 부하 테스트 세팅용: 재고를 지정한 값으로 맞춘다(없으면 생성)
  set(id: number, quantity: number) {
    return this.prisma.stock.upsert({
      where: { id },
      create: { id, quantity },
      update: { quantity },
    });
  }

  // 동시성 제어 방식은 STOCK_STRATEGY 환경변수로 고른 전략에 맡긴다 (stock.module.ts)
  decrease(id: number, quantity: number) {
    return this.strategy.decrease(id, quantity);
  }
}
