/**
 * DriveX Cast Server v2.1.0
 * 
 * WebSocket server for casting files to remote displays
 * - /sessions endpoint for cross-device auto-discovery
 * - Video play/pause sync commands
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

// Session storage: { sessionId: { projector, controllers[], lastUpdate, currentFile } }
const sessions = new Map();

// ═══════════════════════════════════════════════════════════════
// REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'DriveX Cast Server', version: '2.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'online', sessions: sessions.size });
});

// ✅ NEW: Get active projector sessions (for cross-device discovery)
app.get('/sessions', (req, res) => {
  const activeSessions = [];
  
  sessions.forEach((session, sessionId) => {
    // Only return sessions with an active projector
    if (session.projector) {
      activeSessions.push({
        sessionId,
        hasProjector: true,
        controllerCount: session.controllers?.length || 0,
        lastUpdate: session.lastUpdate,
        // Don't expose socket IDs for security
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
  console.log('Connected:', socket.id);

  // Projector (TV) joins
  socket.on('join-projector', ({ sessionId }) => {
    console.log(`📺 Projector joined: ${sessionId}`);
    socket.join(sessionId);
    
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { 
        projector: socket.id, 
        controllers: [],
        lastUpdate: Date.now(),
        currentFile: null
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

  // Controller (phone/desktop) joins
  socket.on('join-controller', ({ sessionId }) => {
    console.log(`📱 Controller joined: ${sessionId}`);
    socket.join(sessionId);
    
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { 
        projector: null, 
        controllers: [socket.id],
        lastUpdate: Date.now(),
        currentFile: null
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
        controllers: [socket.id],
        lastUpdate: Date.now(),
        currentFile: null
      });
    } else {
      const session = sessions.get(sessionId);
      if (!session.controllers.includes(socket.id)) {
        session.controllers.push(socket.id);
      }
      session.lastUpdate = Date.now();
    }
    
    socket.sessionId = sessionId;
    socket.role = 'main';
    
    socket.to(sessionId).emit('main-joined', { socketId: socket.id });
  });

  // Cast update (send file to display)
  socket.on('cast-update', (data) => {
    const { sessionId, url, fileName, index, total } = data;
    console.log(`📤 Cast: ${fileName} to ${sessionId}`);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.currentFile = { url, fileName, index, total };
      session.lastUpdate = Date.now();
    }
    
    // Broadcast to all in session (especially projector)
    socket.to(sessionId).emit('cast-update', data);
  });

  // Stop casting
  socket.on('cast-stop', ({ sessionId }) => {
    console.log(`⏹️ Cast stopped: ${sessionId}`);
    
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.currentFile = null;
      session.lastUpdate = Date.now();
    }
    
    socket.to(sessionId).emit('cast-stop');
  });

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

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        if (socket.role === 'projector') {
          session.projector = null;
          // Notify controllers projector is gone
          socket.to(socket.sessionId).emit('projector-disconnected');
        } else {
          session.controllers = session.controllers.filter(id => id !== socket.id);
        }
        
        // Clean up empty sessions after delay
        setTimeout(() => {
          const s = sessions.get(socket.sessionId);
          if (s && !s.projector && s.controllers.length === 0) {
            sessions.delete(socket.sessionId);
            console.log(`🗑️ Cleaned up session: ${socket.sessionId}`);
          }
        }, 30000);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
