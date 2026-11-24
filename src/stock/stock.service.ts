import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

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

  // 락 없는 baseline: 조회 → JS에서 차감 → 저장.
  // 조회와 저장 사이에 다른 요청이 끼어들면 같은 재고를 여러 번 팔게 된다(오버셀링).
  // Prisma의 { decrement }는 원자적 UPDATE(quantity = quantity - n)라 경쟁 상태가 가려지므로 쓰지 않는다.
  async decrease(id: number, quantity: number) {
    const stock = await this.get(id);
    if (stock.quantity < quantity) {
      throw new ConflictException(`not enough stock: ${stock.quantity}`);
    }
    return this.prisma.stock.update({
      where: { id },
      data: { quantity: stock.quantity - quantity },
    });
  }
}
