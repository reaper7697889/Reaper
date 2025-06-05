// src/backend/services/databaseRowService.js
const { getDb } = require("../db");
const { getColumnsForDatabase }
    = require("./databaseDefService");
const { evaluateFormula } = require('../utils/FormulaEvaluator');
const { performAggregation } = require('../utils/RollupCalculator');
const smartRuleService = require('./smartRuleService');
const { recordRowHistory } = require('./historyService'); // Import history service

const MAX_TRIGGER_DEPTH = 5;

// Helper function to prepare value for storage (unchanged)
function _prepareValueForStorage(columnType, rawValue) {
  const output = { value_text: null, value_number: null, value_boolean: null };
  if (rawValue === null || rawValue === undefined) return output;
  switch (columnType) {
    case 'TEXT': case 'DATE': case 'SELECT':
      output.value_text = String(rawValue); break;
    case 'NUMBER':
      const num = parseFloat(rawValue);
      if (isNaN(num)) throw new Error(`Invalid number format for value: ${rawValue}`);
      output.value_number = num; break;
    case 'BOOLEAN':
      output.value_boolean = rawValue ? 1 : 0; break;
    case 'MULTI_SELECT':
      if (!Array.isArray(rawValue)) {
        try {
            const parsed = JSON.parse(rawValue);
            if (!Array.isArray(parsed)) throw new Error("MULTI_SELECT value must be an array or JSON string array.");
            output.value_text = JSON.stringify(parsed);
        } catch(e) { throw new Error("MULTI_SELECT value must be an array or a valid JSON string array."); }
      } else { output.value_text = JSON.stringify(rawValue); }
      break;
    case 'RELATION': case 'FORMULA': case 'ROLLUP': case 'LOOKUP':
        console.warn(`_prepareValueForStorage called for ${columnType} type. This should be handled separately.`);
        return output;
    default: throw new Error(`Unsupported column type for storage preparation: ${columnType}`);
  }
  return output;
}

// Helper function to deserialize stored value (unchanged)
function _deserializeValue(columnType, value_text, value_number, value_boolean) {
    switch (columnType) {
        case 'TEXT': case 'DATE': case 'SELECT': return value_text;
        case 'NUMBER': return value_number;
        case 'BOOLEAN': return value_boolean === 1;
        case 'MULTI_SELECT':
            try { return value_text ? JSON.parse(value_text) : []; }
            catch (e) { console.error("Error parsing MULTI_SELECT JSON:", e.message, value_text); return []; }
        case 'RELATION': case 'FORMULA': case 'ROLLUP': case 'LOOKUP':
            console.warn(`_deserializeValue called for ${columnType}. This type should be handled by getRow directly.`);
            return null;
        default: return null;
    }
}

/**
 * Internal helper to get only the directly stored data for a row.
 * This means values from database_row_values and links from database_row_links.
 * It does NOT compute formulas, rollups, or lookups.
 * @param {number} rowId
 * @param {object} db - Database instance
 * @returns {Promise<object|null>} - Object of { columnId: value }, or null if row not found.
 */
