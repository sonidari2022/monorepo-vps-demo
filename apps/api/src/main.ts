import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const port = process.env.PORT || 3091;
  await app.listen(port);
  console.log(`🚀 NestJS API con Prisma corriendo en puerto ${port}`);
}
bootstrap();
