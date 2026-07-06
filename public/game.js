const socket = io();

// 💡 1. 전역 게임 주머니 상태 고정
let myId = null;
let currentRoomCode = '';
let myPlayerNumber = 0; 
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

// 오디오 사운드 주머니
const sndBgm = new Audio('bgm.mp3'); sndBgm.loop = true;
const sndPencil = new Audio('pencil.mp3');
const sndBell = new Audio('bell.mp3');
const sndGameOver = new Audio('gameover.mp3');
const sndWin = new Audio('win.mp3');
const sndLose = new Audio('lose.mp3');
const emojiSounds = { '🤔': new Audio('hmm.mp3'), '👏': new Audio('clap.mp3'), '😭': new Audio('cry.mp3'), '😡': new Audio('angry.mp3'), '😎': new Audio('cool.mp3'), '😱': new Audio('scream.mp3') };

let bgmVol = 0.3; 
let sfxVol = 1.0;
let timerInterval;
let timeLeft = 60;
let TURN_LIMIT = 60;

// 복기 상태 주머니
let isSpectatorReviewMode = false;
let spectatorCurrentStep = 0;

let serverConfigTurnLimit = 60;
let serverConfigTurnPref = 'RANDOM';

// 💡 2. 볼륨 조절 모달 제어판
function openVolumeModal() { document.getElementById('volumeModal').style.display = 'flex'; }
function closeVolumeModal() { document.getElementById('volumeModal').style.display = 'none'; }

document.getElementById('bgmVolumeSlider').addEventListener('input', (e) => { 
    bgmVol = e.target.value; sndBgm.volume = bgmVol; 
    if(bgmVol > 0 && isGameStarted && !isGameOver) sndBgm.play().catch(()=>{});
});
document.getElementById('sfxVolumeSlider').addEventListener('input', (e) => { sfxVol = e.target.value; });

function playSound(snd) {
    if (sfxVol == 0) return;
    try { snd.volume = sfxVol; snd.currentTime = 0; snd.play().catch(e=>{}); } catch(e) {}
}

// 💡 3. 초대 링크 감지 및 방 입장
window.onload = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');
    if (roomFromUrl) {
        document.getElementById('joinCodeInput').value = roomFromUrl;
        document.getElementById('nicknameInput').focus();
    }
};

function createNewRoom(isPrivate) {
    const nick = document.getElementById('nicknameInput').value.trim() || '익명';
    socket.emit('createRoom', { nickname: nick, isPrivate: isPrivate });
}
function joinRoomByCode() {
    const nick = document.getElementById('nicknameInput').value.trim() || '익명';
    const code = document.getElementById('joinCodeInput').value.trim();
    if (!code) return alert("입장할 방 코드를 입력해주세요!");
    socket.emit('joinRoom', { roomCode: code, nickname: nick });
}
function copyInviteLink() {
    const link = document.getElementById('inviteLinkDisplay').innerText;
    navigator.clipboard.writeText(link).then(() => { alert("초대 링크가 복사되었습니다!"); });
}

socket.on('joinError', (msg) => { alert(msg); });

socket.on('roomJoined', (data) => {
    myId = data.myId;
    currentRoomCode = data.roomCode;
    document.getElementById('lobbyScreen').style.display = 'none';
    document.getElementById('waitingRoomScreen').style.display = 'block';
    
    const inviteUrl = window.location.origin + window.location.pathname + '?room=' + currentRoomCode;
    document.getElementById('inviteLinkDisplay').innerText = inviteUrl;
    window.history.replaceState({}, '', '?room=' + currentRoomCode);
});

