const cron = require("node-cron");
const miniChallengeService = require("../src/services/minichallengeservice");
const { notifyUser } = require("../src/services/notificationService");

// Weeks close at midnight in each *writer's own* timezone (see the
// local-time comment block at the top of minichallengeservice.js) — there's
// no single global "week end" moment like there is with events. So instead
// of watching one endDate, this runs hourly and asks, for every user: "is
// it Monday where you are right now?" If so, it evaluates and records the
// week that just ended for them (last Monday -> this Monday).
//
// Running hourly means a user sees this fire up to ~24 times across their
// Monday, but evaluateAndRecordWeek is idempotent (upsert on
// [weekStart, userId], and the badge upsert's update:{} is a no-op) so
// repeat calls are harmless — they just re-confirm the same result. The
// isNewBadge flag from evaluateAndRecordWeek is what keeps the *notification*
// from firing more than once.
const SCHEDULE = "0 * * * *"; // top of every hour

async function evaluateJustClosedWeekForUser(user) {
  const { dateStr, weekday } = miniChallengeService.getLocalDateInfo(user.timezone);
  if (weekday !== 1) return null; // only act when it's Monday for this user

  const thisWeekStart = miniChallengeService.mondayOfWeek(dateStr);
  const closedWeekStart = new Date(thisWeekStart);
  closedWeekStart.setUTCDate(closedWeekStart.getUTCDate() - 7);

  return miniChallengeService.evaluateAndRecordWeek(user.id, closedWeekStart);
}

async function notifyIfNewBadge(user, result) {
  if (!result || !result.isNewBadge) return;
  const { template } = result;
  await notifyUser(
    user,
    `You completed "${template.title}" and earned the ${template.badgeName} badge!`,
    `/mini-challenges`,
    "mini_challenge_finisher",
    "GENERAL",
    { kind: "mini_challenge_badge", title: template.badgeName }
  );
}

async function runMiniChallengeWeeklySweep() {
  const users = await miniChallengeService.getUsersForWeeklyEvaluation();
  let evaluatedCount = 0;
  let newBadgeCount = 0;

  for (const user of users) {
    try {
      const result = await evaluateJustClosedWeekForUser(user);
      if (!result) continue;
      evaluatedCount++;
      if (result.isNewBadge) {
        newBadgeCount++;
        await notifyIfNewBadge(user, result);
      }
    } catch (err) {
      console.error(`[minichallengecron] failed for user ${user.id}:`, err);
    }
  }

  if (evaluatedCount) {
    console.log(`[minichallengecron] evaluated ${evaluatedCount} user-week(s), ${newBadgeCount} new badge(s).`);
  }
  return { evaluatedCount, newBadgeCount };
}

function startMiniChallengeCron() {
  cron.schedule(SCHEDULE, () => {
    runMiniChallengeWeeklySweep().catch((err) => {
      console.error("[minichallengecron] sweep failed:", err);
    });
  });
  console.log(`[minichallengecron] scheduled with "${SCHEDULE}"`);
}

module.exports = { startMiniChallengeCron, runMiniChallengeWeeklySweep };