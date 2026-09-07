require("dotenv").config();
const bcrypt      = require("bcryptjs");
const jwt         = require("../config/jwt");
const authService = require("../services/authService");
const userService = require("../services/userService");
const { initWallet } = require("../services/pointService"); 
const draftFolderService = require("../services/draftfolderservice");
const { validationResult } = require("express-validator");
const crypto      = require("crypto");
const { sendEmail } = require("../config/mailer");
const prisma       = require("../config/prismaClient");
const { sendPushNotification } = require("../services/notificationService");

// ============================================
// CONFIGURATION
// ============================================

const isProduction = process.env.NODE_ENV === "production";

const cookieOptions = {
  httpOnly: true,
  secure:   isProduction,
  sameSite: isProduction ? "none" : "lax",
  maxAge:   1000 * 60 * 60 * 24 * 21,
};

// ============================================
// SIGNUP COMMUNITY NOTICES
// ============================================
// These two live here (not authService/userService/notificationService) on
// purpose — they're triggered by *this* specific action (a new signup),
// same "the controller that owns the action decides what/who to notify"
// pattern draftPlanController already uses for its follower fan-outs.

let cachedSystemSenderId = null;

/**
 * Resolve the "Quillweave Team" account that system-sent mailbox cards
 * (welcome cards, etc.) come from. Prefers SYSTEM_USER_ID from env; falls
 * back to the oldest ADMIN account. Cached in memory after the first lookup.
 */
async function getSystemSenderId() {
  if (cachedSystemSenderId) return cachedSystemSenderId;

  if (process.env.SYSTEM_USER_ID) {
    cachedSystemSenderId = Number(process.env.SYSTEM_USER_ID);
    return cachedSystemSenderId;
  }

  const admin = await prisma.user.findFirst({
    where:   { role: "ADMIN", isDeleted: false },
    orderBy: { id: "asc" },
    select:  { id: true },
  });

  if (!admin) return null;
  cachedSystemSenderId = admin.id;
  return cachedSystemSenderId;
}

/**
 * In-app-only notice to every existing user that a new writer joined.
 * Deliberately bypasses notifyUser()/push/email — this is a broadcast to
 * the whole community, not a targeted "someone did something to you"
 * notice, so it only ever needs the inbox row under the Community tab.
 *
 * actorId is set to the new writer's id so clicking the notification opens
 * their profile popup (see notification.jsx) instead of just navigating —
 * the popup's own "Send a card" button is what actually gets the Welcome
 * card sent, so this notice's job is just to point people at it.
 */
async function broadcastNewMemberNotification(newUser) {
  const recipients = await prisma.user.findMany({
    where:  { isDeleted: false, id: { not: newUser.id } },
    select: { id: true, username: true },
  });

  if (recipients.length === 0) return;

  const message = `${newUser.username} just joined Quillweave! Send them a Welcome card to say hi. 👋`;
  const link    = `/${newUser.id}/user`;

  await prisma.notification.createMany({
    data: recipients.map((r) => ({
      username:    r.username,
      userId:      r.id,
      message,
      link,
      type:        "GENERAL",
      category:    "COMMUNITY",
      actorAvatar: newUser.avatar ?? null,
      actorId:     newUser.id,
    })),
  });

  // Web push — same recipients as the in-app broadcast above. No email here.
  const subscriptions = await prisma.subscription.findMany({
    where: { userId: { in: recipients.map((r) => r.id) } },
  });
  const payload = { title: "New Notification", body: message, url: link, icon: newUser.avatar || undefined };
  subscriptions.forEach((sub) => sendPushNotification(sub.subscription, payload));
}

/**
 * Sends the new writer a WELCOME mailbox card from the Quillweave Team
 * account, waiting for them the moment they check their mailbox.
 */
async function sendWelcomeMailboxCard(newUser) {
  const senderId = await getSystemSenderId();
  if (!senderId) {
    console.error("Welcome card skipped — no SYSTEM_USER_ID/ADMIN account configured.");
    return;
  }

  await prisma.mailboxCard.create({
    data: {
      senderId,
      recipientId: newUser.id,
      type:        "WELCOME",
      note:        `Welcome to Quillweave, ${newUser.username}! We're so glad you're here — can't wait to see what you write. 🎉`,
    },
  });
}

// ============================================
// AUTHENTICATION OPERATIONS
// ============================================

/**
 * Register a new user
 * @route POST /auth/signup
 */
async function signup(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => err.msg).join(" ");
    return res.status(400).json({ message: errorMessages });
  }

  const { username, password, email, timezone, referralSource, projectType, timeOnProject, biggestBlock } = req.body
