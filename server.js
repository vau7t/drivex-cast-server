/**
 * DriveX Cast Server v2.5.0
 * 
 * WebSocket server for casting files to remote displays
 * 
 * CHANGES v2.5.0:
 * ✅ Added viewer-joined handler (viewer → host relay)
 * ✅ Added viewer-accepted handler (viewer → host relay)
 * ✅ Added viewer-navigate handler (viewer → host relay)
 * ✅ Added register-host handler (for shareable sessions)
 * ✅ Added cast-file-list handler (host → viewer relay)
 * ✅ Added viewer-left handler (viewer → host relay)
 * 
 * Previous features:
 * - Video mute/unmute sync command
 * - Sessions deleted immediately when projector disconnects
 * - Orphan sessions cleaned up after 5 seconds
 * - Video play/pause sync commands
 * - Auto cast-stop when desktop disconnects
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS for all origins
app.use(cors({ origin: '*' }));
app.use(express.json());

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Session storage: { sessionId: { projector, controllers[], lastUpdate, currentFile, host, viewers[] } }
const sessions = new Map();

// ═══════════════════════════════════════════════════════════════
// REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'DriveX Cast Server', version: '2.5.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'online', sessions: sessions.size });
});

// Get active projector sessions (for cross-device discovery)
app.get('/sessions', (req, res) => {
  const activeSessions = [];
  
  sessions.forEach((session, sessionId) => {
    // Only return sessions with an active projector or host
    if (session.projector || session.host) {
      activeSessions.push({
        sessionId,
        hasProjector: !!session.projector,
        hasHost: !!session.host,
        controllerCount: session.controllers?.length || 0,
        viewerCount: session.viewers?.length || 0,
        lastUpdate: session.lastUpdate,
      });
    }
  });
  
  console.log(`📡 GET /sessions - Found ${activeSessions.length} active sessions`);
  
  res.json({ 
    success: true, 
    sessions: activeSessions,
    count: activeSessions.length
  });
});

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO HANDLERS
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // ═══════════════════════════════════════════════════════════════
  // PROJECTOR (TV) HANDLERS
  // ═══════════════════════════════════════════════════════════════

  // Projector (TV) joins
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
    
    // Notify controllers that projector is ready
    socket.to(sessionId).emit('projector-ready', { sessionId });
  });

  // ═══════════════════════════════════════════════════════════════
  // HOST (VaultFilePreview) HANDLERS
  // ═══════════════════════════════════════════════════════════════

  // ✅ NEW: Host registers a shareable session
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

  // Controller (phone/desktop) joins
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
    }
    
    socket.sessionId = sessionId;
    socket.role = 'controller';
    
    // Notify projector
    socket.to(sessionId).emit('controller-joined', { socketId: socket.id });
  });

  // Main app joins (VaultFilePreview casting)
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
    }
    
    socket.sessionId = sessionId;
    socket.role = 'main';
    
    socket.to(sessionId).emit('main-joined', { socketId: socket.id });
  });

  // ═══════════════════════════════════════════════════════════════
  // VIEWER HANDLERS (Remote viewers joining via share link)
  // ═══════════════════════════════════════════════════════════════

  // ✅ NEW: Viewer joined via share link
  socket.on('viewer-joined', (data) => {
    const { sessionId, viewerId, timestamp, userAgent } = data;
    console.log(`👁️ Viewer joined: ${viewerId} for session ${sessionId}`);
    
    socket.join(sessionId);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (!session.viewers) session.viewers = [];
      if (!session.viewers.includes(socket.id)) {
        session.viewers.push(socket.id);
      }
      session.lastUpdate = Date.now();
    }
    
    socket.sessionId = sessionId;
    socket.role = 'viewer';
    socket.viewerId = viewerId;
    
    // Relay to host/main
    socket.to(sessionId).emit('viewer-joined', {
      sessionId,
      viewerId,
      timestamp,
      userAgent
    });
    
    console.log(`📤 Relayed viewer-joined to session ${sessionId}`);
  });

  // ✅ NEW: Viewer has accepted and is ready to receive content
  socket.on('viewer-accepted', (data) => {
    const { sessionId, viewerId, timestamp } = data;
    console.log(`✅ Viewer accepted: ${viewerId} for session ${sessionId}`);
    
    // Relay to host (VaultFilePreview)
    socket.to(sessionId).emit('viewer-accepted', {
      sessionId,
      viewerId,
      timestamp
    });
    
    console.log(`📤 Relayed viewer-accepted to session ${sessionId}`);
  });

  // ✅ NEW: Viewer requests navigation
  socket.on('viewer-navigate', (data) => {
    const { sessionId, viewerId, index, fileName } = data;
    console.log(`🔄 Viewer navigate: ${viewerId} to index ${index} (${fileName})`);
    
    // Relay to host (VaultFilePreview)
    socket.to(sessionId).emit('viewer-navigate', {
      sessionId,
      viewerId,
      index,
      fileName
    });
    
    console.log(`📤 Relayed viewer-navigate to session ${sessionId}`);
  });

  // ✅ NEW: Viewer left
  socket.on('viewer-left', (data) => {
    const { sessionId, viewerId } = data;
    console.log(`👋 Viewer left: ${viewerId} from session ${sessionId}`);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session.viewers) {
        session.viewers = session.viewers.filter(id => id !== socket.id);
      }
    }
    
    // Relay to host
    socket.to(sessionId).emit('viewer-left', { viewerId });
  });

  // ═══════════════════════════════════════════════════════════════
  // CAST CONTENT HANDLERS
  // ═══════════════════════════════════════════════════════════════

  // Cast update (send file to display)
  socket.on('cast-update', (data) => {
    const { sessionId, url, fileName, index, total } = data;
    console.log(`📤 Cast update: ${fileName} (${index + 1}/${total}) to ${sessionId}`);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.currentFile = { url, fileName, index, total };
      session.lastUpdate = Date.now();
    }
    
    // Broadcast to all in session (projector and viewers)
    socket.to(sessionId).emit('cast-update', data);
  });

  // ✅ NEW: Send file list to viewers for navigation
  socket.on('cast-file-list', (data) => {
    const { sessionId, files } = data;
    console.log(`📋 Cast file list: ${files?.length || 0} files to ${sessionId}`);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.fileList = files;
      session.lastUpdate = Date.now();
    }
    
    // Broadcast to all in session
    socket.to(sessionId).emit('cast-file-list', data);
  });

  // Stop casting
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

  // ═══════════════════════════════════════════════════════════════
  // VIDEO CONTROL HANDLERS
  // ═══════════════════════════════════════════════════════════════

  // Video play command (from VaultFilePreview to Projector)
  socket.on('video-play', ({ sessionId }) => {
    console.log(`▶️ Video play: ${sessionId}`);
    socket.to(sessionId).emit('video-play');
  });

  // Video pause command (from VaultFilePreview to Projector)
  socket.on('video-pause', ({ sessionId }) => {
    console.log(`⏸️ Video pause: ${sessionId}`);
    socket.to(sessionId).emit('video-pause');
  });

  // Video mute command (from VaultFilePreview to Projector)
  socket.on('video-mute', ({ sessionId, muted }) => {
    console.log(`${muted ? '🔇' : '🔊'} Video mute: ${sessionId} -> ${muted}`);
    socket.to(sessionId).emit('video-mute', { muted });
  });

  // ═══════════════════════════════════════════════════════════════
  // DISCONNECT HANDLING
  // ═══════════════════════════════════════════════════════════════

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected:', socket.id, 'role:', socket.role);
    
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        if (socket.role === 'projector') {
          // Projector disconnected - delete session immediately
          console.log(`🗑️ Projector disconnected - deleting session: ${socket.sessionId}`);
          socket.to(socket.sessionId).emit('projector-disconnected');
          sessions.delete(socket.sessionId);
        } else if (socket.role === 'host') {
          // Host disconnected - notify viewers to stop cast
          console.log(`🛑 Host disconnected - notifying viewers`);
          socket.to(socket.sessionId).emit('cast-stop');
          session.currentFile = null;
          session.fileList = [];
          session.host = null;
          
          // Clean up session after delay if no one else
          setTimeout(() => {
            const s = sessions.get(socket.sessionId);
            if (s && !s.projector && !s.host && !s.main) {
              sessions.delete(socket.sessionId);
              console.log(`🗑️ Cleaned up host session: ${socket.sessionId}`);
            }
          }, 5000);
        } else if (socket.role === 'main') {
          // Desktop disconnected - notify projector to stop cast
          console.log('🛑 Main (desktop) disconnected - notifying projector');
          socket.to(socket.sessionId).emit('cast-stop');
          session.currentFile = null;
          session.main = null;
        } else if (socket.role === 'viewer') {
          // Viewer disconnected - notify host
          console.log(`👋 Viewer disconnected: ${socket.viewerId}`);
          if (session.viewers) {
            session.viewers = session.viewers.filter(id => id !== socket.id);
          }
          socket.to(socket.sessionId).emit('viewer-left', { viewerId: socket.viewerId });
        } else {
          session.controllers = session.controllers.filter(id => id !== socket.id);
        }
        
        // Clean up sessions with no projector after short delay
        if (socket.role !== 'projector' && socket.role !== 'host') {
          setTimeout(() => {
            const s = sessions.get(socket.sessionId);
            if (s && !s.projector && !s.host && !s.main) {
              sessions.delete(socket.sessionId);
              console.log(`🗑️ Cleaned up orphan session: ${socket.sessionId}`);
            }
          }, 5000);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// PERIODIC CLEANUP
// ═══════════════════════════════════════════════════════════════

// Clean up stale sessions every 60 seconds
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [sessionId, session] of sessions.entries()) {
    // Remove sessions older than 10 minutes with no projector or host
    if (!session.projector && !session.host && (now - session.createdAt > 10 * 60 * 1000)) {
      sessions.delete(sessionId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Periodic cleanup: removed ${cleaned} stale sessions. Active: ${sessions.size}`);
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 DriveX Cast Server v2.5.0 running on port ${PORT}`);
});
