// src/controllers/draftPlanController.js
const draftPlanService = require("../services/draftplanservice");
const { notifyUser }   = require("../services/notificationService");
const { uploadFile }   = require("../utilis/fileUploader");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function errStatus(msg) {
  if (msg.includes("not found"))                    return 404;
  if (msg.includes("Not authorised"))               return 403;
  if (msg.includes("already been marked complete")) return 409;
  if (msg.includes("already have a draft plan"))    return 409;
  return 400;
}

// ─── PLAN CRUD ────────────────────────────────────────────────────────────────

async function createPlan(req, res) {
  try {
    const plan = await draftPlanService.createPlan(req.user.id, req.body);
    res.status(201).json(plan);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function getMyPlan(req, res) {
  try {
    const result = await draftPlanService.getPlanProgress(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function updatePlan(req, res) {
  try {
    const plan = await draftPlanService.updatePlan(req.user.id, req.body);
    res.json(plan);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function deletePlan(req, res) {
  try {
    const result = await draftPlanService.deletePlan(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── MOODBOARD IMAGE UPLOAD ───────────────────────────────────────────────────
// POST /draftplan/upload-image — multer puts the file on req.file.
// Returns { url } so the frontend can append it to moodboardImages then
// PATCH /draftplan with the updated array.

async function uploadMoodboardImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No image file provided." });
    }
    const url = await uploadFile(req.file);
    res.status(201).json({ url });
  } catch (err) {
    console.error("Moodboard image upload error:", err);
    res.status(500).json({ message: err.message ?? "Couldn't upload that image." });
  }
}

// ─── PROGRESS LOGGING ────────────────────────────────────────────────────────

async function logProgress(req, res) {
  try {
    const result = await draftPlanService.logProgress(req.user.id, req.body);
    const { log, isDraftDone, isPickedDay, metDailyGoal, metWeeklyGoal, plan } = result;

    // ── Notifications (fire-and-forget) ──────────────────────────────────────
    // Only celebrate additions publicly — a "remove" entry is a correction,
    // not a writing session worth notifying other writers about.
    if (result.direction !== "remove") {
      draftPlanService.getOtherActivePlanUsers(req.user.id)
        .then((users) => {
          const unit    = plan.goalType === "WORDS"
            ? "words"
            : plan.goalType === "CHAPTERS" ? "chapters" : "scenes";
          const message = `${req.user.username} just logged ${log.countLogged} ${unit} on "${plan.storyTitle}"`;
          const link    = `/draftplan`;
          users.forEach((u) => notifyUser(u, message, link, "draftplan_progress_logged", "GENERAL", {
            kind: "challenge_update", title: plan.storyTitle,
          }).catch(() => {}));
        })
        .catch(() => {});
    }

    if (isDraftDone) {
      draftPlanService.getOtherActivePlanUsers(req.user.id)
        .then((users) => {
          const message = `${req.user.username} just finished their draft of "${plan.storyTitle}"! Go congratulate them!`;
          const link    = `/draftplan`;
          users.forEach((u) => notifyUser(u, message, link, "draftplan_draft_completed", "GENERAL", {
            kind: "challenge_update", title: plan.storyTitle,
          }).catch(() => {}));
        })
        .catch(() => {});
    }

    res.status(201).json({
      log,
      direction: result.direction,
      isDraftDone,
      isPickedDay,
      metDailyGoal,
      metWeeklyGoal,
      dailyTreat:  result.dailyTreat,
      weeklyTreat: result.weeklyTreat,
    });
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── COMMUNITY FEED ──────────────────────────────────────────────────────────

async function getActiveDraftWriters(req, res) {
  try {
    const writers = await draftPlanService.getActiveDraftWriters(req.user?.id ?? null);
    res.json(writers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getWritersWhoLoggedToday(req, res) {
  try {
    const writers = await draftPlanService.getWritersWhoLoggedToday();
    res.json(writers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// Requires auth — only returns results if the requesting user's own plan
// also has today as a picked writing day (enforced in the service).
async function getWritersScheduledToday(req, res) {
  try {
    const writers = await draftPlanService.getWritersScheduledToday(req.user.id);
    res.json(writers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
  createPlan,
  getMyPlan,
  updatePlan,
  deletePlan,
  logProgress,
  uploadMoodboardImage,
  getActiveDraftWriters,
  getWritersWhoLoggedToday,
  getWritersScheduledToday,
};