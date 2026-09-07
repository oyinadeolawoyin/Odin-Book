// jobs/bragcleanupcron.js
//
// Brag card images (src/uploads/brag) have no natural expiry the way a DB
// row would — they're just files on disk, written once by uploadBragImage
// and never referenced again by your app once the share happens. Left
// alone they'd accumulate forever. This deletes anything older than
// BRAG_IMAGE_TTL_DAYS once a day. No cron library needed — setInterval is
// plenty for a once-a-day sweep.
const fs = require("fs");
const path = require("path");

const BRAG_UPLOADS_DIR = path.join(__dirname, "..", "src", "uploads", "brag");
const BRAG_IMAGE_TTL_DAYS = 14;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function sweepOldBragImages() {
  fs.readdir(BRAG_UPLOADS_DIR, (err, files) => {
    if (err) {
      if (err.code !== "ENOENT") console.error("Brag cleanup readdir error:", err);
      return;
    }
    const cutoff = Date.now() - BRAG_IMAGE_TTL_DAYS * ONE_DAY_MS;
    for (const file of files) {
      const filePath = path.join(BRAG_UPLOADS_DIR, file);
      fs.stat(filePath, (statErr, stats) => {
        if (statErr) return;
        if (stats.mtimeMs < cutoff) {
          fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) console.error("Brag cleanup unlink error:", unlinkErr);
          });
        }
      });
    }
  });
}

function startBragCleanupCron() {
  sweepOldBragImages(); // once on boot, then daily
  setInterval(sweepOldBragImages, ONE_DAY_MS);
}

module.exports = { startBragCleanupCron };