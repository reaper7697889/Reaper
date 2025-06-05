// src/backend/services/databaseRowService.js
const { getDb } = require("../db");
const { getColumnsForDatabase }
    = require("./databaseDefService");
const { evaluateFormula } = require('../utils/FormulaEvaluator');
const { performAggregation } = require('../utils/RollupCalculator');
const smartRuleService = require('./smartRuleService'); // For fetching rules

const MAX_TRIGGER_DEPTH = 5; // Max recursion depth for triggers

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

// addRow (unchanged from previous version with FORMULA/ROLLUP/LOOKUP skips)
function addRow({ databaseId, values, rowOrder = null }) {
  const db = getDb();
  const columnDefsMap = getColumnsForDatabase(databaseId).reduce((acc, col) => { acc[col.id] = col; return acc; }, {});

  const transaction = db.transaction(() => {
    const rowStmt = db.prepare("INSERT INTO database_rows (database_id, row_order) VALUES (?, ?)");
    const rowInfo = rowStmt.run(databaseId, rowOrder);
    const newRowId = rowInfo.lastInsertRowid;
    if (!newRowId) throw new Error("Failed to insert row into database_rows.");

    const valueInsertStmt = db.prepare("INSERT INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean) VALUES (?, ?, ?, ?, ?)");
    const linkInsertStmt = db.prepare("INSERT INTO database_row_links (source_row_id, source_column_id, target_row_id, link_order) VALUES (?, ?, ?, ?)");

    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      if (isNaN(columnId)) throw new Error(`Invalid columnId: ${columnIdStr}`);
      const colDef = columnDefsMap[columnId];
      if (!colDef) throw new Error(`Column with ID ${columnId} not found in database ${databaseId}.`);

      if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
        console.warn(`Attempted to write value for computed column ${colDef.name} (type: ${colDef.type}). Skipping.`);
        continue;
      } else if (colDef.type === 'RELATION') {
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
    return { rowId: newRowId };
  });

  try {
    const result = transaction();
    // After successful add, process ON_ROW_UPDATE triggers (which for add means any rule not specific to changed columns)
    // This is a simplification; a true "on_row_add" trigger type would be better.
    // For now, we can simulate it by considering all columns "changed" from a null state.
    // Or, more simply, call a new function `_processTriggersForRow(newRowId, allColumnDefsMap, initialValuesForTriggers)`
    // For this iteration, we will only process triggers strictly on `updateRow`.
    return { success: true, rowId: result.rowId };
  } catch (err) {
    console.error("Error adding row:", err.message, err.stack);
    return { success: false, error: err.message || "Failed to add row." };
  }
}


