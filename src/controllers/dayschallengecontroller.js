// src/controllers/daysChallengeController.js
const daysChallengeService = require("../services/dayschallengeservice");
const { notifyUser }       = require("../services/notificationService");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function errStatus(msg) {
  if (msg.includes("not found") || msg.includes("No challenge found") || msg.includes("No active")) return 404;
  if (msg.includes("Not authorised"))      return 403;
  if (msg.includes("already have an active")) return 409;
  if (msg.includes("no longer active") || msg.includes("expired")) return 410;
  if (msg.includes("Only manually completed")) return 409;
  if (msg.includes("deadline for this challenge")) return 410;
  return 400;
}

// ─── CHALLENGE CRUD ───────────────────────────────────────────────────────────

async function createChallenge(req, res) {
  try {
    const result = await daysChallengeService.createChallenge(req.user.id, req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function getMyChallenge(req, res) {
  try {
    const result = await daysChallengeService.getMyChallenge(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function updateChallenge(req, res) {
  try {
    const result = await daysChallengeService.updateChallenge(req.user.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// Mark done early
async function completeChallenge(req, res) {
  try {
    const result = await daysChallengeService.completeChallenge(req.user.id);

    // Notify other active challenge writers
    daysChallengeService.getOtherActiveChallengeUsers(req.user.id)
      .then((users) => {
        const title   = result.challenge.storyTitle ? ` on "${result.challenge.storyTitle}"` : "";
        const message = `${req.user.username} just completed their ${result.challenge.duration === "SEVEN" ? "7" : "15"}-day challenge${title}!`;
        const link    = `/days-challenge`;
        users.forEach((u) => notifyUser(u, message, link, "dayschallenge_completed", "GENERAL", {
          kind: "challenge_update", title: result.challenge.storyTitle,
        }).catch(() => {}));
      })
      .catch(() => {});

    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// Undo "Mark done early" — revert COMPLETED → ACTIVE if endDate is still in future
async function uncompleteChallenge(req, res) {
  try {
    const result = await daysChallengeService.uncompleteChallenge(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function leaveChallenge(req, res) {
  try {
    const result = await daysChallengeService.leaveChallenge(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── PROGRESS LOGGING ────────────────────────────────────────────────────────

async function logProgress(req, res) {
  try {
    const result = await daysChallengeService.logProgress(req.user.id, req.body);
    const { checkIn, metDailyGoal, isAllDone, challenge } = result;

    // Notify other active writers when someone logs
    daysChallengeService.getOtherActiveChallengeUsers(req.user.id)
      .then((users) => {
        const unit    = challenge.goalType === "WORDS" ? "words" : "minutes";
        const title   = challenge.storyTitle ? ` on "${challenge.storyTitle}"` : "";
        const message = `${req.user.username} just logged ${checkIn.countLogged} ${unit}${title} in their days challenge`;
        const link    = `/days-challenge`;
        users.forEach((u) => notifyUser(u, message, link, "dayschallenge_progress_logged", "GENERAL", {
          kind: "challenge_update", title: challenge.storyTitle,
        }).catch(() => {}));
      })
      .catch(() => {});

    // If they hit all days, notify other writers
    if (isAllDone) {
      daysChallengeService.getOtherActiveChallengeUsers(req.user.id)
        .then((users) => {
          const days    = challenge.duration === "SEVEN" ? "7" : "15";
          const title   = challenge.storyTitle ? ` on "${challenge.storyTitle}"` : "";
          const message = `${req.user.username} just completed all ${days} days of their writing challenge${title}!`;
          const link    = `/days-challenge`;
          users.forEach((u) => notifyUser(u, message, link, "dayschallenge_completed", "GENERAL", {
            kind: "challenge_update", title: challenge.storyTitle,
          }).catch(() => {}));
        })
        .catch(() => {});
    }

    res.status(201).json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── COMMUNITY FEED ──────────────────────────────────────────────────────────

async function getActiveChallengeWriters(req, res) {
  try {
    const writers = await daysChallengeService.getActiveChallengeWriters(req.user?.id ?? null);
    res.json(writers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getWritersWhoLoggedToday(req, res) {
  try {
    const writers = await daysChallengeService.getWritersWhoLoggedToday();
    res.json(writers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
  createChallenge,
  getMyChallenge,
  updateChallenge,
  completeChallenge,
  uncompleteChallenge,
  leaveChallenge,
  logProgress,
  getActiveChallengeWriters,
  getWritersWhoLoggedToday,
};