import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { HealthController } from './health.controller.js';

const ping = vi.fn();
vi.mock('ioredis', () => ({
  Redis: class {
    ping = ping;
    disconnect = vi.fn();
    on = vi.fn();
  },
}));

describe('HealthController', () => {
  const queryRaw = vi.fn();
  let controller: HealthController;

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    ping.mockReset().mockResolvedValue('PONG');
    controller = new HealthController(
      { $queryRaw: queryRaw } as unknown as PrismaService,
      { getOrThrow: () => 'redis://test' } as unknown as ConfigService,
    );
  });

  it('DB와 Redis가 모두 정상이면 up을 반환한다', async () => {
    await expect(controller.check()).resolves.toEqual({
      db: 'up',
      redis: 'up',
    });
  });

  it('DB가 실패하면 503을 던진다', async () => {
    queryRaw.mockRejectedValue(new Error('db down'));
    await expect(controller.check()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('Redis가 실패하면 503을 던진다', async () => {
    ping.mockRejectedValue(new Error('redis down'));
    await expect(controller.check()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
