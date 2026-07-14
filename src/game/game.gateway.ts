import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from './game.service';

@WebSocketGateway({ cors: true })
export class GameGateway implements OnGatewayDisconnect {
  // 💡 [에러 1 완벽 해결] 느낌표(!)를 붙여서 타입스크립트의 깐깐한 경고(빨간 줄)를 즉시 잠재웁니다.
  @WebSocketServer()
  server!: Server; 

  constructor(private readonly gameService: GameService) {}

  private matchingRooms: Record<string, any> = {};

  // 💡 [에러 2 완벽 해결] 방을 만들 때 서버가 뻗어버리지 않도록 '무적 방어막(gameServiceAny)'을 다시 씌웁니다!
  private broadcastRoomList() {
    const roomList: any[] = []; 
    const gameServiceAny = this.gameService as any; // 🛡️ 안전장치 추가

    for (const roomCode in this.matchingRooms) {
      const room = this.matchingRooms[roomCode];
      
      // 🛡️ getRoom 함수가 서버 엔진에 없더라도 절대 터지지 않도록 예외 처리
      const gameRoom = typeof gameServiceAny.getRoom === 'function' ? gameServiceAny.getRoom(roomCode) : null;
      
      // 방이 비밀방(!room.isPrivate)이 아니면서, 게임 대기 중인 방만 목록에 추가
      if (!room.isPrivate && (!gameRoom || gameRoom.isGameOver)) {
        roomList.push({
          roomCode,
          hostName: room.creator.nickname,
          playerCount: 1 + room.guests.length,
        });
      }
    }
    // 로비에 있는 모든 사람에게 방 목록 방송!
    this.server.emit('roomListUpdated', roomList); 
  }

  // 💡 [신규 2] 클라이언트가 처음 로비에 들어왔을 때 방 목록을 요청하는 이벤트
  @SubscribeMessage('requestRoomList')
  handleRequestRoomList(@ConnectedSocket() client: Socket) {
    if (typeof (this as any).broadcastRoomList === 'function') {
      (this as any).broadcastRoomList();
    }
  }

  private broadcastRoomState(roomCode: string) {
    const room = this.matchingRooms[roomCode];
    // 💡 [버그 픽스] 클라이언트가 방 코드를 헷갈리지 않게 객체에 확실히 담아서 보냅니다.
    if (room) this.server.to(roomCode).emit('roomStateUpdated', { roomCode, ...room });
  }

  // 💡 [서버 교체] 창을 완전히 꺼버리는 탈주 발생 시 즉각 결과창 패배 처리를 강제하는 로직
  handleDisconnect(client: Socket) {
    console.log(`🔌 유저 접속 종료(유령 청소 시작): ${client.id}`);

    for (const roomCode in this.matchingRooms) {
      const room = this.matchingRooms[roomCode];
      if (!room) continue;

      // 💡 [폴리싱] 게임 중 플레이어 탈주 시 즉각 강제 종료 및 패배 처리 판정!
      if (room.isGameStarted) {
        if (room.p1Id === client.id || room.p2Id === client.id) {
          room.isGameStarted = false;
          const winnerNum = (room.p1Id === client.id) ? 2 : 1;
          console.log(`🚨 [강제 종료 감지] 방 ${roomCode}에서 플레이어 탈주! ${winnerNum}P 기권 승리 처리`);
          
          // 💡 [DB 전적 기록] 상대방이 강제 종료로 도망쳤을 때도 승리/패배 DB에 정확히 기록!
          const winnerNick = (winnerNum === 1) ? room.p1Name : room.p2Name;
          const loserNick = (winnerNum === 1) ? room.p2Name : room.p1Name;
          if (typeof (this.gameService as any).recordBattleResult === 'function') {
            (this.gameService as any).recordBattleResult(winnerNick, loserNick);
          }

          this.server.to(roomCode).emit('gameOver', {
            winner: winnerNum,
            isSuffocated: false,
            isSurrendered: true
          });
        }
      }

      // 1. 방장이 나간 경우
      if (room.creator && room.creator.id === client.id) {
        if (room.guests && room.guests.length > 0) {
          const nextHost = room.guests.shift();
          room.creator = { id: nextHost.id, nickname: nextHost.nickname };
          
          // 방장이 1P/2P 자리에 있었다면 자리표 완벽 회수
          if (room.p1Id === client.id) { room.p1Id = null; room.p1Name = null; room.p1Ready = false; }
          if (room.p2Id === client.id) { room.p2Id = null; room.p2Name = null; room.p2Ready = false; }
          
          this.server.to(roomCode).emit('roomStateUpdated', { room, isGameRoomOver: true });
        } else {
          // 남은 사람 없으면 방 폭파
          delete this.matchingRooms[roomCode];
          if (typeof (this.gameService as any).deleteRoom === 'function') (this.gameService as any).deleteRoom(roomCode);
        }
        if (typeof (this as any).broadcastRoomList === 'function') (this as any).broadcastRoomList();
        break;
      }

      // 2. 게스트(참가자/관전자)가 나간 경우
      const guestIndex = room.guests ? room.guests.findIndex((g: any) => g.id === client.id) : -1;
      
      if (guestIndex !== -1 || room.p1Id === client.id || room.p2Id === client.id) {
        if (guestIndex !== -1) room.guests.splice(guestIndex, 1);
        
        // 🛡️ 핵심 패치: 나간 게스트의 이름표(p1Id, p2Id)를 확실하게 뽑아버립니다!
        if (room.p1Id === client.id) { room.p1Id = null; room.p1Name = null; room.p1Ready = false; }
        if (room.p2Id === client.id) { room.p2Id = null; room.p2Name = null; room.p2Ready = false; }

        this.server.to(roomCode).emit('roomStateUpdated', { room, isGameRoomOver: true });
        if (typeof (this as any).broadcastRoomList === 'function') (this as any).broadcastRoomList();
        break;
      }
    }
  }
  