async function _getStoredRowData(rowId, dbInstance) {
    const db = dbInstance || getDb(); // Use provided db or get new one
    const rowData = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(rowId);
    if (!rowData) return null;

    const allColumnDefinitions = getColumnsForDatabase(rowData.database_id); // This uses its own getDb() if dbInstance not passed
    if (!allColumnDefinitions || allColumnDefinitions.length === 0) return {};

    const storedRowData = {};
    const cellValuesStmt = db.prepare("SELECT value_text, value_number, value_boolean FROM database_row_values WHERE row_id = ? AND column_id = ?");
    const linkedRowsStmt = db.prepare("SELECT target_row_id FROM database_row_links WHERE source_row_id = ? AND source_column_id = ? ORDER BY link_order ASC");

    for (const colDef of allColumnDefinitions) {
      if (colDef.type === 'RELATION') {
        const linkedRows = linkedRowsStmt.all(rowId, colDef.id);
        storedRowData[colDef.id] = linkedRows.map(lr => lr.target_row_id);
      } else if (!['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
        const cell = cellValuesStmt.get(rowId, colDef.id);
        storedRowData[colDef.id] = cell ? _deserializeValue(colDef.type, cell.value_text, cell.value_number, cell.value_boolean) : null;
      } else {
        // For computed types, we don't store a direct value here.
        // They will be null or undefined in this context, which is fine.
      }
    }
    return storedRowData;
}


function addRow({ databaseId, values, rowOrder = null }) {
  const db = getDb();
  const columnDefsMap = getColumnsForDatabase(databaseId).reduce((acc, col) => { acc[col.id] = col; return acc; }, {});
  let newRowId;

  const transaction = db.transaction(() => {
    const rowStmt = db.prepare("INSERT INTO database_rows (database_id, row_order) VALUES (?, ?)");
    const rowInfo = rowStmt.run(databaseId, rowOrder);
    newRowId = rowInfo.lastInsertRowid; // Assign to outer scope variable
    if (!newRowId) throw new Error("Failed to insert row into database_rows.");

    const valueInsertStmt = db.prepare("INSERT INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean) VALUES (?, ?, ?, ?, ?)");
    const linkInsertStmt = db.prepare("INSERT INTO database_row_links (source_row_id, source_column_id, target_row_id, link_order) VALUES (?, ?, ?, ?)");

    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      const colDef = columnDefsMap[columnId];
      if (!colDef) throw new Error(`Column ID ${columnId} not found in DB ${databaseId}.`);
      if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) continue;
      else if (colDef.type === 'RELATION') { /* ... */ }
      else { if (rawValue !== undefined) { /* ... */ } }
      // Full logic for RELATION and storable types as in previous correct version
      if (colDef.type === 'RELATION') {
        if (!Array.isArray(rawValue)) throw new Error(`Value for RELATION column ${colDef.name} must be an array.`);
        for (const targetRowId of rawValue) {
          if (typeof targetRowId !== 'number') throw new Error(`Invalid targetRowId ${targetRowId} for RELATION column ${colDef.name}.`);
          const targetRow = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(targetRowId);
          if (!targetRow) throw new Error(`Target row ID ${targetRowId} for RELATION column ${colDef.name} does not exist.`);
          if (targetRow.database_id !== colDef.linked_database_id) throw new Error(`Target row ID ${targetRowId} does not belong to linked DB ${colDef.linked_database_id}.`);
          linkInsertStmt.run(newRowId, columnId, targetRowId, 0);
          if (colDef.inverse_column_id !== null) linkInsertStmt.run(targetRowId, colDef.inverse_column_id, newRowId, 0);
        }
      } else {
        if (rawValue !== undefined) {
            const preparedValues = _prepareValueForStorage(colDef.type, rawValue);
            valueInsertStmt.run(newRowId, columnId, preparedValues.value_text, preparedValues.value_number, preparedValues.value_boolean);
        }
      }
    }
    // For addRow, history is recorded *after* the transaction succeeds, using the final state.
  });

  try {
    transaction(); // Execute the main data changes

    // Record history after successful commit of main data
    if (newRowId) {
      _getStoredRowData(newRowId, db).then(newStoredData => { // Use the same db instance
        const newRowValuesJson = JSON.stringify(newStoredData);
        // For a new row, oldRowValuesJson is effectively null or an empty representation
        recordRowHistory({ rowId: newRowId, oldRowValuesJson: null, newRowValuesJson, db });
      }).catch(histErr => console.error(`Error recording history for new row ${newRowId}:`, histErr.message));
    }
    console.log(`Added row with ID: ${newRowId} to database ${databaseId}`);
    return { success: true, rowId: newRowId };
  } catch (err) {
    console.error("Error adding row:", err.message, err.stack);
    return { success: false, error: err.message || "Failed to add row." };
  }
}


