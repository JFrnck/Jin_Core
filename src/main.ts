import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { loadSecrets } from './config/secrets-loader';
import { FeatureFlagsService } from './feature-flags/feature-flags.service';

async function bootstrap() {
  // Fase 8.1: debe correr ANTES de crear la app — `ConfigModule.forRoot`
  // (dentro de AppModule) lee `process.env` en ese momento, así que
  // `validateEnv()` ve los secretos de Infisical ya inyectados sin que
  // el schema sepa de dónde vinieron. No-op si INFISICAL_ENABLED!='true'.
  await loadSecrets();

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
