import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service.js';

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const end = this.metrics.httpDuration.startTimer();
    res.on('finish', () => {
      // 실제 경로(/stocks/1) 대신 라우트 패턴(/stocks/:id)을 써서 라벨 수가 늘어나지 않게 한다
      const route = (req.route as { path?: string } | undefined)?.path;
      if (route === '/metrics') return; // Prometheus 스크레이프는 집계하지 않음
      end({
        method: req.method,
        route: route ?? 'unmatched',
        status_code: res.statusCode,
      });
    });
    next();
  }
}
