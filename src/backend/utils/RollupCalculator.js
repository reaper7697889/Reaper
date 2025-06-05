// src/backend/utils/RollupCalculator.js

/**
 * Calculates a rollup value based on an array of target values and a rollup function.
 * @param {Array<any>} targetValues - Array of actual, JS-typed values from the target column of linked rows.
 * @param {string} rollupFunction - The aggregation function name (e.g., 'SUM', 'COUNT_ALL').
 * @param {object} targetColumnDef - The definition of the target column being aggregated.
 *                                   Expected to have at least `type` and potentially `formula_result_type`.
 * @returns {{result: any, error: string | null}}
 */
function performAggregation(targetValues, rollupFunction, targetColumnDef) {
  if (!targetColumnDef) {
    return { result: null, error: "Target column definition is required for aggregation." };
  }

  const validValues = targetValues.filter(v => v !== null && v !== undefined && v !== ''); // Also filter out empty strings for some calcs
  const numericValues = validValues.map(Number).filter(n => !isNaN(n));
  // For boolean, explicitly check for true/false, not just truthy/falsy after filtering null/undefined
  const booleanValues = targetValues.filter(v => typeof v === 'boolean');

  const targetType = targetColumnDef.type === 'FORMULA' ? targetColumnDef.formula_result_type : targetColumnDef.type;

  try {
    switch (rollupFunction) {
      case 'COUNT_ALL': // Counts all linked rows, regardless of target value
        return { result: targetValues.length, error: null };
      case 'COUNT_VALUES': // Counts rows with non-empty (not null/undefined/'') target values
        return { result: validValues.length, error: null };
      case 'COUNT_UNIQUE_VALUES':
        // Stringify objects/arrays to count them correctly in a Set
        return { result: new Set(validValues.map(v => (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v)).size, error: null };

      case 'SUM':
        if (targetType !== 'NUMBER') return { result: null, error: `SUM requires target column ('${targetColumnDef.name}') to be NUMBER. Is ${targetType}.` };
        return { result: numericValues.reduce((sum, val) => sum + val, 0), error: null };
      case 'AVG':
        if (targetType !== 'NUMBER') return { result: null, error: `AVG requires target column ('${targetColumnDef.name}') to be NUMBER. Is ${targetType}.` };
        return { result: numericValues.length > 0 ? numericValues.reduce((sum, val) => sum + val, 0) / numericValues.length : null, error: null };

      case 'MIN':
        if (validValues.length === 0) return { result: null, error: null };
        if (targetType === 'NUMBER') return { result: numericValues.length > 0 ? Math.min(...numericValues) : null, error: null };
        if (targetType === 'DATE') return { result: validValues.sort()[0], error: null };
        return { result: null, error: `MIN requires target column ('${targetColumnDef.name}') to be NUMBER or DATE. Is ${targetType}.`};
      case 'MAX':
        if (validValues.length === 0) return { result: null, error: null };
        if (targetType === 'NUMBER') return { result: numericValues.length > 0 ? Math.max(...numericValues) : null, error: null };
        if (targetType === 'DATE') return { result: validValues.sort().pop(), error: null };
        return { result: null, error: `MAX requires target column ('${targetColumnDef.name}') to be NUMBER or DATE. Is ${targetType}.`};

      case 'SHOW_UNIQUE': // Returns a string of unique values
        return { result: Array.from(new Set(validValues.map(v => String(v)))).join(', '), error: null };

      case 'PERCENT_EMPTY':
        // Percentage of rows where target value is null/undefined (original targetValues)
        const emptyCount = targetValues.filter(v => v === null || v === undefined).length;
        return { result: targetValues.length > 0 ? (emptyCount / targetValues.length) * 100 : 0, error: null };
      case 'PERCENT_NOT_EMPTY':
        // Percentage of rows where target value is not null/undefined (original targetValues)
        const nonEmptyCount = targetValues.filter(v => v !== null && v !== undefined).length;
        return { result: targetValues.length > 0 ? (nonEmptyCount / targetValues.length) * 100 : 0, error: null };

      case 'COUNT_CHECKED':
        if (targetType !== 'BOOLEAN') return { result: null, error: `COUNT_CHECKED requires target column ('${targetColumnDef.name}') to be BOOLEAN. Is ${targetType}.` };
        return { result: booleanValues.filter(v => v === true).length, error: null };
      case 'COUNT_UNCHECKED':
        if (targetType !== 'BOOLEAN') return { result: null, error: `COUNT_UNCHECKED requires target column ('${targetColumnDef.name}') to be BOOLEAN. Is ${targetType}.` };
        return { result: booleanValues.filter(v => v === false).length, error: null };

      case 'PERCENT_CHECKED':
        if (targetType !== 'BOOLEAN') return { result: null, error: `PERCENT_CHECKED requires target column ('${targetColumnDef.name}') to be BOOLEAN. Is ${targetType}.` };
        return { result: booleanValues.length > 0 ? (booleanValues.filter(v => v === true).length / booleanValues.length) * 100 : 0, error: null };
      case 'PERCENT_UNCHECKED':
        if (targetType !== 'BOOLEAN') return { result: null, error: `PERCENT_UNCHECKED requires target column ('${targetColumnDef.name}') to be BOOLEAN. Is ${targetType}.` };
        return { result: booleanValues.length > 0 ? (booleanValues.filter(v => v === false).length / booleanValues.length) * 100 : 0, error: null };

      default:
        return { result: null, error: `Unsupported rollup function: ${rollupFunction}` };
    }
  } catch (e) {
    console.error(`Error during rollup aggregation '${rollupFunction}' for target column '${targetColumnDef.name}':`, e);
    return { result: null, error: "Rollup calculation error." };
  }
}

/**
 * Main function to calculate a rollup. (Simplified for this subtask)
 * In full integration, this would orchestrate fetching linked row IDs, then their target values.
 */
async function calculateRollupValue(
    linkedRowTargetValues, // Actual values from the target column of linked rows
    rollupFunctionToApply, // e.g. 'SUM'
    targetColumnDefinitionForRollup // Definition of the column being aggregated
) {
    // This simplified version directly calls performAggregation.
    // The more complex data fetching part is handled by databaseRowService.getRow when it encounters a ROLLUP column.
    return performAggregation(linkedRowTargetValues, rollupFunctionToApply, targetColumnDefinitionForRollup);
}

module.exports = { calculateRollupValue, performAggregation };
