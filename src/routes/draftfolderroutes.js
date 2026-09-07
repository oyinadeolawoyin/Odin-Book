const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/draftfoldercontroller");
const { authenticateJWT } = require("../config/jwt");

// All folder routes require authentication — folders are always private to the writer.
// Writers never create or delete folders directly: plan folders come from
// creating a plan, and the one General folder is created automatically at
// signup (see authController.js). Renaming is the only write action here.

// Specific routes before the /:folderId param route to avoid conflicts.
router.get("/options",        authenticateJWT, ctrl.getFolderOptions);

router.get("/",                authenticateJWT, ctrl.getMyFolders);
router.get("/:folderId",       authenticateJWT, ctrl.getFolderById);
router.patch("/:folderId",     authenticateJWT, ctrl.renameFolder);

module.exports = router;

// Mount alongside the other draft routes, e.g. in app.js / server.js:
//   app.use("/draftfolders", require("./routes/draftfolderroutes"));