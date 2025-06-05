// src/backend/services/databaseRowService.js
const { getDb } = require("../db");

// Helper function to prepare value for storage based on column type
function _prepareValueForStorage(columnType, rawValue) {
  const output = { value_text: null, value_number: null, value_boolean: null };
  if (rawValue === null || rawValue === undefined) {
    return output; // Store all as nulls if rawValue is null or undefined
  }

  switch (columnType) {
    case 'TEXT':
    case 'DATE': // Dates are stored as ISO strings (TEXT)
    case 'SELECT': // Single select option is stored as TEXT
      output.value_text = String(rawValue);
      break;
    case 'NUMBER':
      const num = parseFloat(rawValue);
      if (isNaN(num)) {
        throw new Error(`Invalid number format for value: ${rawValue}`);
      }
      output.value_number = num;
      break;
    case 'BOOLEAN':
      output.value_boolean = rawValue ? 1 : 0;
      break;
    case 'MULTI_SELECT':
      if (!Array.isArray(rawValue)) {
        // Attempt to parse if it's a string, otherwise error
        try {
            const parsed = JSON.parse(rawValue);
            if (!Array.isArray(parsed)) throw new Error();
            output.value_text = JSON.stringify(parsed);
        } catch(e) {
            throw new Error("MULTI_SELECT value must be an array or a JSON string array.");
        }
      } else {
        output.value_text = JSON.stringify(rawValue);
      }
      break;
    default:
      throw new Error(`Unsupported column type: ${columnType}`);
  }
  return output;
}

// Helper function to deserialize stored value to actual type
function _deserializeValue(columnType, value_text, value_number, value_boolean) {
    switch (columnType) {
        case 'TEXT':
        case 'DATE':
        case 'SELECT':
            return value_text;
        case 'NUMBER':
            return value_number;
        case 'BOOLEAN':
            return value_boolean === 1; // Convert 1/0 back to true/false
        case 'MULTI_SELECT':
            try {
                return value_text ? JSON.parse(value_text) : []; // Return empty array if null/empty
            } catch (e) {
                console.error("Error parsing MULTI_SELECT JSON:", e.message);
                return []; // Or handle error as appropriate
            }
        default:
            return null; // Or throw error for unsupported type
    }
}


/**
 * Adds a new row to a database with its associated values.
 * @param {object} args - { databaseId, values, rowOrder = null }
 *                        `values` is an object like { columnId1: rawValue1, ... }
 * @returns {object|null} - The new row ID { rowId: number } or null on failure.
 */
function addRow({ databaseId, values, rowOrder = null }) {
  const db = getDb();
  const transaction = db.transaction(() => {
    const rowStmt = db.prepare(
      "INSERT INTO database_rows (database_id, row_order) VALUES (?, ?)"
    );
    const rowInfo = rowStmt.run(databaseId, rowOrder);
    const rowId = rowInfo.lastInsertRowid;

    if (!rowId) {
      throw new Error("Failed to insert row into database_rows.");
    }

    const valueStmt = db.prepare(
      "INSERT INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean) VALUES (?, ?, ?, ?, ?)"
    );
    const columnTypeCache = {}; // Cache for column types

    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      if (isNaN(columnId)) throw new Error(`Invalid columnId: ${columnIdStr}`);

      let columnType = columnTypeCache[columnId];
      if (!columnType) {
        const colInfo = db.prepare("SELECT type FROM database_columns WHERE id = ?").get(columnId);
        if (!colInfo) throw new Error(`Column with ID ${columnId} not found.`);
        columnType = colInfo.type;
        columnTypeCache[columnId] = columnType;
      }

      const preparedValues = _prepareValueForStorage(columnType, rawValue);
      valueStmt.run(rowId, columnId, preparedValues.value_text, preparedValues.value_number, preparedValues.value_boolean);
    }
    return { rowId };
  });

  try {
    return transaction();
  } catch (err) {
    console.error("Error adding row:", err.message);
    return { success: false, error: err.message || "Failed to add row." };
  }
}

/**
 * Retrieves a single row with its values, correctly typed.
 * @param {number} rowId
 * @returns {object|null} - The row object with typed values or null if not found.
 */
