/**
 * Birthday cron
 *
 * Runs once a day and triggers notificationController.checkBirthdaysAndNotify(),
 * which:
 *   1. Finds every user whose dateOfBirth (month + day) is today.
 *   2. Broadcasts an in-app-only "it's X's birthday!" notice (Community tab)
 *      to every other user.
 *   3. Emails that user's own followers, encouraging them to send a
 *      BIRTHDAY mailbox card.
 *
 * Requires: npm install node-cron
 *
 * Wire this up once, near your other startup code (e.g. in server.js /
 * index.js, alongside where you call app.listen):
 *
 *   require("./cron/birthdayCron");
 */

const cron = require("node-cron");
const { checkBirthdaysAndNotify } = require("../src/controllers/notificationController");

// Runs every day at 07:00 UTC. Adjust the schedule to taste —
// https://crontab.guru is handy for double-checking the expression.
cron.schedule("0 7 * * *", () => {
  console.log("[birthdayCron] Running daily birthday check…");
  checkBirthdaysAndNotify();
});

module.exports = cron;