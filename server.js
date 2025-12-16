/**
 * DriveX Cast Server v2.8.0
 * 
 * WebSocket server for casting files to remote displays
 * + Share notifications
 * 
 * CHANGES v2.8.0:
 * ✅ Added video-seek relay handler
 * ✅ Added slideshow-control relay handler
 * ✅ Added slideshow-interval relay handler
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET_KEY || process.env.JWT_SECRET;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const sessions = new Map();
const notificationUsers = {
  byUserId: new Map(),
  byEmail: new Map()
};

// ═══════════════════════════════════════════════════════════════
// REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'DriveX Cast Server', 
    version: '2.8.0',
    features: ['cast', 'notifications', 'video-seek']
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'online', 
    sessions: sessions.size,
    notificationUsers: notificationUsers.byUserId.size
  });
});

app.get('/sessions', (req, res) => {
  const activeSessions = [];
  sessions.forEach((session, sessionId) => {
    if (session.projector || session.host) {
      activeSessions.push({
        sessionId,
        hasProjector: !!session.projector,
        hasHost: !!session.host,
        hasController: (session.controllers?.length || 0) > 0,
        controllerCount: session.controllers?.length || 0,
        viewerCount: session.viewers?.length || 0,
        lastUpdate: session.lastUpdate,
      });
    }
  });
  res.json({ success: true, sessions: activeSessions, count: activeSessions.length });
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATION TRIGGER ENDPOINT (called by main backend)
// ═══════════════════════════════════════════════════════════════

app.post('/notify', (req, res) => {
  const { secret, event, userId, email, data } = req.body;
  
  if (NOTIFY_SECRET && secret !== NOTIFY_SECRET) {
    console.log('❌ [Notify] Invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log(`🔔 [Notify] Event: ${event}, userId: ${userId}, email: ${email}`);
  
  const notificationsNsp = io.of('/notifications');
  let delivered = 0;
  
  if (userId) {
    notificationsNsp.to(`user:${userId}`).emit(event, data);
    const userSockets = notificationUsers.byUserId.get(userId);
    delivered += userSockets?.size || 0;
  }
  
  if (email) {
    const normalizedEmail = email.toLowerCase();
    notificationsNsp.to(`email:${normalizedEmail}`).emit(event, data);
    const emailSockets = notificationUsers.byEmail.get(normalizedEmail);
    delivered += emailSockets?.size || 0;
  }
  
  console.log(`📤 [Notify] Delivered to ${delivered} sockets`);
  res.json({ success: true, delivered });
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS NAMESPACE
// ═══════════════════════════════════════════════════════════════

const notificationsNsp = io.of('/notifications');

notificationsNsp.use((socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    console.log('🔔 [Notifications] No token provided');
    return next(new Error('Authentication required'));
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.id || decoded._id;
    socket.userEmail = decoded.email?.toLowerCase();
    console.log(`🔔 [Notifications] Auth success: ${socket.userId}`);
    next();
  } catch (err) {
    console.error('🔔 [Notifications] Auth error:', err.message);
    next(new Error('Invalid token'));
  }
});

notificationsNsp.on('connection', (socket) => {
  console.log(`🔔 [Notifications] Connected: ${socket.userId} (${socket.userEmail})`);
  
  if (socket.userId) {
    if (!notificationUsers.byUserId.has(socket.userId)) {
      notificationUsers.byUserId.set(socket.userId, new Set());
    }
    notificationUsers.byUserId.get(socket.userId).add(socket.id);
    socket.join(`user:${socket.userId}`);
  }
  
  if (socket.userEmail) {
    if (!notificationUsers.byEmail.has(socket.userEmail)) {
      notificationUsers.byEmail.set(socket.userEmail, new Set());
    }
    notificationUsers.byEmail.get(socket.userEmail).add(socket.id);
    socket.join(`email:${socket.userEmail}`);
  }
  
  socket.on('join:user', ({ userId }) => {
    if (userId) {
      socket.join(`user:${userId}`);
      console.log(`🔔 [Notifications] Joined room: user:${userId}`);
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log(`🔔 [Notifications] Disconnected: ${socket.userId} - ${reason}`);
    
    if (socket.userId) {
      const userSockets = notificationUsers.byUserId.get(socket.userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) notificationUsers.byUserId.delete(socket.userId);
      }
    }
    
    if (socket.userEmail) {
      const emailSockets = notificationUsers.byEmail.get(socket.userEmail);
      if (emailSockets) {
        emailSockets.delete(socket.id);
        if (emailSockets.size === 0) notificationUsers.byEmail.delete(socket.userEmail);
      }
    }
  });
});

console.log('✅ /notifications namespace initialized');

// ═══════════════════════════════════════════════════════════════
// CAST SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  socket.on('join-projector', ({ sessionId }) => {
    console.log(`📺 Projector joined: ${sessionId}`);
    socket.join(sessionId);
    
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { 
        projector: socket.id, 
        controllers: [],
        viewers: [],
        main: null,
        host: null,
        createdAt: Date.now(),
        lastUpdate: Date.now(),
        currentFile: null,
        fileList: []
      });
    } else {
      const session = sessions.get(sessionId);
      session.projector = socket.id;
      session.lastUpdate = Date.now();
    }
    
    socket.sessionId = sessionId;
    socket.role = 'projector';
    socket.to(sessionId).emit('projector-ready', { sessionId });
    console.log(`📤 Sent projector-ready to session ${sessionId}`);
  });

  socket.on('register-host', ({ sessionId }) => {
    console.log(`🎬 Host registered: ${sessionId}`);
    socket.join(sessionId);
    
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { 
        projector: null, 
        controllers: [],
        viewers: [],
        main: null,
        host: socket.id,
        createdAt: Date.now(),
        lastUpdate: Date.now(),
        currentFile: null,
        fileList: []
      });
    } else {
      const session = sessions.get(sessionId);
      session.host = socket.id;
      session.lastUpdate = Date.now();
    }
    
    socket.sessionId = sessionId;
    socket.role = 'host';
    console.log(`✅ Host ${socket.id} registered for session ${sessionId}`);
  });

  socket.on('join-controller', ({ sessionId }) => {
    console.log(`📱 Controller joined: ${sessionId}`);
    socket.join(sessionId);
    
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { 
        projector: null, 
        controllers: [socket.id],
        viewers: [],
        main: null,
        host: null,
        createdAt: Date.now(),
        lastUpdate: Date.now(),
        currentFile: null,
        fileList: []
      });
    } else {
      const session = sessions.get(sessionId);
      if (!session.controllers.includes(socket.id)) {
        session.controllers.push(socket.id);
      }
      session.lastUpdate = Date.now();
      
      if (session.projector) {
        console.log(`📤 Projector exists! Sending projector-ready to controller ${socket.id}`);
        socket.emit('projector-ready', { sessionId, timestamp: Date.now() });
      }
    }
    
    socket.sessionId = sessionId;
    socket.role = 'controller';
    socket.to(sessionId).emit('controller-joined', { socketId: socket.id });
  });

  socket.on('join-main', ({ sessionId }) => {
    console.log(`🖥️ Main app joined: ${sessionId}`);
    socket.join(sessionId);
    
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { 
        projector: null, 
        controllers: [],
        viewers: [],
        main: socket.id,
        host: null,
        createdAt: Date.now(),
        lastUpdate: Date.now(),
        currentFile: null,
        fileList: []
      });
    } else {
      const session = sessions.get(sessionId);
      session.main = socket.id;
      session.lastUpdate = Date.now();
      
      if (session.projector) {
        console.log(`📤 Projector exists! Sending projector-ready to main ${socket.id}`);
        socket.emit('projector-ready', { sessionId, timestamp: Date.now() });
      }
    }
    
    socket.sessionId = sessionId;
    socket.role = 'main';
    socket.to(sessionId).emit('main-joined', { socketId: socket.id });
  });

  socket.on('join-room', ({ room, role }) => {
    console.log(`🚪 Socket ${socket.id} joining room ${room} as ${role}`);
    socket.join(room);
    
    if ((role === 'controller' || role === 'main') && sessions.has(room)) {
      const session = sessions.get(room);
      if (session.projector) {
        socket.emit('projector-ready', { sessionId: room, timestamp: Date.now() });
      }
    }
  });

  socket.on('ping-projector', ({ sessionId }) => {
    console.log(`🏓 Ping for session: ${sessionId}`);
    if (sessions.has(sessionId) && sessions.get(sessionId).projector) {
      socket.emit('projector-ready', { sessionId, timestamp: Date.now() });
    }
  });

  socket.on('viewer-joined', (data) => {
    const { sessionId, viewerId, timestamp, userAgent } = data;
    console.log(`👁️ Viewer joined: ${viewerId} for session ${sessionId}`);
    socket.join(sessionId);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (!session.viewers) session.viewers = [];
      if (!session.viewers.includes(socket.id)) session.viewers.push(socket.id);
      session.lastUpdate = Date.now();
    }
    
    socket.sessionId = sessionId;
    socket.role = 'viewer';
    socket.viewerId = viewerId;
    socket.to(sessionId).emit('viewer-joined', { sessionId, viewerId, timestamp, userAgent });
  });

  socket.on('viewer-accepted', (data) => {
    const { sessionId, viewerId, timestamp } = data;
    console.log(`✅ Viewer accepted: ${viewerId}`);
    socket.to(sessionId).emit('viewer-accepted', { sessionId, viewerId, timestamp });
  });

  socket.on('viewer-navigate', (data) => {
    const { sessionId, viewerId, index, fileName } = data;
    console.log(`🔄 Viewer navigate: ${viewerId} to index ${index}`);
    socket.to(sessionId).emit('viewer-navigate', { sessionId, viewerId, index, fileName });
  });

  socket.on('viewer-left', (data) => {
    const { sessionId, viewerId } = data;
    console.log(`👋 Viewer left: ${viewerId}`);
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session.viewers) session.viewers = session.viewers.filter(id => id !== socket.id);
    }
    socket.to(sessionId).emit('viewer-left', { viewerId });
  });

  socket.on('cast-update', (data) => {
    const { sessionId, url, fileName, index, total } = data;
    console.log(`📤 Cast update: ${fileName} (${index + 1}/${total}) to ${sessionId}`);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.currentFile = { url, fileName, index, total };
      session.lastUpdate = Date.now();
    }
    socket.to(sessionId).emit('cast-update', data);
  });

  socket.on('cast-file-list', (data) => {
    const { sessionId, files } = data;
    console.log(`📋 Cast file list: ${files?.length || 0} files`);
    if (sessions.has(sessionId)) {
      sessions.get(sessionId).fileList = files;
    }
    socket.to(sessionId).emit('cast-file-list', data);
  });

  socket.on('cast-stop', ({ sessionId }) => {
    console.log(`⏹️ Cast stopped: ${sessionId}`);
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.currentFile = null;
      session.fileList = [];
    }
    socket.to(sessionId).emit('cast-stop');
  });

  // ═══════════════════════════════════════════════════════════════
  // VIDEO CONTROL RELAY HANDLERS
  // ═══════════════════════════════════════════════════════════════

  socket.on('video-play', ({ sessionId }) => {
    console.log(`▶️ Video play: ${sessionId}`);
    socket.to(sessionId).emit('video-play');
  });

  socket.on('video-pause', ({ sessionId }) => {
    console.log(`⏸️ Video pause: ${sessionId}`);
    socket.to(sessionId).emit('video-pause');
  });

  socket.on('video-mute', ({ sessionId, muted }) => {
    console.log(`🔇 Video mute: ${muted} for ${sessionId}`);
    socket.to(sessionId).emit('video-mute', { muted });
  });

  // ✅ v2.8.0: Added video-seek relay
  socket.on('video-seek', ({ sessionId, time }) => {
    console.log(`⏩ Video seek: ${time}s for ${sessionId}`);
    socket.to(sessionId).emit('video-seek', { time });
  });

  // ═══════════════════════════════════════════════════════════════
  // SLIDESHOW CONTROL RELAY HANDLERS
  // ═══════════════════════════════════════════════════════════════

  socket.on('slideshow-toggle', ({ sessionId, enabled, interval }) => {
    console.log(`🎞️ Slideshow toggle: ${enabled} (${interval}s) for ${sessionId}`);
    socket.to(sessionId).emit('slideshow-control', { enabled, interval });
  });

  socket.on('slideshow-control', ({ sessionId, enabled, interval }) => {
    console.log(`🎞️ Slideshow control: ${enabled} (${interval}s) for ${sessionId}`);
    socket.to(sessionId).emit('slideshow-control', { enabled, interval });
  });

  socket.on('slideshow-interval', ({ sessionId, interval }) => {
    console.log(`⏱️ Slideshow interval: ${interval}s for ${sessionId}`);
    socket.to(sessionId).emit('slideshow-interval', { interval });
  });

  // ═══════════════════════════════════════════════════════════════
  // DISCONNECT HANDLER
  // ═══════════════════════════════════════════════════════════════

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected:', socket.id, 'role:', socket.role);
    
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        if (socket.role === 'projector') {
          socket.to(socket.sessionId).emit('projector-disconnected');
          sessions.delete(socket.sessionId);
        } else if (socket.role === 'host') {
          socket.to(socket.sessionId).emit('cast-stop');
          session.currentFile = null;
          session.fileList = [];
          session.host = null;
          setTimeout(() => {
            const s = sessions.get(socket.sessionId);
            if (s && !s.projector && !s.host && !s.main) sessions.delete(socket.sessionId);
          }, 5000);
        } else if (socket.role === 'main') {
          socket.to(socket.sessionId).emit('cast-stop');
          session.currentFile = null;
          session.main = null;
        } else if (socket.role === 'viewer') {
          if (session.viewers) session.viewers = session.viewers.filter(id => id !== socket.id);
          socket.to(socket.sessionId).emit('viewer-left', { viewerId: socket.viewerId });
        } else {
          session.controllers = session.controllers?.filter(id => id !== socket.id) || [];
        }
      }
    }
  });
});

// Cleanup stale sessions every 60 seconds
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [sessionId, session] of sessions.entries()) {
    if (!session.projector && !session.host && (now - session.createdAt > 10 * 60 * 1000)) {
      sessions.delete(sessionId);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} stale sessions`);
}, 60000);

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 DriveX Cast Server v2.8.0 running on port ${PORT}`);
  console.log(`   Features: Cast + Notifications + Video Seek`);
});