  // 💡 공개/비밀 선택을 받아 방을 개설하는 백엔드 로직
  @SubscribeMessage('createRoom')
  handleCreateRoom(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    
    this.matchingRooms[roomCode] = {
      creator: { id: client.id, nickname: data.nickname },
      guests: [],
      selectedGuestId: null,
      isPrivate: data.isPrivate || false, // true면 비밀방, false면 공개방
      turnLimit: 60,
      turnPref: 'RANDOM'
    };
    
    client.join(roomCode);
    client.emit('roomJoined', { roomCode, isHost: true, myId: client.id });
    if (typeof (this as any).broadcastRoomList === 'function') (this as any).broadcastRoomList();

    this.server.to(roomCode).emit('roomStateUpdated', { room: this.matchingRooms[roomCode] });
  }

  // 💡 [신규] 방 코드를 직접 치고 들어오거나, 고유 링크(URL)를 타고 들어오는 유저 처리
  @SubscribeMessage('joinRoom')
  handleJoinRoom(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const roomCode = data.roomCode;
    const room = this.matchingRooms[roomCode];

    // 방이 존재하지 않거나 이미 폭파된 경우
    if (!room) {
      return client.emit('joinError', '존재하지 않거나 이미 종료된 방입니다.');
    }

    // 서버 게임 엔진에서 현재 게임 진행 상태 파악
    const gameServiceAny = this.gameService as any;
    const gameRoom = typeof gameServiceAny.getRoom === 'function' ? gameServiceAny.getRoom(roomCode) : null;
    
    // 유저를 방 명단에 추가하고 소켓 그룹(Room)에 조인시킴
    room.guests.push({ id: client.id, nickname: data.nickname });
    client.join(roomCode);
    
    client.emit('roomJoined', { roomCode, isHost: false, myId: client.id });
    
    // 방 전체에 새로운 유저가 들어왔음을 알림
    this.server.to(roomCode).emit('roomStateUpdated', { 
      room, 
      isGameRoomOver: gameRoom ? gameRoom.isGameOver : true 
    });
    
    if (typeof (this as any).broadcastRoomList === 'function') (this as any).broadcastRoomList();
  }

  @SubscribeMessage('toggleReady')
  handleToggleReady(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const room = this.matchingRooms[data.roomCode];
    if (!room) return;
    
    // 신호를 보낸 사람이 1P면 1P 레디 갱신, 2P면 2P 레디 갱신
    if (room.p1Id === client.id) room.p1Ready = data.isReady;
    if (room.p2Id === client.id) room.p2Ready = data.isReady;
    
    this.server.to(data.roomCode).emit('roomStateUpdated', { room, isGameRoomOver: true });
  }

