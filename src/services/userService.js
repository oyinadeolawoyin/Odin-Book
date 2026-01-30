/**
 * User Service
 * 
 * Comprehensive user management service handling:
 * - User CRUD operations
 * - Social profile management
 * - Follow/unfollow functionality
 * - Library management (saved content)
 * - Notification management
 * - Push notification subscriptions
 */

const prisma = require("../config/prismaClient");

// ==================== User Operations ====================

/**
 * Create a new user account
 * @param {Object} userData - User data object
 * @param {string} userData.username - Username
 * @param {string} userData.password - Hashed password
 * @param {string} userData.email - Email address
 * @returns {Promise<Object>} Created user object
 */
async function createUser({ 
    username, 
    password, 
    email, 
    role 
  }) {
    return await prisma.user.create({
      data: {
        username,
        password,
        email,
        role: role || "USER" 
      }
    });
}


/**
 * Count total number of users
 * @returns {Promise<number>} Total user count
 */
async function countUsers() {
  return await prisma.user.count();
}

/**
 * Fetch all users
 * @returns {Promise<Array>} Array of all user objects
 */
async function fetchUsers() {
  return await prisma.user.findMany({
    select: {
      id: true,
      username: true,
      email: true,
      img: true,
      bio: true,
      role: true,
      country: true,
      gender: true
    },
    orderBy: {
      id: 'desc'
    }
  });
}

/**
 * Fetch a single user by ID with social data, followers, and content stats
 * @param {number} id - User ID
 * @returns {Promise<Object|null>} User object with social, follower data, and content counts
 */
async function fetchUser(id) {
  return await prisma.user.findUnique({
    where: { id },
    include: {
      social: true,
      followers: { 
        select: { 
          followerId: true,
        },
      }, 
      _count: {
        select: {
          followers: true,
          followings: true,
          stories: true,           
          collection: true,         
          images: true,            
          videos: true,           
          recommendations: true     
        }
      }
    }
  });
}

/**
 * Delete a user by ID
 * @param {number} id - User ID to delete
 * @returns {Promise<Object>} Deleted user object
 */
async function deleteUser(id) {
  return await prisma.user.delete({
    where: { id }
  });
}

/**
 * Update user profile information
 * @param {Object} userData - User data to update
 * @param {string} userData.username - Username
 * @param {string} userData.password - Hashed password
 * @param {string} userData.email - Email address
 * @param {string} userData.country - User's country
 * @param {string} userData.gender - User's gender
 * @param {string} userData.bio - User biography
 * @param {string} userData.img - Profile image URL
 * @param {number} userData.writestreak - Write streak count
 * @param {number} userData.readstreak - Read streak count
 * @param {string} userData.instagram - Instagram handle
 * @param {string} userData.facebook - Facebook profile
 * @param {string} userData.twitter - Twitter handle
 * @param {string} userData.discord - Discord username
 * @param {string} userData.donation - Donation link
 * @param {number} userData.id - User ID
 * @returns {Promise<Object>} Updated user object
 */
async function updateUser({ 
  username, 
  password, 
  email, 
  country, 
  gender, 
  bio, 
  img, 
  writestreak, 
  readstreak, 
  instagram, 
  facebook, 
  twitter, 
  discord, 
  donation, 
  id,
  role 
}) {
  return await prisma.user.update({
    where: { id },
    data: {
      username,
      password,
      email,
      country,
      gender,
      bio,
      img,
      writestreak, 
      readstreak,    
      instagram,   
      facebook,    
      twitter,     
      discord,     
      donation,
      role
    },
  });
}


// ==================== Exports ====================

module.exports = {
  createUser,
  fetchUsers,
  countUsers,
  fetchUser,
  deleteUser,
  updateUser,
};