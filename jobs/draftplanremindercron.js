// src/jobs/draftPlanReminderCron.js
//
// Runs every minute. Checks which writers have a reminder set for the current
// UTC day + time and sends them a writing nudge notification.
//
// The heavy timezone lifting is already done at plan creation time —
// reminderTimeUTC is pre-computed and stored on each DraftWritingDay row,
// so this cron just does a simple string match: WHERE reminderTimeUTC = "HH:MM"
// AND day = today's WeekDay enum AND plan.isCompleted = false.
//
// ── Fix from the original upload ────────────────────────────────────────────
// getWritersToRemindNow was required from "../src/services/draftservice",
// but the actual file is draftplanservice.js (exporting getWritersToRemindNow).
// That mismatch would throw "Cannot find module" on startup.
//
// Wire up in your existing jobs entry point:
//   const { startDraftPlanReminderCron } = require("./draftPlanReminderCron");
//   startDraftPlanReminderCron();

const cron         = require("node-cron");
const { getWritersToRemindNow } = require("../src/services/draftplanservice");
const { notifyUser }            = require("../src/services/notificationService");

function startDraftPlanReminderCron() {
  // Run at the top of every minute
  cron.schedule("* * * * *", async () => {
    try {
      const writers = await getWritersToRemindNow();

      if (writers.length === 0) return;

      for (const w of writers) {
        const unit    = w.goalType === "WORDS"
          ? "words"
          : w.goalType === "CHAPTERS" ? "chapters" : "scenes";
        const message = `Time to write! Your goal today is ${w.dailyGoal} ${unit} on "${w.storyTitle}". You've got this.`;
        const link    = `/draftplan`;

        notifyUser(w.user, message, link, "draftplan_daily_reminder", "GENERAL", {
          kind: "challenge_reminder", title: w.storyTitle,
        }).catch(() => {});
      }
    } catch (err) {
      console.error("[draftPlanReminderCron] error:", err.message);
    }
  });

  console.log("✅ Draft plan reminder cron started");
}

module.exports = { startDraftPlanReminderCron };