import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const PORT = process.env.PORT || 10000;
const wss = new WebSocketServer({ port: PORT });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const rooms = {};

// Heartbeat для стабильности Render
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
        playerRole = data.role || data.playerRole || 'player1';

        if (!rooms[currentRoom]) {
          rooms[currentRoom] = {
            clients: [],
            players: {},
            pendingActions: {}
          };
        }

        rooms[currentRoom].clients.push(ws);
        rooms[currentRoom].players[playerRole] = data.player || { role: playerRole };

        console.log(`[+] Игрок подключился к "${currentRoom}" как ${playerRole}`);

        ws.send(JSON.stringify({
          type: 'room_joined',
          roomId: currentRoom,
          players: rooms[currentRoom].players
        }));
      }

      // 2. Игрок отправил ход
      if (data.type === 'coop_action' || data.type === 'submit_action') {
        const room = rooms[currentRoom];
        if (!room) return;

        const role = data.playerRole || data.role || playerRole || 'player1';
        const actionText = data.action || data.cleanActionText || data.actionText || 'Осмотреться вокруг';

        room.pendingActions[role] = actionText;
        console.log(`[Ход] ${role}: ${actionText}`);

        // Оповещаем о принятии действия
        room.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'action_acknowledged',
              role: role
            }));
            client.send(JSON.stringify({
              type: 'generating',
              status: 'Нейросеть описывает происходящее...'
            }));
          }
        });

        const prompt = `
Ты гейммастер ролевой игры "Сверхъестественное" (Supernatural RPG).
Сеттинг: Октябрь 2005 года, город Черный Ручей.
Персонаж: Виктор Крейвен.
Локация: ${data.location || 'Гараж'}.
Действие персонажа: "${actionText}".

Опиши кинематографично и атмосферно последствия этого действия. Что произошло вокруг? Что персонаж заметил или нашел?
Пиши на русском языке, в стиле мистического детектива, 2-3 коротких плотных абзаца.
        `;

        try {
          const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite',
            contents: prompt
          });

          const narrativeText = response.text || 'Вы внимательно осматриваете полумрак вокруг...';
          room.pendingActions = {};

          // Пакет строго по структуре хука useGameNetwork
          const resolvedPayload = {
            type: 'round_resolved',
            narrative: narrativeText,
            stateUpdates: {},
            apiUsage: { promptTokens: 0, responseTokens: 0 }
          };

          room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(resolvedPayload));
              
              // Дублируем и одиночный тип на случай ветвления
              client.send(JSON.stringify({
                ...resolvedPayload,
                type: 'action_resolved'
              }));
            }
          });

          console.log(`[OK] Сюжет отправлен клиенту (${role})`);
        } catch (err) {
          console.error('Ошибка вызова Gemini:', err);
          room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'round_resolved',
                narrative: 'Шорох в темноте отвлек внимание, подробности ускользают. Попробуйте еще раз.',
                stateUpdates: {},
                apiUsage: {}
              }));
            }
          });
        }
      }
    } catch (e) {
      console.error('Ошибка обработки JSON:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].clients = rooms[currentRoom].clients.filter(c => c !== ws);
      delete rooms[currentRoom].players[playerRole];
      console.log(`[-] Игрок ${playerRole} отключился`);
    }
  });
});

console.log(`=== WebSocket Сервер Craven запущен на порту ${PORT} ===`);
