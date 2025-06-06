// src/backend/services/databaseRowService.js
const { getDb } = require("../db");
const databaseDefService = require("./databaseDefService"); // For getDatabaseById and getColumnsForDatabase
const { evaluateFormula } = require('../utils/FormulaEvaluator');
const { performAggregation } = require('../utils/RollupCalculator');
const smartRuleService = require('./smartRuleService');
const { recordRowHistory } = require('./historyService');
const noteService = require('./noteService');
const { validateFieldValue } = require('../utils/validationUtils'); // Added import

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

async function _getStoredRowData(rowId, dbInstance, options = { includeDeleted: false }) { // Added options
    const db = dbInstance || getDb();
    let rowQuery = "SELECT database_id, deleted_at FROM database_rows WHERE id = ?"; // Select deleted_at
    const queryParams = [rowId]; // Renamed params to queryParams to avoid conflict with options
    if (options && !options.includeDeleted) {
        rowQuery += " AND deleted_at IS NULL";
    }
    const rowData = db.prepare(rowQuery).get(...queryParams); // Use queryParams
    if (!rowData) return null;
    // Ensure all column definitions are fetched for internal consistency, not user-filtered ones.
    const allColumnDefinitions = await databaseDefService.getColumnsForDatabase(rowData.database_id, null);
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

// Internal helper for ownership check
async function _getAccessibleDatabaseOrFail(databaseId, requestingUserId, dbInstance, operationNameForError) {
  const db = dbInstance || getDb();
  // Use the imported databaseDefService.getDatabaseById
  const parentDb = await databaseDefService.getDatabaseById(databaseId, requestingUserId);
  if (!parentDb) {
    throw new Error(`Authorization failed for ${operationNameForError}: Database ID ${databaseId} not found or not accessible by user.`);
  }
  return parentDb;
}

async function addRow({ databaseId, values, rowOrder = null, recurrence_rule = null, requestingUserId = null }) {
  const db = getDb();
  await _getAccessibleDatabaseOrFail(databaseId, requestingUserId, db, "addRow");

  // Fetch column definitions using the potentially user-filtered getColumnsForDatabase
  // However, for internal consistency of adding a row, we might need all columns.
  // The _getAccessibleDatabaseOrFail already confirmed user can access the DB container.
  const columnDefsArray = await databaseDefService.getColumnsForDatabase(databaseId, null); // Get all columns for internal logic
  if (!columnDefsArray) throw new Error(`Could not retrieve column definitions for database ${databaseId}`);
  const columnDefsMap = columnDefsArray.reduce((acc, col) => { acc[col.id] = col; return acc; }, {});

  let newRowIdValue;

  // Perform validation before starting transaction for database writes
  const allValidationErrors = {};
  for (const [columnIdStr, rawValue] of Object.entries(values)) {
    const columnId = parseInt(columnIdStr, 10);
    const colDef = columnDefsMap[columnId];
    if (colDef && colDef.validation_rules && !['RELATION', 'FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
      const errors = validateFieldValue(rawValue, colDef.type, colDef.validation_rules);
      if (errors.length > 0) {
        allValidationErrors[colDef.name || columnIdStr] = errors;
      }
    }
  }

  if (Object.keys(allValidationErrors).length > 0) {
    return { success: false, error: "Validation failed.", validation_errors: allValidationErrors };
  }

  // IMPORTANT: database_rows table itself does not have a user_id column.
  // Ownership is derived from the parent note_databases table.
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
      // Use db instance from current scope for _getStoredRowData if it expects one.
      _getStoredRowData(newRowIdValue, db).then(newStoredData => {
        const newRowValuesJson = JSON.stringify(newStoredData);
        recordRowHistory({ rowId: newRowIdValue, oldRowValuesJson: null, newRowValuesJson, db });
      }).catch(histErr => console.error(`Error recording history for new row ${newRowIdValue} (user ${requestingUserId}):`, histErr.message));
      console.log(`Added row with ID: ${newRowIdValue} to database ${databaseId} (user ${requestingUserId})`);
      return { success: true, rowId: newRowIdValue };
    }
    // This path should ideally not be reached if rowInfo.lastInsertRowid was falsy, as an error would have been thrown.
    return { success: false, error: "Row creation failed or newRowIdValue was not obtained." };
  } catch (err) {
    console.error(`Error adding row to DB ${databaseId} (user ${requestingUserId}):`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to add row." };
  }
}

async function getRow(rowId, requestingUserId = null, options = { includeDeleted: false }) {
  const db = getDb();
  try {
    let query = "SELECT id, database_id, row_order, recurrence_rule, created_at, updated_at, deleted_at, deleted_by_user_id FROM database_rows WHERE id = ?";
    const queryParams = [rowId];
    if (!options.includeDeleted) {
      query += " AND deleted_at IS NULL";
    }
    const rowMetaData = db.prepare(query).get(...queryParams);
    if (!rowMetaData) return null;

    // Ownership check on parent database
    await _getAccessibleDatabaseOrFail(rowMetaData.database_id, requestingUserId, db, "getRow");

    // Fetch columns using the potentially user-filtered getColumnsForDatabase,
    // or use an unfiltered version if needed for internal consistency.
    // For getRow, using user-filtered columns seems fine as it's a read operation.
    const allColumnDefinitions = await databaseDefService.getColumnsForDatabase(rowMetaData.database_id, requestingUserId);
    if (!allColumnDefinitions) { // Should not happen if _getAccessibleDatabaseOrFail passed
        console.warn(`getRow: Columns for DB ${rowMetaData.database_id} not found after successful DB access check for user ${requestingUserId}.`);
        return { ...rowMetaData, values: {} }; // Or null
    }
    if (allColumnDefinitions.length === 0) return { ...rowMetaData, values: {} };

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
                // Fetch target columns considering user access if recursive calls need it.
                // For now, assume getColumnsForDatabase within getColumnValuesForRows handles this.
                const allColsInTargetDb = await databaseDefService.getColumnsForDatabase(targetDbId, requestingUserId);
                const targetColDefInLinkedDb = allColsInTargetDb.find(c => c.id === targetColId);

                if (linkedTargetRowIds.length === 0) {
                    const emptyAgg = performAggregation([], func, targetColDefInLinkedDb || { type: 'UNKNOWN', name: 'unknown_target_col' });
                    rowDataValues[colDef.id] = emptyAgg.result; continue;
                }
                if (!targetColDefInLinkedDb) { rowDataValues[colDef.id] = "#TARGET_COL_ERROR!"; console.warn(`Rollup ${colDef.id} target col ${targetColId} not found in DB ${targetDbId} for user ${requestingUserId}.`); continue; }

                let actualTargetValues = [];
                if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetColDefInLinkedDb.type)) { // Target is computed
                    for (const targetRowId of linkedTargetRowIds) {
                        // Pass requestingUserId for recursive calls
                        const targetRowFullData = await getRow(targetRowId, requestingUserId);
                        actualTargetValues.push(targetRowFullData ? targetRowFullData.values[targetColId] : null);
                    }
                } else { // Target is storable or simple relation
                    actualTargetValues = await getColumnValuesForRows(targetDbId, linkedTargetRowIds, targetColId, requestingUserId);
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
                    if(!targetDbId) {rowDataValues[colDef.id] = "#CONFIG_ERROR!"; console.warn(`Lookup ${colDef.id} (user ${requestingUserId}) source relation linked_db_id missing.`); continue;}

                    const allColsInTargetDb = await databaseDefService.getColumnsForDatabase(targetDbId, requestingUserId);
                    const targetValueColDefInLinkedDb = allColsInTargetDb.find(c => c.id === targetValColId);
                    if (!targetValueColDefInLinkedDb) { rowDataValues[colDef.id] = "#TARGET_COL_ERROR!";  console.warn(`Lookup ${colDef.id} (user ${requestingUserId}) target val col ${targetValColId} not found in DB ${targetDbId}.`); continue; }

                    if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetValueColDefInLinkedDb.type)) { // Target value is computed
                         for (const targetRowId of rowsToFetchForLookup) {
                            const targetRowFullData = await getRow(targetRowId, requestingUserId); // Recursive call with user context
                            lookedUpValues.push(targetRowFullData ? targetRowFullData.values[targetValColId] : null);
                        }
                    } else { // Target value is storable or simple relation
                        lookedUpValues = await getColumnValuesForRows(targetDbId, rowsToFetchForLookup, targetValColId, requestingUserId);
                    }
                } else { // NOTES_TABLE
                    const pseudoFieldName = String(targetValColId);
                    // Use the imported noteService.getNoteById which now supports requestingUserId
                    // For notes, the requestingUserId applies to the note itself.
                    const validNoteFields = ['id', 'title', 'content', 'type', 'created_at', 'updated_at', 'folder_id', 'workspace_id', 'is_pinned', 'is_archived', 'user_id'];
                    if (!validNoteFields.includes(pseudoFieldName)) {
                         rowDataValues[colDef.id] = "#TARGET_FIELD_ERROR!"; console.warn(`Invalid pseudo-field name '${pseudoFieldName}' for NOTES_TABLE lookup col ${colDef.id} (user ${requestingUserId}).`); continue;
                    }
                    for (const noteIdToFetch of rowsToFetchForLookup) {
                        const noteData = await noteService.getNoteById(noteIdToFetch, requestingUserId);
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
  } catch (err) { console.error(`Error getting row ${rowId} (user ${requestingUserId}):`, err.message, err.stack); return null; }
}