socket.on('roomStateUpdated', (data) => {
    const room = data.room;
    if (!room) return;
    document.getElementById('roomCodeDisplay').innerText = currentRoomCode;
    
    // 🛡️ 핵심 수정: isMeHost 일회용 변수를 버리고 전역 변수 isHost를 갱신합니다!
    isHost = (myId === room.creator.id);
    document.getElementById('hostConfigBtn').style.display = isHost ? 'block' : 'none';

    serverConfigTurnLimit = room.turnLimit || 60;
    serverConfigTurnPref = room.turnPref || 'RANDOM';
    const prefText = serverConfigTurnPref === 'RANDOM' ? '🎲 랜덤' : (serverConfigTurnPref === 'P1_FIRST' ? '🔴 1P 선공' : '🔵 2P 후공');
    const configSummary = document.getElementById('currentConfigSummary');
    if (configSummary) configSummary.innerText = `시간 ${serverConfigTurnLimit}초 / 선후공: ${prefText}`;

    const waitUserList = document.getElementById('waitUserList');
    waitUserList.innerHTML = '';
    let users = [{ id: room.creator.id, nickname: room.creator.nickname, isHost: true }];
    if (room.guests) room.guests.forEach(g => users.push({ id: g.id, nickname: g.nickname, isHost: false }));
    document.getElementById('participantCount').innerText = users.length;

    users.forEach(u => {
        const div = document.createElement('div');
        div.style.padding = '5px 10px'; div.style.background = '#fff'; div.style.border = '1px solid #ddd'; div.style.borderRadius = '4px'; div.style.display = 'flex'; div.style.justifyContent = 'space-between'; div.style.alignItems = 'center'; div.style.fontSize = '22px';
        div.innerText = u.isHost ? `👑 ${u.nickname} (방장)` : `👤 ${u.nickname}`;
        
        if (isHost && !u.isHost) {
            const btnArea = document.createElement('div'); btnArea.style.display = 'flex'; btnArea.style.gap = '5px';
            const b1 = document.createElement('button'); b1.innerText = '1P 임명'; b1.className = 'btn-small';
            b1.onclick = () => socket.emit('assignSlotTarget', { roomCode: currentRoomCode, targetId: u.id, slot: 1 });
            const b2 = document.createElement('button'); b2.innerText = '2P 임명'; b2.className = 'btn-small';
            b2.onclick = () => socket.emit('assignSlotTarget', { roomCode: currentRoomCode, targetId: u.id, slot: 2 });
            const b3 = document.createElement('button'); b3.innerText = '방장 위임'; b3.className = 'btn-small'; b3.style.background = '#f1c40f';
            b3.onclick = () => socket.emit('delegateHost', { roomCode: currentRoomCode, targetId: u.id });
            const b4 = document.createElement('button'); b4.innerText = '추방'; b4.className = 'btn-small'; b4.style.background = '#e74c3c'; b4.style.color = 'white';
            b4.onclick = () => socket.emit('kickUser', { roomCode: currentRoomCode, targetId: u.id });

            btnArea.appendChild(b1); btnArea.appendChild(b2); btnArea.appendChild(b3); btnArea.appendChild(b4);
            div.appendChild(btnArea);
        }
        waitUserList.appendChild(div);
    });

    const p1IsReady = room.p1Ready || (room.p1Id && room.p1Id === room.creator.id);
    const p2IsReady = room.p2Ready || (room.p2Id && room.p2Id === room.creator.id);
    const canStart = room.p1Id && room.p2Id && p1IsReady && p2IsReady;

    const startBtn = document.getElementById('startGameBtn');
    startBtn.style.display = isHost ? 'block' : 'none';
    startBtn.disabled = !canStart;
    startBtn.style.opacity = canStart ? '1' : '0.5';
    if(isHost) startBtn.innerText = canStart ? "🎮 게임 시작" : "⏳ 플레이어 준비 대기 중...";

    const readyBtn = document.getElementById('readyBtn');
    const amIPlayer = (myId === room.p1Id || myId === room.p2Id);
    if (!isHost && amIPlayer) {
        readyBtn.style.display = 'block';
        const myReadyState = (myId === room.p1Id) ? room.p1Ready : room.p2Ready;
        readyBtn.innerText = myReadyState ? "✅ 준비 완료 (취소)" : "✅ 게임 준비";
        readyBtn.style.background = myReadyState ? "#e67e22" : "#3498db";
    } else {
        readyBtn.style.display = 'none';
    }

    const p1ReadyText = p1IsReady && room.p1Id ? " [✅준비 완료]" : "";
    const p2ReadyText = p2IsReady && room.p2Id ? " [✅준비 완료]" : "";
    document.getElementById('p1SlotName').innerText = room.p1Name ? `${room.p1Name}${p1ReadyText}` : `[비어있음]`;
    document.getElementById('p2SlotName').innerText = room.p2Name ? `${room.p2Name}${p2ReadyText}` : `[비어있음]`;
    
    playerNames[1] = room.p1Name || '선공 대기자';
    playerNames[2] = room.p2Name || '후공 대기자';
    const hostCrown = (room.creator.id === room.p1Id) ? ' 👑' : '';
    const guestCrown = (room.creator.id === room.p2Id) ? ' 👑' : '';
    const p1Info = document.getElementById('p1Info');
    const p2Info = document.getElementById('p2Info');
    if(p1Info) p1Info.innerText = `선공: ${playerNames[1]}${hostCrown}`;
    if(p2Info) p2Info.innerText = `후공: ${playerNames[2]}${guestCrown}`;
});