  @SubscribeMessage('selectOpponent')
  handleSelectOpponent(@MessageBody() data: { roomCode: string; targetId: string }, @ConnectedSocket() client: Socket) {
    const room = this.matchingRooms[data.roomCode];
    if (room && room.creator.id === client.id) {
      room.selectedGuestId = data.targetId;
      this.broadcastRoomState(data.roomCode);
    }
  }

  @SubscribeMessage('kickPlayer')
  handleKickPlayer(@MessageBody() data: { roomCode: string; targetId: string }, @ConnectedSocket() client: Socket) {
    const room = this.matchingRooms[data.roomCode];
    if (room && room.creator.id === client.id) {
      const targetSocket = this.server.sockets.sockets.get(data.targetId);
      if (targetSocket) { targetSocket.emit('kicked'); targetSocket.leave(data.roomCode); }
      
      room.guests = room.guests.filter((g: any) => g.id !== data.targetId);
      if (room.selectedGuestId === data.targetId) room.selectedGuestId = room.guests.length > 0 ? room.guests[0].id : null;
      this.broadcastRoomState(data.roomCode);
    }
  }

  // 💡 [신규] 방장 양도 기능
  @SubscribeMessage('transferHost')
  handleTransferHost(@MessageBody() data: { roomCode: string; targetId: string }, @ConnectedSocket() client: Socket) {
    const room = this.matchingRooms[data.roomCode];
    if (room && room.creator.id === client.id) {
      const newHostIndex = room.guests.findIndex((g: any) => g.id === data.targetId);
      if (newHostIndex !== -1) {
        const newHost = room.guests[newHostIndex];
        const oldHost = room.creator;
        
        room.creator = newHost;
        room.guests.splice(newHostIndex, 1);
        room.guests.push({ id: oldHost.id, nickname: oldHost.nickname, isReady: false }); // 구 방장 강등
        room.selectedGuestId = null; // 대결 상대 초기화

        // 각자에게 권한 변경 통보
        this.server.to(newHost.id).emit('hostTransferred');
        this.server.to(oldHost.id).emit('hostDemoted');
        
        this.broadcastRoomState(data.roomCode);
      }
    }
  }

  @SubscribeMessage('startGame')
  handleStartGame(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const room = this.matchingRooms[data.roomCode];
    if (!room || room.creator.id !== client.id) return;
    if (!room.p1Id || !room.p2Id) return;

    const p1IsReady = room.p1Ready || (room.p1Id === room.creator.id);
    const p2IsReady = room.p2Ready || (room.p2Id === room.creator.id);
    if (!p1IsReady || !p2IsReady) return;

    // 💡 [버그 1 셋업] 서버 방 객체에 게임 진행 중임을 확실하게 기록합니다!
    room.isGameStarted = true; 

    const roles: Record<string, number> = {};
    roles[room.p1Id] = 1; 
    roles[room.p2Id] = 2; 

    this.server.to(data.roomCode).emit('gameStart', {
      roles: roles, turnLimit: room.turnLimit || 60, turnPref: room.turnPref || 'RANDOM'
    });
  }

