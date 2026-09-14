import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const PORT = process.env.PORT || 10000;
const wss = new WebSocketServer({ port: PORT });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const rooms = {};

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
      if (data.type === 'coop_action') {
        const room = rooms[currentRoom];
        if (!room) return;

        // Извлекаем текст действия из любого поля клиента
        const actionText = data.cleanActionText || data.actionText || data.action || 'Осмотреться вокруг';
        room.pendingActions[playerRole] = actionText;
        console.log(`[Ход] ${playerRole}: ${actionText}`);

        // Оповещаем о принятии действия
        room.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'action_acknowledged',
              role: playerRole
            }));
            client.send(JSON.stringify({
              type: 'generating',
              status: 'Нейросеть обрабатывает последствия...'
            }));
          }
        });

        const actions = Object.entries(room.pendingActions);
        const prompt = `
Сеттинг: Мистический детектив, октябрь 2005 года. Город Черный Ручей.
Действия персонажа:
${actions.map(([r, act]) => `- ${r}: "${act}"`).join('\n')}

Опиши кинематографично и атмосферно последствия этих действий. Что произошло вокруг? Что персонаж видит дальше? Сделай ответ живым, в стиле мистического триллера на русском языке. Объем: 2-3 абзаца.
        `;

        try {
          // Используем стабильную рабочую модель
          const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite',
            contents: prompt
          });

          const narrativeText = response.text || 'События вокруг развиваются своим чередом...';
          room.pendingActions = {};

          // Рассылаем ответ клиенту игры
          room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'action_result',
                coopRes: {
                  narrative: narrativeText
                }
              }));
            }
          });
        } catch (err) {
          console.error('Ошибка Gemini:', err);
          // Отправляем fallback-сообщение в чат вместо разрыва связи
          room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'action_result',
                coopRes: {
                  narrative: 'В темноте что-то шевельнулось, но детали рассмотреть не удалось. Попробуйте повторить действие.'
                }
              }));
            }
          });
        }
      }
    } catch (e) {
      console.error('Ошибка обработки пакета:', e);
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
