import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const PORT = process.env.PORT || 10000;
const wss = new WebSocketServer({ port: PORT });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const rooms = {};

// Пинг-понг для поддержания соединения (heartbeat)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  });
}, 25000);

wss.on('connection', (ws) => {
  let currentRoom = null;
  let playerRole = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      // 1. Подключение к комнате
      if (data.type === 'join_room') {
        currentRoom = data.roomId || 'default';
        playerRole = data.role || 'player1';

        if (!rooms[currentRoom]) {
          rooms[currentRoom] = {
            clients: [],
            players: {},
            pendingActions: {}
          };
        }

        rooms[currentRoom].clients.push(ws);
        rooms[currentRoom].players[playerRole] = data.player || { role: playerRole };

        console.log(`[+] Игрок вошел в комнату "${currentRoom}" как ${playerRole}`);

        ws.send(JSON.stringify({
          type: 'room_joined',
          roomId: currentRoom,
          players: rooms[currentRoom].players
        }));
      }

      // 2. Игрок отправил действие
      if (data.type === 'coop_action' || data.type === 'submit_action') {
        const room = rooms[currentRoom];
        if (!room) return;

        const actionText = data.cleanActionText || data.actionText || data.action || 'Осмотреться вокруг';
        room.pendingActions[playerRole] = actionText;
        console.log(`[Ход] ${playerRole}: ${actionText}`);

        // Сразу подтверждаем ход, чтобы игра сняла таймаут ожидания
        room.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'action_acknowledged',
              role: playerRole
            }));
            client.send(JSON.stringify({
              type: 'generating',
              status: 'Нейросеть генерирует ход...'
            }));
          }
        });

        const actions = Object.entries(room.pendingActions);
        const prompt = `
Ты гейммастер текстовой ролевой игры "Сверхъестественное" (Supernatural RPG). Октябрь 2005 года. 
Локация: Гараж / Окраина города.
Действие игрока: "${actionText}".

Опиши кинематографично и атмосферно последствия этого действия. Что произошло вокруг? Какие зацепки или детали заметил Виктор?
Пиши живым языком на русском в стиле мистического триллера, 2-3 абзаца.
        `;

        try {
          const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite',
            contents: prompt
          });

          const narrativeText = response.text || 'Вы внимательно осматриваетесь в полумраке гаража, прислушиваясь к шорохам за стеной...';
          room.pendingActions = {};

          // Отправляем пакет, совместимый с разными версиями хука
          const payload = {
            type: 'coop_action_result',
            narrative: narrativeText,
            storyText: narrativeText,
            coopRes: {
              narrative: narrativeText,
              stateUpdates: {}
            }
          };

          room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(payload));
              // Дополнительный дубль для совместимости с submitCoopAction
              client.send(JSON.stringify({
                type: 'action_result',
                ...payload
              }));
            }
          });
          console.log(`[OK] Ответ от Gemini успешно отправлен игроку!`);
        } catch (err) {
          console.error('Ошибка вызова Gemini:', err);
          room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'action_result',
                coopRes: { narrative: 'Тени сгущаются, но пока ничего не происходит...' }
              }));
            }
          });
        }
      }
    } catch (e) {
      console.error('Ошибка парсинга JSON:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].clients = rooms[currentRoom].clients.filter(c => c !== ws);
      delete rooms[currentRoom].players[playerRole];
      console.log(`[-] Игрок ${playerRole} покинул комнату ${currentRoom}`);
    }
  });
});

console.log(`=== WebSocket Сервер Craven запущен на порту ${PORT} ===`);
