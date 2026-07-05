const socket = io();

// 💡 1. 전역 상태 주머니 (GameState 역할)
let myId = null;
let currentRoomCode = '';
let myPlayerNumber = 0; // 1: 1P, 2: 2P, 0: 관전자
let playerNames = { 1: '', 2: '' };

let isGameStarted = false;
let isGameOver = false;
let isOpeningPhase = false;
let isFirstTurn = false;
let currentPlayer = 1;
let requiredNextBox = null;
let openingNumber = null;

let board = Array.from({length: 9}, () => Array(9).fill(0));
let gameHistory = [];
let lastMove = null;

let isMuted = false;
let timerInterval;
let timeLeft = 60;
let TURN_LIMIT = 60;

// 복기용 변수
let isSpectatorReviewMode = false;
let spectatorCurrentStep = 0;

// 방장 환경설정 변수
let serverConfigTurnLimit = 60;
let serverConfigTurnPref = 'RANDOM';

// 💡 2. 오디오 객체 설정
const sndBgm = new Audio('bgm.mp3'); sndBgm.loop = true; sndBgm.volume = 0.3;
const sndPencil = new Audio('pencil.mp3');
const sndBell = new Audio('bell.mp3');
const sndGameOver = new Audio('gameover.mp3');
const sndWin = new Audio('win.mp3');
const sndLose = new Audio('lose.mp3');
const emojiSounds = { '🤔': new Audio('hmm.mp3'), '👏': new Audio('clap.mp3'), '😭': new Audio('cry.mp3'), '😡': new Audio('angry.mp3'), '😎': new Audio('cool.mp3'), '😱': new Audio('scream.mp3') };

function toggleMute() {
    isMuted = !isMuted;
    document.getElementById('muteBtn').innerText = isMuted ? "🔇 소리 켜기" : "🔊 소리 끄기";
    if (isMuted) sndBgm.pause();
    else if (isGameStarted && !isGameOver) sndBgm.play().catch(()=>{});
}
function playSound(snd) {
    if (isMuted) return;
    try { snd.currentTime = 0; snd.play().catch(e=>{}); } catch(e) {}
}

// 💡 3. 로비 및 대기방 통신 로직
function quickStart() {
    const nick = document.getElementById('nicknameInput').value.trim() || '익명';
    socket.emit('quickStart', { nickname: nick });
}
function createPrivateRoom() {
    const nick = document.getElementById('nicknameInput').value.trim() || '익명';
    socket.emit('createRoom', { nickname: nick, isPrivate: true });
}

socket.on('roomJoined', (data) => {
    myId = data.myId;
    currentRoomCode = data.roomCode;
    document.getElementById('lobbyScreen').style.display = 'none';
    document.getElementById('waitingRoomScreen').style.display = 'block';
});

