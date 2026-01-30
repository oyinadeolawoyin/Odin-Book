const express = require("express");
const router = express.Router();
const writingPlanController = require("../controllers/writingPlanController");
const { authenticateJWT } = require("../config/jwt");

router.get("/", authenticateJWT, writingPlanController.fetchWritingplan);
router.post("/createPlan", authenticateJWT, writingPlanController.createWritingplan);
router.post("/:planId/updatePlan", authenticateJWT, writingPlanController.updateWritingPlan);

module.exports = router;