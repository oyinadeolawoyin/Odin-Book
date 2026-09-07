// src/controllers/workspaceController.js
const workspaceService = require("../services/workspaceservice");

async function getWeeklyTargetFeed(req, res) {
  try {
    const writers = await workspaceService.getWritersWorkingTowardWeeklyTarget(req.user?.id ?? null);
    res.json(writers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getDraftPlanFeed(req, res) {
  try {
    const writers = await workspaceService.getDraftPlanFeed(req.user?.id ?? null);
    res.json(writers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getWorkspaceFeed(req, res) {
  try {
    const members = await workspaceService.getWorkspaceMembers(req.user?.id ?? null);
    res.json(members);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getWeeklyWinners(req, res) {
  try {
    const winners = await workspaceService.getWeeklyGoalCompleters(req.user?.id ?? null);
    res.json(winners);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getFinishedDraftsFeed(req, res) {
  try {
    const finished = await workspaceService.getRecentlyFinishedDraftPlans(req.user?.id ?? null);
    res.json(finished);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getTopStreaks(req, res) {
  try {
    const leaders = await workspaceService.getTopStreakLeaderboard(req.user?.id ?? null);
    res.json(leaders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getMyStats(req, res) {
  try {
    const stats = await workspaceService.getMyWorkspaceStats(req.user.id);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// Lightweight — just the single plan the dashboard's weekly-target ring
// spotlights (the one the writer most recently logged progress on), without
// pulling streaks/history too. `me/stats` already includes this under
// `weeklyGoalPlan`; this exists for callers that only need it.
async function getMyWeeklyGoalPlan(req, res) {
  try {
    const plan = await workspaceService.getMyWeeklyGoalPlan(req.user.id);
    res.json(plan);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// Day-by-day words/chapters/scenes for the workspace activity graph.
// ?days=7|15|30 (default 30, clamped to that range).
async function getMyActivitySeries(req, res) {
  try {
    const series = await workspaceService.getMyActivitySeries(req.user.id, req.query.days);
    res.json(series);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// "Send card" on a writer who's already logged/sprinted today.
async function sendCard(req, res) {
  try {
    const { toUserId, cardType } = req.body;
    const result = await workspaceService.sendEncouragementCard(req.user, toUserId, cardType);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

async function getMyProfile(req, res) {
  try {
    const profile = await workspaceService.getWorkspaceProfile(req.user.id);
    res.json(profile);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateMyProfile(req, res) {
  try {
    const profile = await workspaceService.updateWorkspaceProfile(req.user.id, req.body);
    res.json(profile);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

module.exports = {
  getWeeklyTargetFeed,
  getWeeklyWinners,
  getDraftPlanFeed,
  getWorkspaceFeed,
  getFinishedDraftsFeed,
  getTopStreaks,
  getMyStats,
  getMyWeeklyGoalPlan,
  getMyActivitySeries,
  sendCard,
  getMyProfile,
  updateMyProfile,
};