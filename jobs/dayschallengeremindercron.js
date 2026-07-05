// src/jobs/daysChallengeReminderCron.js
//
// Runs every minute. Checks which writers have an ACTIVE Days Challenge whose
// reminderTimeUTC matches the current UTC HH:MM, and sends them a daily
// check-in nudge. Fires every day of the challenge (no "picked days" concept
// here, unlike the draft plan reminder) until the challenge is completed,
// left, or expires.
//
// All the timezone math is done once, at create/update time, in
// daysChallengeService (reminderTime → reminderTimeUTC) — same pattern as
// draftPlanReminderCron — so this job just does a plain string match.
//
// Wire up alongside your other jobs:
//   const { startDaysChallengeReminderCron } = require("./daysChallengeReminderCron");
//   startDaysChallengeReminderCron();

const cron            = require("node-cron");
const { getChallengeWritersToRemindNow } = require("../src/services/dayschallengeservice");
const { notifyUser }                     = require("../src/services/notificationService");

function startDaysChallengeReminderCron() {
  // Run at the top of every minute
  cron.schedule("* * * * *", async () => {
    try {
      const writers = await getChallengeWritersToRemindNow();

      if (writers.length === 0) return;

      for (const w of writers) {
        const unit  = w.goalType === "WORDS" ? "words" : "minutes";
        const title = w.storyTitle ? ` on "${w.storyTitle}"` : "";
        const days  = w.duration === "SEVEN" ? "7" : "15";
        const message =
          `Day's check-in time! Log ${w.dailyGoal} ${unit}${title} to keep your ` +
          `${days}-day challenge going.`;
        const link = `/days-challenge`;

        notifyUser(w.user, message, link, "dayschallenge_daily_reminder", "GENERAL", {
          kind: "challenge_reminder", title: w.storyTitle,
        }).catch(() => {});
      }
    } catch (err) {
      console.error("[daysChallengeReminderCron] error:", err.message);
    }
  });

  console.log("✅ Days challenge reminder cron started");
}

module.exports = { startDaysChallengeReminderCron };