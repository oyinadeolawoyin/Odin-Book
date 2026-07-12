// jobs/autoendstalesprintscron.js
//
// Why this exists: groupSprintService.autoEndStaleSprints() only ever ran
// opportunistically — right before fetchGroupSprint() or
// fetchAllActiveGroupSprints() returned data. If nobody happened to load
// the sprint room or the homepage after a sprint's time was up, the
// GroupSprint AND every member's individual Sprint row stayed
// isActive: true / completedAt: null forever.
//
// That silently broke sprint history, the heatmap, and the streak count,
// because fetchUserSprintHistory() and fetchUserSprintHeatmap() both
// filter on `completedAt: { not: null }` — a sprint that never got
// "ended" never shows up, even though the writer genuinely did it.
//
// Running the same sweep on a schedule (independent of any page view)
// guarantees every sprint eventually gets its completedAt set once its
// time + grace period has passed, so it reliably lands in history and
// the heatmap.

const cron = require("node-cron");
const groupSprintService = require("../src/services/groupSprintService");

function startAutoEndStaleSprintsCron() {
  // Every 5 minutes — frequent enough that a sprint's data shows up in
  // history/heatmap/streak shortly after it ends, cheap enough to not
  // matter given autoEndStaleSprints() is a no-op when nothing is overdue.
  cron.schedule("*/5 * * * *", async () => {
    try {
      await groupSprintService.autoEndStaleSprints();
    } catch (err) {
      console.error("[cron] autoEndStaleSprints sweep failed:", err);
    }
  });
}

module.exports = { startAutoEndStaleSprintsCron };