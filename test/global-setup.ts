import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

// e2e 테스트 전체에서 한 번만 Postgres/Redis 컨테이너를 띄우고 끝나면 정리한다.
export default async function setup() {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:18-alpine').start(),
    new RedisContainer('redis:8-alpine').start(),
  ]);

  process.env.DATABASE_URL = postgres.getConnectionUri();
  process.env.REDIS_URL = redis.getConnectionUrl();

  execSync('pnpm prisma migrate deploy', { stdio: 'inherit' });

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
