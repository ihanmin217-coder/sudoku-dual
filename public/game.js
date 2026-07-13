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

let scores = { 1: 0, 2: 0 };
let boxOwners = Array(10).fill(0); // 1번~9번 큰 구역의 주인 (0: 없음, 1: 1P, 2: 2P)
let rowOwners = Array(9).fill(0); // 0~8 가로줄
let colOwners = Array(9).fill(0); // 0~8 세로줄

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
    socket.emit('requestRoomList'); // 🛡️ 방 목록 요청 신호 발사!
    
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');
    if (roomFromUrl) {
        document.getElementById('joinCodeInput').value = roomFromUrl;
        document.getElementById('nicknameInput').focus();
    }
};

socket.on('roomListUpdated', (roomList) => {
    const container = document.getElementById('roomListContainer');
    if (!container) return;
    
    container.innerHTML = '';
    if (!roomList || roomList.length === 0) {
        container.innerHTML = '<div style="color: #888; text-align: center; font-size: 22px; padding: 10px;">개설된 공개방이 없습니다.</div>';
        return;
    }
    roomList.forEach(r => {
        const div = document.createElement('div');
        div.style.padding = '10px'; div.style.borderBottom = '1px solid #ccc';
        div.style.display = 'flex'; div.style.justifyContent = 'space-between'; div.style.alignItems = 'center';
        div.innerHTML = `<span style="font-size: 22px;">👑 ${r.hostName} 님의 방 (${r.playerCount}명)</span>
                         <button class="btn-small" style="background:#3498db; color:white;" onclick="document.getElementById('joinCodeInput').value='${r.roomCode}'; joinRoomByCode();">입장</button>`;
        container.appendChild(div);
    });
});

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
        
        // 💡 [버그 1 해결] 이제 '방장 본인'을 포함한 모든 사람의 닉네임 옆에 임명 버튼이 뜹니다!
        if (isHost) {
            const btnArea = document.createElement('div'); btnArea.style.display = 'flex'; btnArea.style.gap = '5px';
            const b1 = document.createElement('button'); b1.innerText = '1P 임명'; b1.className = 'btn-small';
            b1.onclick = () => socket.emit('assignSlotTarget', { roomCode: currentRoomCode, targetId: u.id, slot: 1 });
            const b2 = document.createElement('button'); b2.innerText = '2P 임명'; b2.className = 'btn-small';
            b2.onclick = () => socket.emit('assignSlotTarget', { roomCode: currentRoomCode, targetId: u.id, slot: 2 });
            btnArea.appendChild(b1); btnArea.appendChild(b2);

            if (!u.isHost) {
                // 본인이 아닌 게스트라면 위임/추방 버튼 표시
                const b3 = document.createElement('button'); b3.innerText = '방장 위임'; b3.className = 'btn-small'; b3.style.background = '#f1c40f';
                b3.onclick = () => socket.emit('delegateHost', { roomCode: currentRoomCode, targetId: u.id });
                const b4 = document.createElement('button'); b4.innerText = '추방'; b4.className = 'btn-small'; b4.style.background = '#e74c3c'; b4.style.color = 'white';
                b4.onclick = () => socket.emit('kickUser', { roomCode: currentRoomCode, targetId: u.id });
                btnArea.appendChild(b3); btnArea.appendChild(b4);
            } else {
                // 💡 [관전자 선택 기능] 본인(방장)이라면 자리를 비우고 관전자로 빠지는 버튼 추가!
                const b5 = document.createElement('button'); b5.innerText = '관전자로 전환'; b5.className = 'btn-small'; b5.style.background = '#95a5a6'; b5.style.color = 'white';
                b5.onclick = () => socket.emit('assignSlotTarget', { roomCode: currentRoomCode, targetId: u.id, slot: 0 });
                btnArea.appendChild(b5);
            }
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
    scores = { 1: 0, 2: 0 };
    boxOwners = Array(10).fill(0);
    rowOwners = Array(9).fill(0);
    colOwners = Array(9).fill(0);
    
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
                    // 🛡️ 첫 배치 시 스도쿠 룰 강력 검사!
                    if (!isValidSudokuMove(row, col, openingNumber)) return alert("스도쿠 규칙 위반입니다! (가로, 세로, 3x3 박스 내에 이미 같은 숫자가 있습니다)");
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
    const isOpeningSignal = (data.move.isOpening === true || (isOpeningPhase === true && gameHistory.length === 0));

    if (isOpeningSignal) {
        if (data.move.number) openingNumber = data.move.number;
        isOpeningPhase = false; isFirstTurn = true; currentPlayer = 1;
    } else {
        if (data.move.number === undefined) data.move.number = openingNumber;
        
        const placedRow = data.move.row;
        const placedCol = data.move.col;
        const placedNum = data.move.number;
        const mover = currentPlayer; // 방금 수를 둔 플레이어

        gameHistory.push({ row: placedRow, col: placedCol, number: placedNum, player: mover });
        board[placedRow][placedCol] = placedNum;
        lastMove = { row: placedRow, col: placedCol };
        if (myPlayerNumber === 0 && !isSpectatorReviewMode) spectatorCurrentStep = gameHistory.length;

        // 🛡️ 1. 방금 숫자를 둔 위치를 기준으로 3x3 구역, 가로줄, 세로줄 완성 여부 동시 스캔!
        const targetBox = getBoxFromRowCol(placedRow, placedCol);
        let pointsGained = 0;

        // ① 3x3 구역 검사
        if (boxOwners[targetBox] === 0 && isBoxCompletelyFilled(targetBox)) {
            boxOwners[targetBox] = mover;
            pointsGained += 1;
        }
        // ② 가로줄 검사
        if (rowOwners[placedRow] === 0 && isRowCompletelyFilled(placedRow)) {
            rowOwners[placedRow] = mover;
            pointsGained += 1;
        }
        // ③ 세로줄 검사
        if (colOwners[placedCol] === 0 && isColCompletelyFilled(placedCol)) {
            colOwners[placedCol] = mover;
            pointsGained += 1;
        }

        // 🛡️ 1. 방금 숫자를 둔 위치를 기준으로 3x3 구역, 가로줄, 세로줄 완성 여부 동시 스캔!
        const targetBox = getBoxFromRowCol(placedRow, placedCol);
        let pointsGained = 0;

        // ① 3x3 구역 검사
        if (boxOwners[targetBox] === 0 && isBoxCompletelyFilled(targetBox)) {
            boxOwners[targetBox] = mover;
            pointsGained += 1;
        }
        // ② 가로줄 검사
        if (rowOwners[placedRow] === 0 && isRowCompletelyFilled(placedRow)) {
            rowOwners[placedRow] = mover;
            pointsGained += 1;
        }
        // ③ 세로줄 검사
        if (colOwners[placedCol] === 0 && isColCompletelyFilled(placedCol)) {
            colOwners[placedCol] = mover;
            pointsGained += 1;
        }

        // 점수를 하나라도 얻었다면?
        if (pointsGained > 0) {
            scores[mover] += pointsGained;
            playSound(sndBell); // 띠링! 점수 획득 알림음

            // 🛡️ [승리 조건 1] 2점 이상 따내면 즉시 우승! (한 방에 2점 이상 콤보 획득도 포함)
            if (scores[mover] >= 2) {
                updateUI();
                if (mover === myPlayerNumber) {
                    socket.emit('claimVictory', { roomCode: currentRoomCode, winner: mover, reason: 'SCORE_LIMIT' });
                }
                return;
            }
        }

        // 턴 교대
        if (isFirstTurn) { currentPlayer = 2; isFirstTurn = false; } 
        else { currentPlayer = currentPlayer === 1 ? 2 : 1; }
        
        // 다음 사람이 가야 할 강제 구역 계산
        const nextBox = placedNum;
        requiredNextBox = isBoxCompletelyFilled(nextBox) ? null : nextBox;

        // 🛡️ 2. [승리 조건 2] 강제된 구역(requiredNextBox)에 빈칸이 있어도 둘 수 있는 숫자가 없으면 '질식 승리'!
        if (requiredNextBox !== null && isPlayerSuffocated(requiredNextBox)) {
            updateUI();
            if (mover === myPlayerNumber) {
                // 상대를 질식시킨 플레이어가 서버에 승리를 선언!
                socket.emit('claimVictory', { roomCode: currentRoomCode, winner: mover, reason: 'SUFFOCATION' });
            }
            return;
        }
    }

    updateUI();
    if (data.move.number) playSound(sndPencil);
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
        
        // 🛡️ 점령된 구역은 소유자의 색상으로 연하게 물듭니다! (1P: 연한 붉은색, 2P: 연한 파란색)
        let cellOwner = 0;
        const isOwnedByP1 = (boxOwners[bigBox] === 1 || rowOwners[r] === 1 || colOwners[c] === 1);
        const isOwnedByP2 = (boxOwners[bigBox] === 2 || rowOwners[r] === 2 || colOwners[c] === 2);
        
        // 만약 1P의 점령선과 2P의 점령선이 교차하는 칸이라면 연한 보라색으로 표시
        if (isOwnedByP1 && isOwnedByP2) cellOwner = 3; 
        else if (isOwnedByP1) cellOwner = 1;
        else if (isOwnedByP2) cellOwner = 2;

        if (cellOwner === 1) cell.style.backgroundColor = "#ffebee"; // 1P 연한 붉은색
        else if (cellOwner === 2) cell.style.backgroundColor = "#e3f2fd"; // 2P 연한 파란색
        else if (cellOwner === 3) cell.style.backgroundColor = "#f3e5f5"; // 교차 영역 보라색
        else cell.style.backgroundColor = "#fff";
    });

    if (!isGameStarted) return;
    const isMyTurn = (currentPlayer === myPlayerNumber);
    const turnEl = document.getElementById('turnIndicator');
    
    if (myPlayerNumber === 0) turnEl.innerText = `👀 관전 중 (현재 턴: ${playerNames[currentPlayer] || currentPlayer+'P'})`;
    else turnEl.innerText = isMyTurn ? `🟢 나의 턴 (${playerNames[currentPlayer]})` : `🔴 상대방 대기 중...`;

    document.getElementById('inGameSurrenderBtn').style.display = (myPlayerNumber === 0 || isGameOver) ? 'none' : 'block';
    
    const inGameChat = document.getElementById('inGameChatContainer');
    if (inGameChat) inGameChat.style.display = (myPlayerNumber !== 0 && !isGameOver) ? 'none' : 'flex';

    // 🛡️ [점수 표시 패치] 상단 선공/후공 이름표 옆에 실시간 획득 점수([X점])를 또렷하게 표기합니다!
    const hostCrown = (myId === playerNames[1]) ? ' 👑' : '';
    const guestCrown = (myId === playerNames[2]) ? ' 👑' : '';
    const p1Info = document.getElementById('p1Info');
    const p2Info = document.getElementById('p2Info');
    if(p1Info) p1Info.innerText = `선공: ${playerNames[1]} [${scores[1]}점]${hostCrown}`;
    if(p2Info) p2Info.innerText = `후공: ${playerNames[2]} [${scores[2]}점]${guestCrown}`;

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
    if (isOpeningSelection) {
        socket.emit('playerMove', { roomCode: currentRoomCode, move: { number: num, isOpening: true } });
    } else {
        // 🛡️ 숫자패드에서 고른 숫자 스도쿠 룰 강력 검사!
        if (!isValidSudokuMove(selectedRow, selectedCol, num)) return alert("스도쿠 규칙 위반입니다! (가로, 세로, 3x3 박스 내에 이미 같은 숫자가 있습니다)");
        socket.emit('playerMove', { roomCode: currentRoomCode, move: { row: selectedRow, col: selectedCol, number: num, isOpening: false } });
    }
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