function toggleReady() {
    const readyBtn = document.getElementById('readyBtn');
    const currentReady = readyBtn.innerText.includes("준비 완료");
    socket.emit('toggleReady', { roomCode: currentRoomCode, isReady: !currentReady });
}
function requestStartGame() { socket.emit('startGame', { roomCode: currentRoomCode }); }
function forceHostMigrationBeforeLeave() { if (currentRoomCode) socket.emit('leaveRoom', { roomCode: currentRoomCode }); }
function backToWaitingRoom() { forceHostMigrationBeforeLeave(); document.getElementById('gameOverScreen').style.display = 'none'; document.getElementById('gameContainer').style.display = 'none'; document.getElementById('waitingRoomScreen').style.display = 'block'; isGameOver = true; isGameStarted = false; }
function backToMainLobby() { forceHostMigrationBeforeLeave(); document.getElementById('gameOverScreen').style.display = 'none'; document.getElementById('gameContainer').style.display = 'none'; document.getElementById('waitingRoomScreen').style.display = 'none'; document.getElementById('lobbyScreen').style.display = 'block'; currentRoomCode = ''; isGameOver = true; isGameStarted = false; window.history.replaceState({}, '', window.history.pathname); }

// 💡 5. 인게임 진입 및 보드판 실시간 복구 렌더링
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

    if (bgmVol > 0) {
        sndBgm.volume = bgmVol; sndBgm.currentTime = 0;
        sndBgm.play().catch(()=>{ document.body.addEventListener('click', () => { if(bgmVol>0) sndBgm.play().catch(()=>{}); }, { once: true }); });
    }
    
    // 🛡️ [2번 완벽 해결] 파편화되었던 보드판 레이아웃을 81개의 격자로 실시간 조립 후 강제 사출!
    initBoard();
    updateUI();
});

function initBoard() {
    const boardEl = document.getElementById('sudokuBoard');
    boardEl.innerHTML = ''; 
    board = Array.from({length: 9}, () => Array(9).fill(0));

    for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
            const cell = document.createElement('div');
            cell.className = 'cell'; cell.dataset.row = r; cell.dataset.col = c;
            
            cell.onclick = function() {
                if (!isGameStarted || isGameOver || isSpectatorReviewMode || currentPlayer !== myPlayerNumber) return;
                const row = parseInt(this.dataset.row); const col = parseInt(this.dataset.col);
                if (board[row][col] !== 0) return; 

                const bigBox = getBoxFromRowCol(row, col);
                if (requiredNextBox !== null && bigBox !== requiredNextBox) return;

                if (isFirstTurn && isOpeningPhase === false) {
                    socket.emit('playerMove', { roomCode: currentRoomCode, move: { row: row, col: col, number: openingNumber, bigBox: bigBox, isOpening: false } });
                } else {
                    openNumpadModal(false, row, col); 
                }
            };
            boardEl.appendChild(cell);
        }
    }
    isOpeningPhase = true; isFirstTurn = true; currentPlayer = 1; requiredNextBox = null;
    if (myPlayerNumber === 2) openNumpadModal(true); 
}
function getBoxFromRowCol(r, c) { return Math.floor(r / 3) * 3 + Math.floor(c / 3) + 1; }

