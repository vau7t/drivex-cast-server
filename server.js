/**
 * DriveX Cast Server v2.7.0
 * 
 * WebSocket server for casting files to remote displays
 * + Share notifications
 * 
 * CHANGES v2.7.0:
 * ✅ Added /notifications namespace for share events
 * ✅ Added POST /notify endpoint for backend to trigger notifications
 * ✅ Added JWT verification for notification connections
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);

// CORS for all origins
app.use(cors({ origin: '*' }));
app.use(express.json());

// JWT secret - should match your main backend
const JWT_SECRET = process.env.JWT_SECRET_KEY || process.env.JWT_SECRET;

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Session storage for cast
const sessions = new Map();

// Connected notification users: { odId: Set<socketId>, email: Set<socketId> }
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
    version: '2.7.0',
    features: ['cast', 'notifications']
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'online', 
    sessions: sessions.size,
    notificationUsers: notificationUsers.byUserId.size
  });
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATION TRIGGER ENDPOINT (called by main backend)
// ═══════════════════════════════════════════════════════════════

app.post('/notify', (req, res) => {
  const { secret, event, userId, email, data } = req.body;
  
  // Verify secret (simple auth for server-to-server)
  if (secret !== process.env.NOTIFY_SECRET) {
    console.log('❌ [Notify] Invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log(`🔔 [Notify] Event: ${event}, userId: ${userId}, email: ${email}`);
  
  const notificationsNsp = io.of('/notifications');
  let delivered = 0;
  
  // Emit to user ID room
  if (userId) {
    notificationsNsp.to(`user:${userId}`).emit(event, data);
    const userSockets = notificationUsers.byUserId.get(userId);
    delivered += userSockets?.size || 0;
  }
  
  // Emit to email room (for guests)
  if (email) {
    const normalizedEmail = email.toLowerCase();
    notificationsNsp.to(`email:${normalizedEmail}`).emit(event, data);
    const emailSockets = notificationUsers.byEmail.get(normalizedEmail);
    delivered += emailSockets?.size || 0;
  }
  
  console.log(`📤 [Notify] Delivered to ${delivered} sockets`);
  
  res.json({ success: true, delivered });
});

// Get active sessions (existing endpoint)
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
// NOTIFICATIONS NAMESPACE
// ═══════════════════════════════════════════════════════════════

const notificationsNsp = io.of('/notifications');

// Auth middleware for notifications
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
  
  // Track connected users
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
  
  // Manual room join (if needed)
  socket.on('join:user', ({ userId }) => {
    if (userId) {
      socket.join(`user:${userId}`);
      console.log(`🔔 [Notifications] Joined room: user:${userId}`);
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log(`🔔 [Notifications] Disconnected: ${socket.userId} - ${reason}`);
    
    // Clean up tracking
    if (socket.userId) {
      const userSockets = notificationUsers.byUserId.get(socket.userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          notificationUsers.byUserId.delete(socket.userId);
        }
      }
    }
    
    if (socket.userEmail) {
      const emailSockets = notificationUsers.byEmail.get(socket.userEmail);
      if (emailSockets) {
        emailSockets.delete(socket.id);
        if (emailSockets.size === 0) {
          notificationUsers.byEmail.delete(socket.userEmail);
        }
      }
    }
  });
});

console.log('✅ /notifications namespace initialized');

// ═══════════════════════════════════════════════════════════════
// CAST SOCKET HANDLERS (existing code - keep all of it)
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // ... ALL YOUR EXISTING CAST HANDLERS ...
  // (join-projector, join-controller, cast-update, etc.)
  // Keep everything from your current server
  
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
        socket.emit('projector-ready', { sessionId, timestamp: Date.now() });
      }
    }
    
    socket.sessionId = sessionId;
    socket.role = 'main';
    socket.to(sessionId).emit('main-joined', { socketId: socket.id });
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

  socket.on('cast-stop', ({ sessionId }) => {
    console.log(`⏹️ Cast stopped: ${sessionId}`);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.currentFile = null;
      session.fileList = [];
      session.lastUpdate = Date.now();
    }
    
    socket.to(sessionId).emit('cast-stop');
  });

  socket.on('viewer-joined', (data) => {
    const { sessionId, viewerId } = data;
    console.log(`👁️ Viewer joined: ${viewerId} for session ${sessionId}`);
    socket.join(sessionId);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (!session.viewers) session.viewers = [];
      if (!session.viewers.includes(socket.id)) {
        session.viewers.push(socket.id);
      }
    }
    
    socket.sessionId = sessionId;
    socket.role = 'viewer';
    socket.viewerId = viewerId;
    socket.to(sessionId).emit('viewer-joined', data);
  });

  socket.on('viewer-navigate', (data) => {
    socket.to(data.sessionId).emit('viewer-navigate', data);
  });

  socket.on('video-play', ({ sessionId }) => {
    socket.to(sessionId).emit('video-play');
  });

  socket.on('video-pause', ({ sessionId }) => {
    socket.to(sessionId).emit('video-pause');
  });

  socket.on('video-mute', ({ sessionId, muted }) => {
    socket.to(sessionId).emit('video-mute', { muted });
  });

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected:', socket.id, 'role:', socket.role);
    
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        if (socket.role === 'projector') {
          socket.to(socket.sessionId).emit('projector-disconnected');
          sessions.delete(socket.sessionId);
        } else if (socket.role === 'host' || socket.role === 'main') {
          socket.to(socket.sessionId).emit('cast-stop');
          session.currentFile = null;
          session[socket.role] = null;
        } else {
          session.controllers = session.controllers?.filter(id => id !== socket.id) || [];
          session.viewers = session.viewers?.filter(id => id !== socket.id) || [];
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 DriveX Cast Server v2.7.0 running on port ${PORT}`);
  console.log(`   Features: Cast + Notifications`);
});