function isValidSudokuMove(row, col, num) {
    // 1. 가로, 세로 검사
    for (let i = 0; i < 9; i++) {
        if (board[row][i] === num) return false;
        if (board[i][col] === num) return false;
    }
    // 2. 3x3 큰 칸 검사
    const startRow = Math.floor(row / 3) * 3;
    const startCol = Math.floor(col / 3) * 3;
    for (let i = startRow; i < startRow + 3; i++) {
        for (let j = startCol; j < startCol + 3; j++) {
            if (board[i][j] === num) return false;
        }
    }
    return true;
}

// 💡 특정 3x3 구역이 9칸 모두 채워졌는지 확인하는 함수
function isBoxCompletelyFilled(boxNum) {
    const sr = Math.floor((boxNum - 1) / 3) * 3;
    const sc = ((boxNum - 1) % 3) * 3;
    for (let r = sr; r < sr + 3; r++) {
        for (let c = sc; c < sc + 3; c++) {
            if (board[r][c] === 0) return false;
        }
    }
    return true;
}

// 💡 [기존 3x3 검사 함수 아래에 가로/세로 검사기 추가]
function isRowCompletelyFilled(r) {
    for (let c = 0; c < 9; c++) { if (board[r][c] === 0) return false; }
    return true;
}
function isColCompletelyFilled(c) {
    for (let r = 0; r < 9; r++) { if (board[r][c] === 0) return false; }
    return true;
}

// 💡 [질식 검사기] 특정 3x3 구역 내의 모든 빈칸에 1~9 중 넣을 수 있는 숫자가 단 하나도 없는지 검사!
function isPlayerSuffocated(boxNum) {
    const sr = Math.floor((boxNum - 1) / 3) * 3;
    const sc = ((boxNum - 1) % 3) * 3;
    let hasEmptyCell = false;

    for (let r = sr; r < sr + 3; r++) {
        for (let c = sc; c < sc + 3; c++) {
            if (board[r][c] === 0) {
                hasEmptyCell = true;
                // 1부터 9까지 하나라도 합법적으로 넣을 수 있다면 질식이 아님!
                for (let num = 1; num <= 9; num++) {
                    if (isValidSudokuMove(r, c, num)) return false; 
                }
            }
        }
    }
    // 빈칸은 분명 존재하는데 넣을 수 있는 숫자가 아예 없다면 진정한 질식(Suffocation)!
    return hasEmptyCell;
}