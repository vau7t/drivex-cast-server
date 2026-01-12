/**
 * DriveX Cast Server v2.10.2
 * 
 * WebSocket server for casting files to remote displays
 * + Share notifications
 * 
 * CHANGES v2.10.2:
 * ✅ Fixed cast-stop handler to forward complete data object
 * ✅ Explicit stop flag now properly transmitted to viewers
 * 
 * CHANGES v2.10.1:
 * ✅ Added getViewerDisplayName() - single source of truth for viewer names
 * ✅ Server generates displayName for all viewers (registered + anonymous)
 * ✅ Registered users: use provided viewerName
 * ✅ Anonymous users: generate creative name from location (e.g., "New York Falcon")
 * 
 * CHANGES v2.10.0:
 * ✅ Privacy: Masked emails and user IDs in console logs
 * ✅ Added viewerInfo tracking with names and locations
 * ✅ viewer-count event now includes viewers array
 * 


 * CHANGES v2.9.0:
 * ✅ FIX: Send viewer count to controller when it joins
 * ✅ FIX: Controller no longer misses viewer-joined if viewer connected first
 * ✅ Added viewer-count event for explicit count sync
 
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

// ═══════════════════════════════════════════════════════════════
// PRIVACY: Mask sensitive data in logs
// ═══════════════════════════════════════════════════════════════

const maskEmail = (email) => {
  if (!email) return '[no-email]';
  const parts = email.split('@');
  if (parts.length !== 2) return '[invalid]';
  const name = parts[0];
  const domain = parts[1];
  const maskedName = name.length > 2 ? name[0] + '***' + name.slice(-1) : '***';
  return `${maskedName}@${domain.split('.')[0]}.**`;
};

const maskUserId = (userId) => {
  if (!userId) return '[no-id]';
  const str = String(userId);
  if (str.length <= 8) return str.slice(0, 2) + '***';
  return str.slice(0, 4) + '***' + str.slice(-4);
};



// ═══════════════════════════════════════════════════════════════
// VIEWER NAME GENERATOR - Single source of truth
// ═══════════════════════════════════════════════════════════════

const CREATIVE_ANIMALS = [
  'Falcon', 'Tiger', 'Wolf', 'Eagle', 'Panther', 'Phoenix', 'Dragon', 'Hawk',
  'Lion', 'Leopard', 'Viper', 'Shark', 'Bear', 'Fox', 'Owl', 'Raven'
];

const generateCreativeName = (location, viewerId) => {
  const seed = viewerId ? viewerId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) : Date.now();
  const animal = CREATIVE_ANIMALS[seed % CREATIVE_ANIMALS.length];
  
  // Use city if available
  if (location?.city && location.city !== 'Unknown' && location.city !== 'Localhost') {
    return `${location.city} ${animal}`;
  }
  
  // Use country if available
  if (location?.country && location.country !== 'Unknown' && location.country !== 'Local') {
    return `${location.country} ${animal}`;
  }
  
  // Fallback to region/timezone
  const region = location?.region || (location?.timezone?.split('/')[0]) || '';
  if (region && region !== 'Unknown') {
    return `${region} ${animal}`;
  }
  
  return `Viewer ${animal}`;
};

const getViewerDisplayName = (viewerName, location, viewerId) => {
  if (viewerName) return viewerName;
  return generateCreativeName(location, viewerId);
};



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
    version: '2.10.1',
    features: ['cast', 'notifications', 'video-seek', 'viewer-sync']
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
  
  console.log(`🔔 [Notify] Event: ${event}, userId: ${maskUserId(userId)}, email: ${maskEmail(email)}`);
  
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
// CHAT MESSAGE BROADCAST ENDPOINT (called by main backend)
// ═══════════════════════════════════════════════════════════════

app.post('/chat/broadcast', (req, res) => {
  const { secret, channelPath, channelId, message, recipients } = req.body;
  
  if (NOTIFY_SECRET && secret !== NOTIFY_SECRET) {
    console.log('❌ [Chat] Invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log(`💬 [Chat] Broadcasting to ${recipients?.length || 0} recipients`);
  console.log(`   Channel: ${channelPath}, Message: ${message?.content?.substring(0, 50)}...`);
  
  const notificationsNsp = io.of('/notifications');
  let delivered = 0;
  
  // Send to each recipient (by userId and email)
  if (recipients && Array.isArray(recipients)) {
    recipients.forEach(recipient => {
      const { userId, email } = recipient;
      
      const eventData = {
        channelPath,
        channelId,
        channelName: channelPath?.replace(/^\//, ''),
        senderName: message.senderName,
        senderEmail: message.senderEmail,
        senderId: message.senderId,
        messagePreview: message.content,
        messageId: message._id || message.id,
        messageType: message.type || 'text'
      };
      
      if (userId) {
        notificationsNsp.to(`user:${userId}`).emit('chat:message', eventData);
        delivered++;
      }
      
      if (email) {
        const normalizedEmail = email.toLowerCase();
        notificationsNsp.to(`email:${normalizedEmail}`).emit('chat:message', eventData);
      }
    });
  }
  
  console.log(`📤 [Chat] Delivered to ${delivered} users`);
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
    console.log(`🔔 [Notifications] Auth success: ${maskUserId(socket.userId)}`);
    next();
  } catch (err) {
    console.error('🔔 [Notifications] Auth error:', err.message);
    next(new Error('Invalid token'));
  }
});

notificationsNsp.on('connection', (socket) => {
  console.log(`🔔 [Notifications] Connected: ${maskUserId(socket.userId)}`);
  
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
      console.log(`🔔 [Notifications] Joined room: user:${maskUserId(userId)}`);
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log(`🔔 [Notifications] Disconnected: ${maskUserId(socket.userId)} - ${reason}`);
    
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
// HELPER: Send viewer count to a socket
// ═══════════════════════════════════════════════════════════════

const sendViewerCount = (socket, sessionId) => {
  const session = sessions.get(sessionId);
  const viewerCount = session?.viewers?.length || 0;
  const viewers = session?.viewerInfo || [];
  console.log(`👁️ [Cast] Sending viewer count to ${socket.id}: ${viewerCount} viewers`);
  socket.emit('viewer-count', { count: viewerCount, sessionId, viewers });
};

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
    
    // ✅ v2.9.0: Send current viewer count to new host
    sendViewerCount(socket, sessionId);
    
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
    
    // ✅ v2.9.0: Send current viewer count to new controller
    sendViewerCount(socket, sessionId);
    
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
    
    // ✅ v2.9.0: Send current viewer count to new main
    sendViewerCount(socket, sessionId);
    
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
      // ✅ v2.9.0: Send viewer count when joining room as controller/main
      sendViewerCount(socket, room);
    }
  });

  socket.on('ping-projector', ({ sessionId }) => {
    console.log(`🏓 Ping for session: ${sessionId}`);
    if (sessions.has(sessionId) && sessions.get(sessionId).projector) {
      socket.emit('projector-ready', { sessionId, timestamp: Date.now() });
    }
  });
  
  // ✅ v2.9.0: Request viewer count explicitly
  socket.on('get-viewer-count', ({ sessionId }) => {
    console.log(`👁️ Viewer count requested for: ${sessionId}`);
    sendViewerCount(socket, sessionId);
  });

socket.on('viewer-joined', (data) => {
  const { sessionId, viewerId, timestamp, userAgent, viewerName, location } = data;
  console.log(`👁️ Viewer joined: ${viewerId?.slice(0, 8)}*** for session ${sessionId?.slice(0, 12)}***`);
  socket.join(sessionId);
  
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    if (!session.viewers) session.viewers = [];
    if (!session.viewerInfo) session.viewerInfo = [];
    
    // Store socket.id for counting
    if (!session.viewers.includes(socket.id)) session.viewers.push(socket.id);
    
    // ✅ v2.10.1: Generate displayName on server (single source of truth)
    const displayName = getViewerDisplayName(viewerName, location, viewerId);
    
    // Store viewer info object with pre-computed displayName
    const existingIndex = session.viewerInfo.findIndex(v => v.socketId === socket.id);
    const viewerData = {
      socketId: socket.id,
      viewerId,
      displayName,  // ✅ Pre-computed display name
      location: location || null,
      joinedAt: timestamp || Date.now()
    };
    
    if (existingIndex === -1) {
      session.viewerInfo.push(viewerData);
    } else {
      session.viewerInfo[existingIndex] = viewerData;
    }
    
    session.lastUpdate = Date.now();
    
    // Send viewer count AND viewer info to everyone
    const viewerCount = session.viewers.length;
    io.to(sessionId).emit('viewer-count', { 
      count: viewerCount, 
      sessionId,
      viewers: session.viewerInfo 
    });
  }
  
  socket.sessionId = sessionId;
  socket.role = 'viewer';
  socket.viewerId = viewerId;
  socket.viewerName = viewerName;
  
  // Relay to others in the room (for UI notification)
  socket.to(sessionId).emit('viewer-joined', { sessionId, viewerId, timestamp, userAgent, viewerName, location });
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
if (session.viewers) {
  session.viewers = session.viewers.filter(id => id !== socket.id);
}
if (session.viewerInfo) {
  session.viewerInfo = session.viewerInfo.filter(v => v.socketId !== socket.id);
}
// ✅ v2.10.0: Send updated viewer count with viewer info on disconnect
const viewerCount = session.viewers?.length || 0;
io.to(socket.sessionId).emit('viewer-count', { 
  count: viewerCount, 
  sessionId: socket.sessionId,
  viewers: session.viewerInfo || []
});
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

socket.on('cast-stop', (data) => {  // ✅ Accept full data object
  const { sessionId, timestamp, explicit } = data;
  console.log(`⏹️ Cast stopped: ${sessionId}, explicit: ${explicit}`);
  
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.currentFile = null;
    session.fileList = [];
  }
  
  // ✅ FORWARD THE COMPLETE DATA OBJECT!
  socket.to(sessionId).emit('cast-stop', data);
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
          if (session.viewers) {
            session.viewers = session.viewers.filter(id => id !== socket.id);
          }
          if (session.viewerInfo) {
            session.viewerInfo = session.viewerInfo.filter(v => v.socketId !== socket.id);
          }
          // ✅ v2.10.0: Send updated viewer count with viewer info on disconnect
          const viewerCount = session.viewers?.length || 0;
          io.to(socket.sessionId).emit('viewer-count', { 
            count: viewerCount, 
            sessionId: socket.sessionId,
            viewers: session.viewerInfo || []
          });
          socket.to(socket.sessionId).emit('viewer-left', { viewerId: socket.viewerId });
        } else {
          session.controllers = session.controllers?.filter(id => id !== socket.id) || [];
        }
      }
    }
  });
}); // <-- ADD THIS LINE to close io.on('connection')


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
console.log(`🚀 DriveX Cast Server v2.10.1 running on port ${PORT}`);
  console.log(`   Features: Cast + Notifications + Video Seek + Viewer Sync`);
});
