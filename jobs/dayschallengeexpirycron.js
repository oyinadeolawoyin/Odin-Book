// src/jobs/daysChallengeExpiryCron.js
//
// Runs once daily at midnight UTC. Marks any ACTIVE challenge whose endDate
// has passed as EXPIRED. Writers whose challenge expired get a notification.
//
// Wire up in app.js alongside the other jobs:
//   const { startDaysChallengeCron } = require("./jobs/daysChallengeExpiryCron");
//   startDaysChallengeCron();
//
// ── Fixes from the original upload ──────────────────────────────────────────
// 1. notifyUser was imported from dayschallengeservice, which doesn't export
//    it — it lives in notificationService. Left as-is this would throw
//    "notifyUser is not a function" the first time a challenge expired.
// 2. The require paths mixed "../config/..." and "../src/services/..." in
//    the same file. If this file lives at src/jobs/daysChallengeExpiryCron.js
//    (as the header comment says), both prismaClient and the service should
//    be reached the same way — via "../config/..." and "../services/..."
//    respectively, not "../src/services/...". Adjust if your actual folder
//    depth differs.

const cron            = require("node-cron");
const prisma           = require("../src/config/prismaClient");
const { expireOverdueChallenges } = require("../src/services/dayschallengeservice");
const { notifyUser }              = require("../src/services/notificationService");

async function runExpiry() {
  try {
    // Fetch the challenges that are about to be expired so we can notify their owners
    const now      = new Date();
    const overdue  = await prisma.daysChallenge.findMany({
      where: { status: "ACTIVE", endDate: { lt: now } },
      include: {
        user:    { select: { id: true, username: true, email: true } },
        focuses: true,
      },
    });

    // Expire them all
    const { expired } = await expireOverdueChallenges();

    if (expired > 0) {
      console.log(`[daysChallengeExpiryCron] Expired ${expired} challenge(s)`);
    }

    // Notify each writer whose challenge just expired
    for (const c of overdue) {
      const days    = c.duration === "SEVEN" ? "7" : "15";
      const title   = c.storyTitle ? ` on "${c.storyTitle}"` : "";
      const message = `Your ${days}-day writing challenge${title} has ended. Great effort — you can start a new one whenever you're ready.`;
      const link    = `/days-challenge`;
      notifyUser(c.user, message, link, "dayschallenge_expired", "GENERAL", {
        kind: "challenge_update", title: c.storyTitle,
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[daysChallengeExpiryCron] error:", err.message);
  }
}

function startDaysChallengeCron() {
  // Run at midnight UTC every day
  cron.schedule("0 0 * * *", runExpiry);
  console.log("✅ Days challenge expiry cron started");
}

module.exports = { startDaysChallengeCron };