import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { loadSecrets } from './config/secrets-loader';
import { FeatureFlagsService } from './feature-flags/feature-flags.service';

async function bootstrap() {
  // Fase 8.1: debe correr ANTES de que se evalúe `AppModule`. OJO: no basta con
  // llamarlo antes de `NestFactory.create()`. `ConfigModule.forRoot({ validate })`
  // vive en los argumentos del decorador `@Module` de `ConfigModule`, así que se
  // ejecuta cuando Node IMPORTA ese archivo -- un `import { AppModule }` estático
  // arriba lo dispara antes de que `bootstrap()` corra y `validateEnv()` ve un
  // `process.env` sin los secretos de Infisical (Configuración de entorno inválida,
  // CrashLoopBackOff en el primer despliegue real, 2026-09-20). Por eso el import
  // es dinámico y va después. No-op si INFISICAL_ENABLED!='true'.
  await loadSecrets();
  const { AppModule } = await import('./app.module.js');

  const app = await NestFactory.create(AppModule);

  // Requerida por `JwtAuthGuard`/`extractWsToken` para leer la cookie
  // httpOnly `__Host-jin_session` (Fase 6.1) — sin esto `req.cookies` no
  // existe y el guard cae siempre al header `Authorization: Bearer`.
  app.use(cookieParser());

  // Feature flags en caliente (Fase 9.5, BLUEPRINT §12.3): SIGHUP
  // re-lee config/feature-flags.yaml sin redeploy. El operador lo
  // dispara con `kubectl exec deploy/jin-core -- kill -HUP 1` tras
  // actualizar el ConfigMap (ver Jin_Infra).
  const featureFlagsService = app.get(FeatureFlagsService);
  const logger = new Logger('SIGHUP');
  process.on('SIGHUP', () => {
    featureFlagsService.reload().catch((err: unknown) => {
      logger.error(`Falló el reload de feature flags: ${String(err)}`);
    });
  });

  const config = new DocumentBuilder()
    .setTitle('Jin Core API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // Movido de '/api' a '/docs' (Fase 6.1): BLUEPRINT 5.2 reserva '/api'
  // para la API de negocio real — hasta esta fase, Swagger era el único
  // ocupante de ese path.
  // `cleanupOpenApiDoc` (Fase 6.1.1) post-procesa los DTOs de
  // nestjs-zod: sin esto, cada `createZodDto` reutilizado en más de un
  // endpoint aparece duplicado con sufijos numéricos en el documento.
  SwaggerModule.setup('docs', app, cleanupOpenApiDoc(document));

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
