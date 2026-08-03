import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: false,
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    // DbModule crea un pg.Pool (no conecta hasta la primera query) y
    // RedisThrottlerStorage usa `lazyConnect: true` (mismo criterio) —
    // basta con valores sintácticamente válidos para que ConfigModule no
    // falle al bootstrapear AppModule en este smoke test, sin tocar
    // Postgres/Redis reales.
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test_not_connected',
      REDIS_URL: 'redis://localhost:6379',
      OWNER_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$fake$fake',
      JWT_SECRET: 'e2e-test-secret-at-least-32-characters-long',
    },
  },
  plugins: [swc.vite()],
});