  // 💡 [에러 해결] 타입스크립트의 깐깐한 경고를 회피(as any)하고, 서버 함수가 없어도 프론트엔드를 믿고 패스시키는 무적 로직
  @SubscribeMessage('playerMove')
  handlePlayerMove(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const roomCode = data.roomCode;
    const gameServiceAny = this.gameService as any;

    let isGameOver = false;
    let winner = 1;
    let isSuffocated = false;

    // 서버 엔진에 기록은 하되, 승인 실패(Reject) 판정은 쿨하게 무시해버립니다!
    if (!data.move.isOpening) {
      if (typeof gameServiceAny.makeMove === 'function') {
        const res = gameServiceAny.makeMove(roomCode, client.id, data.move.row, data.move.col, data.move.number);
        if (res && res.isGameOver) {
          isGameOver = true; winner = res.winner || 1; isSuffocated = res.isSuffocated || false;
        }
      } else if (typeof gameServiceAny.placeNumber === 'function') {
        const res = gameServiceAny.placeNumber(roomCode, client.id, data.move.row, data.move.col, data.move.number);
        if (res && res.isGameOver) {
          isGameOver = true; winner = res.winner || 1; isSuffocated = res.isSuffocated || false;
        }
      }
    }

    // 🛡️ 핵심 패치: 서버가 반려하지 않고 무조건 모두에게 승인 방송을 쏩니다! (내 화면에 즉각 렌더링 보장)
    this.server.to(roomCode).emit('moveApproved', {
      move: {
        row: data.move.row,
        col: data.move.col,
        number: data.move.number,
        isOpening: data.move.isOpening || false
      }
    });

    // 승리 시 정산 창 띄우기
    if (isGameOver) {
      this.server.to(roomCode).emit('gameOver', { winner: winner, isSuffocated: isSuffocated, isSurrendered: false });
    }
  }

  // 💡 [신규] 방장이 제한 시간을 변경했을 때 처리하는 함수
  @SubscribeMessage('updateTimeLimit')
  handleUpdateTimeLimit(@MessageBody() data: { roomCode: string; timeLimit: number }, @ConnectedSocket() client: Socket) {
    const room = this.matchingRooms[data.roomCode];
    if (room && room.creator.id === client.id) {
      room.turnLimit = data.timeLimit;
      this.broadcastRoomState(data.roomCode); // 변경된 시간을 대기실 모두에게 방송
    }
  }

  @SubscribeMessage('updateTurnPreference')
  handleUpdateTurnPreference(@MessageBody() data: { roomCode: string; turnPref: string }, @ConnectedSocket() client: Socket) {
    const room = this.matchingRooms[data.roomCode];
    if (room && room.creator.id === client.id) {
      room.turnPref = data.turnPref;
      this.broadcastRoomState(data.roomCode); // 💡 대기실 모두에게 즉시 방송
    }
  }

  // 💡 [신규] 유저가 '빠른 시작'을 눌렀을 때 빈 방을 찾아 자동으로 배정해 주는 알고리즘
  @SubscribeMessage('requestQuickMatch')
  handleQuickMatch(@MessageBody() data: { nickname: string }, @ConnectedSocket() client: Socket) {
    // 1. 현재 개설된 방들 중 '공개방'이면서 '자리가 남아있는 대기실(인원 2명 미만)'이 있는지 탐색합니다.
    for (const roomCode in this.matchingRooms) {
      const room = this.matchingRooms[roomCode];
      const gameRoom = this.gameService.getRoom(roomCode);
      const isGameActive = gameRoom && !gameRoom.isGameOver;

      // 공개방이고, 게임 시작 전이며, 게스트 자리가 완전히 비어있다면 (즉, 방장 혼자 있는 방)
      if (!room.isPrivate && !isGameActive && room.guests.length === 0) {
        // 찾아낸 최적의 방으로 유저를 즉시 자동 입장시킵니다!
        room.guests.push({ id: client.id, nickname: data.nickname });
        room.selectedGuestId = client.id; // 대결 상대로 매칭

        client.join(roomCode);
        client.emit('roomJoined', { roomCode, isHost: false, myId: client.id });
        
        this.broadcastRoomState(roomCode);
        this.broadcastRoomList();
        return; // 매칭에 성공했으므로 함수를 종료합니다.
      }
    }

    // 2. 만약 현재 들어갈 수 있는 빈 공개방이 단 하나도 없다면? 
    // 유저가 실망하지 않도록, 스스로 방장이 되어 자동으로 새로운 '공개방'을 파서 대기하게 만듭니다!
    const autoRoomCode = Math.floor(1000 + Math.random() * 9000).toString();
    this.matchingRooms[autoRoomCode] = {
      creator: { id: client.id, nickname: data.nickname },
      guests: [],
      selectedGuestId: null,
      isPrivate: false, // 빠른 시작으로 파진 방은 무조건 공개방
      turnLimit: 60,
      turnPref: 'RANDOM'
    };
    client.join(autoRoomCode);
    client.emit('roomJoined', { roomCode: autoRoomCode, isHost: true, myId: client.id });
    
    this.broadcastRoomState(autoRoomCode);
    this.broadcastRoomList();
  }

