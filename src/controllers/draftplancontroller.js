// src/controllers/draftPlanController.js
const draftPlanService = require("../services/draftplanservice");
const followService    = require("../services/followService");
const { notifyUser }   = require("../services/notificationService");
const { uploadFile }   = require("../utilis/fileUploader");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function errStatus(msg) {
  if (msg.includes("not found"))                    return 404;
  if (msg.includes("Not authorised"))               return 403;
  if (msg.includes("already been marked complete")) return 409;
  if (msg.includes("up to") && msg.includes("active draft plans")) return 409;
  if (msg.includes("planned writing days"))         return 409; // tried to open a Bonus Quest on a picked day
  if (msg.includes("Pick one of today's two"))      return 409; // tried to log before picking a candidate
  if (msg.includes("already picked a prompt"))      return 409; // tried to decline after already choosing
  return 400;
}

// Every plan-scoped route reads the plan id the same way — a :planId route
// param if the route has one, otherwise the body/query. Centralised here so
// every handler below stays one line for this instead of repeating it.
function planIdFrom(req) {
  return req.params.planId ?? req.body?.planId ?? req.query?.planId;
}

// ─── PLAN LIST ────────────────────────────────────────────────────────────────
// A writer can hold several plans now — this is what the "Draft Plans"
// button in the workspace and the plan-switcher read from.

async function getMyPlans(req, res) {
  try {
    const plans = await draftPlanService.getMyPlans(req.user.id);
    res.json(plans);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── PLAN CRUD ────────────────────────────────────────────────────────────────

async function createPlan(req, res) {
  try {
    const plan = await draftPlanService.createPlan(req.user.id, req.body);
    res.status(201).json(plan);

    // Notify followers (fire-and-forget) — same "someone you follow just
    // did X" pattern as progress/completion/halfway/sprint notifications.
    followService.getFollowerContacts(req.user.id)
      .then((followers) => {
        const message = `${req.user.username} just started a new draft plan for "${plan.storyTitle}" — send them a Booster card for some encouragement!`;
        const link    = `/draftplan/${plan.id}`;
        followers.forEach((f) => notifyUser(f, message, link, "draftplan_started", "GENERAL", req.user.avatar, {
          kind: "challenge_update", title: plan.storyTitle, actorId: req.user.id,
        }, "WRITING").catch(() => {}));
      })
      .catch(() => {});
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function getMyPlan(req, res) {
  try {
    const result = await draftPlanService.getPlanProgress(req.user.id, planIdFrom(req));
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function updatePlan(req, res) {
  try {
    const plan = await draftPlanService.updatePlan(req.user.id, planIdFrom(req), req.body);
    res.json(plan);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function deletePlan(req, res) {
  try {
    const result = await draftPlanService.deletePlan(req.user.id, planIdFrom(req));
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── MOODBOARD IMAGE UPLOAD ───────────────────────────────────────────────────

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
    const planId = planIdFrom(req);
    const result = await draftPlanService.logProgress(req.user.id, planId, req.body);
    const { log, isDraftDone, justCompleted, justReachedHalfway, isPickedDay, metDailyGoal, metWeeklyGoal, plan, dictionary } = result;

    if (result.direction !== "remove") {
      followService.getFollowerContacts(req.user.id)
        .then((followers) => {
          const unit    = plan.goalType === "WORDS"
            ? "words"
            : plan.goalType === "CHAPTERS" ? "chapters" : "scenes";
          const message = `${req.user.username} just logged ${log.countLogged} ${unit} on "${plan.storyTitle}" — send them a Well Done card!`;
          followers.forEach((f) => notifyUser(f, message, `/workspace`, "draftplan_progress_logged", "GENERAL", req.user.avatar, {
            kind: "challenge_update", title: plan.storyTitle, actorId: req.user.id,
          }, "WRITING").catch(() => {}));
        })
        .catch(() => {});
    }

    // justReachedHalfway/justCompleted (not isDraftDone alone) — isDraftDone
    // stays true on every log AFTER completion too, so gating on it directly
    // would re-notify followers on every single log post-completion.
    if (justReachedHalfway) {
      followService.getFollowerContacts(req.user.id)
        .then((followers) => {
          const message = `${req.user.username} just hit the halfway point on "${plan.storyTitle}"! Send them a Congrats card!`;
          followers.forEach((f) => notifyUser(f, message, `/workspace`, "draftplan_halfway_reached", "GENERAL", req.user.avatar, {
            kind: "challenge_update", title: plan.storyTitle, actorId: req.user.id,
          }, "WRITING").catch(() => {}));
        })
        .catch(() => {});
    }

    if (justCompleted) {
      followService.getFollowerContacts(req.user.id)
        .then((followers) => {
          const message = `${req.user.username} just finished their draft of "${plan.storyTitle}"! Send them a Congrats card!`;
          followers.forEach((f) => notifyUser(f, message, `/workspace`, "draftplan_draft_completed", "GENERAL", req.user.avatar, {
            kind: "challenge_update", title: plan.storyTitle, actorId: req.user.id,
          }, "WRITING").catch(() => {}));
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
      dictionary,
    });
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── DAY PLANNING ────────────────────────────────────────────────────────────

async function planDay(req, res) {
  try {
    const entry = await draftPlanService.planDay(req.user.id, planIdFrom(req), req.body);
    res.status(201).json(entry);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── BONUS QUEST ─────────────────────────────────────────────────────────────
// POST /draftplan/:planId/bonus-quest          — open the mystery chest (idempotent
//                                                 per day; picked days are rejected)
// POST /draftplan/:planId/bonus-quest/pick     — lock in candidate A or B
// POST /draftplan/:planId/bonus-quest/decline  — pass on both candidates for today
// GET  /draftplan/:planId/bonus-quest/today    — read-only check for today's quest
// POST /draftplan/:planId/bonus-quest/progress — log words toward today's quest

async function openBonusQuest(req, res) {
  try {
    const quest = await draftPlanService.openBonusQuest(req.user.id, planIdFrom(req), req.body);
    res.status(201).json(quest);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function pickBonusQuestPrompt(req, res) {
  try {
    const quest = await draftPlanService.pickBonusQuestPrompt(req.user.id, planIdFrom(req), req.body);
    res.status(200).json(quest);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function declineBonusQuest(req, res) {
  try {
    const quest = await draftPlanService.declineBonusQuest(req.user.id, planIdFrom(req), req.body);
    res.status(200).json(quest);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function getTodaysBonusQuest(req, res) {
  try {
    const quest = await draftPlanService.getTodaysBonusQuest(req.user.id, planIdFrom(req));
    res.json(quest);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function logBonusQuestProgress(req, res) {
  try {
    const result = await draftPlanService.logBonusQuestProgress(req.user.id, planIdFrom(req), req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── PLAN-SCOPED HISTORY ───────────────────────────────────────────────────

async function getPlanHistory(req, res) {
  try {
    const history = await draftPlanService.getPlanHistory(req.user.id, planIdFrom(req));
    res.json(history);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── TIMELINE ────────────────────────────────────────────────────────────────

async function getTimeline(req, res) {
  try {
    const timeline = await draftPlanService.getPlanTimeline(req.user.id, planIdFrom(req));
    res.json(timeline);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

module.exports = {
  getMyPlans,
  createPlan,
  getMyPlan,
  updatePlan,
  deletePlan,
  logProgress,
  planDay,
  getTimeline,
  getPlanHistory,
  uploadMoodboardImage,
  openBonusQuest,
  pickBonusQuestPrompt,
  declineBonusQuest,
  getTodaysBonusQuest,
  logBonusQuestProgress,
};