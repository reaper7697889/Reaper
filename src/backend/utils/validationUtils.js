// src/backend/utils/validationUtils.js

/**
 * Validates a field value against a set of rules defined for its column.
 * @param {any} value - The value to validate.
 * @param {string} columnType - The type of the column (e.g., 'TEXT', 'NUMBER', 'DATE').
 * @param {string|null} validationRulesJsonString - JSON string array of rule objects.
 * @returns {Array<string>} - An array of error messages. Empty if no errors.
 */
function validateFieldValue(value, columnType, validationRulesJsonString) {
  if (!validationRulesJsonString) {
    return []; // No rules to validate against
  }

  let rules;
  try {
    rules = JSON.parse(validationRulesJsonString);
  } catch (e) {
    console.error("Invalid JSON for validation_rules:", validationRulesJsonString, e);
    return [{ default_error: "Invalid validation rule configuration (JSON parsing failed)." }];
  }

  if (!Array.isArray(rules)) {
    console.error("validation_rules is not an array:", rules);
    return [{ default_error: "Validation rule configuration must be an array." }];
  }

  const errors = [];

  for (const rule of rules) {
    if (!rule || typeof rule.type !== 'string' || typeof rule.error_message !== 'string') {
      errors.push({ default_error: "Malformed rule object: missing type or error_message."});
      continue; // Skip malformed rule
    }

    // If value is null, undefined, or an empty string, only 'NOT_EMPTY' rule applies.
    // Other rules are typically for non-empty values.
    const isEffectivelyEmpty = (value === null || value === undefined || String(value).trim() === "");
    const isMultiSelectEmpty = (columnType === 'MULTI_SELECT' && (!Array.isArray(value) || value.length === 0));


    if (rule.type !== 'NOT_EMPTY' && isEffectivelyEmpty && !isMultiSelectEmpty) {
      // For most rules, if the value is empty, it's considered valid by that specific rule (e.g. MIN_LENGTH doesn't apply to empty)
      // NOT_EMPTY rule will handle the empty case specifically.
      // Exception: if MULTI_SELECT is empty, it's handled by NOT_EMPTY, other rules might still apply if it's not empty.
      continue;
    }

    try {
        switch (rule.type) {
          case 'NOT_EMPTY':
            if (columnType === 'MULTI_SELECT') {
              if (!Array.isArray(value) || value.length === 0) {
                errors.push(rule.error_message);
              }
            } else if (columnType === 'NUMBER' || columnType === 'BOOLEAN') {
              if (value === null || value === undefined) {
                errors.push(rule.error_message);
              }
            } else { // TEXT, DATE, DATETIME, SELECT
              if (value === null || value === undefined || String(value).trim() === "") {
                errors.push(rule.error_message);
              }
            }
            break;

          case 'REGEX':
            if (columnType === 'TEXT') {
              if (typeof rule.regex !== 'string') {
                errors.push({ default_error: `REGEX rule missing 'regex' string parameter for column type ${columnType}.` });
                continue;
              }
              try {
                const re = new RegExp(rule.regex, rule.flags || '');
                if (!re.test(String(value))) {
                  errors.push(rule.error_message);
                }
              } catch (e) {
                errors.push({ default_error: `Invalid regex in rule: ${e.message}`});
              }
            }
            break;

          case 'MIN_LENGTH':
            if (columnType === 'TEXT') {
              if (typeof rule.length !== 'number') {
                errors.push({ default_error: `MIN_LENGTH rule missing 'length' number parameter for column type ${columnType}.` });
                continue;
              }
              if (String(value).length < rule.length) {
                errors.push(rule.error_message);
              }
            }
            break;

          case 'MAX_LENGTH':
            if (columnType === 'TEXT') {
              if (typeof rule.length !== 'number') {
                errors.push({ default_error: `MAX_LENGTH rule missing 'length' number parameter for column type ${columnType}.` });
                continue;
              }
              if (String(value).length > rule.length) {
                errors.push(rule.error_message);
              }
            }
            break;

          case 'MIN_VALUE':
            if (columnType === 'NUMBER') {
              if (typeof rule.value !== 'number') {
                errors.push({ default_error: `MIN_VALUE rule missing 'value' number parameter for column type ${columnType}.` });
                continue;
              }
              const numValue = Number(value);
              if (isNaN(numValue)) { // Value itself is not a number, so it can't be compared.
                // This might be redundant if type conversion happens before validation.
                errors.push({ default_error: `Value '${value}' is not a valid number for MIN_VALUE check.` });
                continue;
              }
              if (numValue < rule.value) {
                errors.push(rule.error_message);
              }
            }
            break;

          case 'MAX_VALUE':
            if (columnType === 'NUMBER') {
              if (typeof rule.value !== 'number') {
                errors.push({ default_error: `MAX_VALUE rule missing 'value' number parameter for column type ${columnType}.` });
                continue;
              }
              const numValue = Number(value);
              if (isNaN(numValue)) {
                errors.push({ default_error: `Value '${value}' is not a valid number for MAX_VALUE check.` });
                continue;
              }
              if (numValue > rule.value) {
                errors.push(rule.error_message);
              }
            }
            break;

          // Future rule types can be added here:
          // case 'IS_EMAIL':
          // case 'IS_URL':
          // case 'DATE_BEFORE': // rule.date_column_id or rule.fixed_date
          // case 'DATE_AFTER':  // rule.date_column_id or rule.fixed_date

          default:
            // console.warn(`Unsupported validation rule type: ${rule.type}`);
            break;
        }
    } catch (e) {
        console.error(`Error applying rule type ${rule.type}:`, e);
        errors.push({ default_error: `Error applying rule ${rule.type}.`});
    }
  }

  return errors;
}

module.exports = {
  validateFieldValue,
};
