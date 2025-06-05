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
    const columnDefsRaw = getColumnsForDatabase(databaseId);
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
            default: return null;
        }
    }

    // Apply Filters
    for (const filter of filters) {
      const colDef = columnDefinitions[filter.columnId];
      if (!colDef) {
        console.warn(`Filter references unknown columnId ${filter.columnId}. Skipping filter.`);
        continue;
      }

      if (colDef.type === 'RELATION') {
        switch (filter.operator) {
          case 'RELATION_CONTAINS_ANY':
            if (!Array.isArray(filter.value) || filter.value.length === 0) {
              console.warn(`RELATION_CONTAINS_ANY requires a non-empty array value. Filter skipped for columnId ${filter.columnId}.`);
              sql += ` AND 1=0`; // No match if value is invalid
              continue;
            }
            const placeholders = filter.value.map(() => '?').join(',');
            sql += ` AND EXISTS (SELECT 1 FROM database_row_links drl WHERE drl.source_row_id = dr.id AND drl.source_column_id = ? AND drl.target_row_id IN (${placeholders}))`;
            params.push(filter.columnId, ...filter.value);
            break;
          case 'RELATION_CONTAINS_ALL':
            if (!Array.isArray(filter.value) || filter.value.length === 0) {
              console.warn(`RELATION_CONTAINS_ALL requires a non-empty array value. Filter skipped for columnId ${filter.columnId}.`);
              sql += ` AND 1=0`; // No match if value is invalid
              continue;
            }
            filter.value.forEach((targetRowId, index) => {
              // Need unique alias for each EXISTS subquery if they were more complex, but simple structure is fine here.
              sql += ` AND EXISTS (SELECT 1 FROM database_row_links drl_${index} WHERE drl_${index}.source_row_id = dr.id AND drl_${index}.source_column_id = ? AND drl_${index}.target_row_id = ?)`;
              params.push(filter.columnId, targetRowId);
            });
            break;
          case 'RELATION_IS_EMPTY':
            sql += ` AND NOT EXISTS (SELECT 1 FROM database_row_links drl WHERE drl.source_row_id = dr.id AND drl.source_column_id = ?)`;
            params.push(filter.columnId);
            break;
          case 'RELATION_IS_NOT_EMPTY':
            sql += ` AND EXISTS (SELECT 1 FROM database_row_links drl WHERE drl.source_row_id = dr.id AND drl.source_column_id = ?)`;
            params.push(filter.columnId);
            break;
          default:
            console.warn(`Unsupported operator "${filter.operator}" for RELATION type columnId ${filter.columnId}. Filter skipped.`);
            sql += ` AND 1=0`; // Effectively skip filter
        }
      } else { // Logic for non-RELATION type columns
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
          sql += ` AND EXISTS (SELECT 1 FROM database_row_values drv WHERE drv.row_id = dr.id AND drv.column_id = ? `;
          params.push(filter.columnId);

          let valueForParam = filter.value;
          let conditionAdded = false;

          switch (colDef.type) {
            case 'TEXT': case 'DATE': case 'SELECT':
              switch (filter.operator) {
              case 'EQUALS': sql += `AND drv.value_text = ?`; params.push(String(valueForParam)); conditionAdded = true; break;
              case 'NOT_EQUALS': sql += `AND (drv.value_text IS NULL OR drv.value_text != ?)`; params.push(String(valueForParam)); conditionAdded = true; break;
              case 'CONTAINS': sql += `AND drv.value_text LIKE ?`; params.push(`%${String(valueForParam)}%`); conditionAdded = true; break;
              case 'LESS_THAN_OR_EQUAL_TO': sql += `AND drv.value_text <= ?`; params.push(String(valueForParam)); conditionAdded = true; break;
              case 'GREATER_THAN_OR_EQUAL_TO': sql += `AND drv.value_text >= ?`; params.push(String(valueForParam)); conditionAdded = true; break;
              }
              break;
            case 'NUMBER':
              valueForParam = parseFloat(filter.value);
            if (isNaN(valueForParam)) { console.warn(`Invalid number value for filter: ${filter.value}`); break; }
              switch (filter.operator) {
                case 'EQUALS': sql += `AND drv.value_number = ?`; params.push(valueForParam); conditionAdded = true; break;
                case 'NOT_EQUALS': sql += `AND (drv.value_number IS NULL OR drv.value_number != ?)`; params.push(valueForParam); conditionAdded = true; break;
                case 'GREATER_THAN': sql += `AND drv.value_number > ?`; params.push(valueForParam); conditionAdded = true; break;
                case 'LESS_THAN': sql += `AND drv.value_number < ?`; params.push(valueForParam); conditionAdded = true; break;
              case 'LESS_THAN_OR_EQUAL_TO': sql += `AND drv.value_number <= ?`; params.push(valueForParam); conditionAdded = true; break;
              case 'GREATER_THAN_OR_EQUAL_TO': sql += `AND drv.value_number >= ?`; params.push(valueForParam); conditionAdded = true; break;
              }
              break;
            case 'BOOLEAN':
              valueForParam = filter.value ? 1 : 0;
              switch (filter.operator) {
                case 'EQUALS': sql += `AND drv.value_boolean = ?`; params.push(valueForParam); conditionAdded = true; break;
              }
              break;
            case 'MULTI_SELECT':
              switch (filter.operator) {
                case 'CONTAINS': sql += `AND drv.value_text LIKE ?`; params.push(`%"${valueForParam}"%`); conditionAdded = true; break;
              }
              break;
          }

          if (conditionAdded) {
            sql += `)`;
          } else {
            sql += `AND 1=0)`;
            console.warn(`Unsupported operator "${filter.operator}" for type "${colDef.type}" or invalid value, for columnId ${filter.columnId}. Filter skipped.`);
          }
        }
      }
    }

    // Apply Sorting
    let sortApplied = false;
    if (sorts && sorts.length > 0) {
      const sort = sorts[0];
      const sortColDef = columnDefinitions[sort.columnId];
      if (sortColDef) {
        if (sortColDef.type === 'RELATION') {
          console.warn(`Sorting by RELATION column type (columnId ${sort.columnId}) is not currently supported. Using default sort.`);
        } else {
          sql += ` LEFT JOIN database_row_values sort_drv ON dr.id = sort_drv.row_id AND sort_drv.column_id = ?`;
          params.push(sort.columnId);
          const sortField = getValueFieldName(sortColDef.type);
          if (sortField) {
            const direction = sort.direction === 'DESC' ? 'DESC' : 'ASC';
            sql += ` ORDER BY ${sortField} ${direction} NULLS LAST`;
            sortApplied = true;
          } else {
            console.warn(`Unsupported column type ${sortColDef.type} for sorting. Using default sort.`);
          }
        }
      } else {
        console.warn(`Sort references unknown columnId ${sort.columnId}. Using default sort.`);
      }
    }

    if (!sortApplied) {
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