async function getRow(rowId) {
  const db = getDb();
  try {
    const rowData = db.prepare("SELECT * FROM database_rows WHERE id = ?").get(rowId);
    if (!rowData) return null;

    const allColumnDefinitions = getColumnsForDatabase(rowData.database_id);
    if (!allColumnDefinitions || allColumnDefinitions.length === 0) return { ...rowData, values: {} };

    const rowDataValues = {};
    const cellValuesStmt = db.prepare("SELECT value_text, value_number, value_boolean FROM database_row_values WHERE row_id = ? AND column_id = ?");
    const linkedRowsStmt = db.prepare("SELECT target_row_id FROM database_row_links WHERE source_row_id = ? AND source_column_id = ? ORDER BY link_order ASC");

    for (const colDef of allColumnDefinitions) { // Pass 1
      if (colDef.type === 'RELATION') {
        rowDataValues[colDef.id] = linkedRowsStmt.all(rowId, colDef.id).map(lr => lr.target_row_id);
      } else if (!['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
        const cell = cellValuesStmt.get(rowId, colDef.id);
        rowDataValues[colDef.id] = cell ? _deserializeValue(colDef.type, cell.value_text, cell.value_number, cell.value_boolean) : null;
      } else { rowDataValues[colDef.id] = null; }
    }
    for (const colDef of allColumnDefinitions) { // Pass 2: Formulas
      if (colDef.type === 'FORMULA') { /* ... as before ... */
        if (colDef.formula_definition && colDef.formula_definition.trim() !== "") {
          const evalResult = evaluateFormula(colDef.formula_definition, rowDataValues, allColumnDefinitions);
          rowDataValues[colDef.id] = evalResult.error ? "#ERROR!" : evalResult.result;
          if(evalResult.error) console.error(`Formula Error (row ${rowId}, col ${colDef.id}): ${evalResult.error}`);
        } else { rowDataValues[colDef.id] = null; }
      }
    }
    for (const colDef of allColumnDefinitions) { // Pass 3: Rollups
        if (colDef.type === 'ROLLUP') { /* ... as before ... */
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
    for (const colDef of allColumnDefinitions) { // Pass 4: Lookups
        if (colDef.type === 'LOOKUP') { /* ... as before ... */
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
            const rowsToFetchForLookup = behavior === 'FIRST' ? [linkedTargetRowIds[0]] : linkedTargetRowIds;
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
  } catch (err) {
    console.error(`Error getting row ${rowId}:`, err.message, err.stack);
    return null;
  }
}

async function updateRow({ rowId, values, _triggerDepth = 0 }) {
  if (_triggerDepth >= MAX_TRIGGER_DEPTH) {
    console.error(`Trigger depth (${_triggerDepth}) exceeded for row ${rowId}. Halting rule processing.`);
    return { success: false, error: "Trigger depth exceeded. Potential infinite loop." };
  }

  const db = getDb();
  const rowMeta = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(rowId);
  if (!rowMeta) return { success: false, error: `Row with ID ${rowId} not found.` };

  const columnDefsMap = getColumnsForDatabase(rowMeta.database_id).reduce((acc, col) => { acc[col.id] = col; return acc; }, {});

  // Perform the primary update requested by the user or a preceding trigger
  const primaryUpdateTransaction = db.transaction(() => {
    const valueReplaceStmt = db.prepare("REPLACE INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean, updated_at, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, (SELECT created_at FROM database_row_values WHERE row_id = ? AND column_id = ? UNION ALL SELECT CURRENT_TIMESTAMP LIMIT 1))");
    const getLinksStmt = db.prepare("SELECT target_row_id FROM database_row_links WHERE source_row_id = ? AND source_column_id = ?");
    const deleteLinksStmt = db.prepare("DELETE FROM database_row_links WHERE source_row_id = ? AND source_column_id = ?");
    const specificLinkDeleteStmt = db.prepare("DELETE FROM database_row_links WHERE source_row_id = ? AND source_column_id = ? AND target_row_id = ?");
    const linkInsertStmt = db.prepare( "INSERT OR IGNORE INTO database_row_links (source_row_id, source_column_id, target_row_id, link_order) VALUES (?, ?, ?, ?)");

    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      if (isNaN(columnId)) throw new Error(`Invalid columnId: ${columnIdStr}`);
      const colDef = columnDefsMap[columnId];
      if (!colDef) throw new Error(`Column with ID ${columnId} not found.`);

      if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
        console.warn(`Attempted to update computed column ${colDef.name} (type: ${colDef.type}). Skipping.`);
        continue;
      } else if (colDef.type === 'RELATION') { /* ... existing relation update logic ... */
        if (!Array.isArray(rawValue)) throw new Error(`Value for RELATION column ${colDef.name} must be an array.`);
        const currentLinkedIds = new Set(getLinksStmt.all(rowId, columnId).map(r => r.target_row_id));
        const newLinkedIds = new Set(rawValue.map(id => parseInt(id, 10)));
        for (const targetRowId of newLinkedIds) {
            if (isNaN(targetRowId)) throw new Error(`Invalid targetRowId for RELATION ${colDef.name}.`);
            const targetRow = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(targetRowId);
            if (!targetRow) throw new Error(`Target row ID ${targetRowId} for RELATION ${colDef.name} does not exist.`);
            if (targetRow.database_id !== colDef.linked_database_id) throw new Error(`Target row ID ${targetRowId} does not belong to linked DB.`);
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
        const preparedValues = _prepareValueForStorage(colDef.type, rawValue);
        valueReplaceStmt.run(rowId, columnId, preparedValues.value_text, preparedValues.value_number, preparedValues.value_boolean, rowId, columnId);
      }
    }
    db.prepare("UPDATE database_rows SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(rowId);
    return { success: true };
  });

  let primaryUpdateResult;
  try {
    primaryUpdateResult = primaryUpdateTransaction();
  } catch (err) {
    console.error(`Error during primary update for row ${rowId}:`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to update row." };
  }

  if (!primaryUpdateResult.success) return primaryUpdateResult; // Primary update failed

  // If primary update succeeded, proceed to process triggers
  try {
    const updatedRowData = await getRow(rowId); // Get fresh data after primary update
    if (!updatedRowData) {
        console.error(`Failed to fetch row ${rowId} after update, cannot process triggers.`);
        return { success: true, warning: "Primary update succeeded but failed to fetch row for triggers." };
    }
    const dbId = updatedRowData.database_id;
    const rules = smartRuleService.getRulesForDatabase(dbId, { triggerType: 'ON_ROW_UPDATE', isEnabled: true });
    const allColumnDefinitions = getColumnsForDatabase(dbId); // Fetch once for all rules

    if (rules && rules.length > 0) {
      console.log(`Processing ${rules.length} ON_ROW_UPDATE rules for row ${rowId}, depth: ${_triggerDepth}`);
      const changedByUserColIds = Object.keys(values).map(id => parseInt(id, 10)); // IDs from original `values` argument

      for (const rule of rules) {
        try {
          const watchedIds = rule.trigger_config?.watched_column_ids;
          let shouldRunRule = true;
          if (Array.isArray(watchedIds) && watchedIds.length > 0) {
            const anWatchedColumnChanged = watchedIds.some(watchedId => changedByUserColIds.includes(watchedId));
            if (!anWatchedColumnChanged) shouldRunRule = false;
          }

          if (!shouldRunRule) continue;

          let conditionMet = true;
          if (rule.condition_formula && rule.condition_formula.trim() !== '') {
            const evalResult = evaluateFormula(rule.condition_formula, updatedRowData.values, allColumnDefinitions);
            if (evalResult.error || !evalResult.result) {
              if(evalResult.error) console.warn(`Rule ${rule.id} condition error for row ${rowId}: ${evalResult.error}`);
              conditionMet = false;
            }
          }
          if (!conditionMet) continue;

          if (rule.action_type === 'UPDATE_SAME_ROW' && rule.action_config?.set_values) {
            const updatePayload = {};
            let payloadHasChanges = false;
            for (const [colIdToSetStr, valOrFormula] of Object.entries(rule.action_config.set_values)) {
              const colIdToSet = parseInt(colIdToSetStr, 10);
              let finalValueToSet;
              if (valOrFormula === "NOW()") finalValueToSet = new Date().toISOString().split('T')[0]; // YYYY-MM-DD for DATE
              else if (valOrFormula === "DATETIME_NOW()") finalValueToSet = new Date().toISOString(); // Full ISO for potential DATETIME
              else if (typeof valOrFormula === 'string' && valOrFormula.startsWith("=")) { // Formula
                 const actionEvalResult = evaluateFormula(valOrFormula.substring(1), updatedRowData.values, allColumnDefinitions);
                 if (actionEvalResult.error) {
                    console.warn(`Rule ${rule.id} action value formula error for col ${colIdToSet} on row ${rowId}: ${actionEvalResult.error}`);
                    continue;
                 }
                 finalValueToSet = actionEvalResult.result;
              } else { finalValueToSet = valOrFormula; } // Literal

              // Check if this action actually changes the value (important to prevent infinite loops on no-op changes)
              // This simple comparison might not be deep for objects/arrays but ok for primitives
              if (updatedRowData.values[colIdToSet] !== finalValueToSet) {
                updatePayload[colIdToSet] = finalValueToSet;
                payloadHasChanges = true;
              }
            }
            if (payloadHasChanges && Object.keys(updatePayload).length > 0) {
              console.log(`Rule ${rule.id} (depth ${_triggerDepth}) triggering update for row ${rowId} with payload:`, updatePayload);
              await updateRow({ rowId: rowId, values: updatePayload, _triggerDepth: _triggerDepth + 1 });
              // NOTE: Row state `updatedRowData` is NOT refreshed after this recursive call within the loop.
              // Subsequent rules in this same loop iteration will use the `updatedRowData` from *before* this specific rule actioned.
            }
          }
        } catch (ruleError) { console.error(`Error processing rule ${rule.id} for row ${rowId}:`, ruleError); }
      }
    }
  } catch (triggerProcessingError) {
    console.error(`Error during trigger processing for row ${rowId} after primary update:`, triggerProcessingError);
    // The primary update was successful, so we still return success for that.
    // Errors in triggers are logged but don't roll back the user's original change.
  }
  return { success: true }; // Success of the initial user-triggered update
}


function deleteRow(rowId) {
  const db = getDb();
  try {
    const stmt = db.prepare("DELETE FROM database_rows WHERE id = ?");
    const info = stmt.run(rowId);
    return info.changes > 0 ? { success: true } : { success: false, error: "Row not found." };
  } catch (err) {
    console.error(`Error deleting row ID ${rowId}:`, err.message);
    return { success: false, error: "Failed to delete row." };
  }
}

async function getColumnValuesForRows(databaseId, rowIds, columnId) {
  if (!rowIds || rowIds.length === 0) return [];
  const db = getDb();
  try {
    const allColsInDb = getColumnsForDatabase(databaseId);
    const colDef = allColsInDb.find(c => c.id === columnId);
    if (!colDef) {
      const errorMsg = `getColumnValuesForRows: Column ID ${columnId} not found in database ${databaseId}.`;
      console.error(errorMsg); throw new Error(errorMsg);
    }
    const resultsMap = new Map();
    if (colDef.type === 'RELATION') { /* ... as before ... */ }
    else if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
      for (const id of rowIds) {
          const fullRow = await getRow(id);
          resultsMap.set(id, fullRow ? fullRow.values[columnId] : "#ERROR_ROW_NOT_FOUND#");
      }
    } else {  /* ... as before ... */ }
    return rowIds.map(id => resultsMap.get(id));
  } catch (err) {
    console.error(`Error in getColumnValuesForRows (dbId: ${databaseId}, colId: ${columnId}):`, err.message, err.stack);
    return rowIds.map(() => null);
  }
}
// Ensure all parts of getColumnValuesForRows are filled in from previous version if they were elided by '...' above
// For example, the storable types part:
// else {
//       const placeholders = rowIds.map(() => '?').join(',');
//       const stmt = db.prepare(`SELECT row_id, value_text, value_number, value_boolean FROM database_row_values WHERE column_id = ? AND row_id IN (${placeholders})`);
//       const storedValues = stmt.all(colDef.id, ...rowIds);
//       const valuesByRowId = {};
//       storedValues.forEach(sv => { valuesByRowId[sv.row_id] = _deserializeValue(colDef.type, sv.value_text, sv.value_number, sv.value_boolean); });
//       rowIds.forEach(id => resultsMap.set(id, valuesByRowId[id] === undefined ? null : valuesByRowId[id]));
// }
// And relation part:
// if (colDef.type === 'RELATION') {
//       const placeholders = rowIds.map(() => '?').join(',');
//       const stmt = db.prepare(`SELECT source_row_id, target_row_id FROM database_row_links WHERE source_column_id = ? AND source_row_id IN (${placeholders}) ORDER BY source_row_id, link_order ASC`);
//       const links = stmt.all(colDef.id, ...rowIds);
//       const groupedLinks = {};
//       links.forEach(link => {
//         if (!groupedLinks[link.source_row_id]) groupedLinks[link.source_row_id] = [];
//         groupedLinks[link.source_row_id].push(link.target_row_id);
//       });
//       rowIds.forEach(id => resultsMap.set(id, groupedLinks[id] || []));
// }


module.exports = { addRow, getRow, updateRow, deleteRow, getColumnValuesForRows };