async function updateRow({ rowId, values, recurrence_rule, _triggerDepth = 0, requestingUserId = null }) {
  const db = getDb();
  if (_triggerDepth > MAX_TRIGGER_DEPTH) {
    console.error(`Max trigger depth (${MAX_TRIGGER_DEPTH}) exceeded for row ${rowId}. Aborting update.`);
    return { success: false, error: "Max trigger depth exceeded." };
  }

  const transaction = db.transaction(async () => {
    const currentRowMeta = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(rowId);
    if (!currentRowMeta) throw new Error("Row not found.");

    await _getAccessibleDatabaseOrFail(currentRowMeta.database_id, requestingUserId, db, "updateRow");

    // Pass includeDeleted option to _getStoredRowData if current row is soft-deleted but we are fetching it (e.g. for history)
    const oldStoredValues = await _getStoredRowData(rowId, db, { includeDeleted: true }); // History needs full "before" state
    if (oldStoredValues === null && !currentRowMeta.deleted_at) {
      // If not soft-deleted, old values should exist. If it IS soft-deleted, oldStoredValues might be null if it was deleted before any values.
      // This condition might need refinement based on how history for "creation of a now-deleted row" is handled.
      // For now, if it's not a soft-deleted row we are processing, then not finding old values is an issue.
      throw new Error("Could not retrieve current stored values for history for an existing row.");
    }


    const columnDefsMap = (await databaseDefService.getColumnsForDatabase(currentRowMeta.database_id, null)) // Use null to get all columns for processing
        .reduce((acc, col) => { acc[col.id] = col; return acc; }, {});

    // Perform validation on incoming values before applying changes
    const allValidationErrors = {};
    for (const [columnIdStr, rawValue] of Object.entries(values)) {
        const columnId = parseInt(columnIdStr, 10);
        const colDef = columnDefsMap[columnId];
        if (colDef && colDef.validation_rules && !['RELATION', 'FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
            const errors = validateFieldValue(rawValue, colDef.type, colDef.validation_rules);
            if (errors.length > 0) {
                allValidationErrors[colDef.name || columnIdStr] = errors;
            }
        }
    }

    if (Object.keys(allValidationErrors).length > 0) {
        // Throw an error to be caught by the outer try-catch, which will handle transaction rollback.
        const validationError = new Error("Validation failed.");
        validationError.validation_errors = allValidationErrors;
        throw validationError;
    }

    const valueUpdateStmt = db.prepare("REPLACE INTO database_row_values (row_id, column_id, value_text, value_number, value_boolean) VALUES (?, ?, ?, ?, ?)");
    const linkDeleteStmt = db.prepare("DELETE FROM database_row_links WHERE source_row_id = ? AND source_column_id = ?");
    const linkInsertStmt = db.prepare("INSERT INTO database_row_links (source_row_id, source_column_id, target_row_id, link_order) VALUES (?, ?, ?, ?)");

    let changedNonComputed = false;
    for (const [columnIdStr, rawValue] of Object.entries(values)) {
      const columnId = parseInt(columnIdStr, 10);
      const colDef = columnDefsMap[columnId];
      if (!colDef) throw new Error(`Column ID ${columnId} not found in DB ${currentRowMeta.database_id}.`);
      if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) continue;

      if (colDef.type === 'RELATION') {
        linkDeleteStmt.run(rowId, columnId);
        if (colDef.inverse_column_id !== null && colDef.relation_target_entity_type === 'NOTE_DATABASES') {
            const oldLinkedTargetIds = oldStoredValues[columnId] || [];
            for(const oldTargetId of oldLinkedTargetIds){
                db.prepare("DELETE FROM database_row_links WHERE source_row_id = ? AND source_column_id = ? AND target_row_id = ?")
                  .run(oldTargetId, colDef.inverse_column_id, rowId);
            }
        }
        if (Array.isArray(rawValue)) {
          rawValue.forEach((targetRowId, index) => {
            if (typeof targetRowId !== 'number') throw new Error(`Invalid targetRowId ${targetRowId} for RELATION column ${colDef.name}.`);

            // --- BEGIN VALIDATION (copied and adapted from addRow) ---
            if (colDef.relation_target_entity_type === 'NOTES_TABLE') {
              const targetNote = db.prepare("SELECT id FROM notes WHERE id = ?").get(targetRowId);
              if (!targetNote) throw new Error(`Target note ID ${targetRowId} for RELATION column ${colDef.name} does not exist.`);
            } else { // NOTE_DATABASES
              const targetRow = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(targetRowId);
              if (!targetRow) throw new Error(`Target row ID ${targetRowId} for RELATION column ${colDef.name} does not exist.`);
              if (targetRow.database_id !== colDef.linked_database_id) throw new Error(`Target row ID ${targetRowId} does not belong to linked DB ${colDef.linked_database_id}.`);
            }
            // --- END VALIDATION ---

            linkInsertStmt.run(rowId, columnId, targetRowId, index);
            if (colDef.inverse_column_id !== null && colDef.relation_target_entity_type === 'NOTE_DATABASES') {
               linkInsertStmt.run(targetRowId, colDef.inverse_column_id, rowId, 0); // Order might need adjustment for inverse
            }
          });
        }
        changedNonComputed = true;
      } else {
        if (rawValue !== undefined) { // Allow clearing a value by passing null
            const preparedValues = _prepareValueForStorage(colDef.type, rawValue);
            valueUpdateStmt.run(rowId, columnId, preparedValues.value_text, preparedValues.value_number, preparedValues.value_boolean);
            changedNonComputed = true;
        }
      }
    }

    if (recurrence_rule !== undefined) { // Could be null to clear it
        db.prepare("UPDATE database_rows SET recurrence_rule = ? WHERE id = ?").run(recurrence_rule, rowId);
        changedNonComputed = true;
    }

    if (changedNonComputed) {
        db.prepare("UPDATE database_rows SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(rowId);
    }

    // History Recording (only if _triggerDepth is 0, for user-initiated changes)
    if (_triggerDepth === 0) {
        const newStoredValues = await _getStoredRowData(rowId, db);
        const oldRowValuesJson = JSON.stringify(oldStoredValues);
        const newRowValuesJson = JSON.stringify(newStoredValues);
        if (oldRowValuesJson !== newRowValuesJson) { // Only record if actual stored values changed
             await recordRowHistory({rowId, oldRowValuesJson, newRowValuesJson, db});
        }
    }

    // Run Smart Rules (only if _triggerDepth is 0 for user-initiated changes)
    // Pass includeDeleted:true if we need to get the state of a soft-deleted row after updates (e.g. undeleting)
    if (_triggerDepth === 0) {
        const newStoredValuesForRules = await _getStoredRowData(rowId, db, { includeDeleted: true });
        await smartRuleService.runSmartRulesForRowChange(rowId, currentRowMeta.database_id, oldStoredValues || {}, newStoredValuesForRules, db, _triggerDepth + 1, requestingUserId);
    }
    return { success: true };
  });

  try {
    return await transaction(); // Ensure async operations within transaction are awaited
  } catch (err) {
    console.error(`Error updating row ${rowId} (user ${requestingUserId}):`, err.message, err.stack);
    // If the error came from our validation logic, propagate the validation_errors object
    if (err.validation_errors) {
        return { success: false, error: err.message, validation_errors: err.validation_errors };
    }
    return { success: false, error: err.message || "Failed to update row." };
  }
}

async function deleteRow(rowId, requestingUserId = null) {
  const db = getDb();
  const transaction = db.transaction(async () => { // Changed to async to allow await inside
    const rowMeta = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(rowId);
    if (!rowMeta) {
      throw new Error("Row not found."); // Throw error to rollback transaction
    }
    // Perform accessibility check using the awaited version. Allow fetching a (soft) deleted row for the purpose of modifying it (e.g. undelete via history).
    const parentDb = await _getAccessibleDatabaseOrFail(rowMeta.database_id, requestingUserId, db, "deleteRow");

    // Soft delete: Update deleted_at and deleted_by_user_id
    const stmt = db.prepare(
      "UPDATE database_rows SET deleted_at = CURRENT_TIMESTAMP, deleted_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    const info = stmt.run(requestingUserId, rowId);

    if (info.changes > 0) {
      console.log(`Soft deleted row ${rowId} by user ${requestingUserId}.`);
      // For soft delete, links in database_row_links are NOT removed.
      // History recording for soft delete:
      // Fetch the state *before* soft delete (which is the current state)
      // The 'after' state is this row with deleted_at set.
      // This might require _getStoredRowData to fetch a row even if it's about to be marked deleted.
      // The current recordRowHistory in historyService.js would need to be called appropriately.
      // For now, just performing the soft delete. History of soft delete is a further refinement.
      return { success: true, changes: info.changes };
    }
    // If no changes, it means the row was not found (e.g. already hard-deleted, or ID is wrong)
    // or it was already soft-deleted and this operation effectively did nothing new.
    // Check if it was already soft-deleted by this user to avoid error.
    if (rowMeta.deleted_at && rowMeta.deleted_by_user_id === requestingUserId) {
        return { success: true, changes: 0, message: "Row was already soft-deleted by this user." };
    }
    throw new Error("Row not found for soft delete or no changes made.");
  });

  try {
    return await transaction(); // Execute the transaction
  } catch (err) {
    console.error(`Error deleting row ${rowId} (user ${requestingUserId}):`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to delete row." };
  }
}

async function getColumnValuesForRows(databaseId, rowIds, columnId, requestingUserId = null) {
  const db = getDb();
  if (!rowIds || rowIds.length === 0) return [];

  await _getAccessibleDatabaseOrFail(databaseId, requestingUserId, db, "getColumnValuesForRows");

  const columnDefsMap = (await databaseDefService.getColumnsForDatabase(databaseId, requestingUserId))
      .reduce((acc, col) => { acc[col.id] = col; return acc; }, {});
  const targetColDef = columnDefsMap[columnId];

  if (!targetColDef) throw new Error(`Column ID ${columnId} not found in database ${databaseId}.`);
  if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetColDef.type)) {
    // For computed columns, we need to fetch each row individually.
    // Pass includeDeleted from options to getRow.
    const values = [];
    for (const rowId of rowIds) {
      const fullRow = await getRow(rowId, requestingUserId, options);
      values.push(fullRow ? fullRow.values[columnId] : null);
    }
    return values;
  } else if (targetColDef.type === 'RELATION') {
    const placeholder = rowIds.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT source_row_id, target_row_id FROM database_row_links WHERE source_column_id = ? AND source_row_id IN (${placeholder}) ORDER BY source_row_id, link_order ASC`);
    const links = stmt.all(columnId, ...rowIds);
    const resultsMap = new Map(rowIds.map(id => [id, []]));
    links.forEach(link => resultsMap.get(link.source_row_id).push(link.target_row_id));
    return rowIds.map(id => resultsMap.get(id));
  } else {
    const placeholder = rowIds.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT row_id, value_text, value_number, value_boolean FROM database_row_values WHERE column_id = ? AND row_id IN (${placeholder})`);
    const rows = stmt.all(columnId, ...rowIds);
    const valuesMap = new Map(rows.map(r => [r.row_id, _deserializeValue(targetColDef.type, r.value_text, r.value_number, r.value_boolean)]));
    return rowIds.map(id => valuesMap.get(id) ?? null);
  }
}

module.exports = { addRow, getRow, updateRow, deleteRow, getColumnValuesForRows };
