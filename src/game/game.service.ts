import { Injectable } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class GameService {
  // 💡 아까 찾으신 Project URL과 API Key (anon public)를 아래에 정확히 입력해 주세요!
  private supabase: any = createClient(
    'https://zbucvqsonuefsbmkfvrc.supabase.co',      // <--여기에 https://...로 시작하는 Project URL을 붙여넣으세요.
    'sb_publishable_k_K27JqDyZs6x3NqcznNiw_CqJQhoU0'  // <--여기에 eyJ...로 시작하는 API Key (anon public)를 붙여넣으세요.
  );

  private rooms: Record<string, any> = {};

  getRoom(roomCode: string) {
    return this.rooms[roomCode];
  }

  // 💡 게임 종료 시 승자와 패자의 전적을 Supabase DB에 기록 및 자동 생성(Insert/Update)하는 오리지널 함수
  async recordBattleResult(winnerNick: string, loserNick: string) {
    if (!winnerNick || !loserNick || winnerNick === '익명' || loserNick === '익명') {
      console.log('⚠️ 익명 유저는 전적이 기록되지 않습니다.');
      return;
    }

    try {
      const db = this.supabase.from('users');

      // 1. 승리자 기록 (id는 DB 기본값인 gen_random_uuid()가 자동으로 생성해 주므로 빼고 보냅니다)
      const { data: winUser } = await db.select('*').eq('nickname', winnerNick).single();
      if (winUser) {
        const { error } = await db.update({ wins: winUser.wins + 1, points: winUser.points + 20 }).eq('nickname', winnerNick);
        if (error) console.error('❌ 승리자 업데이트 실패:', error.message);
      } else {
        const { error } = await db.insert([{ nickname: winnerNick, wins: 1, losses: 0, points: 1020 }]);
        if (error) console.error('❌ 승리자 신규 등록 실패:', error.message);
      }

      // 2. 패배자 기록
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