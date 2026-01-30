/**
 * Authentication Service
 * 
 * Handles user authentication operations including:
 * - User lookup by email/username
 * - Password reset token management
 * - User registration
 * - Password updates
 */

const prisma = require("../config/prismaClient");

// ==================== User Lookup ====================

/**
 * Find a user by their email address
 * @param {string} email - User's email address
 * @returns {Promise<Object|null>} User object if found, null otherwise
 */
async function findUserByEmail(email) {
  return await prisma.user.findUnique({
    where: { email }
  });
}

/**
 * Find a user by their username
 * @param {string} username - User's username
 * @returns {Promise<Object|null>} User object if found, null otherwise
 */
async function findUserByUsername(username) {
  return await prisma.user.findUnique({
    where: { username }
  });
}

// ==================== Password Reset ====================

/**
 * Save a password reset token for a user
 * @param {number} userId - User's ID
 * @param {string} token - Reset token to save
 * @param {Date} expiry - Token expiration date
 * @returns {Promise<Object>} Updated user object
 */
async function saveResetToken(userId, token, expiry) {
  return await prisma.user.update({
    where: { id: Number(userId) },
    data: {
      resetToken: token,
      resetTokenExpiry: expiry,
    },
  });
}

/**
 * Find a user by their valid reset token
 * @param {string} token - Reset token to look up
 * @returns {Promise<Object|null>} User object if token is valid, null otherwise
 */
async function findUserByResetToken(token) {
  return await prisma.user.findFirst({
    where: {
      resetToken: token,
      resetTokenExpiry: {
        gt: new Date(),
      },
    },
  });
}

/**
 * Clear the reset token for a user
 * @param {number} userId - User's ID
 * @returns {Promise<Object>} Updated user object
 */
async function clearResetToken(userId) {
  return await prisma.user.update({
    where: { id: Number(userId) },
    data: {
      resetToken: null,
      resetTokenExpiry: null,
    },
  });
}

/**
 * Update a user's password
 * @param {number} id - User's ID
 * @param {string} password - New hashed password
 * @returns {Promise<Object>} Updated user object
 */
async function updatePassword(id, password) {
  return await prisma.user.update({
    where: { id },
    data: { password },
  });
}

// ==================== Exports ====================

module.exports = {
  findUserByEmail,
  findUserByUsername,
  saveResetToken,
  findUserByResetToken,
  clearResetToken,
  updatePassword
};