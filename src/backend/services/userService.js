// src/backend/services/userService.js
const bcrypt = require('bcrypt');
const { getDb } = require('../db');

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

    const stmt = db.prepare("INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
    const info = stmt.run(trimmedUsername, passwordHash);

    if (info.changes > 0 && info.lastInsertRowid) {
        return {
            success: true,
            user: { id: info.lastInsertRowid, username: trimmedUsername }
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
    const user = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE").get(trimmedUsername);
    if (!user) {
      return { success: false, error: "Invalid username or password.", reason: "invalid_credentials" };
    }

    const isValidPassword = await _verifyPassword(password, user.password_hash);
    if (!isValidPassword) {
      return { success: false, error: "Invalid username or password.", reason: "invalid_credentials" };
    }

    return {
      success: true,
      user: { id: user.id, username: user.username }
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
    const user = db.prepare("SELECT id, username, created_at, updated_at FROM users WHERE id = ?").get(userId);
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
};
