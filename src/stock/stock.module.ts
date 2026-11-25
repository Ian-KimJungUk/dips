import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsModule } from '../metrics/metrics.module.js';
import { StockController } from './stock.controller.js';
import { StockService } from './stock.service.js';
import { AtomicUpdateStrategy } from './strategies/atomic-update.strategy.js';
import { NaiveStrategy } from './strategies/naive.strategy.js';
import { OptimisticLockStrategy } from './strategies/optimistic-lock.strategy.js';
import { PessimisticLockStrategy } from './strategies/pessimistic-lock.strategy.js';
import {
  STOCK_STRATEGY,
  type StockStrategy,
} from './strategies/stock-strategy.js';

@Module({
  // OptimisticLockStrategy가 재시도·소진 카운터를 올린다
  imports: [MetricsModule],
  controllers: [StockController],
  providers: [
    StockService,
    NaiveStrategy,
    AtomicUpdateStrategy,
    PessimisticLockStrategy,
    OptimisticLockStrategy,
    {
      provide: STOCK_STRATEGY,
      inject: [
        ConfigService,
        NaiveStrategy,
        AtomicUpdateStrategy,
        PessimisticLockStrategy,
        OptimisticLockStrategy,
      ],
      useFactory: (config: ConfigService, ...strategies: StockStrategy[]) => {
        const name = config.get<string>('STOCK_STRATEGY') ?? 'naive';
        const strategy = strategies.find((s) => s.name === name);
        // 잘못된 값이 조용히 기본 전략으로 바뀌면 엉뚱한 전략을 측정하게 되므로 시작을 막는다
        if (!strategy) {
          throw new Error(
            `unknown STOCK_STRATEGY: ${name} (${strategies.map((s) => s.name).join(', ')})`,
          );
        }
        new Logger('StockModule').log(`stock strategy: ${strategy.name}`);
        return strategy;
      },
    },
  ],
})
export class StockModule {}
