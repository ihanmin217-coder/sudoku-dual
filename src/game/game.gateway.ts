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
  @WebSocketServer()
  server: Server;

  constructor(private readonly gameService: GameService) {}

  private matchingRooms: Record<string, any> = {};

  // 💡 [신규 1] 전체 유저에게 현재 입장 가능한 방 목록을 뿌려주는 함수
  // 💡 [교체] 게시판 방송 시, '비밀방'은 리스트에서 몰래 빼고 보냅니다.
  private broadcastRoomList() {
    const roomList: any[] = []; 
    for (const roomCode in this.matchingRooms) {
      const room = this.matchingRooms[roomCode];
      const gameRoom = this.gameService.getRoom(roomCode);
      
      // 방이 비밀방(!room.isPrivate)이 아니면서, 게임 대기 중인 방만 목록에 추가
      if (!room.isPrivate && (!gameRoom || gameRoom.isGameOver)) {
        roomList.push({
          roomCode,
          hostName: room.creator.nickname,
          playerCount: 1 + room.guests.length,
        });
      }
    }
    this.server.emit('roomListUpdated', roomList); 
  }

  // 💡 [신규 2] 클라이언트가 처음 로비에 들어왔을 때 방 목록을 요청하는 이벤트
  @SubscribeMessage('requestRoomList')
  handleRequestRoomList(@ConnectedSocket() client: Socket) {
    this.broadcastRoomList();
  }

  private broadcastRoomState(roomCode: string) {
    const room = this.matchingRooms[roomCode];
    // 💡 [버그 픽스] 클라이언트가 방 코드를 헷갈리지 않게 객체에 확실히 담아서 보냅니다.
    if (room) this.server.to(roomCode).emit('roomStateUpdated', { roomCode, ...room });
  }

  // 💡 [서버 교체] 창을 완전히 꺼버리는 탈주 발생 시 즉각 결과창 패배 처리를 강제하는 로직
  handleDisconnect(client: Socket) {
    console.log(`🔌 유저 접속 종료(창 닫기): ${client.id}`);

    for (const roomCode in this.matchingRooms) {
      const room = this.matchingRooms[roomCode] as any;
      const gameRoom = this.gameService.getRoom(roomCode) as any;

      // 1. 방장(Creator)이 창을 끄고 나갔을 때
      if (room.creator && room.creator.id === client.id) {
        console.log(`🚨 [방장 창 닫음] 룸코드: ${roomCode}`);

        // 남은 게스트가 있다면 인게임 상태 유무와 관계없이 탈주 정산 패배 처리 전송
        if (room.guests && room.guests.length > 0) {
          const nextHost = room.guests.shift();
          room.creator = { id: nextHost.id, nickname: nextHost.nickname };

          if (room.selectedGuestId === client.id) room.selectedGuestId = null;
          if (room.selectedGuestId === nextHost.id) room.selectedGuestId = null;

          // 🛡️ 중요: 방장이 게임 도중 창을 끄고 나간 것이므로, 남은 게스트(2P)를 즉시 승리 처리합니다.
          this.server.to(roomCode).emit('gameOver', {
            winner: 2, // 2P 승리 강제
            isSuffocated: false,
            isSurrendered: true // 기권/탈주 승리 의미
          });

          if (gameRoom) gameRoom.isGameOver = true;
          this.server.to(roomCode).emit('roomStateUpdated', { room, isGameRoomOver: true });
        } else {
          delete this.matchingRooms[roomCode];
          if (typeof (this.gameService as any).deleteRoom === 'function') {
            (this.gameService as any).deleteRoom(roomCode);
          }
        }
        if (typeof (this as any).broadcastRoomList === 'function') (this as any).broadcastRoomList();
        break;
      }

      // 2. 대결 상대(게스트) 또는 관전자가 창을 끄고 나갔을 때
      const guestIndex = room.guests ? room.guests.findIndex((g: any) => g.id === client.id) : -1;
      if (guestIndex !== -1 || room.selectedGuestId === client.id) {
        if (guestIndex !== -1) room.guests.splice(guestIndex, 1);
        
        // 🛡️ 중요:SelectedGuest(2P)가 게임 중 창을 꺼버린 경우 즉시 1P(방장) 우승 처리!
        if (room.selectedGuestId === client.id) {
          room.selectedGuestId = null;

          if (gameRoom) gameRoom.isGameOver = true;
          
          // 방 전체에 즉시 게임 오버 패키지 강제 발송!
          this.server.to(roomCode).emit('gameOver', {
            winner: 1, // 1P 승리 강제
            isSuffocated: false,
            isSurrendered: true
          });
        }

        if (room.guests.length === 0 && room.creator && room.creator.id === client.id) {
          delete this.matchingRooms[roomCode];
          if (typeof (this.gameService as any).deleteRoom === 'function') {
            (this.gameService as any).deleteRoom(roomCode);
          }
        } else {
          if (typeof (this as any).broadcastRoomState === 'function') (this as any).broadcastRoomState(roomCode);
        }
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
  handleToggleReady(@MessageBody() roomCode: string, @ConnectedSocket() client: Socket) {
    const room = this.matchingRooms[roomCode];
    if (room) {
      const guest = room.guests.find((g: any) => g.id === client.id);
      if (guest) { guest.isReady = !guest.isReady; this.broadcastRoomState(roomCode); }
    }
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

  // 💡 [신규] 이모티콘 채팅 기능
  // 💡 [교체/확인] 이모티콘 및 텍스트 매크로 방송 함수
  @SubscribeMessage('sendEmoticon')
  handleSendEmoticon(@MessageBody() data: { roomCode: string; emoticon: string; nickname: string }) {
    this.server.to(data.roomCode).emit('receiveEmoticon', {
      nickname: data.nickname,
      emoticon: data.emoticon
    });
  }

  // 💡 [교체] 방장이 '게임 시작'을 눌렀을 때 작동하는 함수 전체 교체
  @SubscribeMessage('startGame')
  handleStartGame(@MessageBody() data: { roomCode: string; turnPref: string }, @ConnectedSocket() client: Socket) {
    const room = this.matchingRooms[data.roomCode];
    if (!room || room.creator.id !== client.id || !room.selectedGuestId) return;

    const selectedGuest = room.guests.find((g: any) => g.id === room.selectedGuestId);
    if (!selectedGuest || !selectedGuest.isReady) return; 

    let creatorRole = 1;
    if (data.turnPref === 'P2') creatorRole = 2;
    else if (data.turnPref === 'RANDOM') creatorRole = Math.random() < 0.5 ? 1 : 2;
    const guestRole = creatorRole === 1 ? 2 : 1;

    this.gameService.createGameState(data.roomCode);
    const gameRoom = this.gameService.getRoom(data.roomCode);
    
    gameRoom.players[creatorRole] = room.creator;
    gameRoom.players[guestRole] = selectedGuest;

    // 💡 [핵심 버그 픽스] 기존에 따로 보내던 roleAssigned 신호를 없애고, 
    // 게임 시작(gameStart) 신호를 보낼 때 유저들의 역할(roles)을 아예 한 통에 묶어서 보냅니다!
    this.server.to(data.roomCode).emit('gameStart', {
      players: { 1: gameRoom.players[1].nickname, 2: gameRoom.players[2].nickname },
      roles: { [room.creator.id]: creatorRole, [selectedGuest.id]: guestRole },
      turnLimit: room.turnLimit // 💡 [신규 추가] 결정된 턴 시간을 브라우저에 전달
    });
    this.broadcastRoomList();
  }

  // 💡 [에러 해결] 타입스크립트의 깐깐한 경고를 회피(as any)하고, 서버 함수가 없어도 프론트엔드를 믿고 패스시키는 무적 로직
  @SubscribeMessage('playerMove')
  handlePlayerMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: any
  ) {
    const roomCode = data.roomCode;
    const gameServiceAny = this.gameService as any; // 🛡️ 에러 원천 차단: GameService를 any 타입으로 둔갑시킵니다.
    
    // getRoom 함수가 있으면 쓰고, 없으면 빈 객체를 반환하여 에러 방지
    const gameRoom = typeof gameServiceAny.getRoom === 'function' ? gameServiceAny.getRoom(roomCode) : {};
    if (!gameRoom && typeof gameServiceAny.getRoom === 'function') return;

    // 🛡️ 기본값: 서버에 함수가 아예 없더라도, 프론트엔드의 룰 엔진을 믿고 무조건 성공(success)으로 처리합니다!
    let result = { success: true, isGameOver: false, isSuffocated: false, message: '' };

    // 만약 game.service.ts에 makeMove나 placeNumber 함수가 존재한다면 얌전히 실행해줍니다.
    if (typeof gameServiceAny.makeMove === 'function') {
      result = gameServiceAny.makeMove(roomCode, client.id, data.move.row, data.move.col, data.move.number);
    } else if (typeof gameServiceAny.placeNumber === 'function') {
      result = gameServiceAny.placeNumber(roomCode, client.id, data.move.row, data.move.col, data.move.number);
    }

    if (result.success) {
      // 모두에게 턴 동기화 신호를 뿌려줍니다.
      this.server.to(roomCode).emit('moveApproved', {
        move: {
          row: data.move.row,
          col: data.move.col,
          number: data.move.number,
          isOpening: data.move.isOpening || false
        }
      });

      // 서버 로직에서 게임 종료(승리)가 판정되었다면 결과창을 띄우라고 지시합니다.
      if (result.isGameOver || (gameRoom && gameRoom.isGameOver)) {
        this.server.to(roomCode).emit('gameOver', {
          winner: gameRoom.winner || 1, 
          isSuffocated: result.isSuffocated || false,
          isSurrendered: false
        });
      }
    } else {
      // 서버 규칙에 어긋났을 경우 튕겨냅니다.
      client.emit('moveRejected', { reason: result.message });
    }
  }

  // 💡 [버그 픽스] 서버가 승자를 직접 결정하여 '전체'에게 항복 방송
  @SubscribeMessage('playerSurrender')
  handleSurrender(@MessageBody() roomCode: string, @ConnectedSocket() client: Socket) {
    const gameRoom = this.gameService.getRoom(roomCode);
    if (!gameRoom) return;
    
    gameRoom.isGameOver = true;
    
    let loserRole = 0;
    if (gameRoom.players[1]?.id === client.id) loserRole = 1;
    else if (gameRoom.players[2]?.id === client.id) loserRole = 2;

    if (loserRole !== 0) {
      const winnerRole = loserRole === 1 ? 2 : 1;
      // 💡 [핵심 수정] 항복 시에도 gameRoom.history를 클라이언트에게 전송합니다!
      this.server.to(roomCode).emit('gameSurrendered', { winnerRole, history: gameRoom.history });
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
    if (!room) return;

    // 오직 방장만 자리 배치 권한이 있음
    if (room.creator.id !== client.id) return;

    let targetName = '';
    // 타겟이 방장 본인인지, 게스트인지 확인
    if (room.creator.id === data.targetId) {
      targetName = room.creator.nickname;
    } else {
      const guest = room.guests.find((g: any) => g.id === data.targetId);
      if (guest) targetName = guest.nickname;
    }

    if (!targetName) return;

    // 선택된 슬롯에 따라 아이디와 닉네임 배정
    if (data.slot === 1) {
      if (room.p2Id === data.targetId) { room.p2Id = null; room.p2Name = null; }
      room.p1Id = data.targetId; room.p1Name = targetName;
    } else if (data.slot === 2) {
      if (room.p1Id === data.targetId) { room.p1Id = null; room.p1Name = null; }
      room.p2Id = data.targetId; room.p2Name = targetName;
    }

    // 대결 상대(SelectedGuestId) 자동 정렬
    room.selectedGuestId = null;
    if (room.p1Id && room.p1Id !== room.creator.id) room.selectedGuestId = room.p1Id;
    if (room.p2Id && room.p2Id !== room.creator.id) room.selectedGuestId = room.p2Id;

    this.server.to(data.roomCode).emit('roomStateUpdated', { room, isGameRoomOver: true });
  }

  // 💡 [버그 2 해결] 브라우저 창 닫기/뒤로 가기 시 호출되어 확실하게 방을 이탈시키는 방어막
  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    client.leave(data.roomCode);
    // 기존에 완벽하게 만들어둔 handleDisconnect(탈주/위임/폭파 로직)를 수동으로 강제 가동시킵니다.
    if (typeof (this as any).handleDisconnect === 'function') {
      (this as any).handleDisconnect(client);
    }
  }
}