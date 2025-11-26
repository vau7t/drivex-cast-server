const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
app.use(cors({ origin: '*' }));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.get('/', (req, res) => res.json({ status: 'online', service: 'DriveX Cast Server' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const sessions = new Map();

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join-projector', ({ sessionId }) => {
    socket.join('session-' + sessionId);
    socket.sessionId = sessionId;
    socket.role = 'projector';
    let s = sessions.get(sessionId) || { projector: null, controller: null, main: null, data: null };
    s.projector = socket;
    sessions.set(sessionId, s);
    socket.emit('joined', { sessionId, role: 'projector' });
    if (s.controller) s.controller.emit('projector-connected');
    if (s.main) s.main.emit('projector-connected');
  });

  socket.on('join-controller', ({ sessionId }) => {
    socket.join('session-' + sessionId);
    socket.sessionId = sessionId;
    socket.role = 'controller';
    let s = sessions.get(sessionId) || { projector: null, controller: null, main: null, data: null };
    s.controller = socket;
    sessions.set(sessionId, s);
    socket.emit('joined', { sessionId, role: 'controller' });
    if (s.projector) { s.projector.emit('controller-joined'); socket.emit('projector-connected'); }
  });

  socket.on('join-main', ({ sessionId }) => {
    socket.join('session-' + sessionId);
    socket.sessionId = sessionId;
    socket.role = 'main';
    let s = sessions.get(sessionId) || { projector: null, controller: null, main: null, data: null };
    s.main = socket;
    sessions.set(sessionId, s);
    socket.emit('joined', { sessionId, role: 'main' });
    socket.to('session-' + sessionId).emit('main-connected');
  });

  socket.on('cast-update', (data) => {
    let s = sessions.get(data.sessionId);
    if (s) s.data = data;
    socket.to('session-' + data.sessionId).emit('cast-update', data);
  });

  socket.on('cast-stop', ({ sessionId }) => {
    let s = sessions.get(sessionId);
    if (s) s.data = null;
    socket.to('session-' + sessionId).emit('cast-stop');
  });

  socket.on('disconnect', () => {
    let s = sessions.get(socket.sessionId);
    if (!s) return;
    if (socket.role === 'projector') { s.projector = null; if (s.controller) s.controller.emit('projector-disconnected'); if (s.main) s.main.emit('projector-disconnected'); }
    if (socket.role === 'controller') { s.controller = null; if (s.projector) s.projector.emit('controller-disconnected'); }
    if (socket.role === 'main') { s.main = null; socket.to('session-' + socket.sessionId).emit('cast-stop'); }
    if (!s.projector && !s.controller && !s.main) setTimeout(() => sessions.delete(socket.sessionId), 30000);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Server running'));
