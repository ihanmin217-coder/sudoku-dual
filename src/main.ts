import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  // 1. NestJS 앱을 Express 기반으로 명시하여 생성합니다.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 2. 정적 파일(HTML, CSS, JS 등)이 모여있는 public 폴더를 서버에 연결합니다.
  app.useStaticAssets(join(__dirname, '..', 'public'));

  // 3. 3000번 포트에서 유저의 접속을 기다립니다.
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();