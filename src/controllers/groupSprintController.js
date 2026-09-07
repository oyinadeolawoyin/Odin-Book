const groupSprintService = require("../services/groupSprintService");
const { notifyUser } = require('../services/notificationService');
const { AccessToken, TrackSource } = require("livekit-server-sdk");

// ─── GROUP SPRINT ─────────────────────────────────────────────
async function startGroupSprint(req, res) {
  const { duration, sprintType } = req.body;
  const userId = Number(req.user.id);

  if (!userId) {
    return res.status(400).json({ message: "Missing userId" });
  }

  const allowedSprintTypes  = ["WRITING", "READING"];
  const resolvedSprintType  = allowedSprintTypes.includes(sprintType)  ? sprintType  : "WRITING";

  try {
    const groupSprint = await groupSprintService.startGroupSprint(
      userId, Number(duration), resolvedSprintType
    );

    res.status(201).json({ groupSprint });
  } catch (error) {
    console.error("Group sprint start error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function endGroupSprint(req, res) {
  const groupSprintId = Number(req.params.groupSprintId);

  try {
    const groupSprint = await groupSprintService.fetchGroupSprint(groupSprintId);
    if (!groupSprint) {
      return res.status(404).json({ message: "Group sprint not found" });
    }
    if (Number(groupSprint.userId) !== Number(req.user.id)) {
      return res.status(403).json({ message: "Only the host can end the sprint early." });
    }

    const ended = await groupSprintService.endGroupSprint(groupSprintId);

    res.status(200).json({ groupSprint: ended });
  } catch (error) {
    console.error("Group sprint end error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function fetchGroupSprint(req, res) {
  const groupSprintId = Number(req.params.groupSprintId);
  try {
    const groupSprint = await groupSprintService.fetchGroupSprint(groupSprintId);
    if (!groupSprint) {
      return res.status(404).json({ message: "Group sprint not found" });
    }
    res.status(200).json({ groupSprint });
  } catch (error) {
    console.error("Fetch group sprint error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function fetchAllActiveGroupSprints(req, res) {
  const page  = Number(req.query.page)  || 1;
  const limit = Number(req.query.limit) || 10;
  const skip  = (page - 1) * limit;

  try {
    const result = await groupSprintService.fetchAllActiveGroupSprints({ skip, take: limit });

    res.status(200).json({
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
      groupSprints: result.groupSprints,
    });
  } catch (error) {
    console.error("Fetch active group sprints error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function fetchLastGroupSprint(req, res) {
  try {
    const groupSprint = await groupSprintService.fetchLastGroupSprint();
    if (!groupSprint) {
      return res.status(404).json({ message: "No completed group sprint found" });
    }
    res.status(200).json({ groupSprint });
  } catch (error) {
    console.error("Fetch last group sprint error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── SPRINT ───────────────────────────────────────────────────

async function joinSprint(req, res) {
  const { groupSprintId, startWords, soundscapeId, rebaseline } = req.body;
  const userId = Number(req.user.id);

  try {
    const sprint = await groupSprintService.joinSprint(
      userId,
      Number(groupSprintId),
      startWords    != null ? Number(startWords)    : 0,
      soundscapeId  ? Number(soundscapeId)  : null,
      { rebaseline: !!rebaseline },
    );

    res.status(201).json({ sprint });
  } catch (error) {
    console.error("Join sprint error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// Periodic background sync while a sprint is still running — persists the
// live word count so an in-progress sprint survives a closed tab, crash, or
// quick navigation away without waiting for a proper checkout/leave. Does
// NOT end the sprint (isActive/completedAt untouched). Silently no-ops
// (rather than erroring) if the sprint was already checked out/left, since
// a late sync ping arriving after that is expected, not a problem.
async function updateSprintProgress(req, res) {
  const sprintId = Number(req.params.sprintId);
  const { currentWordCount } = req.body;

  if (!sprintId || isNaN(sprintId)) {
    return res.status(400).json({ message: "Invalid sprint ID." });
  }

  try {
    const sprint = await groupSprintService.updateSprintProgress(
      sprintId,
      currentWordCount != null ? Number(currentWordCount) : 0
    );

    res.status(200).json({ sprint });
  } catch (error) {
    console.error("Sprint progress sync error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// Draft switch mid-sprint — NOT a rejoin. The writer is still in the same
// sprint the whole time, they just changed which draft they're looking at.
// Keeps the existing sprint row and re-anchors its startWords baseline so
// the total already earned carries over exactly, then keeps climbing
// against the new draft as they keep typing.
async function rebaselineSprint(req, res) {
  const sprintId = Number(req.params.sprintId);
  const { oldWordCount, newWordCount } = req.body;

  if (!sprintId || isNaN(sprintId)) {
    return res.status(400).json({ message: "Invalid sprint ID." });
  }

  try {
    const sprint = await groupSprintService.rebaselineSprint(
      sprintId,
      oldWordCount != null ? Number(oldWordCount) : 0,
      newWordCount != null ? Number(newWordCount) : 0
    );

    res.status(200).json({ sprint });
  } catch (error) {
    console.error("Rebaseline sprint error:", error);
    const status = error.message === "Sprint not found" ? 404
      : error.message === "Sprint is no longer active" ? 409
      : 500;
    res.status(status).json({ message: error.message || "Something went wrong. Please try again later." });
  }
}

async function checkoutSprint(req, res) {
  const sprintId = Number(req.params.sprintId);
  const { currentWordCount } = req.body;

  if (!sprintId || isNaN(sprintId)) {
    return res.status(400).json({ message: "Invalid sprint ID." });
  }

  try {
    const sprint = await groupSprintService.checkoutSprint(
      sprintId,
      currentWordCount != null ? Number(currentWordCount) : 0
    );

    res.status(200).json({ sprint });
  } catch (error) {
    console.error("Checkout sprint error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function leaveSprint(req, res) {
  const sprintId = Number(req.params.sprintId);
  const { currentWordCount } = req.body;

  if (!sprintId || isNaN(sprintId)) {
    return res.status(400).json({ message: "Invalid sprint ID." });
  }

  try {
    const sprint = await groupSprintService.leaveSprint(
      sprintId,
      currentWordCount != null ? Number(currentWordCount) : null
    );

    res.status(200).json({ sprint });
  } catch (error) {
    console.error("Leave sprint error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function fetchLoginUserSprint(req, res) {
  const userId = Number(req.user.id);
  try {
    const sprint = await groupSprintService.fetchLoginUserSprint(userId);
    res.status(200).json({ sprint });
  } catch (error) {
    console.error("Fetch user's sprint error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── SPRINT HISTORY & HEATMAP ──────────────────────────────────

async function fetchUserSprintHistory(req, res) {
  const userId = Number(req.user.id);
  const limit  = Number(req.query.limit) || 20;
  const days   = req.query.days != null ? Number(req.query.days) : undefined;
  try {
    const sprints = await groupSprintService.fetchUserSprintHistory(userId, { limit, days });
    res.status(200).json({ sprints });
  } catch (error) {
    console.error("Fetch sprint history error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function fetchUserSprintHeatmap(req, res) {
  const userId = Number(req.user.id);
  const days   = Number(req.query.days) || 182;
  try {
    const { heatmap, total } = await groupSprintService.fetchUserSprintHeatmap(userId, { days });
    res.status(200).json({ heatmap, sprintsTotal: total });
  } catch (error) {
    console.error("Fetch sprint heatmap error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── LIVEKIT TOKEN ────────────────────────────────────────────

async function getLiveKitToken(req, res) {
  const groupSprintId = Number(req.params.groupSprintId);

  try {
    const groupSprint = await groupSprintService.fetchGroupSprint(groupSprintId);

    if (!groupSprint) {
      return res.status(404).json({ message: "Group sprint not found" });
    }
    if (!groupSprint.liveKitRoomName) {
      return res.status(400).json({ message: "No LiveKit room found for this sprint" });
    }

    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      console.error("Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET in .env");
      return res.status(500).json({ message: "LiveKit is not configured on the server." });
    }

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: req.user.username, ttl: "2h" }
    );

    at.addGrant({
      roomJoin:          true,
      room:              groupSprint.liveKitRoomName,
      canPublish:        true,
      canSubscribe:      true,
      canPublishSources: [TrackSource.SCREEN_SHARE],
    });

    const jwt = await at.toJwt();
    res.status(200).json({ token: jwt, roomName: groupSprint.liveKitRoomName });
  } catch (error) {
    console.error("LiveKit token error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

module.exports = {
  startGroupSprint,
  endGroupSprint,
  fetchGroupSprint,
  fetchAllActiveGroupSprints,
  fetchLastGroupSprint,
  joinSprint,
  checkoutSprint,
  leaveSprint,
  updateSprintProgress,
  rebaselineSprint,
  fetchLoginUserSprint,
  fetchUserSprintHistory,
  fetchUserSprintHeatmap,
  getLiveKitToken,
};