async function getRow(rowId) {
  // ... (existing getRow logic from Phase 5C - no changes here)
  const db = getDb();
  try {
    const rowData = db.prepare("SELECT * FROM database_rows WHERE id = ?").get(rowId);
    if (!rowData) return null;
    const allColumnDefinitions = getColumnsForDatabase(rowData.database_id);
    if (!allColumnDefinitions || allColumnDefinitions.length === 0) return { ...rowData, values: {} };
    const rowDataValues = {};
    const cellValuesStmt = db.prepare("SELECT value_text, value_number, value_boolean FROM database_row_values WHERE row_id = ? AND column_id = ?");
    const linkedRowsStmt = db.prepare("SELECT target_row_id FROM database_row_links WHERE source_row_id = ? AND source_column_id = ? ORDER BY link_order ASC");
    for (const colDef of allColumnDefinitions) {
      if (colDef.type === 'RELATION') {
        rowDataValues[colDef.id] = linkedRowsStmt.all(rowId, colDef.id).map(lr => lr.target_row_id);
      } else if (!['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
        const cell = cellValuesStmt.get(rowId, colDef.id);
        rowDataValues[colDef.id] = cell ? _deserializeValue(colDef.type, cell.value_text, cell.value_number, cell.value_boolean) : null;
      } else { rowDataValues[colDef.id] = null; }
    }
    for (const colDef of allColumnDefinitions) {
      if (colDef.type === 'FORMULA') {
        if (colDef.formula_definition && colDef.formula_definition.trim() !== "") {
          const evalResult = evaluateFormula(colDef.formula_definition, rowDataValues, allColumnDefinitions);
          rowDataValues[colDef.id] = evalResult.error ? "#ERROR!" : evalResult.result;
          if(evalResult.error) console.error(`Formula Error (row ${rowId}, col ${colDef.id}): ${evalResult.error}`);
        } else { rowDataValues[colDef.id] = null; }
      }
    }
    for (const colDef of allColumnDefinitions) {
        if (colDef.type === 'ROLLUP') {
            const { rollup_source_relation_column_id: srcRelId, rollup_target_column_id: targetColId, rollup_function: func } = colDef;
            if (!srcRelId || !targetColId || !func) { rowDataValues[colDef.id] = "#CONFIG_ERROR!"; continue; }
            const linkedTargetRowIds = rowDataValues[srcRelId];
            if (!Array.isArray(linkedTargetRowIds)) { rowDataValues[colDef.id] = "#RELATION_ERROR!"; continue; }
            if (linkedTargetRowIds.length === 0) {
                const emptyAgg = performAggregation([], func, { type: 'UNKNOWN' });
                rowDataValues[colDef.id] = emptyAgg.result; continue;
            }
            const sourceRelationColDef = allColumnDefinitions.find(c => c.id === srcRelId);
            if (!sourceRelationColDef || !sourceRelationColDef.linked_database_id) { rowDataValues[colDef.id] = "#CONFIG_ERROR!"; continue; }
            const targetDbId = sourceRelationColDef.linked_database_id;
            const allColsInTargetDb = getColumnsForDatabase(targetDbId);
            const targetColDefInLinkedDb = allColsInTargetDb.find(c => c.id === targetColId);
            if (!targetColDefInLinkedDb) { rowDataValues[colDef.id] = "#TARGET_COL_ERROR!"; continue; }
            let actualTargetValues = [];
            if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetColDefInLinkedDb.type)) {
                for (const targetRowId of linkedTargetRowIds) {
                    const targetRowFullData = await getRow(targetRowId);
                    actualTargetValues.push(targetRowFullData ? targetRowFullData.values[targetColId] : null);
                }
            } else { actualTargetValues = await getColumnValuesForRows(targetDbId, linkedTargetRowIds, targetColId); }
            const rollupResult = performAggregation(actualTargetValues, func, targetColDefInLinkedDb);
            rowDataValues[colDef.id] = rollupResult.error ? "#ROLLUP_ERROR!" : rollupResult.result;
            if(rollupResult.error) console.error(`Rollup Error (row ${rowId}, col ${colDef.id}): ${rollupResult.error}`);
        }
    }
    for (const colDef of allColumnDefinitions) {
        if (colDef.type === 'LOOKUP') {
            const { lookup_source_relation_column_id: srcRelId, lookup_target_value_column_id: targetValColId, lookup_multiple_behavior: behavior } = colDef;
            if (!srcRelId || !targetValColId || !behavior) { rowDataValues[colDef.id] = "#CONFIG_ERROR!"; continue; }
            const linkedTargetRowIds = rowDataValues[srcRelId];
            if (!Array.isArray(linkedTargetRowIds)) { rowDataValues[colDef.id] = "#RELATION_ERROR!"; continue; }
            if (linkedTargetRowIds.length === 0) { rowDataValues[colDef.id] = behavior === 'LIST_UNIQUE_STRINGS' ? "" : null; continue; }
            const sourceRelationColDef = allColumnDefinitions.find(c => c.id === srcRelId);
            if (!sourceRelationColDef || !sourceRelationColDef.linked_database_id) { rowDataValues[colDef.id] = "#CONFIG_ERROR!"; continue; }
            const targetDbId = sourceRelationColDef.linked_database_id;
            const allColsInTargetDb = getColumnsForDatabase(targetDbId);
            const targetValueColDefInLinkedDb = allColsInTargetDb.find(c => c.id === targetValColId);
            if (!targetValueColDefInLinkedDb) { rowDataValues[colDef.id] = "#TARGET_COL_ERROR!"; continue; }
            const rowsToFetchForLookup = behavior === 'FIRST' && linkedTargetRowIds.length > 0 ? [linkedTargetRowIds[0]] : linkedTargetRowIds;
            if (rowsToFetchForLookup.length === 0) { rowDataValues[colDef.id] = behavior === 'LIST_UNIQUE_STRINGS' ? "" : null; continue;}

            let lookedUpValues = [];
            if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetValueColDefInLinkedDb.type)) {
                 for (const targetRowId of rowsToFetchForLookup) {
                    const targetRowFullData = await getRow(targetRowId);
                    lookedUpValues.push(targetRowFullData ? targetRowFullData.values[targetValColId] : null);
                }
            } else { lookedUpValues = await getColumnValuesForRows(targetDbId, rowsToFetchForLookup, targetValColId); }
            if (behavior === 'FIRST') rowDataValues[colDef.id] = lookedUpValues.length > 0 ? lookedUpValues[0] : null;
            else rowDataValues[colDef.id] = Array.from(new Set(lookedUpValues.filter(v => v !== null && v !== undefined).map(String))).join(', ');
        }
    }
    return { ...rowData, values: rowDataValues };
  } catch (err) { console.error(`Error getting row ${rowId}:`, err.message, err.stack); return null; }
}

