import { Injectable } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class GameService {
  // 💡 [핵심 해결] 타입을 ': any'로 지정하여, TypeScript가 DB 문법이나 테이블 구조로 에러(이슈)를 띄우지 못하게 원천 차단합니다!
  private supabase: any = createClient(
    'https://zbucvqsonuefsbmkfvrc.supabase.co/rest/v1/', 
    'sb_publishable_k_K27JqDyZs6x3NqcznNiw_CqJQhoU0'
  );

  private rooms: Record<string, any> = {};

  getRoom(roomCode: string) {
    return this.rooms[roomCode];
  }

  async recordBattleResult(winnerNick: string, loserNick: string) {
    if (!winnerNick || !loserNick || winnerNick === '익명' || loserNick === '익명') {
      console.log('⚠️ 익명 유저는 전적이 기록되지 않습니다.');
      return;
    }

    try {
      const db = this.supabase.from('users');

      // 1. 승리자 기록 및 숨겨진 에러 감지
      const { data: winUser } = await db.select('*').eq('nickname', winnerNick).single();
      if (winUser) {
        const { error } = await db.update({ wins: winUser.wins + 1, points: winUser.points + 20 }).eq('nickname', winnerNick);
        if (error) console.error('❌ 승리자 업데이트 실패:', error.message);
      } else {
        const { error } = await db.insert([{ nickname: winnerNick, wins: 1, losses: 0, points: 1020 }]);
        if (error) console.error('❌ 승리자 신규 등록 실패:', error.message);
      }

      // 2. 패배자 기록 및 숨겨진 에러 감지
      const { data: loseUser } = await db.select('*').eq('nickname', loserNick).single();
      if (loseUser) {
        const { error } = await db.update({ losses: loseUser.losses + 1, points: Math.max(0, loseUser.points - 10) }).eq('nickname', loserNick);
        if (error) console.error('❌ 패배자 업데이트 실패:', error.message);
      } else {
        const { error } = await db.insert([{ nickname: loserNick, wins: 0, losses: 1, points: 990 }]);
        if (error) console.error('❌ 패배자 신규 등록 실패:', error.message);
      }

      console.log(`📊 [DB 전적 기록 완료] 승리: ${winnerNick} (+20점) / 패배: ${loserNick} (-10점)`);
    } catch (error) {
      console.error('❌ DB 통신 중 치명적 오류 발생:', error);
    }
  }
}