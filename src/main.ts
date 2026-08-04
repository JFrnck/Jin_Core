import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Requerida por `JwtAuthGuard`/`extractWsToken` para leer la cookie
  // httpOnly `__Host-jin_session` (Fase 6.1) — sin esto `req.cookies` no
  // existe y el guard cae siempre al header `Authorization: Bearer`.
  app.use(cookieParser());

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