async function updateRow({ rowId, values, _triggerDepth = 0 }) {
  if (_triggerDepth >= MAX_TRIGGER_DEPTH) {
    console.error(`Trigger depth (${_triggerDepth}) exceeded for row ${rowId}. Halting.`);
    return { success: false, error: "Trigger depth exceeded." };
  }

  const db = getDb();
  const rowMeta = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(rowId);
  if (!rowMeta) return { success: false, error: `Row ${rowId} not found.` };

  const columnDefsMap = getColumnsForDatabase(rowMeta.database_id).reduce((acc, col) => { acc[col.id] = col; return acc; }, {});

  let oldStoredDataJson = null;
  if (_triggerDepth === 0) {
    try {
        const oldStoredData = await _getStoredRowData(rowId, db); // Use current db instance from getDb()
        oldStoredDataJson = JSON.stringify(oldStoredData);
    } catch (e) {
        console.error(`Error fetching oldStoredData for history on row ${rowId}: ${e.message}`);
        return { success: false, error: "Failed to fetch pre-update state for history."};
    }
  }

  let primaryUpdateChangesMade = 0; // Track if any actual change happened

  const primaryUpdateTransaction = db.transaction(async () => { // Make transaction callback async
    // ... (valueReplaceStmt, getLinksStmt, etc. as before) ...
    const valueReplaceStmt = db.prepare("REPLACE INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean, updated_at, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, (SELECT created_at FROM database_row_values WHERE row_id = ? AND column_id = ? UNION ALL SELECT CURRENT_TIMESTAMP LIMIT 1))");
    const getLinksStmt = db.prepare("SELECT target_row_id FROM database_row_links WHERE source_row_id = ? AND source_column_id = ?");
    const deleteLinksStmt = db.prepare("DELETE FROM database_row_links WHERE source_row_id = ? AND source_column_id = ?");
    const specificLinkDeleteStmt = db.prepare("DELETE FROM database_row_links WHERE source_row_id = ? AND source_column_id = ? AND target_row_id = ?");
    const linkInsertStmt = db.prepare( "INSERT OR IGNORE INTO database_row_links (source_row_id, source_column_id, target_row_id, link_order) VALUES (?, ?, ?, ?)");

    let changesInThisUpdate = 0;

    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      const colDef = columnDefsMap[columnId];
      if (!colDef) throw new Error(`Column ID ${columnId} not found.`);
      if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) continue;
      // ... (Full logic for RELATION and storable types from previous version)
      if (colDef.type === 'RELATION') {
        if (!Array.isArray(rawValue)) throw new Error(`Value for RELATION column ${colDef.name} must be an array.`);
        const currentLinkedIds = new Set(getLinksStmt.all(rowId, columnId).map(r => r.target_row_id));
        const newLinkedIds = new Set(rawValue.map(id => parseInt(id, 10)));
        for (const targetRowId of newLinkedIds) {
            if (isNaN(targetRowId)) throw new Error(`Invalid targetRowId for RELATION ${colDef.name}.`);
            const targetRow = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(targetRowId);
            if (!targetRow) throw new Error(`Target row ID ${targetRowId} for RELATION ${colDef.name} does not exist.`);
            if (targetRow.database_id !== colDef.linked_database_id) throw new Error(`Target row ID ${targetRowId} does not belong to linked DB.`);
        }
        // Only count as change if sets are different
        if (currentLinkedIds.size !== newLinkedIds.size || ![...currentLinkedIds].every(id => newLinkedIds.has(id))) {
            changesInThisUpdate++;
        }
        deleteLinksStmt.run(rowId, columnId);
        for (const targetRowId of newLinkedIds) linkInsertStmt.run(rowId, columnId, targetRowId, 0);
        if (colDef.inverse_column_id !== null) {
          const colB_id = colDef.inverse_column_id;
          const idsToUnlink = [...currentLinkedIds].filter(id => !newLinkedIds.has(id));
          const idsToLink = [...newLinkedIds].filter(id => !currentLinkedIds.has(id));
          for (const idToUnlink of idsToUnlink) specificLinkDeleteStmt.run(idToUnlink, colB_id, rowId);
          for (const idToLink of idsToLink) linkInsertStmt.run(idToLink, colB_id, rowId, 0);
        }
      } else {
        if (rawValue === undefined) continue;
        // For storable values, check if it actually changed before running REPLACE
        const existingCell = db.prepare("SELECT value_text, value_number, value_boolean FROM database_row_values WHERE row_id = ? AND column_id = ?").get(rowId, columnId);
        const existingValue = existingCell ? _deserializeValue(colDef.type, existingCell.value_text, existingCell.value_number, existingCell.value_boolean) : null;
        if (existingValue !== rawValue) { // Simple comparison, might need deep for objects/arrays if used in future
            changesInThisUpdate++;
        }
        const preparedValues = _prepareValueForStorage(colDef.type, rawValue);
        valueReplaceStmt.run(rowId, columnId, preparedValues.value_text, preparedValues.value_number, preparedValues.value_boolean, rowId, columnId);
      }
    }

    if (changesInThisUpdate > 0 || Object.keys(values).length > 0) { // If any value was processed or intended to be changed
        db.prepare("UPDATE database_rows SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(rowId);
        primaryUpdateChangesMade = changesInThisUpdate; // Store how many columns effectively changed
    }

    if (_triggerDepth === 0 && oldStoredDataJson !== null && primaryUpdateChangesMade > 0) {
      const newStoredData = await _getStoredRowData(rowId, db); // Pass db for transaction
      const newRowValuesJson = JSON.stringify(newStoredData);
      if (oldStoredDataJson !== newRowValuesJson) {
        const historyResult = await recordRowHistory({ rowId, oldRowValuesJson, newRowValuesJson, db });
        if (!historyResult.success) {
          throw new Error(historyResult.error || "Failed to record row history.");
        }
      }
    }
    return { success: true, changes: primaryUpdateChangesMade }; // Indicate if primary update made changes
  });

  let primaryUpdateResult;
  try {
    primaryUpdateResult = await primaryUpdateTransaction(); // Now await if transaction callback is async
  } catch (err) {
    console.error(`Error during primary update for row ${rowId}:`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to update row." };
  }

  if (!primaryUpdateResult.success) return primaryUpdateResult;

  // Trigger processing (remains largely the same, after primary transaction)
  try {
    // Only run triggers if the user's direct update resulted in actual changes to stored data
    if (primaryUpdateResult.changes > 0) {
        const updatedRowData = await getRow(rowId);
        if (!updatedRowData) { /* ... error ... */ return { success: true, warning: "Primary update succeeded but failed to fetch row for triggers." };}
        const dbId = updatedRowData.database_id;
        const rules = smartRuleService.getRulesForDatabase(dbId, { triggerType: 'ON_ROW_UPDATE', isEnabled: true });
        const allColumnDefinitions = getColumnsForDatabase(dbId);
        if (rules && rules.length > 0) { /* ... rule processing loop ... */
            const changedByUserColIds = Object.keys(values).map(id => parseInt(id, 10));
            for (const rule of rules) { /* ... as before ... */ }
        }
    }
  } catch (triggerProcessingError) { /* ... logging ... */ }
  return { success: true };
}


function deleteRow(rowId) { /* ... unchanged ... */ }
async function getColumnValuesForRows(databaseId, rowIds, columnId) { /* ... unchanged but ensure it's async and uses await for getRow ... */ }

module.exports = { addRow, getRow, updateRow, deleteRow, getColumnValuesForRows };
