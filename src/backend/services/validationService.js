// src/backend/services/validationService.js

// No direct db import here, it should be passed in for rules that need it (e.g., 'unique')

/**
 * Determines the correct value column name in `database_row_values` based on column type.
 * @param {string} columnType - The type of the column.
 * @returns {string|null} The field name ('value_text', 'value_number', 'value_boolean') or null if not applicable.
 */
function _getValueFieldName(columnType) {
    switch (columnType) {
        case 'TEXT':
        case 'DATE': // Dates are stored as text
        case 'DATETIME': // DateTimes are stored as text
        case 'SELECT': // Select stored as text
            return 'value_text';
        case 'NUMBER':
            return 'value_number';
        case 'BOOLEAN':
            return 'value_boolean';
        case 'MULTI_SELECT': // Stored as JSON string in value_text
            return 'value_text';
        // FORMULA, RELATION, ROLLUP, LOOKUP are not directly validated for uniqueness this way
        default:
            return null;
    }
}

/**
 * Validates a field value against a set of rules.
 * @param {*} fieldValue - The value of the field to validate.
 * @param {Array<object>} rules - Array of rule objects (e.g., { "type": "not_empty", "message": "..." }).
 * @param {object} columnDef - The column definition object (id, type, name, etc.).
 * @param {object|null} allRowData - (Optional) Complete data of the row, used for context like current rowId.
 * @param {object|null} db - (Optional) Database instance, required for 'unique' validation.
 * @returns {Array<string>} An array of error messages. Empty if no errors.
 */
function validateFieldValue(fieldValue, rules, columnDef, allRowData = null, db = null) {
    const errors = [];
    if (!rules || !Array.isArray(rules)) {
        return errors; // No rules to apply
    }

    for (const rule of rules) {
        if (!rule || !rule.type) {
            console.warn("Skipping invalid rule object:", rule);
            continue;
        }

        const message = rule.message || `Validation failed for rule: ${rule.type}`;

        switch (rule.type) {
            case 'not_empty':
                let isEmpty = false;
                if (fieldValue === null || fieldValue === undefined) {
                    isEmpty = true;
                } else if (typeof fieldValue === 'string' && fieldValue.trim() === "") {
                    isEmpty = true;
                } else if (Array.isArray(fieldValue) && fieldValue.length === 0) { // For MULTI_SELECT
                    isEmpty = true;
                }
                if (isEmpty) {
                    errors.push(message || "Field cannot be empty.");
                }
                break;

            case 'is_email':
                if (fieldValue && typeof fieldValue === 'string') {
                    // Basic regex, consider a more robust library for production
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!emailRegex.test(fieldValue)) {
                        errors.push(message || "Invalid email format.");
                    }
                } else if (fieldValue) { // Not a string but has a value
                    errors.push(message || "Email must be a string.");
                }
                break;

            case 'min_length':
                if (typeof fieldValue === 'string' && typeof rule.value === 'number') {
                    if (fieldValue.length < rule.value) {
                        errors.push(message || `Must be at least ${rule.value} characters.`);
                    }
                } else if (typeof fieldValue !== 'string') {
                     // errors.push("min_length can only be applied to strings."); // Or ignore if not string
                }
                break;

            case 'max_length':
                if (typeof fieldValue === 'string' && typeof rule.value === 'number') {
                    if (fieldValue.length > rule.value) {
                        errors.push(message || `Must be at most ${rule.value} characters.`);
                    }
                } else if (typeof fieldValue !== 'string') {
                    // errors.push("max_length can only be applied to strings.");
                }
                break;

            case 'min_value':
                if (typeof rule.value === 'number') {
                    if (columnDef.type === 'NUMBER' && typeof fieldValue === 'number') {
                        if (fieldValue < rule.value) {
                            errors.push(message || `Value must be at least ${rule.value}.`);
                        }
                    } else if ((columnDef.type === 'DATE' || columnDef.type === 'DATETIME') && fieldValue) {
                        try {
                            const dateValue = new Date(fieldValue);
                            const ruleDateValue = new Date(rule.value); // Assuming rule.value is also a date string or timestamp
                            if (dateValue < ruleDateValue) {
                                errors.push(message || `Date must be on or after ${new Date(rule.value).toLocaleDateString()}.`);
                            }
                        } catch (e) { errors.push("Invalid date format for min_value comparison."); }
                    }
                }
                break;

            case 'max_value':
                 if (typeof rule.value === 'number') {
                    if (columnDef.type === 'NUMBER' && typeof fieldValue === 'number') {
                        if (fieldValue > rule.value) {
                            errors.push(message || `Value must be at most ${rule.value}.`);
                        }
                    } else if ((columnDef.type === 'DATE' || columnDef.type === 'DATETIME') && fieldValue) {
                         try {
                            const dateValue = new Date(fieldValue);
                            const ruleDateValue = new Date(rule.value);
                            if (dateValue > ruleDateValue) {
                                errors.push(message || `Date must be on or before ${new Date(rule.value).toLocaleDateString()}.`);
                            }
                        } catch (e) { errors.push("Invalid date format for max_value comparison."); }
                    }
                }
                break;

            case 'regex':
                if (fieldValue && typeof fieldValue === 'string' && rule.value) {
                    try {
                        const regex = new RegExp(rule.value);
                        if (!regex.test(fieldValue)) {
                            errors.push(message || "Value does not match the required pattern.");
                        }
                    } catch (e) {
                        console.error("Invalid regex in validation rule:", rule.value, e);
                        errors.push("Invalid validation pattern configured.");
                    }
                }
                break;

            case 'unique':
                if (!db) {
                    console.warn("Database instance not provided for 'unique' validation rule. Skipping.");
                    break;
                }
                const valueFieldName = _getValueFieldName(columnDef.type);
                if (!valueFieldName) {
                    console.warn(`'unique' validation not applicable for column type: ${columnDef.type}. Skipping.`);
                    break;
                }
                // For MULTI_SELECT, a simple unique check on the JSON string might be too naive
                // if order or spacing can vary but still represent the "same set".
                // For now, it will compare the exact JSON string if type is MULTI_SELECT.

                // fieldValue might need to be stringified for MULTI_SELECT if it's an array at this point
                let valueToCompare = fieldValue;
                if (columnDef.type === 'MULTI_SELECT' && Array.isArray(fieldValue)) {
                    valueToCompare = JSON.stringify(fieldValue.sort()); // Sort for consistent string representation
                } else if (columnDef.type === 'BOOLEAN') {
                    valueToCompare = fieldValue ? 1 : 0;
                }


                if (valueToCompare === null || valueToCompare === undefined) break; // Unique check doesn't apply to empty values usually

                try {
                    let query = `SELECT id FROM database_row_values WHERE column_id = ? AND ${valueFieldName} = ?`;
                    const params = [columnDef.id, valueToCompare];

                    if (allRowData && allRowData.id !== undefined) { // If updating an existing row
                        query += " AND row_id != ?";
                        params.push(allRowData.id);
                    }

                    const stmt = db.prepare(query);
                    const existingRow = stmt.get(...params);

                    if (existingRow) {
                        errors.push(message || `Value for '${columnDef.name}' must be unique.`);
                    }
                } catch (dbError) {
                    console.error("Database error during 'unique' validation:", dbError);
                    errors.push("Could not perform uniqueness validation due to a server error.");
                }
                break;

            default:
                console.warn(`Unknown validation rule type: ${rule.type}`);
                break;
        }
    }
    return errors;
}

module.exports = {
    validateFieldValue,
};
