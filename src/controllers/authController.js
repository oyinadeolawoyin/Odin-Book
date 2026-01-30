require("dotenv").config();
const bcrypt = require("bcryptjs");
const jwt = require("../config/jwt")
const authService = require("../services/authService");
const userService = require("../services/userService");
const { validationResult } = require("express-validator");
const crypto = require("crypto");
const { sendEmail } = require("../config/mailer");

// ============================================
// CONFIGURATION
// ============================================

/**
 * Cookie configuration for JWT tokens
 * Automatically adjusts security settings based on environment
 */
const cookieOptions = {
    httpOnly: true,  // Prevents client-side JavaScript access
    secure: process.env.NODE_ENV === "development",  // HTTPS only in production
    sameSite: process.env.NODE_ENV === 'development' ? 'None' : 'Lax',
    maxAge: 1000 * 60 * 60 * 24 * 21,  // 21 days
};

// ============================================
// AUTHENTICATION OPERATIONS
// ============================================

/**
 * Register a new user
 * Creates user account
 * Automatically logs user in after successful registration
 * @route POST /auth/signup
 */
async function signup(req, res) {
  // Validate request body
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: errors.array().map(err => err.msg)
    });
  }

  const { username, password, email } = req.body;

  try {
    // Check if email already exists
    const existingEmail = await authService.findUserByEmail(email);
    if (existingEmail) {
      return res.status(409).json({ message: "Email is already in use." });
    }

    // Check if username already exists
    const existingUsername = await authService.findUserByUsername(username);
    if (existingUsername) {
      return res.status(409).json({ message: "Username is already taken. Please choose another one." });
    }

    // Hash password for security
    const hashedPassword = await bcrypt.hash(password, 10);

    //Check total user count to determine if user gets premium
    const userCount = await userService.countUsers();
    const isPremiumEligible = userCount < 10; // First 10 users get free premium

    // Create user account with role based on eligibility
    const user = await userService.createUser({
      username,
      password: hashedPassword,
      email,
      role: isPremiumEligible ? "FOUNDING_WRITER" : "USER" // FOUNDING WRITER = Premium forever
    });

    // Generate JWT and set secure cookie
    const token = jwt.generateToken(user);
    res.cookie("token", token, cookieOptions).status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * Authenticate and log in a user
 * Validates credentials and returns JWT token
 * @route POST /auth/login
 */
async function login(req, res) {
    // Validate request body
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            message: errors.array().map(err => err.msg)
        });
    }

    const { username, password } = req.body;

    try {
        // Find user by username
        const user = await authService.findUserByUsername(username);
        if (!user) {
            return res.status(404).json({ message: "Username does not exist" });
        }
        
        // Verify password
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.status(401).json({ message: "Invalid password" });
        }

        // Generate JWT and set secure cookie
        const token = jwt.generateToken(user);
        res.cookie("token", token, cookieOptions).status(200).json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: "Something went wrong. Please try again later." });
    }
}

/**
 * Log out the current user
 * Clears the authentication cookie
 * @route POST /auth/logout
 */
function logout(req, res) {
    res.clearCookie("token", {
        httpOnly: true,
        secure: true,  // Only if using HTTPS
        sameSite: "none",  // Required for cross-origin requests (Render frontend + backend)
    });
    res.status(200).json({ message: "Logged out successfully" });
}

/**
 * Get current authenticated user's information
 * User data is attached to request by authentication middleware
 * @route GET /auth/me
 */
async function getMe(req, res) {
    try {
        const user = req.user;
        res.status(200).json(user);
    } catch (error) {
        console.error("Get me error:", error);
        res.status(500).json({ message: "Failed to fetch user" });
    }
}

// ============================================
// PASSWORD RESET OPERATIONS
// ============================================

/**
 * Initiate password reset process
 * Generates secure token and sends reset email
 * Returns generic message to prevent email enumeration
 * @route POST /auth/forget-password
 */
async function forgetPassword(req, res) {
    const { email } = req.body;
    
    // Validate email is provided
    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }
  
    try {
        // Find user by email
        const user = await authService.findUserByEmail(email);
        
        // Return generic message regardless of whether user exists (security best practice)
        if (!user) {
            return res.status(200).json({ 
                message: "If an account exists, a reset email has been sent." 
            });
        }
 
        // Generate cryptographically secure random token
        const resetToken = crypto.randomBytes(32).toString("hex");
        const resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);  // 15 minutes expiry
  
        // Save token and expiry in database
        await authService.saveResetToken(user.id, resetToken, resetTokenExpiry);

        // Create password reset link (frontend route)
        const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

        // Send password reset email
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
 * Reset user password with token
 * Validates token and updates password
 * @route POST /auth/reset-password
 */
async function resetPassword(req, res) {
    const { token, newPassword } = req.body;

    // Validate required fields
    if (!token || !newPassword) {
        return res.status(400).json({ message: "Token and new password are required" });
    }
  
    try {
        // Find user by reset token
        const user = await authService.findUserByResetToken(token);
        
        // Validate token exists and hasn't expired
        if (!user || user.resetTokenExpiry < Date.now()) {
            return res.status(400).json({ message: "Invalid or expired token" });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
  
        // Update password and clear reset token from database
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
    // Authentication
    signup,
    login,
    logout,
    getMe,
    
    // Password Reset
    forgetPassword,
    resetPassword
};