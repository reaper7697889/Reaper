// src/backend/services/databaseRowService.js
const { getDb } = require("../db");
const { getColumnsForDatabase }
    = require("./databaseDefService");
const { evaluateFormula } = require('../utils/FormulaEvaluator');
const { performAggregation } = require('../utils/RollupCalculator');
const smartRuleService = require('./smartRuleService');
const { recordRowHistory } = require('./historyService');
const noteService = require('./noteService');

const MAX_TRIGGER_DEPTH = 5;

function _prepareValueForStorage(columnType, rawValue) {
  const output = { value_text: null, value_number: null, value_boolean: null };
  if (rawValue === null || rawValue === undefined) return output;
  switch (columnType) {
    case 'TEXT': case 'DATE': case 'SELECT': case 'DATETIME':
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
        case 'TEXT': case 'DATE': case 'SELECT': case 'DATETIME': return value_text;
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

async function _getStoredRowData(rowId, dbInstance) {
    const db = dbInstance || getDb();
    const rowData = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(rowId);
    if (!rowData) return null;
    const allColumnDefinitions = getColumnsForDatabase(rowData.database_id);
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
      }
    }
    return storedRowData;
}

function addRow({ databaseId, values, rowOrder = null, recurrence_rule = null }) {
  const db = getDb();
  const columnDefsMap = getColumnsForDatabase(databaseId).reduce((acc, col) => { acc[col.id] = col; return acc; }, {});
  let newRowIdValue;

  const transaction = db.transaction(() => {
    const rowStmt = db.prepare("INSERT INTO database_rows (database_id, row_order, recurrence_rule) VALUES (?, ?, ?)");
    const rowInfo = rowStmt.run(databaseId, rowOrder, recurrence_rule);
    newRowIdValue = rowInfo.lastInsertRowid;
    if (!newRowIdValue) throw new Error("Failed to insert row into database_rows.");

    const valueInsertStmt = db.prepare("INSERT INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean) VALUES (?, ?, ?, ?, ?)");
    const linkInsertStmt = db.prepare("INSERT INTO database_row_links (source_row_id, source_column_id, target_row_id, link_order) VALUES (?, ?, ?, ?)");

    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      const colDef = columnDefsMap[columnId];
      if (!colDef) throw new Error(`Column ID ${columnId} not found in DB ${databaseId}.`);

      if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) continue;
      else if (colDef.type === 'RELATION') {
        if (!Array.isArray(rawValue)) throw new Error(`Value for RELATION column ${colDef.name} must be an array.`);
        for (const targetRowId of rawValue) {
          if (typeof targetRowId !== 'number') throw new Error(`Invalid targetRowId ${targetRowId} for RELATION column ${colDef.name}.`);
          if (colDef.relation_target_entity_type === 'NOTES_TABLE') {
            const targetNote = db.prepare("SELECT id FROM notes WHERE id = ?").get(targetRowId);
            if (!targetNote) throw new Error(`Target note ID ${targetRowId} for RELATION column ${colDef.name} does not exist.`);
          } else {
            const targetRow = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(targetRowId);
            if (!targetRow) throw new Error(`Target row ID ${targetRowId} for RELATION column ${colDef.name} does not exist.`);
            if (targetRow.database_id !== colDef.linked_database_id) throw new Error(`Target row ID ${targetRowId} does not belong to linked DB ${colDef.linked_database_id}.`);
          }
          linkInsertStmt.run(newRowIdValue, columnId, targetRowId, 0);
          if (colDef.inverse_column_id !== null && colDef.relation_target_entity_type === 'NOTE_DATABASES') {
            linkInsertStmt.run(targetRowId, colDef.inverse_column_id, newRowIdValue, 0);
          }
        }
      } else {
        if (rawValue !== undefined) {
            const preparedValues = _prepareValueForStorage(colDef.type, rawValue);
            valueInsertStmt.run(newRowIdValue, columnId, preparedValues.value_text, preparedValues.value_number, preparedValues.value_boolean);
        }
      }
    }
  });

  try {
    transaction();
    if (newRowIdValue) {
      _getStoredRowData(newRowIdValue, db).then(newStoredData => {
        const newRowValuesJson = JSON.stringify(newStoredData);
        recordRowHistory({ rowId: newRowIdValue, oldRowValuesJson: null, newRowValuesJson, db });
      }).catch(histErr => console.error(`Error recording history for new row ${newRowIdValue}:`, histErr.message));
      console.log(`Added row with ID: ${newRowIdValue} to database ${databaseId}`);
      return { success: true, rowId: newRowIdValue };
    }
    return { success: false, error: "Row creation succeeded but failed to get newRowIdValue for history." };
  } catch (err) {
    console.error("Error adding row:", err.message, err.stack);
    return { success: false, error: err.message || "Failed to add row." };
  }
}

