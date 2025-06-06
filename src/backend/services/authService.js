// src/backend/services/authService.js

// Assuming userService.js is in the same directory. Adjust path if necessary.
const userService = require('./userService');

/**
 * Retrieves a user object including their role.
 * Thin wrapper around userService.getUserById for semantic clarity or future expansion.
 * @param {number|string} requestingUserId - The ID of the user to fetch.
 * @returns {Promise<object|null>} User object { id, username, role, ... } or null if not found/error.
 */
async function getUserWithRole(requestingUserId) {
  if (requestingUserId === null || requestingUserId === undefined) {
    console.warn("getUserWithRole called with null or undefined requestingUserId");
    return null;
  }
  // userService.getUserById now returns the role as part of the user object.
  return await userService.getUserById(requestingUserId);
}

/**
 * Checks if a user has a specific role or one of a list of roles.
 * @param {number|string} requestingUserId - The ID of the user whose role is to be checked.
 * @param {string|Array<string>} requiredRoleOrRoles - The role string or array of role strings to check against.
 * @returns {Promise<boolean>} - True if the user has the required role, false otherwise.
 */
async function checkUserRole(requestingUserId, requiredRoleOrRoles) {
  if (requestingUserId === null || requestingUserId === undefined) {
    console.warn("checkUserRole called with no requestingUserId.");
    return false; // Cannot check role for an undefined user.
  }

  if (!requiredRoleOrRoles || (Array.isArray(requiredRoleOrRoles) && requiredRoleOrRoles.length === 0)) {
    console.warn("checkUserRole called with no requiredRoleOrRoles specified.");
    return false; // No role to check against.
  }

  let user;
  try {
    user = await getUserWithRole(requestingUserId);
  } catch (error) {
    console.error(`Error fetching user in checkUserRole for userId ${requestingUserId}:`, error);
    return false; // If user fetching fails, cannot confirm role.
  }

  if (!user || !user.role) {
    // User not found or role is not set (though schema now enforces NOT NULL and DEFAULT for role).
    console.warn(`User ${requestingUserId} not found or has no role for checkUserRole.`);
    return false;
  }

  const userRole = user.role;

  if (typeof requiredRoleOrRoles === 'string') {
    return userRole === requiredRoleOrRoles;
  } else if (Array.isArray(requiredRoleOrRoles)) {
    return requiredRoleOrRoles.includes(userRole);
  } else {
    console.warn("checkUserRole called with invalid format for requiredRoleOrRoles. Must be string or array of strings.");
    return false; // Invalid format for required roles.
  }
}

module.exports = {
  getUserWithRole,
  checkUserRole,
};