socket.on('roomStateUpdated', (data) => {
    const room = data.room;
    if (!room) return;
    document.getElementById('roomCodeDisplay').innerText = currentRoomCode;
    document.getElementById('hostConfigBtn').style.display = (socket.id === room.creator.id) ? 'block' : 'none';
    document.getElementById('startGameBtn').style.display = (socket.id === room.creator.id) ? 'block' : 'none';

    // 명단 및 권한 렌더링
    const waitUserList = document.getElementById('waitUserList');
    waitUserList.innerHTML = '';
    let users = [{ id: room.creator.id, nickname: room.creator.nickname, isHost: true }];
    if (room.guests) room.guests.forEach(g => users.push({ id: g.id, nickname: g.nickname, isHost: false }));
    document.getElementById('participantCount').innerText = users.length;

    users.forEach(u => {
        const div = document.createElement('div');
        div.style.padding = '5px 10px'; div.style.background = '#fff'; div.style.border = '1px solid #ddd'; div.style.borderRadius = '4px'; div.style.display = 'flex'; div.style.justifyContent = 'space-between'; div.style.fontSize = '22px';
        div.innerText = u.isHost ? `👑 ${u.nickname} (방장)` : `👤 ${u.nickname}`;
        
        if (socket.id === room.creator.id && !u.isHost) {
            const btnArea = document.createElement('div'); btnArea.style.display = 'flex'; btnArea.style.gap = '5px';
            const b1 = document.createElement('button'); b1.innerText = '1P 임명'; b1.onclick = () => socket.emit('assignSlotTarget', { roomCode: currentRoomCode, targetId: u.id, slot: 1 });
            const b2 = document.createElement('button'); b2.innerText = '2P 임명'; b2.onclick = () => socket.emit('assignSlotTarget', { roomCode: currentRoomCode, targetId: u.id, slot: 2 });
            btnArea.appendChild(b1); btnArea.appendChild(b2); div.appendChild(btnArea);
        }
        waitUserList.appendChild(div);
    });

    document.getElementById('p1SlotName').innerText = room.p1Name ? room.p1Name : `[비어있음]`;
    document.getElementById('p2SlotName').innerText = room.p2Name ? room.p2Name : `[비어있음]`;
    
    playerNames[1] = room.p1Name || '선공 대기자';
    playerNames[2] = room.p2Name || '후공 대기자';
    const hostCrown = (room.creator.id === room.p1Id) ? ' 👑' : '';
    const guestCrown = (room.creator.id === room.p2Id) ? ' 👑' : '';
    document.getElementById('p1Info').innerText = `선공: ${playerNames[1]}${hostCrown}`;
    document.getElementById('p2Info').innerText = `후공: ${playerNames[2]}${guestCrown}`;
});

function requestStartGame() { socket.emit('startGame', { roomCode: currentRoomCode }); }
function forceHostMigrationBeforeLeave() { if (currentRoomCode) socket.emit('leaveRoom', { roomCode: currentRoomCode }); }
function backToWaitingRoom() { forceHostMigrationBeforeLeave(); document.getElementById('gameOverScreen').style.display = 'none'; document.getElementById('gameContainer').style.display = 'none'; document.getElementById('waitingRoomScreen').style.display = 'block'; isGameOver = true; isGameStarted = false; }
function backToMainLobby() { forceHostMigrationBeforeLeave(); document.getElementById('gameOverScreen').style.display = 'none'; document.getElementById('gameContainer').style.display = 'none'; document.getElementById('waitingRoomScreen').style.display = 'none'; document.getElementById('lobbyScreen').style.display = 'block'; currentRoomCode = ''; isGameOver = true; isGameStarted = false; }

// 💡 4. 게임 시작 및 초기화 로직
socket.on('gameStart', (data) => {
    isGameStarted = true; isGameOver = false; gameHistory = []; lastMove = null;
    document.getElementById('waitingRoomScreen').style.display = 'none';
    document.getElementById('gameContainer').style.display = 'block';
    document.getElementById('gameOverScreen').style.display = 'none';

    myPlayerNumber = (data && data.roles) ? (data.roles[socket.id] || data.roles[myId] || 0) : 0; 
    TURN_LIMIT = (data && data.turnLimit) ? data.turnLimit : 60;

    document.getElementById('inGameSurrenderBtn').style.display = (myPlayerNumber === 0) ? 'none' : 'block';
    document.getElementById('spectatorReviewControls').style.display = (myPlayerNumber === 0) ? 'block' : 'none';
    document.getElementById('playerReviewControls').style.display = 'none';
    isSpectatorReviewMode = false;

    if (!isMuted) {
        sndBgm.currentTime = 0;
        const playPromise = sndBgm.play();
        if (playPromise !== undefined) playPromise.catch(()=>{ document.body.addEventListener('click', function forceBgm() { sndBgm.play().catch(()=>{}); document.body.removeEventListener('click', forceBgm); }, { once: true }); });
    }
    initBoard();
    updateUI();
});

