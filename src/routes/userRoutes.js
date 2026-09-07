const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const { authenticateJWT, optionalJWT } = require("../config/jwt");
const upload = require("../config/multer");

router.get("/founding-writers", optionalJWT, userController.fetchFoundingWriters);
router.get("/blocked", authenticateJWT, userController.getBlockedUsers);         
router.get("/:userId/user", authenticateJWT, userController.fetchUser);
router.post("/updateUser", authenticateJWT, upload.single("avatar"), userController.updateUser);
router.delete("/me", authenticateJWT, userController.deleteUser);
router.post("/:userId/block", authenticateJWT, userController.blockUser);        
router.delete("/:userId/block", authenticateJWT, userController.unblockUser);    

module.exports = router;