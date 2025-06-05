// src/backend/services/databaseRowService.js
const { getDb } = require("../db");
const { getColumnsForDatabase, getDatabaseById } // Import from databaseDefService
    = require("./databaseDefService");

// Helper function to prepare value for storage based on column type (for non-RELATION types)
function _prepareValueForStorage(columnType, rawValue) {
  const output = { value_text: null, value_number: null, value_boolean: null };
  if (rawValue === null || rawValue === undefined) {
    return output;
  }

  switch (columnType) {
    case 'TEXT':
    case 'DATE':
    case 'SELECT':
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
        try {
            const parsed = JSON.parse(rawValue); // Allow stringified JSON array
            if (!Array.isArray(parsed)) throw new Error("MULTI_SELECT value must be an array or JSON string array.");
            output.value_text = JSON.stringify(parsed);
        } catch(e) {
            throw new Error("MULTI_SELECT value must be an array or a valid JSON string array.");
        }
      } else {
        output.value_text = JSON.stringify(rawValue);
      }
      break;
    case 'RELATION':
        // This function should not be called for RELATION types by addRow/updateRow.
        // Values for RELATION types are stored in database_row_links.
        console.warn("_prepareValueForStorage called for RELATION type. This should be handled separately.");
        return output; // Return nulls, but this indicates a logic flaw if reached.
    default:
      throw new Error(`Unsupported column type: ${columnType}`);
  }
  return output;
}

// Helper function to deserialize stored value to actual type (for non-RELATION types)
function _deserializeValue(columnType, value_text, value_number, value_boolean) {
    switch (columnType) {
        case 'TEXT':
        case 'DATE':
        case 'SELECT':
            return value_text;
        case 'NUMBER':
            return value_number;
        case 'BOOLEAN':
            return value_boolean === 1;
        case 'MULTI_SELECT':
            try {
                return value_text ? JSON.parse(value_text) : [];
            } catch (e) {
                console.error("Error parsing MULTI_SELECT JSON:", e.message, value_text);
                return [];
            }
        case 'RELATION':
            // This function is not used for RELATION types in getRow.
            // Relation data (array of linked row IDs) is fetched directly from database_row_links.
            return []; // Should not be reached by getRow's logic for RELATION.
        default:
            return null;
    }
}

/**
 * Adds a new row to a database with its associated values.
 * @param {object} args - { databaseId, values, rowOrder = null }
 *                        `values` is an object like { columnId1: rawValue1, ... }
 * @returns {object} - { success: boolean, rowId?: number, error?: string }
 */
function addRow({ databaseId, values, rowOrder = null }) {
  const db = getDb();
  // Cache column definitions for this database to avoid repeated DB calls
  const columnDefs = getColumnsForDatabase(databaseId).reduce((acc, col) => {
    acc[col.id] = col;
    return acc;
  }, {});

  const transaction = db.transaction(() => {
    const rowStmt = db.prepare(
      "INSERT INTO database_rows (database_id, row_order) VALUES (?, ?)"
    );
    const rowInfo = rowStmt.run(databaseId, rowOrder);
    const newRowId = rowInfo.lastInsertRowid;

    if (!newRowId) {
      throw new Error("Failed to insert row into database_rows.");
    }

    const valueInsertStmt = db.prepare(
      "INSERT INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean) VALUES (?, ?, ?, ?, ?)"
    );
    const linkInsertStmt = db.prepare(
      "INSERT INTO database_row_links (source_row_id, source_column_id, target_row_id, link_order) VALUES (?, ?, ?, ?)"
    );

    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      if (isNaN(columnId)) throw new Error(`Invalid columnId: ${columnIdStr}`);

      const colDef = columnDefs[columnId];
      if (!colDef) throw new Error(`Column with ID ${columnId} not found in database ${databaseId}.`);

      if (colDef.type === 'RELATION') {
        if (!Array.isArray(rawValue)) {
          throw new Error(`Value for RELATION column ${colDef.name} (ID: ${columnId}) must be an array of target row IDs.`);
        }
        for (const targetRowId of rawValue) {
          if (typeof targetRowId !== 'number') throw new Error(`Invalid targetRowId ${targetRowId} for RELATION column ${colDef.name}. Must be a number.`);
          // Validate targetRowId: exists and belongs to the linked_database_id
          const targetRow = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(targetRowId);
          if (!targetRow) throw new Error(`Target row ID ${targetRowId} for RELATION column ${colDef.name} does not exist.`);
          if (targetRow.database_id !== colDef.linked_database_id) {
            throw new Error(`Target row ID ${targetRowId} for RELATION column ${colDef.name} does not belong to linked database ID ${colDef.linked_database_id}.`);
          }
          linkInsertStmt.run(newRowId, columnId, targetRowId, 0); // Assuming default link_order 0
        }
      } else {
        if (rawValue !== undefined) { // Only store if value is provided
            const preparedValues = _prepareValueForStorage(colDef.type, rawValue);
            valueInsertStmt.run(newRowId, columnId, preparedValues.value_text, preparedValues.value_number, preparedValues.value_boolean);
        }
      }
    }
    return { rowId: newRowId };
  });

  try {
    const result = transaction();
    return { success: true, rowId: result.rowId };
  } catch (err) {
    console.error("Error adding row:", err.message);
    return { success: false, error: err.message || "Failed to add row." };
  }
}

