const miniChallengeService = require("../services/minichallengeservice");

const VALID_TYPES = ["SESSION_COUNT", "WEEKLY_GOAL", "SPRINT_COUNT", "CONSECUTIVE_DAYS", "CONSECUTIVE_SPRINT_DAYS"];

// ─── Templates (admin write, admin read w/ inactive included) ────────────────

async function createTemplate(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }

  const { title, description, type, badgeName, badgeIcon } = req.body;
  const targetValue = Number(req.body.targetValue);
  const rotationOrder = Number(req.body.rotationOrder);

  if (!title)     return res.status(400).json({ message: "Title is required." });
  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ message: `type must be one of: ${VALID_TYPES.join(", ")}` });
  }
  if (!Number.isFinite(targetValue) || targetValue < 1) {
    return res.status(400).json({ message: "targetValue must be a positive number (ignored for WEEKLY_GOAL, but still required)." });
  }
  if (!badgeName) return res.status(400).json({ message: "badgeName is required." });
  if (!badgeIcon) return res.status(400).json({ message: "badgeIcon is required." });
  if (!Number.isFinite(rotationOrder) || rotationOrder < 0) {
    return res.status(400).json({ message: "rotationOrder must be a non-negative number." });
  }

  try {
    const template = await miniChallengeService.createTemplate({
      title,
      description: description || null,
      type,
      targetValue,
      badgeName,
      badgeIcon,
      rotationOrder,
    });
    res.status(201).json({ template });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ message: "rotationOrder is already used by another template." });
    }
    console.error("Create mini-challenge template error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getTemplates(req, res) {
  const includeInactive = req.user?.role === "ADMIN" && req.query.includeInactive === "true";
  try {
    const templates = await miniChallengeService.listTemplates({ includeInactive });
    res.status(200).json({ templates });
  } catch (error) {
    console.error("List mini-challenge templates error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function updateTemplate(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const id = Number(req.params.templateId);
  const { title, description, type, badgeName, badgeIcon, isActive } = req.body;

  if (type !== undefined && !VALID_TYPES.includes(type)) {
    return res.status(400).json({ message: `type must be one of: ${VALID_TYPES.join(", ")}` });
  }

  let targetValue;
  if (req.body.targetValue !== undefined) {
    targetValue = Number(req.body.targetValue);
    if (!Number.isFinite(targetValue) || targetValue < 1) {
      return res.status(400).json({ message: "targetValue must be a positive number." });
    }
  }

  let rotationOrder;
  if (req.body.rotationOrder !== undefined) {
    rotationOrder = Number(req.body.rotationOrder);
    if (!Number.isFinite(rotationOrder) || rotationOrder < 0) {
      return res.status(400).json({ message: "rotationOrder must be a non-negative number." });
    }
  }

  try {
    const template = await miniChallengeService.updateTemplate(id, {
      title,
      description,
      type,
      targetValue,
      badgeName,
      badgeIcon,
      rotationOrder,
      isActive,
    });
    res.status(200).json({ template });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === "P2002") {
      return res.status(409).json({ message: "rotationOrder is already used by another template." });
    }
    console.error("Update mini-challenge template error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// Dedicated enable/disable toggle — the "disable and enable templates I no
// longer want" behaviour, without needing to resend the whole template body.
async function setTemplateActive(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const id = Number(req.params.templateId);
  const { isActive } = req.body;
  if (typeof isActive !== "boolean") {
    return res.status(400).json({ message: "isActive must be true or false." });
  }
  try {
    const template = await miniChallengeService.setTemplateActive(id, isActive);
    res.status(200).json({ template });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error("Toggle mini-challenge template error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Member-facing: current live challenge + progress ─────────────────────────

async function getCurrentChallenge(req, res) {
  try {
    const template = await miniChallengeService.getCurrentTemplateForUser(req.user?.id);
    if (!template) return res.status(200).json({ template: null });
    res.status(200).json({
      template: {
        id: template.id,
        title: template.title,
        description: template.description,
        type: template.type,
        badgeName: template.badgeName,
        badgeIcon: template.badgeIcon,
      },
    });
  } catch (error) {
    console.error("Get current mini-challenge error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getMyProgress(req, res) {
  try {
    const progress = await miniChallengeService.getMyWeeklyProgress(req.user.id);
    res.status(200).json(progress);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error("Get my mini-challenge progress error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// Batch progress view, e.g. for an admin dashboard or a "who's close" widget.
// Body: { userIds: number[] }
async function getProgressForUsers(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const userIds = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number).filter(Number.isFinite) : [];
  if (!userIds.length) {
    return res.status(400).json({ message: "userIds must be a non-empty array of user ids." });
  }
  try {
    const results = await miniChallengeService.getWeeklyProgressForUsers(userIds);
    res.status(200).json({ results });
  } catch (error) {
    console.error("Get batch mini-challenge progress error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// Public leaderboard of recently-active writers' progress toward this
// week's challenge — no auth required, unlike the admin batch view above.
async function getLeaderboard(req, res) {
  try {
    const leaderboard = await miniChallengeService.getWeeklyLeaderboard({});
    res.status(200).json(leaderboard);
  } catch (error) {
    console.error("Get mini-challenge leaderboard error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Badges ────────────────────────────────────────────────────────────────────

async function getMyBadges(req, res) {
  try {
    const badges = await miniChallengeService.getMyBadges(req.user.id);
    res.status(200).json(badges);
  } catch (error) {
    console.error("Get my badges error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function claimBadge(req, res) {
  const badgeId = Number(req.params.badgeId);
  try {
    const badge = await miniChallengeService.claimBadge(req.user.id, badgeId);
    res.status(200).json({ badge });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error("Claim badge error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

module.exports = {
  createTemplate,
  getTemplates,
  updateTemplate,
  setTemplateActive,
  getCurrentChallenge,
  getMyProgress,
  getProgressForUsers,
  getLeaderboard,
  getMyBadges,
  claimBadge,
};