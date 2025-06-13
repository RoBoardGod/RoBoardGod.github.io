// === Firebase 初始化 ===

const firebaseConfig = {
  apiKey: "AIzaSyB8p_0AOlE45hpcfip_lLN5PnYR-7MTYHc",
  authDomain: "signaling-server-8a20f.firebaseapp.com",
  databaseURL: "https://signaling-server-8a20f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "signaling-server-8a20f",
  storageBucket: "signaling-server-8a20f.firebasestorage.app",
  messagingSenderId: "214889646051",
  appId: "1:214889646051:web:9a642eabd8646ffdfa82d6",
  measurementId: "G-KPZP1J0HZW"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

let myRoomId = null;
let myPeerId = Math.random().toString(36).substr(2, 9);
let peerConnection = null;
let dataChannel = null;
let isOfferer = false;
let roomRef = null;
let roomListRef = db.ref('rooms');
let membersRef = null;
let membersListener = null;
let beforeUnloadRemoveSelfRegistered = false;

// === UI 元素 ===
const roomsUl = document.getElementById('rooms');
const roomActions = document.getElementById('room-actions');
const currentRoomSpan = document.getElementById('current-room');
const chatDiv = document.getElementById('chat');
const messagesDiv = document.getElementById('messages');
const chatInput = document.getElementById('chat-input');
const createRoomBtn = document.querySelector('button[onclick="createRoom()"]');
// 新增：成員列表容器
let memberListDiv = document.getElementById('member-list');
if (!memberListDiv) {
  memberListDiv = document.createElement('div');
  memberListDiv.id = 'member-list';
  memberListDiv.className = 'mb-2';
  // 插入到聊天室(messagesDiv)上方
  if (chatDiv && messagesDiv) {
    chatDiv.insertBefore(memberListDiv, messagesDiv);
  }
}

// === 房間列表 ===
function updateRoomList(snap) {
  roomsUl.innerHTML = '';
  const rooms = snap.val() || {};
  const shown = new Set();
  Object.keys(rooms).forEach(roomId => {
    if (shown.has(roomId)) return;
    shown.add(roomId);
    // 排除自己已加入的房間
    if (myRoomId === roomId) return;
    const li = document.createElement('li');
    li.className = 'list-group-item room-list-item';
    li.innerHTML = `<span>${roomId}</span>`;
    const joinBtn = document.createElement('button');
    joinBtn.textContent = '加入';
    joinBtn.className = 'btn btn-outline-primary btn-sm ms-2';
    joinBtn.onclick = () => joinRoom(roomId);
    li.appendChild(joinBtn);
    roomsUl.appendChild(li);
  });
}

// 只用 on('value') 監聽
roomListRef.on('value', updateRoomList);

// === 創建房間 ===
window.createRoom = async function() {
  if (myRoomId) return;
  const roomId = 'room-' + Math.random().toString(36).substr(2, 6);
  await db.ref('rooms/' + roomId).set({ created: Date.now() });
  if (createRoomBtn) createRoomBtn.style.display = 'none';
  joinRoom(roomId, true);
};

// === 加入房間 ===
async function joinRoom(roomId, asOfferer = false) {
  // === 新增: 如果是 offerer 且已在房間，先清除舊房間 ===
  if (isOfferer && myRoomId && myRoomId !== roomId) {
    await cleanupRoom();
  }
  // === 修正: 進入房間前先清理舊連線與事件 ===
  if (peerConnection) {
    peerConnection.ondatachannel = null;
    peerConnection.close();
    peerConnection = null;
  }
  if (dataChannel) {
    dataChannel.onopen = null;
    dataChannel.onmessage = null;
    dataChannel.onclose = null;
    dataChannel = null;
  }
  // 這裡移除 myRoomId 的判斷，確保可以重複進入
  myRoomId = roomId;
  // 將 isOfferer 設定移到這裡
  isOfferer = asOfferer;
  roomRef = db.ref('rooms/' + roomId);
  membersRef = db.ref('rooms/' + roomId + '/members');
  currentRoomSpan.textContent = '當前房間: ' + roomId;
  showRoomUI(true);
  if (createRoomBtn) createRoomBtn.style.display = 'none';

  // 監聽房間是否被刪除
  roomRef.on('value', snap => {
    if (!snap.exists()) {
      appendMessage('系統', '房間已不存在，您已自動離開。');
      setTimeout(() => {
        alert('房間已不存在，您已自動離開。');
        window.leaveRoom();
      }, 100);
    }
  });

  // 加入 members
  await membersRef.child(myPeerId).set(true);

  // 只註冊一次 beforeunload
  if (!beforeUnloadRemoveSelfRegistered) {
    window.addEventListener('beforeunload', removeSelfFromMembers);
    beforeUnloadRemoveSelfRegistered = true;
  }

  // 監聽成員變化
  let prevMembers = {};
  membersListener = membersRef.on('value', async snap => {
    const members = snap.val() || {};
    // 處理新加入
    for (const pid of Object.keys(members)) {
      if (!(pid in prevMembers) && pid !== myPeerId) {
        appendMessage('系統', `${pid} 加入房間`);
        // 房主針對新加入者建立 offer
        if (isOfferer && myRoomId) {
          await createOfferForPeer(pid);
        }
      }
    }
    // 處理離開
    for (const pid of Object.keys(prevMembers)) {
      if (!(pid in members) && pid !== myPeerId) {
        appendMessage('系統', `${pid} 離開房間`);
        // 房主可選擇清理該 peer 的 signaling 資料（保險起見）
        if (isOfferer && myRoomId) {
          await clearSignalingForPeer(myRoomId, pid);
        }
      }
    }
    prevMembers = members;
    // 修正：傳遞所有成員
    updateMemberListUI(members);
  });

  // === 關鍵: 先清空 dataChannel，setupWebRTC 會正確建立新的 ===
  dataChannel = null;

  // 只有房主不主動建立 WebRTC，等新成員加入時才建立
  if (!isOfferer) {
    // === 等待房主建立 offer ===
    await waitForOfferFromHost();
    await setupWebRTCWithHost();
    console.log(`Waiting for dataChannel to open in room ${roomId}...`);
    await waitForDataChannelOpen();
    console.log(`DataChannel is open in room ${roomId}`);
  }

  listenForMessages();
  if (asOfferer) {
    window.addEventListener('beforeunload', cleanupRoom);
  }
}

// === 房主針對新加入者建立 offer ===
async function createOfferForPeer(peerId) {
  console.log(`[Host] Creating offer for peer: ${peerId}`);
  // 建立一個新的 RTCPeerConnection
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel('chat');
  // 將 dataChannel 儲存到一個物件，方便後續操作
  if (!window.hostDataChannels) window.hostDataChannels = {};
  window.hostDataChannels[peerId] = dc;

  // 收集 ICE
  pc.onicecandidate = e => {
    if (e.candidate) {
      console.log(`[Host] Sending ICE candidate to peer: ${peerId}`, e.candidate);
      db.ref(`rooms/${myRoomId}/candidates/${peerId}/offerer`).push(e.candidate.toJSON());
    }
  };
  // 建立 offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  console.log(`[Host] Offer SDP for ${peerId}:`, offer.sdp);
  await db.ref(`rooms/${myRoomId}/offers/${peerId}`).set({ sdp: offer.sdp, type: offer.type });

  // 監聽 answer
  const answerRef = db.ref(`rooms/${myRoomId}/answers/${peerId}`);
  const answerListener = answerRef.on('value', async snap => {
    const answer = snap.val();
    if (answer && pc.signalingState === 'have-local-offer') {
      console.log(`[Host] Received answer from peer: ${peerId}`, answer);
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      // 連線建立後，清理 signaling
      await clearSignalingForPeer(myRoomId, peerId);
      answerRef.off('value', answerListener);
      console.log(`[Host] Signaling data for peer ${peerId} cleared`);
    }
  });

  // 監聽對方 ICE
  db.ref(`rooms/${myRoomId}/candidates/${peerId}/answerer`).on('child_added', snap => {
    const candidate = snap.val();
    if (candidate) {
      console.log(`[Host] Received ICE candidate from peer: ${peerId}`, candidate);
      pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  });

  // DataChannel 可根據需求處理
  dc.onopen = () => {
    console.log(`[Host] DataChannel open for peer: ${peerId}`);
    // 修正：用 membersRef 取得所有成員物件
    if (membersRef) {
      membersRef.once('value').then(snap => updateMemberListUI(snap.val() || {}));
    }
  };
  dc.onmessage = e => {
    console.log(`[Host] DataChannel message from peer ${peerId}:`, e.data);
    try {
      const msgObj = JSON.parse(e.data);
      appendMessage(msgObj.peerId, msgObj.text);
    } catch {
      appendMessage(peerId, e.data);
    }
  };
  dc.onclose = () => {
    console.log(`[Host] DataChannel closed for peer: ${peerId}`);
    if (membersRef) {
      membersRef.once('value').then(snap => updateMemberListUI(snap.val() || {}));
    }
  };

  // 房主可選擇是否保留 pc 實例（如需管理多連線）
  if (!window.hostPeerConnections) window.hostPeerConnections = {};
  window.hostPeerConnections[peerId] = pc;
}

// === 加入者建立與房主的連線 ===
async function setupWebRTCWithHost() {
  console.log(`[Peer] Setting up WebRTC with host`);
  peerConnection = new RTCPeerConnection();
  peerConnection.onicecandidate = e => {
    if (e.candidate) {
      console.log(`[Peer] Sending ICE candidate to host`, e.candidate);
      db.ref(`rooms/${myRoomId}/candidates/${myPeerId}/answerer`).push(e.candidate.toJSON());
    }
  };
  peerConnection.ondatachannel = e => {
    dataChannel = e.channel;
    setupDataChannel();
    console.log(`[Peer] DataChannel received from host`);
    updateMemberListUI({ [myPeerId]: true }); // 觸發UI刷新
  };

  // 監聽屬於自己的 offer
  const offerRef = db.ref(`rooms/${myRoomId}/offers/${myPeerId}`);
  const offerSnap = await offerRef.once('value');
  const offer = offerSnap.val();
  if (offer) {
    console.log(`[Peer] Received offer from host:`, offer);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    console.log(`[Peer] Sending answer to host:`, answer.sdp);
    await db.ref(`rooms/${myRoomId}/answers/${myPeerId}`).set({ sdp: answer.sdp, type: answer.type });
    // 監聽房主 ICE
    db.ref(`rooms/${myRoomId}/candidates/${myPeerId}/offerer`).on('child_added', snap => {
      const candidate = snap.val();
      if (candidate) {
        console.log(`[Peer] Received ICE candidate from host`, candidate);
        peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });
    // 連線建立後，清理 signaling
    peerConnection.onconnectionstatechange = async () => {
      if (peerConnection.connectionState === 'connected') {
        console.log(`[Peer] Connection established, clearing signaling`);
        await clearSignalingForPeer(myRoomId, myPeerId);
      }
    };
  } else {
    console.warn(`[Peer] No offer found for myPeerId: ${myPeerId}`);
  }
}

// === 清理屬於該 peer 的 signaling ===
async function clearSignalingForPeer(roomId, peerId) {
  console.log(`[Signaling] Clearing signaling for peer: ${peerId}`);
  await db.ref(`rooms/${roomId}/offers/${peerId}`).remove();
  await db.ref(`rooms/${roomId}/answers/${peerId}`).remove();
  await db.ref(`rooms/${roomId}/candidates/${peerId}`).remove();
}

// 等待 dataChannel ready（僅 for answerer）
function waitForDataChannelOpen() {
  return new Promise(resolve => {
    if (dataChannel && dataChannel.readyState === 'open') {
      console.log('dataChannel already open');
      resolve();
    } else {
      const handler = () => {
        if (dataChannel && dataChannel.readyState === 'open') {
          console.log('dataChannel open event');
          dataChannel.removeEventListener('open', handler);
          resolve();
        }
      };
      const interval = setInterval(() => {
        if (dataChannel) {
          console.log('dataChannel created, state:', dataChannel.readyState);
          dataChannel.addEventListener('open', handler);
          clearInterval(interval);
        }
      }, 50);
    }
  });
}

// === 離開房間 ===
window.leaveRoom = async function() {
  if (!myRoomId) return;
  if (isOfferer) await cleanupRoom();
  else await removePeer();
  await removeSelfFromMembers();
  if (membersRef && membersListener) {
    membersRef.off('value', membersListener);
    membersListener = null;
  }
  // === 離開時清除自己的 candidates 與 answer（如果是 answerer） ===
  if (myRoomId && myPeerId) {
    await db.ref(`rooms/${myRoomId}/candidates/${myPeerId}`).remove();
    if (!isOfferer) {
      await db.ref(`rooms/${myRoomId}/answer`).remove();
    }
  }
  membersRef = null;
  myRoomId = null;
  isOfferer = false;
  if (roomRef) roomRef.off();
  roomRef = null;
  // === 修正: 檢查 roomActions/chatDiv 是否存在再操作 style ===
  if (typeof roomActions !== "undefined" && roomActions) {
    roomActions.style.display = 'none';
  }
  if (typeof chatDiv !== "undefined" && chatDiv) {
    chatDiv.style.display = 'none';
  }
  // 隱藏當前房間文字和離開房間按鈕
  if (typeof currentRoomSpan !== "undefined" && currentRoomSpan) {
    currentRoomSpan.textContent = '';
  }
  const leaveBtn = document.getElementById('leave-btn');
  if (leaveBtn) leaveBtn.style.display = 'none';
  if (createRoomBtn) createRoomBtn.style.display = '';
  appendMessage('系統', '你已退出房間');
  messagesDiv.innerHTML = '';
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (dataChannel && (!isOfferer || (isOfferer && myRoomId === null))) {
    dataChannel.onopen = null;
    dataChannel.onmessage = null;
    dataChannel.onclose = null;
    dataChannel = null;
  }
  roomListRef.once('value', updateRoomList);
};

// === 新增: 離開時移除自己 from members ===
async function removeSelfFromMembers() {
  if (membersRef && myPeerId) {
    try { await membersRef.child(myPeerId).remove(); } catch {}
  }
}

// === 自動刪除房間 ===
async function cleanupRoom() {
  if (myRoomId) {
    // 房主離開時，清除 offer/answer/candidates
    await db.ref('rooms/' + myRoomId + '/offer').remove();
    await db.ref('rooms/' + myRoomId + '/answer').remove();
    await db.ref('rooms/' + myRoomId + '/candidates').remove();
    await db.ref('rooms/' + myRoomId).remove();
    myRoomId = null;
  }
}

// === DataChannel 聊天 ===
function setupDataChannel() {
  if (!dataChannel) return;
  dataChannel.onopen = () => {
    membersRef && membersRef.once('value').then(snap => updateMemberListUI(snap.val() || {}));
  };
  dataChannel.onclose = () => {
    // === 修正: 只有非 offerer 或自己主動離開時才清除 dataChannel ===
    // 不要在主機端(offerer)因為對方離開就清除 dataChannel
    // 只在自己主動離開時清除
    // 並且只有在 dataChannel 存在時才執行清除
    if (dataChannel && (!isOfferer || (isOfferer && myRoomId === null))) {
      dataChannel.onopen = null;
      dataChannel.onmessage = null;
      dataChannel.onclose = null;
      dataChannel = null;
    }
  };
}

// === DataChannel 狀態追蹤輔助 ===
function getPeerConnectionState(pid) {
  if (isOfferer) {
    if (pid === myPeerId) return true;
    // 房主：有 hostDataChannels 且 readyState 為 open 才算連線
    if (window.hostDataChannels && window.hostDataChannels[pid]) {
      return window.hostDataChannels[pid].readyState === 'open';
    }
    return false;
  } else {
    if (pid === myPeerId) return true;
    // 非房主：只和房主有 dataChannel，且 readyState 為 open 才算連線
    // 找到房主 peerId（不是自己且排序最前的那個）
    const memberIds = Object.keys(currentMembers || {});
    const hostId = memberIds.find(id => id !== myPeerId);
    if (pid === hostId && dataChannel) {
      return dataChannel.readyState === 'open';
    }
    // 其他人都不是連線
    return false;
  }
}

// === 更新成員列表UI ===
let currentMembers = {};
function updateMemberListUI(members) {
  currentMembers = members; // 讓 getPeerConnectionState 能取得所有成員
  if (!memberListDiv) return;
  if (chatDiv && messagesDiv && memberListDiv.parentNode !== chatDiv) {
    chatDiv.insertBefore(memberListDiv, messagesDiv);
  }
  memberListDiv.innerHTML = '<strong>房間成員：</strong>';
  const ul = document.createElement('ul');
  ul.className = 'list-group list-group-horizontal flex-wrap';
  Object.keys(members).forEach(pid => {
    const li = document.createElement('li');
    li.className = 'list-group-item py-1 px-2 d-flex align-items-center';
    // 判斷 dataChannel 狀態
    let isConnected = getPeerConnectionState(pid);
    // 燈號
    const dot = document.createElement('span');
    dot.style.display = 'inline-block';
    dot.style.width = '12px';
    dot.style.height = '12px';
    dot.style.borderRadius = '50%';
    dot.style.marginRight = '6px';
    dot.style.background = isConnected ? '#28a745' : '#adb5bd'; // 綠/灰
    li.appendChild(dot);
    // 名稱
    li.appendChild(document.createTextNode(pid === myPeerId ? `${pid} (你)` : pid));
    ul.appendChild(li);
  });
  memberListDiv.appendChild(ul);
}

window.sendMessage = function() {
  const msg = chatInput.value.trim();
  console.log(`Sending message: ${msg}`);
  console.log(dataChannel);
  console.log(`DataChannel state: ${dataChannel ? dataChannel.readyState : 'null'}`);
  if (!msg) return;

  const msgObj = { peerId: myPeerId, text: msg };

  if (isOfferer && window.hostDataChannels) {
    // 房主對所有 dataChannel 廣播訊息
    Object.entries(window.hostDataChannels).forEach(([peerId, dc]) => {
      if (dc && dc.readyState === 'open') {
        try {
          dc.send(JSON.stringify(msgObj));
        } catch (e) {
          console.warn(`Failed to send to ${peerId}:`, e);
        }
      }
    });
    appendMessage(myPeerId, msg); // 房主自己也顯示訊息
  } else if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(msgObj));
    appendMessage(myPeerId, msg);
  }
  chatInput.value = '';
};

function appendMessage(sender, msg) {
  const div = document.createElement('div');
  div.className = 'chat-message';
  div.innerHTML = `<strong class="text-primary">${sender}:</strong> <span>${msg}</span>`;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function listenForMessages() {
  messagesDiv.innerHTML = '';
}

// 顯示/隱藏房間操作與聊天室
function showRoomUI(show) {
  // 先檢查 roomActions/chatDiv 是否存在
  if (typeof roomActions !== "undefined" && roomActions) {
    roomActions.style.display = show ? '' : 'none';
  }
  if (typeof chatDiv !== "undefined" && chatDiv) {
    chatDiv.style.display = show ? '' : 'none';
  }
  const leaveBtn = document.getElementById('leave-btn');
  if (leaveBtn) leaveBtn.style.display = show ? '' : 'none';
}

// 房主關閉頁面時刪除房間
window.addEventListener('beforeunload', async () => {
  if (isOfferer && myRoomId) {
    await cleanupRoom();
  }
});

// === 等待房主建立屬於自己的 offer ===
async function waitForOfferFromHost() {
  const offerRef = db.ref(`rooms/${myRoomId}/offers/${myPeerId}`);
  let offer = null;
  while (!offer) {
    const snap = await offerRef.once('value');
    offer = snap.val();
    if (!offer) {
      // 每 200ms 檢查一次
      await new Promise(res => setTimeout(res, 200));
    }
  }
}

// === 移除 Peer (非房主離開) ===
async function removePeer() {
  // 預留給未來 ICE candidate 清理等功能，目前可留空
}

// 支援按 Enter 送出訊息
if (chatInput) {
  chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      window.sendMessage();
      e.preventDefault();
    }
  });
  // 新增：手機瀏覽器通常會觸發 input 的 'change' 或 'input' 事件
  chatInput.form?.addEventListener('submit', function(e) {
    window.sendMessage();
    e.preventDefault();
  });
}