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

  // 💡 [교체] 방장 및 참가자 탈주 시 승계 처리와 더불어 '로비 게시판 즉시 갱신'을 보장합니다.
  handleDisconnect(client: Socket) {
    let listChanged = false; // 게시판을 갱신해야 하는지 체크하는 스위치

    for (const roomCode in this.matchingRooms) {
      const room = this.matchingRooms[roomCode];
      const gameRoom = this.gameService.getRoom(roomCode);
      const isGameActive = gameRoom && !gameRoom.isGameOver;

      if (room.creator.id === client.id) {
        if (room.guests.length > 0) {
          const newHost = room.guests.shift();
          room.creator = newHost;
          room.selectedGuestId = room.guests.length > 0 ? room.guests[0].id : null;
          this.server.to(newHost.id).emit('hostTransferred');

          if (isGameActive) {
            gameRoom.isGameOver = true;
            this.server.to(roomCode).emit('opponentDisconnected');
          }
          this.broadcastRoomState(roomCode);
          listChanged = true;
        } else {
          if (isGameActive) this.server.to(roomCode).emit('opponentDisconnected');
          else this.server.to(roomCode).emit('roomDestroyed');
          delete this.matchingRooms[roomCode];
          listChanged = true;
        }
      } else {
        const guestIndex = room.guests.findIndex((g: any) => g.id === client.id);
        if (guestIndex !== -1) {
          const isOpponent = room.selectedGuestId === client.id;
          room.guests.splice(guestIndex, 1);
          
          if (isOpponent) {
            room.selectedGuestId = room.guests.length > 0 ? room.guests[0].id : null;
            if (isGameActive) {
              gameRoom.isGameOver = true;
              this.server.to(roomCode).emit('opponentDisconnected');
            }
          }
          this.broadcastRoomState(roomCode);
          listChanged = true;
        }
      }
    }

    // 💡 [핵심 버그 픽스] 누군가 나가서 방 상태가 변했다면, 로비에 있는 모두의 게시판을 즉시 갱신합니다!
    if (listChanged) {
      this.broadcastRoomList();
    }
  }

  // 💡 [교체] 방 개설 시 비밀방(isPrivate) 옵션을 받아 저장합니다.
  // 💡 [수정] 방 생성 시 turnLimit(제한 시간) 속성을 추가로 저장합니다.
  // 💡 [수정] 방 생성 시 turnPref(선공 설정) 속성을 추가로 저장합니다.
  @SubscribeMessage('createRoom')
  handleCreateRoom(@MessageBody() data: { nickname: string, isPrivate: boolean }, @ConnectedSocket() client: Socket) {
    const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    this.matchingRooms[roomCode] = {
      creator: { id: client.id, nickname: data.nickname },
      guests: [],
      selectedGuestId: null,
      isPrivate: data.isPrivate,
      turnLimit: 60,
      turnPref: 'RANDOM' // 💡 [신규] 기본 선공 설정은 랜덤으로 세팅
    };
    client.join(roomCode);
    client.emit('roomJoined', { roomCode, isHost: true, myId: client.id });
    this.broadcastRoomState(roomCode);
    this.broadcastRoomList();
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(@MessageBody() data: { roomCode: string; nickname: string }, @ConnectedSocket() client: Socket) {
    const room = this.matchingRooms[data.roomCode];
    if (room) {
      room.guests.push({ id: client.id, nickname: data.nickname, isReady: false });
      if (!room.selectedGuestId) room.selectedGuestId = client.id;

      client.join(data.roomCode);
      client.emit('roomJoined', { roomCode: data.roomCode, isHost: false, myId: client.id });
      this.broadcastRoomState(data.roomCode);
    } else {
      client.emit('joinError', '방이 존재하지 않습니다.');
    }
    this.broadcastRoomList();
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

  @SubscribeMessage('playerMove')
  handlePlayerMove(@MessageBody() data: any, @ConnectedSocket() client: Socket) {
    const { roomCode, move } = data;
    const gameRoom = this.gameService.getRoom(roomCode);
    if (!gameRoom) return;

    if (move.isOpening) {
      this.gameService.setOpeningNumber(roomCode, move.number);
      this.server.to(roomCode).emit('moveApproved', { move, turnResult: null }); 
    } else {
      const isValid = this.gameService.isValidSudoku(roomCode, move.row, move.col, move.number);
      if (isValid) {
        gameRoom.board[move.row][move.col] = move.number;
        const turnResult = this.gameService.executeTurnEnd(roomCode, move.row, move.col, move.bigBox, move.number);
        this.server.to(roomCode).emit('moveApproved', { move, turnResult }); 
      }
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
}