import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const PORT = process.env.PORT || 3000;
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
        playerRole = data.role || 'player';

        if (!rooms[currentRoom]) {
          rooms[currentRoom] = {
            clients: [],
            players: {},
            pendingActions: {}
          };
        }

        rooms[currentRoom].clients.push(ws);
        rooms[currentRoom].players[playerRole] = data.player;

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

        room.pendingActions[playerRole] = data.actionText;
        console.log(`[Ход] ${playerRole}: ${data.actionText}`);

        // Оповещаем о получении действия
        room.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'action_acknowledged',
              role: playerRole
            }));
          }
        });

        // Запуск генерации (если действие получено)
        const actions = Object.entries(room.pendingActions);
        if (actions.length >= 1) { // Срабатывает от действия игрока
          room.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'generating',
                status: 'Нейросеть обрабатывает последствия...'
              }));
            }
          });

          const prompt = `
Сеттинг: Мистический детектив, октябрь 2005 года.
Действия персонажей:
${actions.map(([r, act]) => `- ${r}: "${act}"`).join('\n')}

Опиши кинематографично и атмосферно последствия этих действий. Что произошло вокруг? Что персонажи видят дальше? Сделай ответ живым, в стиле мистического триллера на русском языке.
          `;

          try {
            const response = await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: prompt
            });

            const narrativeText = response.text;
            room.pendingActions = {}; // сброс раунда

            // Рассылаем ответ всем в комнате
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
          }
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