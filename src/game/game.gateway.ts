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

  private broadcastRoomState(roomCode: string) {
    const room = this.matchingRooms[roomCode];
    // 💡 [버그 픽스] 클라이언트가 방 코드를 헷갈리지 않게 객체에 확실히 담아서 보냅니다.
    if (room) this.server.to(roomCode).emit('roomStateUpdated', { roomCode, ...room });
  }

  handleDisconnect(client: Socket) {
    for (const roomCode in this.matchingRooms) {
      const room = this.matchingRooms[roomCode];
      
      if (room.creator.id === client.id) {
        this.server.to(roomCode).emit('roomDestroyed');
        delete this.matchingRooms[roomCode];
      } else {
        const guestIndex = room.guests.findIndex((g: any) => g.id === client.id);
        if (guestIndex !== -1) {
          room.guests.splice(guestIndex, 1);
          if (room.selectedGuestId === client.id) {
            room.selectedGuestId = room.guests.length > 0 ? room.guests[0].id : null;
          }
          this.broadcastRoomState(roomCode);
        }
      }
    }
  }

  @SubscribeMessage('createRoom')
  handleCreateRoom(@MessageBody() data: { nickname: string }, @ConnectedSocket() client: Socket) {
    const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    this.matchingRooms[roomCode] = {
      creator: { id: client.id, nickname: data.nickname },
      guests: [],
      selectedGuestId: null,
    };
    client.join(roomCode);
    client.emit('roomJoined', { roomCode, isHost: true, myId: client.id });
    this.broadcastRoomState(roomCode);
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
  @SubscribeMessage('sendEmoticon')
  handleSendEmoticon(@MessageBody() data: { roomCode: string; emoticon: string }, @ConnectedSocket() client: Socket) {
    const room = this.matchingRooms[data.roomCode];
    if (!room) return;
    
    // 누가 보냈는지 닉네임 찾기
    let senderName = "관전자";
    if (room.creator.id === client.id) senderName = room.creator.nickname;
    else {
      const guest = room.guests.find((g: any) => g.id === client.id);
      if (guest) senderName = guest.nickname;
    }
    
    // 방 전체에 이모티콘 방송
    this.server.to(data.roomCode).emit('receiveEmoticon', { senderName, emoticon: data.emoticon });
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
      roles: { [room.creator.id]: creatorRole, [selectedGuest.id]: guestRole }
    });
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
}