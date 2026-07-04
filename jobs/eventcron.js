const cron = require("node-cron");
const eventService = require("../src/services/eventservice");

/**
 * Runs every 15 minutes. Finds any event whose endDate has passed but that
 * hasn't been finalized yet (status !== ENDED), and finalizes it — walking
 * its participantPlanIds, checking which DraftPlans are complete, and
 * promoting those writers' User.role to the event's finisherRole.
 *
 * finalizeEvent() is idempotent, so overlapping runs are harmless.
 */
function startEventFinalizeCron() {
  cron.schedule("*/15 * * * *", async () => {
    try {
      const results = await eventService.finalizeEndedEvents();
      if (results.length > 0) {
        console.log(`✅ Finalized ${results.length} ended event(s).`);
      }
    } catch (error) {
      console.error("Event finalize cron error:", error);
    }
  });
}

module.exports = { startEventFinalizeCron };