function getRow(rowId) {
  const db = getDb();
  try {
    const rowData = db.prepare("SELECT * FROM database_rows WHERE id = ?").get(rowId);
    if (!rowData) return null;

    const valuesRaw = db.prepare(`
      SELECT drv.column_id, drv.value_text, drv.value_number, drv.value_boolean, dc.name as column_name, dc.type as column_type
      FROM database_row_values drv
      JOIN database_columns dc ON drv.column_id = dc.id
      WHERE drv.row_id = ?
    `).all(rowId);

    const valuesFormatted = {};
    for (const val of valuesRaw) {
      valuesFormatted[val.column_id] = _deserializeValue(val.column_type, val.value_text, val.value_number, val.value_boolean);
    }

    return {
      id: rowData.id,
      database_id: rowData.database_id,
      row_order: rowData.row_order,
      created_at: rowData.created_at,
      updated_at: rowData.updated_at,
      values: valuesFormatted,
    };
  } catch (err) {
    console.error(`Error getting row ${rowId}:`, err.message);
    return null;
  }
}

/**
 * Updates values for an existing row.
 * @param {object} args - { rowId, values }
 *                        `values` is an object like { columnId1: rawValue1, ... }
 * @returns {object} - { success: boolean, error?: string }
 */
function updateRow({ rowId, values }) {
  const db = getDb();
  const transaction = db.transaction(() => {
    const columnTypeCache = {}; // Cache for column types
    // Using REPLACE INTO, which is effectively an UPSERT.
    // If created_at for individual cell values is important, a SELECT+UPDATE/INSERT pattern is needed.
    const valueReplaceStmt = db.prepare(
      "REPLACE INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean, updated_at, created_at) "+
      "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, (SELECT created_at FROM database_row_values WHERE row_id = ? AND column_id = ? UNION ALL SELECT CURRENT_TIMESTAMP LIMIT 1))"
    );
    // The subselect for created_at attempts to preserve it on REPLACE if the row/col combo exists.
    // If not, it uses CURRENT_TIMESTAMP. This is a common SQLite trick for conditional created_at on REPLACE.

    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      if (isNaN(columnId)) throw new Error(`Invalid columnId: ${columnIdStr}`);

      let columnType = columnTypeCache[columnId];
      if (!columnType) {
        const colInfo = db.prepare("SELECT type FROM database_columns WHERE id = ?").get(columnId);
        if (!colInfo) throw new Error(`Column with ID ${columnId} not found for this row's database.`);
        columnType = colInfo.type;
        columnTypeCache[columnId] = columnType;
      }

      const preparedValues = _prepareValueForStorage(columnType, rawValue);
      valueReplaceStmt.run(rowId, columnId, preparedValues.value_text, preparedValues.value_number, preparedValues.value_boolean, rowId, columnId);
    }

    // Explicitly update the parent row's updated_at timestamp
    const updateRowTimestampStmt = db.prepare("UPDATE database_rows SET updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const info = updateRowTimestampStmt.run(rowId);
    if(info.changes === 0) throw new Error(`Row with ID ${rowId} not found to update timestamp.`);

    return { success: true };
  });

  try {
    return transaction();
  } catch (err) {
    console.error(`Error updating row ${rowId}:`, err.message);
    return { success: false, error: err.message || "Failed to update row." };
  }
}

/**
 * Deletes a row from a database. Cascading delete handles its values.
 * @param {number} rowId
 * @returns {object} - { success: boolean, error?: string }
 */
function deleteRow(rowId) {
  const db = getDb();
  try {
    const stmt = db.prepare("DELETE FROM database_rows WHERE id = ?");
    const info = stmt.run(rowId);
    if (info.changes > 0) {
      return { success: true };
    }
    return { success: false, error: "Row not found." };
  } catch (err) {
    console.error(`Error deleting row ID ${rowId}:`, err.message);
    return { success: false, error: "Failed to delete row." };
  }
}

module.exports = {
  addRow,
  getRow,
  updateRow,
  deleteRow,
  // _prepareValueForStorage is not exported as it's internal
};
