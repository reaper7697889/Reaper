// src/backend/services/userService.js
const bcrypt = require('bcrypt');
const { getDb } = require('../../../db'); // Corrected path

const SALT_ROUNDS = 10; // bcrypt salt rounds

// Internal helper to hash password
async function _hashPassword(password) {
  try {
    return await bcrypt.hash(password, SALT_ROUNDS);
  } catch (error) {
    console.error("Error hashing password:", error);
    throw new Error("Failed to hash password."); // Re-throw to be caught by calling function
  }
}

// Internal helper to verify password
async function _verifyPassword(password, hash) {
  try {
    return await bcrypt.compare(password, hash);
  } catch (error) {
    console.error("Error verifying password:", error);
    throw new Error("Failed to verify password."); // Re-throw
  }
}

/**
 * Registers a new user.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<object>} { success: boolean, user?: {id, username}, error?: string }
 */
async function registerUser(username, password) {
  const db = getDb();
  const trimmedUsername = username ? username.trim() : "";

  if (!trimmedUsername || trimmedUsername.length < 3) {
    return { success: false, error: "Username must be at least 3 characters long." };
  }
  if (!password || password.length < 6) {
    return { success: false, error: "Password must be at least 6 characters long." };
  }

  try {
    const existingUser = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(trimmedUsername);
    if (existingUser) {
      return { success: false, error: "Username already taken." };
    }

    const passwordHash = await _hashPassword(password);

    // Determine role: first user is ADMIN, others are EDITOR by default
    const userCountInfo = db.prepare("SELECT COUNT(*) as count FROM users").get();
    const roleToSet = (userCountInfo.count === 0) ? 'ADMIN' : 'EDITOR';

    const stmt = db.prepare("INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
    const info = stmt.run(trimmedUsername, passwordHash, roleToSet);

    if (info.changes > 0 && info.lastInsertRowid) {
        return {
            success: true,
            user: { id: info.lastInsertRowid, username: trimmedUsername, role: roleToSet }
        };
    } else {
        // This case should ideally not be reached if prepare/run didn't throw for other reasons
        return { success: false, error: "User registration failed to insert data."};
    }
  } catch (error) {
    console.error("Error during user registration:", error);
    // Check if it's a unique constraint error from a race condition (though less likely with COLLATE NOCASE pre-check)
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { success: false, error: "Username already taken (concurrent registration)." };
    }
    return { success: false, error: error.message || "User registration failed due to a server error." };
  }
}

/**
 * Logs in a user by verifying credentials.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<object>} { success: boolean, user?: {id, username}, error?: string, reason?: string }
 */
async function loginUser(username, password) {
  const db = getDb();
  const trimmedUsername = username ? username.trim() : "";

  if (!trimmedUsername || !password) {
     return { success: false, error: "Username and password are required.", reason: "missing_credentials" };
  }

  try {
    const user = db.prepare("SELECT id, username, password_hash, role FROM users WHERE username = ? COLLATE NOCASE").get(trimmedUsername);
    if (!user) {
      return { success: false, error: "Invalid username or password.", reason: "invalid_credentials" };
    }

    const isValidPassword = await _verifyPassword(password, user.password_hash);
    if (!isValidPassword) {
      return { success: false, error: "Invalid username or password.", reason: "invalid_credentials" };
    }

    return {
      success: true,
      user: { id: user.id, username: user.username, role: user.role }
    };
  } catch (error) {
    console.error("Error during user login:", error);
    return { success: false, error: error.message || "Login failed due to a server error.", reason: "server_error" };
  }
}

/**
 * Retrieves a user by ID (excluding password hash).
 * @param {number} userId
 * @returns {Promise<object | null>} User object { id, username, created_at, updated_at } or null if not found/error.
 */
async function getUserById(userId) {
  const db = getDb();
  if (userId === null || userId === undefined) {
      console.warn("getUserById called with null or undefined userId");
      return null;
  }
  try {
    const user = db.prepare("SELECT id, username, role, created_at, updated_at FROM users WHERE id = ?").get(userId);
    return user || null;
  } catch (error) {
    console.error(`Error fetching user by ID ${userId}:`, error);
    return null;
  }
}

module.exports = {
  registerUser,
  loginUser,
  getUserById,
  getUserByUsername,
  adminSetUserRole, // Export the new function
};

/**
 * Retrieves a user by username (excluding password hash).
 * Case-insensitive username search.
 * @param {string} username
 * @returns {Promise<object | null>} User object { id, username, role, created_at, updated_at } or null if not found/error.
 */
async function getUserByUsername(username) {
  const db = getDb();
  if (username === null || username === undefined || String(username).trim() === "") {
      console.warn("getUserByUsername called with empty or invalid username");
      return null;
  }
  try {
    const sql = "SELECT id, username, role, created_at, updated_at FROM users WHERE username = ? COLLATE NOCASE";
    const user = db.prepare(sql).get(String(username).trim());
    return user || null;
  } catch (error) {
    console.error(`Error fetching user by username "${username}":`, error);
    return null;
  }
}

/**
 * Allows an ADMIN user to set the role of a target user.
 * @param {number} targetUserId - The ID of the user whose role is to be changed.
 * @param {string} newRole - The new role ('ADMIN', 'EDITOR', 'VIEWER').
 * @param {number} adminUserId - The ID of the user attempting this action (must be an ADMIN).
 * @returns {Promise<object>} { success: boolean, user?: {id, role}, error?: string }
 */
async function adminSetUserRole(targetUserId, newRole, adminUserId) {
  const db = getDb();

  if (!targetUserId || !newRole || !adminUserId) {
    return { success: false, error: "Target user ID, new role, and admin user ID are required." };
  }

  try {
    // Authorization: Check if adminUserId is actually an ADMIN
    const adminUser = await getUserById(adminUserId); // This now fetches role too
    if (!adminUser || adminUser.role !== 'ADMIN') {
      return { success: false, error: "Unauthorized: Only ADMIN users can change roles." };
    }

    // Validate newRole
    if (!['ADMIN', 'EDITOR', 'VIEWER'].includes(newRole)) {
      return { success: false, error: "Invalid role specified. Must be 'ADMIN', 'EDITOR', or 'VIEWER'." };
    }

    // Check if target user exists
    const targetUser = await getUserById(targetUserId);
    if (!targetUser) {
      return { success: false, error: "Target user not found." };
    }

    // Prevent admin from changing their own role if they are the sole admin
    if (targetUser.id === adminUserId && newRole !== 'ADMIN') {
        const adminCountInfo = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN'").get();
        if (adminCountInfo.count === 1) {
            return { success: false, error: "Cannot change the role of the sole ADMIN user." };
        }
    }


    const stmt = db.prepare("UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const info = stmt.run(newRole, targetUserId);

    if (info.changes > 0) {
      // Fetch the updated user details to confirm
      const updatedUser = await getUserById(targetUserId);
      return { success: true, user: { id: updatedUser.id, username: updatedUser.username, role: updatedUser.role } };
    } else {
      // This could happen if the targetUserId doesn't exist (though checked above) or role was already set to newRole
      if (targetUser.role === newRole) {
        return { success: true, message: "User role is already set to the specified value.", user: { id: targetUser.id, username: targetUser.username, role: targetUser.role }};
      }
      return { success: false, error: "Failed to update user role or user not found." };
    }
  } catch (error) {
    console.error(`Error in adminSetUserRole (target: ${targetUserId}, newRole: ${newRole}, admin: ${adminUserId}):`, error);
    return { success: false, error: error.message || "Failed to set user role due to a server error." };
  }
}