console.log("proTy", projectType, "bigest", biggestBlock, "timepro", timeOnProject);
  try {
    const existingEmail = await authService.findUserByEmail(email);
    if (existingEmail) {
      return res.status(409).json({ message: "Email is already in use." });
    }

    const existingUsername = await authService.findUserByUsername(username);
    if (existingUsername) {
      return res.status(409).json({ message: "Username is already taken. Please choose another one." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const userCount = await userService.countUsers();
    const isPremiumEligible = userCount < 10;

    const user = await userService.createUser({
      username,
      password: hashedPassword,
      email,
      timezone,
      referralSource: referralSource || null,
      projectType: projectType || null,
      timeOnProject: timeOnProject || null,
      biggestBlock: biggestBlock || null,
      role: isPremiumEligible ? "FOUNDING_WRITER" : "USER",
    });

    // ── Seed the feedback hub wallet for every new user ─────────────────────
    // Gives them 5 pts — enough to browse but not enough to post yet.
    await initWallet(user.id);

    // ── Every writer gets one "General" draft folder, created once here ────
    // Not user-creatable — this is the catch-all for drafts that aren't
    // tied to a draft plan. They can rename it later, but never delete it.
    await draftFolderService.createDefaultGeneralFolder(user.id);

    // ── Community notices ────────────────────────────────────────────────
    // Fire-and-forget: never let one of these fail the signup response.
    broadcastNewMemberNotification(user).catch((err) =>
      console.error("New member broadcast error:", err)
    );
    sendWelcomeMailboxCard(user).catch((err) =>
      console.error("Welcome card error:", err)
    );

    const token = jwt.generateToken(user);
    res.cookie("token", token, cookieOptions).status(201).json({
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, avatar: user.avatar ?? null },
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * Log in a user.
 *
 * Supports two login flows:
 *   1. Email + password  (site-registered users)
 *   2. Discord ID + password  (users auto-created via Discord bot)
 *
 * @route POST /auth/login
 */
async function login(req, res) {
  const { identifier, password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ message: "Please provide your login details and password." });
  }

  try {
    let user = null;

    const isDiscordId = /^\d{17,20}$/.test(identifier.trim());

    if (isDiscordId) {
      user = await authService.findUserByDiscordId(identifier.trim());
      if (!user) {
        return res.status(404).json({ message: "No account found with that Discord ID." });
      }
    } else {
      user = await authService.findUserByEmail(identifier.trim());
      if (!user) {
        return res.status(404).json({ message: "No account found with that email." });
      }
    }

    if (!user.password) {
      return res.status(400).json({
        message: "This account doesn't have a password yet. Please go to Settings to set one first.",
      });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ message: "Incorrect password." });
    }

    const token = jwt.generateToken(user);
    res.cookie("token", token, cookieOptions).status(200).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        discordId: user.discordId,
        avatar: user.avatar ?? null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * Log out the current user
 * @route POST /auth/logout
 */
function logout(req, res) {
  res.clearCookie("token", { httpOnly: true, secure: true, sameSite: "none" });
  res.status(200).json({ message: "Logged out successfully" });
}

/**
 * Get current authenticated user's info
 * @route GET /auth/me
 */
async function getMe(req, res) {
  try {
    // Re-fetch from DB so avatar and other mutable fields are always fresh
    const freshUser = await userService.fetchUser(Number(req.user.id));
    if (!freshUser) {
      return res.status(401).json({ message: "User not found." });
    }
    res.status(200).json({ user: freshUser });
  } catch (error) {
    console.error("Get me error:", error);
    res.status(500).json({ message: "Failed to fetch user" });
  }
}

/**
 * Change or set a password for the authenticated user.
 * @route PATCH /auth/changePassword
 */
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const userId = Number(req.user.id);

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ message: "New password must be at least 8 characters." });
  }

  if (
    !/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) ||
    !/[0-9]/.test(newPassword) || !/[\W_]/.test(newPassword)
  ) {
    return res.status(400).json({
      message: "Password must contain uppercase, lowercase, a number, and a special character.",
    });
  }

  try {
    const existingUser = await userService.fetchUserWithPassword(userId);

    if (existingUser.password) {
      if (!currentPassword) {
        return res.status(400).json({ message: "Please provide your current password." });
      }
      const valid = await bcrypt.compare(currentPassword, existingUser.password);
      if (!valid) {
        return res.status(401).json({ message: "Current password is incorrect." });
      }
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const updatedUser = await authService.updatePassword(userId, hashedPassword);

    res.status(200).json({
      message: existingUser.password
        ? "Password updated successfully."
        : "Password set! You can now log in with your Discord ID and this password.",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
}

// ============================================
// PASSWORD RESET OPERATIONS
// ============================================

/**
 * Initiate password reset — sends reset email
 * @route POST /auth/forgetPassword
 */
async function forgetPassword(req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const user = await authService.findUserByEmail(email);

    if (!user) {
      return res.status(200).json({ message: "If an account exists, a reset email has been sent." });
    }

    const resetToken      = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);

    await authService.saveResetToken(user.id, resetToken, resetTokenExpiry);

    const resetLink = `https://inkwell.com.ng/reset-password?token=${resetToken}`;

    await sendEmail(
      user.email,
      "Password Reset Request",
      `<p>Hello ${user.username},</p>
       <p>You requested to reset your password. Click the link below:</p>
       <a href="${resetLink}">${resetLink}</a>
       <p>This link will expire in 15 minutes.</p>
       <p>If you didn't request this, please ignore this email.</p>`
    );

    res.status(200).json({ message: "Password reset email sent!" });
  } catch (error) {
    console.error("Forget password error:", error);
    res.status(500).json({ message: "Error processing request" });
  }
}

/**
 * Reset password using token
 * @route POST /auth/resetPassword
 */
async function resetPassword(req, res) {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ message: "Token and new password are required" });
  }

  try {
    const user = await authService.findUserByResetToken(token);

    if (!user || user.resetTokenExpiry < Date.now()) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await authService.updatePassword(Number(user.id), hashedPassword);
    await authService.clearResetToken(Number(user.id));

    res.status(200).json({ message: "Password reset successful!" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Error resetting password" });
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  signup,
  login,
  logout,
  getMe,
  changePassword,
  forgetPassword,
  resetPassword,
};