function initBoard() {
    board = Array.from({length: 9}, () => Array(9).fill(0));
    const cells = document.querySelectorAll('.cell');
    
    cells.forEach(cell => {
        cell.innerText = ''; cell.style.backgroundColor = "transparent"; cell.classList.remove('hoverable', 'highlight-box', 'last-move');
        cell.onclick = function() {
            if (!isGameStarted || isGameOver || isSpectatorReviewMode || currentPlayer !== myPlayerNumber) return;
            const r = parseInt(this.dataset.row); const c = parseInt(this.dataset.col);
            if (board[r][c] !== 0) return; 

            const bigBox = getBoxFromRowCol(r, c);
            if (requiredNextBox !== null && bigBox !== requiredNextBox) return;

            if (isFirstTurn && isOpeningPhase === false) {
                // 선공의 역사적인 첫 배치!
                socket.emit('playerMove', { roomCode: currentRoomCode, move: { row: r, col: c, number: openingNumber, bigBox: bigBox, isOpening: false } });
            } else {
                openNumpadModal(false, r, c); 
            }
        };
    });
    
    isOpeningPhase = true; isFirstTurn = true; currentPlayer = 1; requiredNextBox = null;
    if (myPlayerNumber === 2) openNumpadModal(true); 
}
function getBoxFromRowCol(r, c) { return Math.floor(r / 3) * 3 + Math.floor(c / 3) + 1; }

// 💡 5. 코어 룰 엔진 (서버 데이터 수신부)
socket.on('moveApproved', (data) => {
    if (!data || !data.move) return;
    const isOpeningSignal = (data.move.isOpening === true || isOpeningPhase === true && gameHistory.length === 0);

    if (isOpeningSignal) {
        if (data.move.number) openingNumber = data.move.number;
        isOpeningPhase = false; isFirstTurn = true; currentPlayer = 1;
    } else {
        if (data.move.number === undefined) data.move.number = openingNumber;
        gameHistory.push({ row: data.move.row, col: data.move.col, number: data.move.number, player: currentPlayer });
        board[data.move.row][data.move.col] = data.move.number;
        lastMove = { row: data.move.row, col: data.move.col };
        if (myPlayerNumber === 0 && !isSpectatorReviewMode) spectatorCurrentStep = gameHistory.length;

        if (isFirstTurn) { currentPlayer = 2; isFirstTurn = false; } 
        else { currentPlayer = currentPlayer === 1 ? 2 : 1; }
        
        const nextBox = data.move.number;
        let isFull = true;
        const sr = Math.floor((nextBox - 1) / 3) * 3; const sc = ((nextBox - 1) % 3) * 3;
        for (let r = sr; r < sr + 3; r++) {
            for (let c = sc; c < sc + 3; c++) { if (board[r][c] === 0) { isFull = false; break; } }
        }
        requiredNextBox = isFull ? null : nextBox;
    }

    updateUI();
    if (data.move.number) playSound(sndPencil);
    startTimer(); 
});

