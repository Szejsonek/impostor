const WebSocket = require('ws');
const http = require('http');
const uuid = require('uuid'); // npm install uuid

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const gameSessions = new Map();
const connectedPlayers = new Map();

// Generowanie losowych haseł
const PASSWORDS = {
  normal: ["KOTELET", "KOMÓRKA", "WIATRAK", "ŚWIECZKA", "PARASOL", "KAPUSTA"],
  impostor: ["KOTLET", "KOMURKA", "WIATRAK", "ŚWIECKA", "PARASOL", "KAPUSTA"]
};

function generateGameCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function assignPasswords(session) {
  const connectedPlayers = session.players.filter(p => p.connected);
  if (connectedPlayers.length < 2) return;
  
  // Losowanie indeksu impostora spośród połączonych graczy
  const impostorIndex = Math.floor(Math.random() * connectedPlayers.length);
  const passwordIndex = Math.floor(Math.random() * PASSWORDS.normal.length);
  
  // Resetowanie wszystkich haseł
  session.players.forEach(player => {
    player.password = "";
    player.isImpostor = false;
  });
  
  // Przypisanie haseł
  connectedPlayers.forEach((player, index) => {
    player.isImpostor = (index === impostorIndex);
    player.password = player.isImpostor 
      ? PASSWORDS.impostor[passwordIndex] 
      : PASSWORDS.normal[passwordIndex];
  });
  
  session.gameStarted = true;
}

wss.on('connection', (ws) => {
  const playerId = uuid.v4();
  connectedPlayers.set(playerId, { ws, sessionId: null });
  
  console.log(`Nowy gracz połączony: ${playerId}`);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'createGame':
          const gameCode = generateGameCode();
          const session = {
            id: gameCode,
            players: Array(5).fill().map((_, i) => ({
              id: null,
              name: `Gracz ${i + 1}`,
              connected: false,
              password: "",
              isImpostor: false
            })),
            gameStarted: false,
            hostId: playerId
          };
          
          gameSessions.set(gameCode, session);
          connectedPlayers.get(playerId).sessionId = gameCode;
          
          ws.send(JSON.stringify({
            type: 'gameCreated',
            gameCode,
            players: session.players
          }));
          break;
          
        case 'joinGame':
          const sessionToJoin = gameSessions.get(data.gameCode);
          if (!sessionToJoin) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Nie znaleziono gry o podanym kodzie'
            }));
            return;
          }
          
          // Szukamy wolnego miejsca
          let playerSlot = -1;
          for (let i = 0; i < sessionToJoin.players.length; i++) {
            if (!sessionToJoin.players[i].connected) {
              playerSlot = i;
              break;
            }
          }
          
          if (playerSlot === -1) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Gra jest już pełna'
            }));
            return;
          }
          
          // Przypisanie gracza do slotu
          sessionToJoin.players[playerSlot] = {
            id: playerId,
            name: data.playerName || `Gracz ${playerSlot + 1}`,
            connected: true,
            password: "",
            isImpostor: false
          };
          
          connectedPlayers.get(playerId).sessionId = data.gameCode;
          
          // Powiadomienie wszystkich graczy w sesji
          broadcastToSession(data.gameCode, {
            type: 'playerJoined',
            players: sessionToJoin.players,
            newPlayerId: playerId,
            newPlayerSlot: playerSlot
          });
          break;
          
        case 'startGame':
          const sessionToStart = gameSessions.get(data.gameCode);
          if (!sessionToStart) return;
          
          assignPasswords(sessionToStart);
          
          // Wysyłamy każdemu graczowi jego własne hasło
          broadcastToSession(data.gameCode, {
            type: 'gameStarted',
            players: sessionToStart.players.map(p => ({
              id: p.id,
              name: p.name,
              connected: p.connected,
              isImpostor: p.isImpostor
              // Hasło nie jest wysyłane do wszystkich!
            }))
          });
          
          // Wysyłamy prywatne wiadomości z hasłami
          sessionToStart.players.forEach((player, index) => {
            if (player.connected && player.id) {
              const playerWs = getPlayerWebSocket(player.id);
              if (playerWs) {
                playerWs.send(JSON.stringify({
                  type: 'yourPassword',
                  password: player.password,
                  isImpostor: player.isImpostor,
                  playerIndex: index
                }));
              }
            }
          });
          break;
          
        case 'resetGame':
          const sessionToReset = gameSessions.get(data.gameCode);
          if (!sessionToReset) return;
          
          // Resetujemy tylko stan gry, zachowujemy połączenia
          sessionToReset.gameStarted = false;
          sessionToReset.players.forEach(player => {
            if (player.connected) {
              player.password = "";
              player.isImpostor = false;
            }
          });
          
          broadcastToSession(data.gameCode, {
            type: 'gameReset',
            players: sessionToReset.players
          });
          break;
      }
    } catch (error) {
      console.error('Błąd przetwarzania wiadomości:', error);
    }
  });
  
  ws.on('close', () => {
    const playerData = connectedPlayers.get(playerId);
    if (playerData && playerData.sessionId) {
      const session = gameSessions.get(playerData.sessionId);
      if (session) {
        // Oznaczamy gracza jako rozłączonego
        for (let player of session.players) {
          if (player.id === playerId) {
            player.connected = false;
            player.id = null;
            break;
          }
        }
        
        broadcastToSession(playerData.sessionId, {
          type: 'playerLeft',
          players: session.players
        });
      }
    }
    
    connectedPlayers.delete(playerId);
    console.log(`Gracz rozłączony: ${playerId}`);
  });
});

function broadcastToSession(sessionId, message) {
  const session = gameSessions.get(sessionId);
  if (!session) return;
  
  session.players.forEach(player => {
    if (player.connected && player.id) {
      const playerWs = getPlayerWebSocket(player.id);
      if (playerWs && playerWs.readyState === WebSocket.OPEN) {
        playerWs.send(JSON.stringify(message));
      }
    }
  });
}

function getPlayerWebSocket(playerId) {
  const playerData = connectedPlayers.get(playerId);
  return playerData ? playerData.ws : null;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Serwer WebSocket działa na porcie ${PORT}`);
  console.log(`WebSocket URL: ws://localhost:${PORT}`);
});