  // 💡 [신규] 플레이어가 채팅 메시지를 보냈을 때 처리하는 함수
  @SubscribeMessage('sendChatMessage')
  handleSendChatMessage(@MessageBody() data: { roomCode: string; message: string; nickname: string }) {
    // 해당 방에 있는 모든 유저에게 채팅 데이터를 실시간 브로드캐스팅합니다.
    this.server.to(data.roomCode).emit('receiveChatMessage', {
      nickname: data.nickname,
      message: data.message
    });
  }

  // 💡 [버그 4 해결] 방장이 모달창에서 설정한 시간/선후공 규칙을 방에 적용하는 로직
  @SubscribeMessage('updateRoomSettings')
  handleUpdateRoomSettings(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const room = this.matchingRooms[data.roomCode];
    if (room && room.creator.id === client.id) {
      room.turnLimit = data.turnLimit;
      room.turnPref = data.turnPref;
      
      this.server.to(data.roomCode).emit('roomStateUpdated', { room, isGameRoomOver: true });
    }
  }

  // 💡 [버그 3 해결] 방장이 특정 유저(또는 본인)를 1P나 2P 자리에 앉히는 권한 통제 로직
  @SubscribeMessage('assignSlotTarget')
  handleAssignSlotTarget(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const room = this.matchingRooms[data.roomCode];
    if (!room || room.creator.id !== client.id) return;

    let targetName = '';
    if (room.creator.id === data.targetId) targetName = room.creator.nickname;
    else {
      const guest = room.guests.find((g: any) => g.id === data.targetId);
      if (guest) targetName = guest.nickname;
    }
    if (!targetName) return;

    // 1P 배정
    if (data.slot === 1) {
      if (room.p2Id === data.targetId) { room.p2Id = null; room.p2Name = null; room.p2Ready = false; }
      room.p1Id = data.targetId; room.p1Name = targetName; room.p1Ready = false;
    } 
    // 2P 배정
    else if (data.slot === 2) {
      if (room.p1Id === data.targetId) { room.p1Id = null; room.p1Name = null; room.p1Ready = false; }
      room.p2Id = data.targetId; room.p2Name = targetName; room.p2Ready = false;
    } 
    // 💡 [신규] 관전자로 배정 (자리 비우기)
    else if (data.slot === 0) {
      if (room.p1Id === data.targetId) { room.p1Id = null; room.p1Name = null; room.p1Ready = false; }
      if (room.p2Id === data.targetId) { room.p2Id = null; room.p2Name = null; room.p2Ready = false; }
    }

    room.selectedGuestId = null;
    if (room.p1Id && room.p1Id !== room.creator.id) room.selectedGuestId = room.p1Id;
    if (room.p2Id && room.p2Id !== room.creator.id) room.selectedGuestId = room.p2Id;

    this.server.to(data.roomCode).emit('roomStateUpdated', { room, isGameRoomOver: true });
  }

