// src/backend/models/Tag.js

class Tag {
  /**
   * @param {number | null} id
   * @param {string} name
   */
  constructor(id = null, name) {
    this.id = id;
    this.name = name;
  }

  // Static methods for DB interaction (e.g., findOrCreate, findByName) would go here or in a service.
}

module.exports = Tag;

