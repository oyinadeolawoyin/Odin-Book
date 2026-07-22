const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const groupSprintService = require("../services/groupSprintService");

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.ALLOWED_ORIGIN,
      credentials: true,
    },
  });

  // Same JWT-in-cookie scheme as authenticateJWT — read manually since
  // socket.io connections don't pass through Express's cookie-parser.
  io.use((socket, next) => {
    try {
      const raw = socket.handshake.headers.cookie;
      if (!raw) return next(new Error("Authentication token missing"));
      const { token } = cookie.parse(raw);
      if (!token) return next(new Error("Authentication token missing"));
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch (err) {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    // Room-scoped channel — still just one sprint room today, but keyed
    // by id so a second room works later without touching this.
    socket.on("room:join", (sprintRoomId) => {
      socket.join(`sprint-room:${sprintRoomId}`);
    });
    socket.on("room:leave", (sprintRoomId) => {
      socket.leave(`sprint-room:${sprintRoomId}`);
    });

    // Live word-count push — writes through the same service function the
    // HTTP path used, then broadcasts to everyone else in the room.
    socket.on("sprint:progress", async ({ sprintId, sprintRoomId, currentWordCount }) => {
      try {
        const updated = await groupSprintService.updateSprintProgress(
          Number(sprintId),
          Number(currentWordCount) || 0
        );
        if (!updated) return; // sprint already ended server-side — ignore late ping

        io.to(`sprint-room:${sprintRoomId}`).emit("sprint:progress", {
          userId: updated.userId,
          sprintId: updated.id,
          wordsWritten: updated.wordsWritten,
        });
      } catch (err) {
        console.error("[socket] sprint:progress failed:", err);
      }
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error("Socket.io not initialized — call initSocket(server) first");
  return io;
}

module.exports = { initSocket, getIO };