// 💡 6. 다이나믹 UI 렌더러 (플레이어 색상 적용)
function updateUI() {
    if (isSpectatorReviewMode) return; 

    const cells = document.querySelectorAll('.cell');
    cells.forEach(cell => {
        const r = parseInt(cell.dataset.row); const c = parseInt(cell.dataset.col);
        const val = board[r][c]; const bigBox = getBoxFromRowCol(r, c);
        
        cell.innerText = val !== 0 ? val : '';
        cell.classList.remove('hoverable', 'highlight-box', 'last-move');
        cell.style.backgroundColor = "transparent"; cell.style.color = "#222"; 

        const moveInfo = gameHistory.find(h => h.row === r && h.col === c);
        if (moveInfo) { cell.style.color = moveInfo.player === 1 ? "#d32f2f" : "#1976d2"; cell.style.fontWeight = "bold"; }
        if (lastMove && lastMove.row === r && lastMove.col === c) cell.classList.add('last-move');

        if (isGameStarted && val === 0 && !isGameOver && !isOpeningPhase && currentPlayer === myPlayerNumber) {
            if (requiredNextBox === null || bigBox === requiredNextBox) {
                cell.classList.add('hoverable');
                if (requiredNextBox !== null) cell.classList.add('highlight-box');
            }
        }
    });

    if (!isGameStarted) return;
    const isMyTurn = (currentPlayer === myPlayerNumber);
    const turnEl = document.getElementById('turnIndicator');
    
    if (myPlayerNumber === 0) turnEl.innerText = `👀 관전 중 (현재 턴: ${playerNames[currentPlayer] || currentPlayer+'P'})`;
    else turnEl.innerText = isMyTurn ? `🟢 나의 턴 (${playerNames[currentPlayer]})` : `🔴 상대방 대기 중...`;

    document.getElementById('inGameSurrenderBtn').style.display = (myPlayerNumber === 0 || isGameOver) ? 'none' : 'block';
    
    const inGameChat = document.getElementById('inGameChatContainer');
    if (inGameChat) inGameChat.style.display = (myPlayerNumber !== 0 && !isGameOver) ? 'none' : 'flex';

    const hintEl = document.getElementById('hintText');
    if (isOpeningPhase) hintEl.innerText = myPlayerNumber === 2 ? "⏳ [오프닝] 선공이 쓸 첫 숫자를 골라주세요." : "⏳ 상대방이 첫 숫자를 정하고 있습니다.";
    else if (isFirstTurn) hintEl.innerText = isMyTurn ? `✨ 자유 구역. 원하는 빈칸에 [${openingNumber}] 기입.` : `상대방이 [${openingNumber}]를 배치 중입니다.`;
    else if (requiredNextBox !== null) hintEl.innerText = isMyTurn ? `💥 제약 조건: [${requiredNextBox}번 큰 칸] 내부에 놓으세요.` : `상대방이 [${requiredNextBox}번 큰 칸]에 배치 중입니다.`;
    else hintEl.innerText = isMyTurn ? "✨ 프리 턴: 빈칸을 자유롭게 클릭하세요." : "상대방이 프리 턴으로 배치 중입니다.";
}

// 💡 7. 모달창 컨트롤러
let selectedRow = -1; let selectedCol = -1; let isOpeningSelection = false;
function openNumpadModal(isOpening, r=-1, c=-1) {
    isOpeningSelection = isOpening; selectedRow = r; selectedCol = c;
    document.getElementById('numpadTitle').innerText = isOpening ? "선공이 쓸 오프닝 숫자 선택" : "기입할 숫자 선택";
    document.getElementById('numpadModal').style.display = 'flex';
}
function closeNumpadModal() { document.getElementById('numpadModal').style.display = 'none'; }
function selectNumber(num) {
    closeNumpadModal();
    if (isOpeningSelection) socket.emit('playerMove', { roomCode: currentRoomCode, move: { number: num, isOpening: true } });
    else socket.emit('playerMove', { roomCode: currentRoomCode, move: { row: selectedRow, col: selectedCol, number: num, isOpening: false } });
}
function openConfigModal() { if(myPlayerNumber === 1) { document.getElementById('modalTurnLimit').value = serverConfigTurnLimit; document.getElementById('modalTurnPref').value = serverConfigTurnPref; document.getElementById('configModal').style.display = 'flex'; } }
function closeConfigModal() { document.getElementById('configModal').style.display = 'none'; }
function saveConfigFromModal() {
    serverConfigTurnLimit = parseInt(document.getElementById('modalTurnLimit').value);
    serverConfigTurnPref = document.getElementById('modalTurnPref').value;
    socket.emit('updateRoomSettings', { roomCode: currentRoomCode, turnLimit: serverConfigTurnLimit, turnPref: serverConfigTurnPref });
    document.getElementById('currentConfigSummary').innerText = `시간 ${serverConfigTurnLimit}초 / 선후공: ` + (serverConfigTurnPref==='RANDOM' ? '🎲 랜덤' : (serverConfigTurnPref==='P1_FIRST' ? '🔴 1P 선공' : '🔵 2P 후공'));
    closeConfigModal();
}
function requestAssignSlot(slotNum) { socket.emit('assignRoomSlot', { roomCode: currentRoomCode, slot: slotNum }); }

