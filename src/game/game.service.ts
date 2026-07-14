import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface GameRoom {
  roomCode: string;
  players: { 1?: any; 2?: any };
  board: number[][];
  currentPlayer: number;
  scores: { 1: number; 2: number };
  requiredNextBox: number | null;
  isOpeningPhase: boolean;
  openingNumber: number | null;
  isFirstTurn: boolean;
  completedRows: Set<number>;
  completedCols: Set<number>;
  completedBoxes: Set<number>;
  isGameOver: boolean;
  history: any[]; // 💡 [추가] 복기를 위한 기보 저장소
}

@Injectable()
export class GameService {
  private rooms: Record<string, GameRoom> = {};

  private supabase: SupabaseClient = createClient(
    'https://zbucvqsonuefsbmkfvrc.supabase.co/rest/v1/', 
    'sb_publishable_k_K27JqDyZs6x3NqcznNiw_CqJQhoU0'
  );

  createGameState(roomCode: string) {
    this.rooms[roomCode] = {
      roomCode,
      players: {},
      board: Array.from({ length: 9 }, () => Array(9).fill(0)),
      currentPlayer: 2,
      scores: { 1: 0, 2: 0 },
      requiredNextBox: null,
      isOpeningPhase: true,
      openingNumber: null,
      isFirstTurn: true,
      completedRows: new Set(),
      completedCols: new Set(),
      completedBoxes: new Set(),
      isGameOver: false,
      history: [], // 💡 [추가] 게임 시작 시 기보 초기화
    };
  }

  getRoom(roomCode: string): GameRoom {
    return this.rooms[roomCode];
  }

  // 💡 [추가] 오프닝 숫자를 정하면 즉시 턴을 1P(선공)로 넘깁니다! (턴 버그 수정)
  setOpeningNumber(roomCode: string, num: number) {
    const room = this.rooms[roomCode];
    if (room) {
      room.openingNumber = num;
      room.isOpeningPhase = false;
      room.currentPlayer = 1; 
    }
  }

  isValidSudoku(roomCode: string, row: number, col: number, num: number): boolean {
    const room = this.rooms[roomCode];
    if (!room) return false;
    const board = room.board;
    for (let c = 0; c < 9; c++) if (board[row][c] === num) return false;
    for (let r = 0; r < 9; r++) if (board[r][col] === num) return false;
    const startR = Math.floor(row / 3) * 3;
    const startC = Math.floor(col / 3) * 3;
    for (let r = startR; r < startR + 3; r++) {
      for (let c = startC; c < startC + 3; c++) {
        if (board[r][c] === num) return false;
      }
    }
    return true;
  }

  executeTurnEnd(roomCode: string, row: number, col: number, bigBox: number, placedNum: number) {
    const room = this.rooms[roomCode];
    if (!room) return null;

    const activePlayer = room.currentPlayer;
    
    // 💡 [추가] 서버 기보에 현재 착수를 기록합니다.
    room.history.push({ row, col, number: placedNum, player: activePlayer, bigBox });

    this.checkAndUpdateScores(room, row, col, bigBox, activePlayer);

    if (room.scores[activePlayer as 1|2] >= 2) {
      room.isGameOver = true;
      return { isGameOver: true, winner: activePlayer, isSuffocated: false, history: room.history };
    }

    room.requiredNextBox = placedNum;
    room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
    if (room.isFirstTurn) room.isFirstTurn = false;

    const boxStatus = this.analyzeRequiredBox(room, room.requiredNextBox);
    if (boxStatus === "FULL") {
      room.requiredNextBox = null;
    } else if (boxStatus === "SUFFOCATED") {
      room.isGameOver = true;
      return { isGameOver: true, winner: activePlayer, isSuffocated: true, history: room.history };
    }

    return { 
        isGameOver: false, 
        nextPlayer: room.currentPlayer, 
        requiredNextBox: room.requiredNextBox, 
        scores: room.scores,
        isFirstTurn: room.isFirstTurn
    };
  }

  private checkAndUpdateScores(room: GameRoom, row: number, col: number, bigBox: number, player: number) {
    const board = room.board;
    if (!room.completedRows.has(row) && board[row].every(v => v !== 0)) {
      room.completedRows.add(row); room.scores[player as 1|2]++;
    }
    let colFull = true;
    for (let r = 0; r < 9; r++) if (board[r][col] === 0) colFull = false;
    if (!room.completedCols.has(col) && colFull) {
      room.completedCols.add(col); room.scores[player as 1|2]++;
    }
    const startR = Math.floor(row / 3) * 3; const startC = Math.floor(col / 3) * 3;
    let boxFull = true;
    for (let r = startR; r < startR + 3; r++) {
      for (let c = startC; c < startC + 3; c++) { if (board[r][c] === 0) boxFull = false; }
    }
    if (!room.completedBoxes.has(bigBox) && boxFull) {
      room.completedBoxes.add(bigBox); room.scores[player as 1|2]++;
    }
  }

  private analyzeRequiredBox(room: GameRoom, targetBox: number) {
    const board = room.board;
    let hasEmptyCell = false; let anyValidMove = false;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const bigBox = Math.floor(r / 3) * 3 + Math.floor(c / 3) + 1;
        if (bigBox === targetBox && board[r][c] === 0) {
          hasEmptyCell = true;
          for (let n = 1; n <= 9; n++) {
            if (this.isValidSudoku(room.roomCode, r, c, n)) { anyValidMove = true; break; }
          }
        }
      }
    }
    if (!hasEmptyCell) return "FULL";
    if (!anyValidMove) return "SUFFOCATED";
    return "NORMAL";
  }

  // 💡 [신규 추가] 게임 종료 시 승자와 패자의 전적을 DB에 기록/업데이트하는 마법의 함수!
  async recordBattleResult(winnerNick: string, loserNick: string) {
    if (!winnerNick || !loserNick || winnerNick === '익명' || loserNick === '익명') {
      console.log('⚠️ 익명 유저는 전적이 기록되지 않습니다.');
      return;
    }

    try {
      // 1. 승리자 기록 (없으면 새로 만들고 wins + 1, 점수 + 20)
      const { data: winUser } = await this.supabase.from('users').select('*').eq('nickname', winnerNick).single();
      if (winUser) {
        await this.supabase.from('users').update({ wins: winUser.wins + 1, points: winUser.points + 20 }).eq('nickname', winnerNick);
      } else {
        await this.supabase.from('users').insert([{ id: crypto.randomUUID(), nickname: winnerNick, wins: 1, losses: 0, points: 1020 }]);
      }

      // 2. 패배자 기록 (없으면 새로 만들고 losses + 1, 점수 - 10)
      const { data: loseUser } = await this.supabase.from('users').select('*').eq('nickname', loserNick).single();
      if (loseUser) {
        await this.supabase.from('users').update({ losses: loseUser.losses + 1, points: Math.max(0, loseUser.points - 10) }).eq('nickname', loserNick);
      } else {
        await this.supabase.from('users').insert([{ id: crypto.randomUUID(), nickname: loserNick, wins: 0, losses: 1, points: 990 }]);
      }

      console.log(`📊 [DB 전적 기록 완료] 승리: ${winnerNick} (+20점) / 패배: ${loserNick} (-10점)`);
    } catch (error) {
      console.error('❌ DB 전적 저장 중 오류 발생:', error);
    }
  }
}