/**
 * Retrieves a single row with its values, correctly typed.
 * @param {number} rowId
 * @returns {object|null} - The row object with typed values or null if not found/error.
 */
function getRow(rowId) {
  const db = getDb();
  try {
    const rowData = db.prepare("SELECT * FROM database_rows WHERE id = ?").get(rowId);
    if (!rowData) return null;

    const columns = getColumnsForDatabase(rowData.database_id);
    if (!columns) {
        console.error(`Could not fetch columns for database_id ${rowData.database_id} when retrieving row ${rowId}`);
        return { ...rowData, values: {} }; // Return row data but empty values if columns can't be fetched
    }

    const valuesFormatted = {};
    const cellValuesStmt = db.prepare("SELECT value_text, value_number, value_boolean FROM database_row_values WHERE row_id = ? AND column_id = ?");
    const linkedRowsStmt = db.prepare("SELECT target_row_id FROM database_row_links WHERE source_row_id = ? AND source_column_id = ? ORDER BY link_order ASC");

    for (const col of columns) {
      if (col.type === 'RELATION') {
        const linkedRows = linkedRowsStmt.all(rowId, col.id);
        valuesFormatted[col.id] = linkedRows.map(lr => lr.target_row_id);
      } else {
        const cell = cellValuesStmt.get(rowId, col.id);
        if (cell) {
          valuesFormatted[col.id] = _deserializeValue(col.type, cell.value_text, cell.value_number, cell.value_boolean);
        } else {
          valuesFormatted[col.id] = null; // Or some default based on col.default_value if implemented
        }
      }
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
  // Fetch database_id for the row to get column definitions
  const rowMeta = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(rowId);
  if (!rowMeta) return { success: false, error: `Row with ID ${rowId} not found.` };

  const columnDefs = getColumnsForDatabase(rowMeta.database_id).reduce((acc, col) => {
    acc[col.id] = col;
    return acc;
  }, {});

  const transaction = db.transaction(() => {
    const valueReplaceStmt = db.prepare(
      "REPLACE INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean, updated_at, created_at) "+
      "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, (SELECT created_at FROM database_row_values WHERE row_id = ? AND column_id = ? UNION ALL SELECT CURRENT_TIMESTAMP LIMIT 1))"
    );
    const deleteLinksStmt = db.prepare("DELETE FROM database_row_links WHERE source_row_id = ? AND source_column_id = ?");
    const linkInsertStmt = db.prepare(
      "INSERT INTO database_row_links (source_row_id, source_column_id, target_row_id, link_order) VALUES (?, ?, ?, ?)"
    );

    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      if (isNaN(columnId)) throw new Error(`Invalid columnId: ${columnIdStr}`);

      const colDef = columnDefs[columnId];
      if (!colDef) throw new Error(`Column with ID ${columnId} not found for this row's database.`);

      if (colDef.type === 'RELATION') {
        if (!Array.isArray(rawValue)) {
          throw new Error(`Value for RELATION column ${colDef.name} (ID: ${columnId}) must be an array of target row IDs.`);
        }
        // Delete existing links for this cell
        deleteLinksStmt.run(rowId, columnId);
        // Add new links
        for (const targetRowId of rawValue) {
          if (typeof targetRowId !== 'number') throw new Error(`Invalid targetRowId ${targetRowId} for RELATION column ${colDef.name}. Must be a number.`);
           const targetRow = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(targetRowId);
          if (!targetRow) throw new Error(`Target row ID ${targetRowId} for RELATION column ${colDef.name} does not exist.`);
          if (targetRow.database_id !== colDef.linked_database_id) {
            throw new Error(`Target row ID ${targetRowId} for RELATION column ${colDef.name} does not belong to linked database ID ${colDef.linked_database_id}.`);
          }
          linkInsertStmt.run(rowId, columnId, targetRowId, 0); // Assuming default link_order 0
        }
      } else {
         if (rawValue === undefined) continue; // Allow partial updates, skip if value not provided for a column
        const preparedValues = _prepareValueForStorage(colDef.type, rawValue);
        valueReplaceStmt.run(rowId, columnId, preparedValues.value_text, preparedValues.value_number, preparedValues.value_boolean, rowId, columnId);
      }
    }

    const updateRowTimestampStmt = db.prepare("UPDATE database_rows SET updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    updateRowTimestampStmt.run(rowId);

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
 * Deletes a row from a database. Cascading delete handles its values and links.
 * @param {number} rowId
 * @returns {object} - { success: boolean, error?: string }
 */
function deleteRow(rowId) {
  const db = getDb();
  try {
    // ON DELETE CASCADE for database_rows.id in database_row_values and database_row_links (source_row_id)
    // and database_row_links (target_row_id) will handle cleanup.
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
};