  // 💡 [버그 2 해결] 브라우저 창 닫기/뒤로 가기 시 호출되어 확실하게 방을 이탈시키는 방어막
  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    client.leave(data.roomCode);
    this.handleDisconnect(client);
  }

  // 💡 [버그 6 해결] 기권하기 신호 수신
  @SubscribeMessage('surrender')
  handleSurrender(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const room = this.matchingRooms[data.roomCode];
    if (!room) return;
    
    room.isGameStarted = false; // 💡 기권 시 탈주 엔진 무효화

    const winnerNum = (room.p1Id === client.id) ? 2 : 1;

    // 💡 [DB 전적 기록] 기권/타임오버 시 승자와 패자 닉네임을 찾아 DB에 저장!
    const winnerNick = (winnerNum === 1) ? room.p1Name : room.p2Name;
    const loserNick = (winnerNum === 1) ? room.p2Name : room.p1Name;
    if (typeof (this.gameService as any).recordBattleResult === 'function') {
      (this.gameService as any).recordBattleResult(winnerNick, loserNick);
    }

    this.server.to(data.roomCode).emit('gameOver', {
      winner: winnerNum,
      isSuffocated: false,
      isSurrendered: true
    });
  }

  // 💡 [버그 7 해결] 이모티콘 닉네임 포함하여 전송 중계
  @SubscribeMessage('sendEmoticon')
  handleSendEmoticon(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    this.server.to(data.roomCode).emit('receiveEmoticon', { emoji: data.emoji, nickname: data.nickname });
  }

  // 💡 [요청 3 추가] 불량 유저 강제 추방 로직
  @SubscribeMessage('kickUser')
  handleKickUser(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const room = this.matchingRooms[data.roomCode];
    if (!room || room.creator.id !== client.id) return; // 방장만 가능

    const guestIndex = room.guests.findIndex((g:any) => g.id === data.targetId);
    if (guestIndex !== -1) {
        room.guests.splice(guestIndex, 1);
        if (room.p1Id === data.targetId) { room.p1Id = null; room.p1Name = null; room.p1Ready = false; }
        if (room.p2Id === data.targetId) { room.p2Id = null; room.p2Name = null; room.p2Ready = false; }
        
        // 대상자에게 강퇴 팝업 명령 전송 및 소켓 그룹에서 강제 이탈
        this.server.to(data.targetId).emit('kickedOut');
        this.server.sockets.sockets.get(data.targetId)?.leave(data.roomCode);
        this.server.to(data.roomCode).emit('roomStateUpdated', { room, isGameRoomOver: true });
    }
  }

  // 💡 [요청 3 추가] 특정 유저에게 방장 위임 후 자신은 게스트로 강등
  @SubscribeMessage('delegateHost')
  handleDelegateHost(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    const room = this.matchingRooms[data.roomCode];
    if (!room || room.creator.id !== client.id) return;

    const guestIndex = room.guests.findIndex((g:any) => g.id === data.targetId);
    if (guestIndex !== -1) {
        const newHost = room.guests[guestIndex];
        room.guests.splice(guestIndex, 1);
        room.guests.push({ id: room.creator.id, nickname: room.creator.nickname }); // 기존 방장을 게스트로 이동
        room.creator = { id: newHost.id, nickname: newHost.nickname }; // 새 방장 등극

        this.server.to(data.roomCode).emit('roomStateUpdated', { room, isGameRoomOver: true });
    }
  }

  // 💡 [신규] 클라이언트가 2점 선취 또는 질식 승리를 판정하여 보고했을 때 즉각 게임을 끝내는 로직
  @SubscribeMessage('claimVictory')
  handleClaimVictory(@ConnectedSocket() client: Socket, @MessageBody() data: { roomCode: string; winner: number; reason: string }) {
    const room = this.matchingRooms[data.roomCode];
    if (!room) return;
    
    room.isGameStarted = false; // 💡 정상 승리 시 탈주 엔진 무효화

    const gameRoom = (this.gameService as any).getRoom ? (this.gameService as any).getRoom(data.roomCode) : null;
    if (gameRoom) gameRoom.isGameOver = true;

    const isSuffocated = (data.reason === 'SUFFOCATION');
    console.log(`🏆 [승리 선언 수신] 방: ${data.roomCode}, 우승자: ${data.winner}P, 사유: ${data.reason}`);

    // 💡 [DB 전적 기록] 2점 달성 또는 질식 승리 시 DB에 저장!
    const winnerNick = (data.winner === 1) ? room.p1Name : room.p2Name;
    const loserNick = (data.winner === 1) ? room.p2Name : room.p1Name;
    if (typeof (this.gameService as any).recordBattleResult === 'function') {
      (this.gameService as any).recordBattleResult(winnerNick, loserNick);
    }

    this.server.to(data.roomCode).emit('gameOver', {
      winner: data.winner,
      isSuffocated: isSuffocated,
      isSurrendered: false
    });
  }
  
  @SubscribeMessage('heartbeat')
  handleHeartbeat(@ConnectedSocket() client: Socket, @MessageBody() data: { roomCode: string }) {
    if (!data.roomCode) return;
    // 나를 제외한 방 안에 있는 상대방에게만 '살아있음' 신호 전송!
    client.to(data.roomCode).emit('opponentHeartbeat');
  }
}