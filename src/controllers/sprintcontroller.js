const sprintService  = require("../services/sprintservice");
const followService  = require("../services/followService");
const { notifyUser } = require("../services/notificationService");

async function startSprint(req, res) {
  const { duration, startWords, draftId } = req.body;
  const userId = Number(req.user.id);

  try {
    const sprint = await sprintService.startSprint(
      userId,
      duration != null ? Number(duration) : null,
      startWords != null ? Number(startWords) : 0,
      draftId != null ? Number(draftId) : null
    );

    res.status(201).json({ sprint });

    // Notify followers (fire-and-forget) — same "someone you follow just
    // did X" pattern as draft plan progress/completion notifications.
    followService.getFollowerContacts(userId)
      .then((followers) => {
        const message = `${req.user.username} just started a writing sprint — join them in the Sprint Room!`;
        followers.forEach((f) => notifyUser(f, message, `/sprint-room`, "sprint_started", "GENERAL", req.user.avatar, {
          kind: "challenge_update",
        }, "WRITING").catch(() => {}));
      })
      .catch(() => {});
  } catch (error) {
    console.error("Start sprint error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function checkinSprint(req, res) {
  const sprintId = Number(req.params.sprintId);
  const { currentWordCount } = req.body;
  const userId = Number(req.user.id);

  if (!sprintId || isNaN(sprintId)) {
    return res.status(400).json({ message: "Invalid sprint ID." });
  }

  try {
    const sprint = await sprintService.checkinSprint(
      sprintId,
      userId,
      currentWordCount != null ? Number(currentWordCount) : 0
    );

    res.status(200).json({ sprint });
  } catch (error) {
    console.error("Sprint checkin error:", error);
    const status = error.message === "Sprint not found" ? 404
      : error.message === "Not your sprint" ? 403
      : error.message === "Sprint already checked in" ? 409
      : 500;
    res.status(status).json({ message: error.message || "Something went wrong. Please try again later." });
  }
}

async function fetchActiveSprint(req, res) {
  const userId = Number(req.user.id);

  try {
    const sprint = await sprintService.fetchActiveSprint(userId);
    res.status(200).json({ sprint });
  } catch (error) {
    console.error("Fetch active sprint error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

module.exports = {
  startSprint,
  checkinSprint,
  fetchActiveSprint,
};