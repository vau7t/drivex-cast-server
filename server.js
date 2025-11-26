const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*', credentials: true }));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
  transports: ['websocket', 'polling']
});

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'DriveX Cast Server', sessions: sessions.size });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const sessions = new Map();

io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  socket.on('join-projector', ({ sessionId }) => {
    socket.join(`session-${sessionId}`);
    socket.sessionId = sessionId;
    socket.role = 'projector';
    let session = sessions.get(sessionId) || { sessionId, projectorSocket: null, controllerSocket: null, mainSocket: null, castData: null };
    session.projectorSocket = socket;
    sessions.set(sessionId, session);
    socket.emit('joined', { sessionId, role: 'projector' });
    if (session.controllerSocket) session.controllerSocket.emit('projector-connected');
    if (session.mainSocket) session.mainSocket.emit('projector-connected');
  });

  socket.on('join-controller', ({ sessionId }) => {
    socket.join(`session-${sessionId}`);
    socket.sessionId = sessionId;
    socket.role = 'controller';
    let session = sessions.get(sessionId) || { sessionId, projectorSocket: null, controllerSocket: null, mainSocket: null, castData: null };
    session.controllerSocket = socket;
    sessions.set(sessionId, session);
    socket.emit('joined', { sessionId, role: 'controller', projectorConnected: !!session.projectorSocket });
    if (session.projectorSocket) {
      session.projectorSocket.emit('controller-joined');
      socket.emit('projector-connected');
    }
  });

  socket.on('join-main', ({ sessionId }) => {
    socket.join(`session-${sessionId}`);
    socket.sessionId = sessionId;
    socket.role = 'main';
    let session = sessions.get(sessionId) || { sessionId, projectorSocket: null, controllerSocket: null, mainSocket: null, castData: null };
    session.mainSocket = socket;
    sessions.set(sessionId, session);
    socket.emit('joined', { sessionId, role: 'main' });
    socket.to(`session-${sessionId}`).emit('main-connected');
  });

  socket.on('cast-update', (data) => {
    const { sessionId } = data;
    const session = sessions.get(sessionId);
    if (session) session.castData = data;
    socket.to(`session-${sessionId}`).emit('cast-update', data);
  });

  socket.on('cast-stop', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (session) session.castData = null;
    socket.to(`session-${sessionId}`).emit('cast-stop');
  });

  socket.on('disconnect', () => {
    const { sessionId, role } = socket;
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    if (role === 'projector') {
      session.projectorSocket = null;
      if (session.controllerSocket) session.controllerSocket.emit('projector-disconnected');
      if (session.mainSocket) session.mainSocket.emit('projector-disconnected');
    } else if (role === 'controller') {
      session.controllerSocket = null;
      if (session.projectorSocket) session.projectorSocket.emit('controller-disconnected');
    } else if (role === 'main') {
      session.mainSocket = null;
      socket.to(`session-${sessionId}`).emit('main-disconnected');
      socket.to(`session-${sessionId}`).emit('cast-stop');
    }
    if (!session.projectorSocket && !session.co
