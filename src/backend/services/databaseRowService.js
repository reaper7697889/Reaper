// src/backend/services/databaseRowService.js
const { getDb } = require("../db");
const { getColumnsForDatabase }
    = require("./databaseDefService");
const { evaluateFormula } = require('../utils/FormulaEvaluator');
const { performAggregation } = require('../utils/RollupCalculator');

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

    // Pass 1: Stored and Relation Values
    for (const colDef of allColumnDefinitions) {
      if (colDef.type === 'RELATION') {
        rowDataValues[colDef.id] = linkedRowsStmt.all(rowId, colDef.id).map(lr => lr.target_row_id);
      } else if (!['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
        const cell = cellValuesStmt.get(rowId, colDef.id);
        rowDataValues[colDef.id] = cell ? _deserializeValue(colDef.type, cell.value_text, cell.value_number, cell.value_boolean) : null;
      } else {
        rowDataValues[colDef.id] = null; // Initialize computed types
      }
    }

    // Pass 2: Formula Calculations
    for (const colDef of allColumnDefinitions) {
      if (colDef.type === 'FORMULA') {
        if (colDef.formula_definition && colDef.formula_definition.trim() !== "") {
          const evalResult = evaluateFormula(colDef.formula_definition, rowDataValues, allColumnDefinitions);
          rowDataValues[colDef.id] = evalResult.error ? "#ERROR!" : evalResult.result;
          if(evalResult.error) console.error(`Formula Error (row ${rowId}, col ${colDef.id}): ${evalResult.error}`);
        } else { rowDataValues[colDef.id] = null; }
      }
    }

    // Pass 3: Rollup Calculations
    for (const colDef of allColumnDefinitions) {
        if (colDef.type === 'ROLLUP') {
            const { rollup_source_relation_column_id: srcRelId, rollup_target_column_id: targetColId, rollup_function: func } = colDef;
            if (!srcRelId || !targetColId || !func) {
                rowDataValues[colDef.id] = "#CONFIG_ERROR!"; continue;
            }
            const linkedTargetRowIds = rowDataValues[srcRelId];
            if (!Array.isArray(linkedTargetRowIds)) {
                rowDataValues[colDef.id] = "#RELATION_ERROR!"; continue;
            }
            if (linkedTargetRowIds.length === 0) {
                const emptyAgg = performAggregation([], func, { type: 'UNKNOWN' }); // Default for empty set
                rowDataValues[colDef.id] = emptyAgg.result; continue;
            }
            const sourceRelationColDef = allColumnDefinitions.find(c => c.id === srcRelId);
            if (!sourceRelationColDef || !sourceRelationColDef.linked_database_id) {
                 rowDataValues[colDef.id] = "#CONFIG_ERROR!"; continue;
            }
            const targetDbId = sourceRelationColDef.linked_database_id;
            const allColsInTargetDb = getColumnsForDatabase(targetDbId);
            const targetColDefInLinkedDb = allColsInTargetDb.find(c => c.id === targetColId);
            if (!targetColDefInLinkedDb) {
                rowDataValues[colDef.id] = "#TARGET_COL_ERROR!"; continue;
            }
            let actualTargetValues = [];
            if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetColDefInLinkedDb.type)) { // Target is computed
                for (const targetRowId of linkedTargetRowIds) {
                    const targetRowFullData = await getRow(targetRowId); // Recursive
                    actualTargetValues.push(targetRowFullData ? targetRowFullData.values[targetColId] : null);
                }
            } else {
                actualTargetValues = await getColumnValuesForRows(targetDbId, linkedTargetRowIds, targetColId);
            }
            const rollupResult = performAggregation(actualTargetValues, func, targetColDefInLinkedDb);
            rowDataValues[colDef.id] = rollupResult.error ? "#ROLLUP_ERROR!" : rollupResult.result;
            if(rollupResult.error) console.error(`Rollup Error (row ${rowId}, col ${colDef.id}): ${rollupResult.error}`);
        }
    }

    // Pass 4: Lookup Calculations
    for (const colDef of allColumnDefinitions) {
        if (colDef.type === 'LOOKUP') {
            const { lookup_source_relation_column_id: srcRelId, lookup_target_value_column_id: targetValColId, lookup_multiple_behavior: behavior } = colDef;
            if (!srcRelId || !targetValColId || !behavior) {
                rowDataValues[colDef.id] = "#CONFIG_ERROR!"; continue;
            }
            const linkedTargetRowIds = rowDataValues[srcRelId];
            if (!Array.isArray(linkedTargetRowIds)) {
                rowDataValues[colDef.id] = "#RELATION_ERROR!"; continue;
            }
            if (linkedTargetRowIds.length === 0) {
                rowDataValues[colDef.id] = behavior === 'LIST_UNIQUE_STRINGS' ? "" : null; continue;
            }
            const sourceRelationColDef = allColumnDefinitions.find(c => c.id === srcRelId);
            if (!sourceRelationColDef || !sourceRelationColDef.linked_database_id) {
                 rowDataValues[colDef.id] = "#CONFIG_ERROR!"; continue;
            }
            const targetDbId = sourceRelationColDef.linked_database_id;
            const allColsInTargetDb = getColumnsForDatabase(targetDbId);
            const targetValueColDefInLinkedDb = allColsInTargetDb.find(c => c.id === targetValColId);
             if (!targetValueColDefInLinkedDb) {
                rowDataValues[colDef.id] = "#TARGET_COL_ERROR!"; continue;
            }

            const rowsToFetchForLookup = behavior === 'FIRST' ? [linkedTargetRowIds[0]] : linkedTargetRowIds;
            let lookedUpValues = [];
            if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetValueColDefInLinkedDb.type)) { // Target value is computed
                 for (const targetRowId of rowsToFetchForLookup) {
                    const targetRowFullData = await getRow(targetRowId); // Recursive
                    lookedUpValues.push(targetRowFullData ? targetRowFullData.values[targetValColId] : null);
                }
            } else {
                lookedUpValues = await getColumnValuesForRows(targetDbId, rowsToFetchForLookup, targetValColId);
            }

            if (behavior === 'FIRST') {
                rowDataValues[colDef.id] = lookedUpValues.length > 0 ? lookedUpValues[0] : null;
            } else { // LIST_UNIQUE_STRINGS
                rowDataValues[colDef.id] = Array.from(new Set(lookedUpValues.filter(v => v !== null && v !== undefined).map(String))).join(', ');
            }
        }
    }

    return { ...rowData, values: rowDataValues };
  } catch (err) {
    console.error(`Error getting row ${rowId}:`, err.message, err.stack);
    return null;
  }
}

