import { Module } from '@nestjs/common';
import { GameModule } from './game/game.module'; // 💡 방금 만든 모듈 불러오기

@Module({
  imports: [GameModule], // 💡 여기에 통째로 조립합니다.
  controllers: [],
  providers: [],
})
export class AppModule {}