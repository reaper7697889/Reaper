// src/backend/services/databaseQueryService.js
const { getDb } = require("../db");
const { getRow } = require("./databaseRowService"); // To fetch full row data
const { getColumnsForDatabase } = require("./databaseDefService"); // To get column definitions

/**
 * Retrieves rows for a database with filtering and sorting.
 * @param {number} databaseId
 * * @param {object} options - { filters = [], sorts = [] }
 *   - filters: [{ columnId, operator, value }]
 *   - sorts: [{ columnId, direction ('ASC'|'DESC') }] (simplified to one sort criteria)
 * @returns {Promise<Array<object>>} - Array of full row objects, or empty array on error.
 */
async function getRowsForDatabase(databaseId, { filters = [], sorts = [] }) {
  const db = getDb();
  try {
    const columnDefsRaw = getColumnsForDatabase(databaseId); // from databaseDefService
    if (!columnDefsRaw || columnDefsRaw.length === 0) {
        // If no columns, perhaps no rows or an issue, but query for rows might still be valid if columns are optional.
        // For now, let's assume a database meant to be queried should have columns.
        console.warn(`No column definitions found for database ID ${databaseId}. Returning empty rows.`);
        // return []; // Or proceed to query rows if that makes sense.
    }
    const columnDefinitions = columnDefsRaw.reduce((acc, col) => {
      acc[col.id] = col;
      return acc;
    }, {});

    let sql = `SELECT DISTINCT dr.id FROM database_rows dr WHERE dr.database_id = ?`;
    const params = [databaseId];

    function getValueFieldName(columnType) {
        switch (columnType) {
            case 'TEXT': case 'DATE': case 'SELECT': case 'MULTI_SELECT': return 'value_text';
            case 'NUMBER': return 'value_number';
            case 'BOOLEAN': return 'value_boolean';
            default: return null; // Should not happen if colDef.type is validated
        }
    }

    // Apply Filters
    for (const filter of filters) {
      const colDef = columnDefinitions[filter.columnId];
      if (!colDef) {
        console.warn(`Filter references unknown columnId ${filter.columnId}. Skipping filter.`);
        continue;
      }

      const valueField = getValueFieldName(colDef.type);
      if (!valueField) {
        console.warn(`Unsupported column type ${colDef.type} for filtering (value field mapping). Skipping filter.`);
        continue;
      }

      if (filter.operator === 'IS_NULL') {
        sql += ` AND NOT EXISTS (SELECT 1 FROM database_row_values drv_checknull WHERE drv_checknull.row_id = dr.id AND drv_checknull.column_id = ? AND drv_checknull.${valueField} IS NOT NULL)`;
        params.push(filter.columnId);
      } else if (filter.operator === 'IS_NOT_NULL') {
        sql += ` AND EXISTS (SELECT 1 FROM database_row_values drv_checknotnull WHERE drv_checknotnull.row_id = dr.id AND drv_checknotnull.column_id = ? AND drv_checknotnull.${valueField} IS NOT NULL)`;
        params.push(filter.columnId);
      } else {
        // For operators that require a value
        sql += ` AND EXISTS (SELECT 1 FROM database_row_values drv WHERE drv.row_id = dr.id AND drv.column_id = ? `;
        params.push(filter.columnId);

        let valueForParam = filter.value;
        let conditionAdded = false;

        switch (colDef.type) {
          case 'TEXT':
          case 'DATE': // Dates are stored as text
          case 'SELECT':
            switch (filter.operator) {
              case 'EQUALS': sql += `AND drv.value_text = ?`; params.push(valueForParam); conditionAdded = true; break;
              case 'NOT_EQUALS': sql += `AND (drv.value_text IS NULL OR drv.value_text != ?)`; params.push(valueForParam); conditionAdded = true; break;
              case 'CONTAINS': sql += `AND drv.value_text LIKE ?`; params.push(`%${valueForParam}%`); conditionAdded = true; break;
            }
            break;
          case 'NUMBER':
            valueForParam = parseFloat(filter.value);
            if (isNaN(valueForParam)) { console.warn(`Invalid number value for filter: ${filter.value}`); break; } // Skips this filter by not setting conditionAdded = true
            switch (filter.operator) {
              case 'EQUALS': sql += `AND drv.value_number = ?`; params.push(valueForParam); conditionAdded = true; break;
              case 'NOT_EQUALS': sql += `AND (drv.value_number IS NULL OR drv.value_number != ?)`; params.push(valueForParam); conditionAdded = true; break;
              case 'GREATER_THAN': sql += `AND drv.value_number > ?`; params.push(valueForParam); conditionAdded = true; break;
              case 'LESS_THAN': sql += `AND drv.value_number < ?`; params.push(valueForParam); conditionAdded = true; break;
            }
            break;
          case 'BOOLEAN':
            valueForParam = filter.value ? 1 : 0;
            switch (filter.operator) {
              case 'EQUALS': sql += `AND drv.value_boolean = ?`; params.push(valueForParam); conditionAdded = true; break;
            }
            break;
          case 'MULTI_SELECT': // Stored as JSON string array
            switch (filter.operator) {
              case 'CONTAINS': sql += `AND drv.value_text LIKE ?`; params.push(`%"${valueForParam}"%`); conditionAdded = true; break;
            }
            break;
        }

        if (conditionAdded) {
            sql += `)`; // Close the specific condition part of EXISTS
        } else {
            // Operator or type was unsupported for value-based filters, or value was invalid (e.g., NaN for number)
            sql += `AND 1=0)`; // Make the EXISTS clause false to effectively skip this filter
            console.warn(`Unsupported operator "${filter.operator}" for type "${colDef.type}" or invalid value, for columnId ${filter.columnId}. Filter skipped.`);
        }
      }
    }

    // Apply Sorting (Simplified: only ONE sort criteria)
    if (sorts && sorts.length > 0) {
      const sort = sorts[0];
      const sortColDef = columnDefinitions[sort.columnId];
      if (sortColDef) {
        // Add LEFT JOIN for the sorting column's values
        // Alias is important to not conflict with potential filter joins on same table if we were to expand.
        sql += ` LEFT JOIN database_row_values sort_drv ON dr.id = sort_drv.row_id AND sort_drv.column_id = ?`;
        params.push(sort.columnId);

        let sortField = "";
        switch (sortColDef.type) {
          case 'TEXT': case 'DATE': case 'SELECT': case 'MULTI_SELECT': sortField = "sort_drv.value_text"; break;
          case 'NUMBER': sortField = "sort_drv.value_number"; break;
          case 'BOOLEAN': sortField = "sort_drv.value_boolean"; break;
          default: console.warn(`Unsupported column type ${sortColDef.type} for sorting. Sorting may be ineffective.`); break;
        }

        if (sortField) {
            const direction = sort.direction === 'DESC' ? 'DESC' : 'ASC';
            sql += ` ORDER BY ${sortField} ${direction} NULLS LAST`; // NULLS LAST is a good default
        }
      } else {
          console.warn(`Sort references unknown columnId ${sort.columnId}. Skipping sort.`);
      }
    } else {
        // Default sort by row_order if available, then by ID, if no other sort specified
        sql += ` ORDER BY dr.row_order ASC NULLS LAST, dr.id ASC`;
    }


    // Execute Query for Row IDs
    const rowIdResults = db.prepare(sql).all(...params);
    const rowIds = rowIdResults.map(r => r.id);

    // Fetch Full Row Data for each ID
    // Using Promise.all to fetch them concurrently.
    const fullRows = await Promise.all(rowIds.map(id => getRow(id)));

    // Filter out any null results from getRow (e.g., if a row was deleted between queries)
    return fullRows.filter(row => row !== null);

  } catch (err) {
    console.error(`Error querying rows for database ${databaseId}:`, err.message, err.stack);
    return []; // Return empty array on error
  }
}

module.exports = {
  getRowsForDatabase,
};
