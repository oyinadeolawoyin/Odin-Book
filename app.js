const express = require("express");
require("dotenv").config();
const app = express();
const cookieParser = require("cookie-parser");
const cors = require("cors");
const multer = require("multer");
// require("./jobs/scheduledjobs");
const { startChallengeCron } = require("./jobs/challengecron");
const { startDaysChallengeCron } = require("./jobs/dayschallengeexpirycron");
const { startDaysChallengeReminderCron } = require("./jobs/dayschallengeremindercron");
const { startDraftPlanReminderCron } = require("./jobs/draftplanremindercron");
const { startSprintReminderCron } = require("./jobs/sprintremindercron");
const { startEventFinalizeCron } = require("./jobs/eventcron");

const rateLimit = require("express-rate-limit");

const authRoutes        = require("./src/routes/authRoutes");
const groupSprintRoutes = require("./src/routes/groupSprintRoutes");
const userRoutes        = require("./src/routes/userRoutes");
const notificationRoutes = require("./src/routes/notificationRoutes");
const blogRoutes        = require("./src/routes/blogRoutes");
const soundscapesRoutes = require("./src/routes/soundscaperoutes");
const feedbackRoutes    = require("./src/routes/feedbackRoutes"); 
const discoveryRoutes = require("./src/routes/discoveryroutes");
const leaderboardRoutes = require("./src/routes/leaderboardRoutes");
const draftRoutes = require("./src/routes/draftroutes");
const reportRoutes = require("./src/routes/reportRoutes");
const challengeRoutes = require("./src/routes/challengeroutes");
const threadRoutes = require("./src/routes/threadroutes");
const eventRoutes = require("./src/routes/eventroutes");
const miniChallengeRoutes = require("./src/routes/minichallengeroutes");
const draftPlanRoutes = require("./src/routes/draftplanroutes");
const dayChallengeRoutes = require("./src/routes/dayschallengeroutes");
const directMessageRoutes = require("./src/routes/directmessageroutes");
const profileRoutes = require("./src/routes/profileroutes");

app.use(express.json());
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
startDaysChallengeCron();
startDaysChallengeReminderCron();
startDraftPlanReminderCron();
startSprintReminderCron();
startEventFinalizeCron();

app.use("/api/auth",          authRoutes);
app.use("/api/sprint",        groupSprintRoutes);
app.use("/api/users",         userRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/blog",          blogRoutes);
app.use("/api/soundscapes",   soundscapesRoutes);
app.use("/api/feedback",      feedbackRoutes); 
app.use("/api/discovery", discoveryRoutes);
app.use("/api/leaderboard", leaderboardRoutes)
app.use("/api/drafts", draftRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/challenge", challengeRoutes);
app.use("/api/threads", threadRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/mini-challenges", miniChallengeRoutes);
app.use("/api/draftplan", draftPlanRoutes);
app.use("/api/days-challenge", dayChallengeRoutes);
app.use("/api/direct-messages", directMessageRoutes);
app.use("/api/profile", profileRoutes);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === "Unsupported file type") {
    return res.status(400).json({ message: err.message });
  }
  res.status(500).json({ message: err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});