// 💡 6. [3번 완벽 해결] 코어 룰 엔진 및 정밀 턴 핑퐁 시스템
socket.on('moveApproved', (data) => {
    if (!data || !data.move) return;
    const isOpeningSignal = (data.move.isOpening === true || isOpeningPhase === true && gameHistory.length === 0);

    if (isOpeningSignal) {
        if (data.move.number) openingNumber = data.move.number;
        isOpeningPhase = false; isFirstTurn = true; currentPlayer = 1; // 선공에게 첫 수 고정 권한 배정
    } else {
        if (data.move.number === undefined) data.move.number = openingNumber;
        
        // 🛡️ 프리턴 꼬임 전면 수술: 현재 보드를 둔 유저의 정확한 명의(currentPlayer)를 기보에 확정 각인!
        gameHistory.push({ row: data.move.row, col: data.move.col, number: data.move.number, player: currentPlayer });
        board[data.move.row][data.move.col] = data.move.number;
        lastMove = { row: data.move.row, col: data.move.col };
        if (myPlayerNumber === 0 && !isSpectatorReviewMode) spectatorCurrentStep = gameHistory.length;

        // 🛡️ 순서 교대 엇박자 전면 격파
        if (isFirstTurn) { 
            currentPlayer = 2; isFirstTurn = false; // 선공 첫 수 완료 -> 후공(2P)의 턴으로 전환
        } else { 
            currentPlayer = currentPlayer === 1 ? 2 : 1; // 1P <-> 2P 무한 핑퐁 교대 보장
        }
        
        // 다음 사람의 강제 칸 자체 계산
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
    
    // 🛡️ [4번 완벽 해결] 수가 제대로 성립되어 내려왔으므로 60초 타이머를 강제로 리셋 후 리스타트!
    startTimer(); 
});

function updateUI() {
    if (isSpectatorReviewMode) return; 

    const cells = document.querySelectorAll('.cell');
    cells.forEach(cell => {
        const r = parseInt(cell.dataset.row); const c = parseInt(cell.dataset.col);
        const val = board[r][c]; const bigBox = getBoxFromRowCol(r, c);
        
        cell.innerText = val !== 0 ? val : '';
        cell.classList.remove('hoverable', 'highlight-box', 'last-move');
        
        // 🛡️ 핵심 수정: 칸 배경색을 무조건 하얀색으로 깔아줍니다!
        cell.style.backgroundColor = "#fff"; 
        cell.style.color = "#222"; 

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

// 💡 8. 모달 제어 시스템
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
function openConfigModal() { if(isHost) { document.getElementById('modalTurnLimit').value = serverConfigTurnLimit; document.getElementById('modalTurnPref').value = serverConfigTurnPref; document.getElementById('configModal').style.display = 'flex'; } }
function closeConfigModal() { document.getElementById('configModal').style.display = 'none'; }
function saveConfigFromModal() {
    serverConfigTurnLimit = parseInt(document.getElementById('modalTurnLimit').value);
    serverConfigTurnPref = document.getElementById('modalTurnPref').value;
    socket.emit('updateRoomSettings', { roomCode: currentRoomCode, turnLimit: serverConfigTurnLimit, turnPref: serverConfigTurnPref });
    closeConfigModal();
}

// 💡 9. [4번 완벽 해결] 카운트다운 타이머 구동 엔진
function startTimer() {
    clearInterval(timerInterval); timeLeft = TURN_LIMIT;
    const bar = document.getElementById('timerBar');
    bar.style.width = '100%'; bar.style.backgroundColor = '#2ecc71';
    
    timerInterval = setInterval(() => {
        timeLeft--;
        const pct = (timeLeft / TURN_LIMIT) * 100;
        bar.style.width = pct + '%';
        if (pct < 30) bar.style.backgroundColor = '#e74c3c';
        else if (pct < 60) bar.style.backgroundColor = '#f1c40f';
        
        if (timeLeft <= 0) { 
            clearInterval(timerInterval); 
            if (currentPlayer === myPlayerNumber) surrender(); // 타임오버 탈주 정산 패배 처리
        }
    }, 1000);
}
function surrender() { socket.emit('surrender', { roomCode: currentRoomCode }); }

socket.on('gameOver', (data) => { endGame(data.winner, data.isSuffocated, data.isSurrendered); });
socket.on('kickedOut', () => { alert("대기방에서 강제 퇴장되었습니다."); backToMainLobby(); });

function endGame(gameWinner, isSuffocated, isSurrendered) {
    if (isGameOver) return;
    isGameOver = true; clearInterval(timerInterval);
    
    try { 
        sndBgm.pause(); sndBgm.currentTime = 0; 
        // 🛡️ 기존에 가지고 계시던 gameover.mp3 하나만 재생하도록 원상 복구합니다.
        playSound(sndGameOver); 
    } catch(e) {}
    
    updateUI(); 
    
    const finalWinnerName = playerNames[gameWinner] || '우승자';
    const announce = document.getElementById('winnerAnounce');
    if (isSurrendered) announce.innerHTML = `🏃 누군가 기권/탈주했습니다!<br>🎉 승리: ${finalWinnerName}`;
    else if (isSuffocated) announce.innerHTML = `💀 더 이상 둘 곳이 없습니다 (질식)!<br>🎉 승리: ${finalWinnerName}`;
    else announce.innerHTML = `🎉 승리: ${finalWinnerName} !`;

    try { if (typeof confetti !== 'undefined' && (myPlayerNumber === gameWinner || myPlayerNumber === 0)) confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#f39c12', '#e74c3c', '#3498db', '#2ecc71'] }); } catch(e) {}
    
    document.getElementById('gameOverScreen').style.display = 'flex'; document.getElementById('gameOverScreen').style.pointerEvents = 'auto';
}

// 💡 10. [5번 완벽 해결] 원하는 수 입력 및 타임 점프 복기 모드
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
    
    // 🛡️ 입력상자의 숫자와 텍스트를 실시간으로 최대 턴 수에 동기화합니다.
    const specInput = document.getElementById('specMoveDirectInput');
    const playerInput = document.getElementById('playerMoveDirectInput');
    if(specInput) specInput.value = spectatorCurrentStep;
    if(playerInput) playerInput.value = spectatorCurrentStep;

    document.getElementById('specReplayStatus').innerText = `/ ${gameHistory.length} 턴`;
    document.getElementById('playerReplayStatus').innerText = `/ ${gameHistory.length} 턴`;
    
    playSound(sndPencil); renderVirtualBoardToStep(spectatorCurrentStep);
}

function stepSpectatorReplay(dir) { jumpToReviewStep(spectatorCurrentStep + dir); }
function showGameOverScreenAgain() { document.getElementById('gameOverScreen').style.display = 'flex'; document.getElementById('gameOverScreen').style.pointerEvents = 'auto'; }

// 💡 [5번 핵심] 엔터키 혹은 입력값 변경 시 호출되어 타임 점프를 일으키는 브릿지 함수
function directJumpFromInput(type) {
    const inputId = type === 'spec' ? 'specMoveDirectInput' : 'playerMoveDirectInput';
    const targetStep = parseInt(document.getElementById(inputId).value);
    if (!isNaN(targetStep)) jumpToReviewStep(targetStep);
}

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

// 💡 11. 채팅 및 소통 중계
function sendRoomChat(type) {
    if (type === 'game' && myPlayerNumber !== 0 && !isGameOver) return alert("플레이어는 게임 중 채팅 금지!");
    const inputEl = document.getElementById(type === 'wait' ? 'waitChatInput' : 'gameChatInput');
    const msg = inputEl.value.trim(); if (!msg) return;
    const nick = document.getElementById('nicknameInput').value || '익명';
    socket.emit('sendChatMessage', { roomCode: currentRoomCode, message: msg, nickname: nick });
    inputEl.value = ''; 
}
socket.on('receiveChatMessage', (data) => {
    const msgDiv = document.createElement('div'); msgDiv.innerText = `[${data.nickname}] ${data.message}`;
    const waitChat = document.getElementById('waitChatMessages'); const gameChat = document.getElementById('gameChatMessages');
    if(waitChat) { waitChat.appendChild(msgDiv.cloneNode(true)); waitChat.scrollTop = waitChat.scrollHeight; }
    if(gameChat) { gameChat.appendChild(msgDiv); gameChat.scrollTop = gameChat.scrollHeight; }
});
function toggleEmoticonPanel() { const panel = document.getElementById('emoticonPanel'); panel.style.display = panel.style.display === 'none' ? 'grid' : 'none'; }
function sendEmoticon(emoji) { toggleEmoticonPanel(); const nick = document.getElementById('nicknameInput').value || '익명'; socket.emit('sendEmoticon', { roomCode: currentRoomCode, emoji: emoji, nickname: nick }); }
socket.on('receiveEmoticon', (data) => {
    const emojiStr = data.emoji; if(emojiSounds[emojiStr]) playSound(emojiSounds[emojiStr]);
    const floating = document.createElement('div'); floating.innerText = `${data.nickname}: ${emojiStr}`; floating.style.position = 'absolute'; floating.style.left = '50%'; floating.style.bottom = '100px'; floating.style.transform = 'translateX(-50%)'; floating.style.fontSize = '30px'; floating.style.fontWeight = 'bold'; floating.style.color = '#fff'; floating.style.textShadow = '0 0 10px #000'; floating.style.zIndex = '9999'; floating.style.animation = 'floatUp 2s ease-out forwards';
    document.body.appendChild(floating); setTimeout(() => { floating.remove(); }, 2000);
});
const style = document.createElement('style'); style.innerHTML = `@keyframes floatUp { 0% { opacity: 1; bottom: 100px; } 100% { opacity: 0; bottom: 200px; } }`; document.head.appendChild(style);