// 💡 8. 타이머 및 정산 로직
function startTimer() {
    clearInterval(timerInterval); timeLeft = TURN_LIMIT;
    document.getElementById('timerBar').style.width = '100%'; document.getElementById('timerBar').style.backgroundColor = '#2ecc71';
    timerInterval = setInterval(() => {
        timeLeft--;
        const pct = (timeLeft / TURN_LIMIT) * 100;
        document.getElementById('timerBar').style.width = pct + '%';
        if (pct < 30) document.getElementById('timerBar').style.backgroundColor = '#e74c3c';
        else if (pct < 60) document.getElementById('timerBar').style.backgroundColor = '#f1c40f';
        if (timeLeft <= 0) { clearInterval(timerInterval); if (currentPlayer === myPlayerNumber) surrender(); }
    }, 1000);
}
function surrender() { socket.emit('surrender', { roomCode: currentRoomCode }); }

socket.on('gameOver', (data) => { endGame(data.winner, data.isSuffocated, data.isSurrendered); });

function endGame(gameWinner, isSuffocated, isSurrendered) {
    if (isGameOver) return;
    isGameOver = true; clearInterval(timerInterval);
    try { sndBgm.pause(); sndBgm.currentTime = 0; if(myPlayerNumber === gameWinner) playSound(sndWin); else if (myPlayerNumber!==0) playSound(sndLose); else playSound(sndGameOver); } catch(e) {}
    updateUI(); 
    
    const finalWinnerName = playerNames[gameWinner] || '우승자';
    const announce = document.getElementById('winnerAnounce');
    if (isSurrendered) announce.innerHTML = `🏃 누군가 기권/탈주했습니다!<br>🎉 승리: ${finalWinnerName}`;
    else if (isSuffocated) announce.innerHTML = `💀 더 이상 둘 곳이 없습니다 (질식)!<br>🎉 승리: ${finalWinnerName}`;
    else announce.innerHTML = `🎉 승리: ${finalWinnerName} !`;

    try { if (typeof confetti !== 'undefined' && (myPlayerNumber === gameWinner || myPlayerNumber === 0)) confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#f39c12', '#e74c3c', '#3498db', '#2ecc71'] }); } catch(e) {}
    
    const gameOverScreen = document.getElementById('gameOverScreen');
    gameOverScreen.style.display = 'flex'; gameOverScreen.style.pointerEvents = 'auto';
}

// 💡 9. 관전자 타임머신 복기 엔진
function startReviewMode() {
    document.getElementById('gameOverScreen').style.display = 'none'; document.getElementById('gameOverScreen').style.pointerEvents = 'none';
    isSpectatorReviewMode = true; 
    
    if (myPlayerNumber !== 0) { document.getElementById('playerReviewControls').style.display = 'block'; document.getElementById('spectatorReviewControls').style.display = 'none'; } 
    else { document.getElementById('spectatorReviewControls').style.display = 'block'; if (document.getElementById('specLiveBtn')) document.getElementById('specLiveBtn').style.display = 'none'; if (document.getElementById('specResultBtn')) document.getElementById('specResultBtn').style.display = 'inline-block'; }
    jumpToReviewStep(gameHistory.length);
}
function jumpToReviewStep(step) {
    if (gameHistory.length === 0) return;
    isSpectatorReviewMode = true; spectatorCurrentStep = step;
    if (spectatorCurrentStep < 0) spectatorCurrentStep = 0; if (spectatorCurrentStep > gameHistory.length) spectatorCurrentStep = gameHistory.length;
    const statusText = `🔎 복기 중 (${spectatorCurrentStep}/${gameHistory.length} 턴)`;
    if(document.getElementById('specReplayStatus')) document.getElementById('specReplayStatus').innerText = statusText;
    if(document.getElementById('playerReplayStatus')) document.getElementById('playerReplayStatus').innerText = statusText;
    playSound(sndPencil); renderVirtualBoardToStep(spectatorCurrentStep);
}
function stepSpectatorReplay(dir) { jumpToReviewStep(spectatorCurrentStep + dir); }
function showGameOverScreenAgain() { document.getElementById('gameOverScreen').style.display = 'flex'; document.getElementById('gameOverScreen').style.pointerEvents = 'auto'; }

function renderVirtualBoardToStep(step) {
    const cells = document.querySelectorAll('.cell');
    cells.forEach(c => { c.innerText = ''; c.style.backgroundColor = 'white'; c.style.color = '#222'; c.classList.remove('last-move'); });
    let virtualLastMove = null;
    for (let i = 0; i < step; i++) {
        const move = gameHistory[i];
        const targetCell = document.querySelector(`.cell[data-row="${move.row}"][data-col="${move.col}"]`);
        if (targetCell) {
            targetCell.innerText = move.number; targetCell.style.backgroundColor = '#e8f5e9'; targetCell.style.color = move.player === 1 ? "#d32f2f" : "#1976d2"; targetCell.style.fontWeight = "bold";
            virtualLastMove = { row: move.row, col: move.col };
        }
    }
    if (virtualLastMove) { const activeCell = document.querySelector(`.cell[data-row="${virtualLastMove.row}"][data-col="${virtualLastMove.col}"]`); if (activeCell) activeCell.classList.add('last-move'); }
}

// 💡 10. 채팅 및 이모티콘 처리
function sendRoomChat(type) {
    if (type === 'game' && myPlayerNumber !== 0 && !isGameOver) return alert("플레이어는 게임 중 채팅 금지!");
    const inputEl = document.getElementById(type === 'wait' ? 'waitChatInput' : 'gameChatInput');
    const msg = inputEl.value.trim(); if (!msg) return;
    socket.emit('sendChatMessage', { roomCode: currentRoomCode, message: msg, nickname: playerNames[myPlayerNumber] || "익명" });
    inputEl.value = ''; 
}
socket.on('receiveChatMessage', (data) => {
    const msgDiv = document.createElement('div'); msgDiv.innerText = `[${data.nickname}] ${data.message}`;
    const waitChat = document.getElementById('waitChatMessages'); const gameChat = document.getElementById('gameChatMessages');
    if(waitChat) { waitChat.appendChild(msgDiv.cloneNode(true)); waitChat.scrollTop = waitChat.scrollHeight; }
    if(gameChat) { gameChat.appendChild(msgDiv); gameChat.scrollTop = gameChat.scrollHeight; }
});
function toggleEmoticonPanel() { const panel = document.getElementById('emoticonPanel'); panel.style.display = panel.style.display === 'none' ? 'grid' : 'none'; }
function sendEmoticon(emoji) { toggleEmoticonPanel(); socket.emit('sendEmoticon', { roomCode: currentRoomCode, emoji: emoji }); }
socket.on('receiveEmoticon', (data) => {
    const emojiStr = data.emoji; if(emojiSounds[emojiStr]) playSound(emojiSounds[emojiStr]);
    const floating = document.createElement('div'); floating.innerText = `${data.nickname}: ${emojiStr}`; floating.style.position = 'absolute'; floating.style.left = '50%'; floating.style.bottom = '100px'; floating.style.transform = 'translateX(-50%)'; floating.style.fontSize = '30px'; floating.style.fontWeight = 'bold'; floating.style.color = '#fff'; floating.style.textShadow = '0 0 10px #000'; floating.style.zIndex = '9999'; floating.style.animation = 'floatUp 2s ease-out forwards';
    document.body.appendChild(floating);
    setTimeout(() => { floating.remove(); }, 2000);
});
const style = document.createElement('style'); style.innerHTML = `@keyframes floatUp { 0% { opacity: 1; bottom: 100px; } 100% { opacity: 0; bottom: 200px; } }`; document.head.appendChild(style);