function updateRow({ rowId, values }) {
  const db = getDb();
  const rowMeta = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(rowId);
  if (!rowMeta) return { success: false, error: `Row with ID ${rowId} not found.` };

  const columnDefsMap = getColumnsForDatabase(rowMeta.database_id).reduce((acc, col) => { acc[col.id] = col; return acc; }, {});

  const transaction = db.transaction(() => {
    // ... (valueReplaceStmt, getLinksStmt, etc. as before) ...
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
            if (isNaN(targetRowId)) throw new Error(`Invalid targetRowId for RELATION column ${colDef.name}.`);
            const targetRow = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(targetRowId);
            if (!targetRow) throw new Error(`Target row ID ${targetRowId} for RELATION column ${colDef.name} does not exist.`);
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

  try { return transaction(); }
  catch (err) { console.error(`Error updating row ${rowId}:`, err.message, err.stack); return { success: false, error: err.message || "Failed to update row." }; }
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
    if (colDef.type === 'RELATION') {
      const placeholders = rowIds.map(() => '?').join(',');
      const stmt = db.prepare(`SELECT source_row_id, target_row_id FROM database_row_links WHERE source_column_id = ? AND source_row_id IN (${placeholders}) ORDER BY source_row_id, link_order ASC`);
      const links = stmt.all(colDef.id, ...rowIds);
      const groupedLinks = {};
      links.forEach(link => {
        if (!groupedLinks[link.source_row_id]) groupedLinks[link.source_row_id] = [];
        groupedLinks[link.source_row_id].push(link.target_row_id);
      });
      rowIds.forEach(id => resultsMap.set(id, groupedLinks[id] || []));
    } else if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
      // For computed types, we need full row context for each row.
      // This can be slow for many rows but ensures correctness.
      for (const id of rowIds) {
          const fullRow = await getRow(id); // `getRow` is now async
          resultsMap.set(id, fullRow ? fullRow.values[columnId] : "#ERROR_ROW_NOT_FOUND#");
      }
    } else {
      const placeholders = rowIds.map(() => '?').join(',');
      const stmt = db.prepare(`SELECT row_id, value_text, value_number, value_boolean FROM database_row_values WHERE column_id = ? AND row_id IN (${placeholders})`);
      const storedValues = stmt.all(colDef.id, ...rowIds);
      const valuesByRowId = {};
      storedValues.forEach(sv => { valuesByRowId[sv.row_id] = _deserializeValue(colDef.type, sv.value_text, sv.value_number, sv.value_boolean); });
      rowIds.forEach(id => resultsMap.set(id, valuesByRowId[id] === undefined ? null : valuesByRowId[id]));
    }
    return rowIds.map(id => resultsMap.get(id));
  } catch (err) {
    console.error(`Error in getColumnValuesForRows (dbId: ${databaseId}, colId: ${columnId}):`, err.message, err.stack);
    return rowIds.map(() => null);
  }
}

module.exports = { addRow, getRow, updateRow, deleteRow, getColumnValuesForRows };
