const express = require("express");
require("dotenv").config();
const app = express();
const http = require("http");
const path = require("path");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const multer = require("multer");
const { initSocket } = require("./src/socket");
require("./jobs/birthdaycron");


const { startDraftPlanReminderCron } = require("./jobs/draftplanremindercron");
const { startEventFinalizeCron } = require("./jobs/eventcron");
const { startBragCleanupCron } = require("./jobs/bragcleanupcron");

const rateLimit = require("express-rate-limit");

const authRoutes        = require("./src/routes/authRoutes");
// GroupSprint (LiveKit rooms, multi-writer tracking) is disconnected for
// now — replaced below by a minimal solo sprint flow (duration + checkin).
// const groupSprintRoutes = require("./src/routes/groupSprintRoutes");
const sprintRoutes      = require("./src/routes/sprintroutes");
const sprintRoomRoutes  = require("./src/routes/sprintroomroutes");
const userRoutes        = require("./src/routes/userRoutes");
const notificationRoutes = require("./src/routes/notificationRoutes");
const blogRoutes        = require("./src/routes/blogRoutes");
const soundscapesRoutes = require("./src/routes/soundscaperoutes");
const feedbackRoutes    = require("./src/routes/feedbackRoutes"); 
const draftRoutes = require("./src/routes/draftroutes");
const reportRoutes = require("./src/routes/reportRoutes");
const threadRoutes = require("./src/routes/threadroutes");
const eventRoutes = require("./src/routes/eventroutes");
const draftPlanRoutes = require("./src/routes/draftplanroutes");
const directMessageRoutes = require("./src/routes/directmessageroutes");
const profileRoutes = require("./src/routes/profileroutes");
const dictionaryRoutes = require("./src/routes/dictionaryroutes");
const workspaceRoutes = require("./src/routes/workspaceroutes");
const draftFolderRoutes = require("./src/routes/draftfolderroutes");
const shareRoutes = require("./src/routes/shareRoutes");
const mailboxRoutes = require("./src/routes/mailboxRoutes");

app.use(express.json({ limit: "10mb" })); // raised from the default 100kb — the brag card's captured PNG travels here as base64
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN,
  credentials: true, // needed because you use cookies for JWT
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
}));

app.use(cookieParser());

// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // max 100 requests per IP per 15 min
//   message: { error: "Too many requests, slow down." }
// });

// app.use("/api/", limiter); // applies to all your API routes

startDraftPlanReminderCron();
startEventFinalizeCron();
startBragCleanupCron();

app.use("/api/auth",          authRoutes);
app.use("/api/sprint",        sprintRoutes);
app.use("/api/sprint-room",   sprintRoomRoutes);
app.use("/api/users",         userRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/blog",          blogRoutes);
app.use("/api/soundscapes",   soundscapesRoutes);
app.use("/api/feedback",      feedbackRoutes); 
app.use("/api/drafts", draftRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/threads", threadRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/draftplan", draftPlanRoutes);
app.use("/api/direct-messages", directMessageRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/dictionary", dictionaryRoutes);
app.use("/api/workspace", workspaceRoutes);
app.use("/api/draftfolders", draftFolderRoutes);
app.use("/api", shareRoutes); // /api/share/sprint/:id, /api/og/sprint-room/:id.png, /api/brag/upload, /api/share/brag/:id — no auth, see sharerroutes.js
app.use("/api/mailbox", mailboxRoutes);

// Static host for uploaded brag-card images (uploadBragImage in
// sharecontroller.js writes to src/uploads/brag). Public and
// unauthenticated on purpose — X/Tumblr's crawlers need to fetch these
// directly, same as everything else in sharerroutes.js.
app.use("/api/uploads", express.static(path.join(__dirname, "src", "uploads")));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === "Unsupported file type") {
    return res.status(400).json({ message: err.message });
  }
  res.status(500).json({ message: err.message });
});

const server = http.createServer(app);
initSocket(server);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});