async function getRow(rowId) {
  const db = getDb();
  try {
    const rowData = db.prepare("SELECT id, database_id, row_order, recurrence_rule, created_at, updated_at FROM database_rows WHERE id = ?").get(rowId);
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
      } else if (!['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) { // Storable types
        const cell = cellValuesStmt.get(rowId, colDef.id);
        rowDataValues[colDef.id] = cell ? _deserializeValue(colDef.type, cell.value_text, cell.value_number, cell.value_boolean) : null;
      } else {
        rowDataValues[colDef.id] = null; // Initialize computed types
      }
    }

    // Pass 2: Rollup Calculations (Moved before Formulas)
    for (const colDef of allColumnDefinitions) {
        if (colDef.type === 'ROLLUP') {
            try {
                const { rollup_source_relation_column_id: srcRelId, rollup_target_column_id: targetColId, rollup_function: func } = colDef;
                if (!srcRelId || !targetColId || !func) { rowDataValues[colDef.id] = "#CONFIG_ERROR!"; console.warn(`Rollup ${colDef.id} config error.`); continue; }

                const linkedTargetRowIds = rowDataValues[srcRelId];
                if (!Array.isArray(linkedTargetRowIds)) { rowDataValues[colDef.id] = "#RELATION_ERROR!"; console.warn(`Rollup ${colDef.id} source relation error.`); continue; }

                const sourceRelationColDef = allColumnDefinitions.find(c => c.id === srcRelId);
                if (!sourceRelationColDef || (sourceRelationColDef.relation_target_entity_type === 'NOTE_DATABASES' && !sourceRelationColDef.linked_database_id) ) {
                    rowDataValues[colDef.id] = "#CONFIG_ERROR!"; console.warn(`Rollup ${colDef.id} source relation col_def error.`); continue;
                }
                if (sourceRelationColDef.relation_target_entity_type === 'NOTES_TABLE') {
                     rowDataValues[colDef.id] = "#ROLLUP_UNSUPPORTED_SOURCE";
                     console.warn(`Rollup on relation to NOTES_TABLE (col ${srcRelId}) not supported for rollup column ${colDef.id}.`);
                     continue;
                }

                const targetDbId = sourceRelationColDef.linked_database_id;
                const allColsInTargetDb = getColumnsForDatabase(targetDbId);
                const targetColDefInLinkedDb = allColsInTargetDb.find(c => c.id === targetColId);

                if (linkedTargetRowIds.length === 0) {
                    const emptyAgg = performAggregation([], func, targetColDefInLinkedDb || { type: 'UNKNOWN', name: 'unknown_target_col' });
                    rowDataValues[colDef.id] = emptyAgg.result; continue;
                }
                if (!targetColDefInLinkedDb) { rowDataValues[colDef.id] = "#TARGET_COL_ERROR!"; console.warn(`Rollup ${colDef.id} target col ${targetColId} not found in DB ${targetDbId}.`); continue; }

                let actualTargetValues = [];
                if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetColDefInLinkedDb.type)) { // Target is computed
                    for (const targetRowId of linkedTargetRowIds) {
                        const targetRowFullData = await getRow(targetRowId); // Recursive call
                        actualTargetValues.push(targetRowFullData ? targetRowFullData.values[targetColId] : null);
                    }
                } else { // Target is storable or simple relation
                    actualTargetValues = await getColumnValuesForRows(targetDbId, linkedTargetRowIds, targetColId);
                }
                const rollupResult = performAggregation(actualTargetValues, func, targetColDefInLinkedDb);
                rowDataValues[colDef.id] = rollupResult.error ? "#ROLLUP_ERROR!" : rollupResult.result;
                if(rollupResult.error) console.error(`Rollup Error (row ${rowId}, col ${colDef.id}): ${rollupResult.error}`);
            } catch (rollupErr) {
                console.error(`Rollup Processing Error (row ${rowId}, col ${colDef.id}): ${rollupErr.message}`, rollupErr.stack);
                rowDataValues[colDef.id] = "#ROLLUP_EXCEPTION!";
            }
        }
    }

    // Pass 3: Formula Calculations
    for (const colDef of allColumnDefinitions) {
      if (colDef.type === 'FORMULA') {
        if (colDef.formula_definition && colDef.formula_definition.trim() !== "") {
          const evalResult = evaluateFormula(colDef.formula_definition, rowDataValues, allColumnDefinitions);
          rowDataValues[colDef.id] = evalResult.error ? "#ERROR!" : evalResult.result;
          if(evalResult.error) console.error(`Formula Error (row ${rowId}, col ${colDef.id}): ${evalResult.error}`);
        } else {
            // console.warn(`Formula column ${colDef.id} (${colDef.name}) has no definition.`);
            rowDataValues[colDef.id] = null;
        }
      }
    }

    // Pass 4: Lookup Calculations
    for (const colDef of allColumnDefinitions) {
        if (colDef.type === 'LOOKUP') {
            try {
                const { lookup_source_relation_column_id: srcRelId, lookup_target_value_column_id: targetValColId, lookup_multiple_behavior: behavior } = colDef;
                if (!srcRelId || !targetValColId || !behavior) { rowDataValues[colDef.id] = "#CONFIG_ERROR!"; console.warn(`Lookup ${colDef.id} config error.`); continue; }

                const linkedIds = rowDataValues[srcRelId];
                if (!Array.isArray(linkedIds)) { rowDataValues[colDef.id] = "#RELATION_ERROR!"; console.warn(`Lookup ${colDef.id} source relation error, not an array.`); continue; }
                if (linkedIds.length === 0) { rowDataValues[colDef.id] = behavior === 'LIST_UNIQUE_STRINGS' ? "" : null; continue; }

                const sourceRelationColDef = allColumnDefinitions.find(c => c.id === srcRelId);
                if (!sourceRelationColDef) { rowDataValues[colDef.id] = "#CONFIG_ERROR!"; console.warn(`Lookup ${colDef.id} source relation col def not found.`); continue; }

                const rowsToFetchForLookup = behavior === 'FIRST' ? [linkedIds[0]] : linkedIds;
                if (rowsToFetchForLookup.length === 0) { rowDataValues[colDef.id] = behavior === 'LIST_UNIQUE_STRINGS' ? "" : null; continue;}

                let lookedUpValues = [];
                if (sourceRelationColDef.relation_target_entity_type === 'NOTE_DATABASES') {
                    const targetDbId = sourceRelationColDef.linked_database_id;
                    if(!targetDbId) {rowDataValues[colDef.id] = "#CONFIG_ERROR!"; console.warn(`Lookup ${colDef.id} source relation linked_db_id missing.`); continue;}

                    const allColsInTargetDb = getColumnsForDatabase(targetDbId);
                    const targetValueColDefInLinkedDb = allColsInTargetDb.find(c => c.id === targetValColId);
                    if (!targetValueColDefInLinkedDb) { rowDataValues[colDef.id] = "#TARGET_COL_ERROR!";  console.warn(`Lookup ${colDef.id} target val col ${targetValColId} not found in DB ${targetDbId}.`); continue; }

                    if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetValueColDefInLinkedDb.type)) { // Target value is computed
                         for (const targetRowId of rowsToFetchForLookup) {
                            const targetRowFullData = await getRow(targetRowId); // Recursive call
                            lookedUpValues.push(targetRowFullData ? targetRowFullData.values[targetValColId] : null);
                        }
                    } else { // Target value is storable or simple relation
                        lookedUpValues = await getColumnValuesForRows(targetDbId, rowsToFetchForLookup, targetValColId);
                    }
                } else { // NOTES_TABLE
                    const pseudoFieldName = String(targetValColId);
                    const validNoteFields = ['id', 'title', 'content', 'type', 'created_at', 'updated_at', 'folder_id', 'workspace_id', 'is_pinned', 'is_archived'];
                    if (!validNoteFields.includes(pseudoFieldName)) {
                         rowDataValues[colDef.id] = "#TARGET_FIELD_ERROR!"; console.warn(`Invalid pseudo-field name '${pseudoFieldName}' for NOTES_TABLE lookup col ${colDef.id}.`); continue;
                    }
                    for (const noteIdToFetch of rowsToFetchForLookup) {
                        const noteData = await noteService.getNoteById(noteIdToFetch);
                        lookedUpValues.push(noteData && noteData.hasOwnProperty(pseudoFieldName) ? noteData[pseudoFieldName] : null);
                    }
                }
                if (behavior === 'FIRST') rowDataValues[colDef.id] = lookedUpValues.length > 0 ? lookedUpValues[0] : null;
                else rowDataValues[colDef.id] = Array.from(new Set(lookedUpValues.filter(v => v !== null && v !== undefined).map(String))).join(', ');
            } catch (lookupErr) {
                console.error(`Lookup Error (row ${rowId}, col ${colDef.id}): ${lookupErr.message}`, lookupErr.stack);
                rowDataValues[colDef.id] = "#LOOKUP_ERROR!";
            }
        }
    }
    return { ...rowData, values: rowDataValues };
  } catch (err) { console.error(`Error getting row ${rowId}:`, err.message, err.stack); return null; }
}

async function updateRow({ rowId, values, recurrence_rule, _triggerDepth = 0 }) { /* ... unchanged ... */ }
function deleteRow(rowId) { /* ... unchanged ... */ }
async function getColumnValuesForRows(databaseId, rowIds, columnId) { /* ... unchanged ... */ }

module.exports = { addRow, getRow, updateRow, deleteRow, getColumnValuesForRows };
