// src/routes/dictionaryRoutes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/dictionarycontroller");
const { authenticateJWT } = require("../config/jwt");

// A writer's dictionary is always private to them.
router.use(authenticateJWT);

router.get("/",             ctrl.getDictionary);
router.post("/",            ctrl.addEntry);
router.delete("/:entryId",  ctrl.deleteEntry);

module.exports = router;