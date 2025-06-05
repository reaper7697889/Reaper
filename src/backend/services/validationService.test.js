const { validateFieldValue } = require('./validationService');
const Database = require('better-sqlite3');

let db;

describe('Validation Service - validateFieldValue', () => {
    beforeAll(() => {
        db = new Database(':memory:');
        // Minimal schema for 'unique' checks
        db.exec(`
            CREATE TABLE IF NOT EXISTS database_columns (
                id INTEGER PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT
            );
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS database_row_values (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                row_id INTEGER NOT NULL,
                column_id INTEGER NOT NULL,
                value_text TEXT,
                value_number REAL,
                value_boolean INTEGER,
                FOREIGN KEY (column_id) REFERENCES database_columns(id)
            );
        `);
    });

    beforeEach(() => {
        db.prepare("DELETE FROM database_row_values").run();
        db.prepare("DELETE FROM database_columns").run(); // Clear columns to redefine for each test type if needed
    });

    afterAll(() => {
        if (db) db.close();
    });

    // --- Test Cases ---

    describe('not_empty', () => {
        const rule = { type: 'not_empty', message: 'Cannot be empty.' };
        const colDef = { type: 'TEXT', name: 'TestNotEmpty' };

        it('should error for null', () => {
            expect(validateFieldValue(null, [rule], colDef)).toEqual([rule.message]);
        });
        it('should error for undefined', () => {
            expect(validateFieldValue(undefined, [rule], colDef)).toEqual([rule.message]);
        });
        it('should error for empty string', () => {
            expect(validateFieldValue("", [rule], colDef)).toEqual([rule.message]);
        });
        it('should error for whitespace string', () => {
            expect(validateFieldValue("   ", [rule], colDef)).toEqual([rule.message]);
        });
        it('should not error for valid string', () => {
            expect(validateFieldValue("value", [rule], colDef)).toEqual([]);
        });
        it('should error for empty array (e.g., MULTI_SELECT)', () => {
            const multiSelectColDef = { ...colDef, type: 'MULTI_SELECT' };
            expect(validateFieldValue([], [rule], multiSelectColDef)).toEqual([rule.message]);
        });
        it('should not error for non-empty array', () => {
             const multiSelectColDef = { ...colDef, type: 'MULTI_SELECT' };
            expect(validateFieldValue(["item"], [rule], multiSelectColDef)).toEqual([]);
        });
    });

    describe('is_email', () => {
        const rule = { type: 'is_email', message: 'Invalid email.' };
        const colDef = { type: 'TEXT', name: 'TestEmail' };

        it('should pass for valid email', () => {
            expect(validateFieldValue('test@example.com', [rule], colDef)).toEqual([]);
        });
        it('should error for invalid email (no @)', () => {
            expect(validateFieldValue('testexample.com', [rule], colDef)).toEqual([rule.message]);
        });
        it('should error for invalid email (no domain)', () => {
            expect(validateFieldValue('test@', [rule], colDef)).toEqual([rule.message]);
        });
        it('should error for invalid email (no user part)', () => {
            expect(validateFieldValue('@example.com', [rule], colDef)).toEqual([rule.message]);
        });
        it('should ignore for empty string (use not_empty for that)', () => {
            expect(validateFieldValue('', [rule], colDef)).toEqual([]);
        });
         it('should error if not a string but has value', () => {
            expect(validateFieldValue(123, [rule], colDef)).toEqual([rule.message]);
        });
    });

    describe('min_length / max_length', () => {
        const colDef = { type: 'TEXT', name: 'TestLength' };
        const minRule = { type: 'min_length', value: 3, message: 'Too short.' };
        const maxRule = { type: 'max_length', value: 5, message: 'Too long.' };

        it('min_length: should error if too short', () => {
            expect(validateFieldValue('ab', [minRule], colDef)).toEqual([minRule.message]);
        });
        it('min_length: should pass if exact min', () => {
            expect(validateFieldValue('abc', [minRule], colDef)).toEqual([]);
        });
        it('min_length: should pass if longer', () => {
            expect(validateFieldValue('abcd', [minRule], colDef)).toEqual([]);
        });
        it('max_length: should error if too long', () => {
            expect(validateFieldValue('abcdef', [maxRule], colDef)).toEqual([maxRule.message]);
        });
        it('max_length: should pass if exact max', () => {
            expect(validateFieldValue('abcde', [maxRule], colDef)).toEqual([]);
        });
        it('max_length: should pass if shorter', () => {
            expect(validateFieldValue('abcd', [maxRule], colDef)).toEqual([]);
        });
        it('should ignore non-string values', () => {
            expect(validateFieldValue(12345, [minRule, maxRule], colDef)).toEqual([]);
        });
    });

    describe('min_value / max_value (Numbers)', () => {
        const colDef = { type: 'NUMBER', name: 'TestNumValue' };
        const minRule = { type: 'min_value', value: 10, message: 'Too small.' };
        const maxRule = { type: 'max_value', value: 20, message: 'Too large.' };

        it('min_value: should error if too small', () => {
            expect(validateFieldValue(5, [minRule], colDef)).toEqual([minRule.message]);
        });
        it('min_value: should pass if exact min', () => {
            expect(validateFieldValue(10, [minRule], colDef)).toEqual([]);
        });
        it('max_value: should error if too large', () => {
            expect(validateFieldValue(25, [maxRule], colDef)).toEqual([maxRule.message]);
        });
        it('max_value: should pass if exact max', () => {
            expect(validateFieldValue(20, [maxRule], colDef)).toEqual([]);
        });
    });

    describe('min_value / max_value (Dates)', () => {
        const colDefDate = { type: 'DATE', name: 'TestDateValue' };
        const colDefDateTime = { type: 'DATETIME', name: 'TestDateTimeValue' };
        const minDateRule = { type: 'min_value', value: '2023-01-10', message: 'Date too early.' };
        const maxDateRule = { type: 'max_value', value: '2023-01-20', message: 'Date too late.' };

        it('min_value (DATE): should error if too early', () => {
            expect(validateFieldValue('2023-01-05', [minDateRule], colDefDate)).toEqual([minDateRule.message]);
        });
        it('min_value (DATE): should pass if exact min', () => {
            expect(validateFieldValue('2023-01-10', [minDateRule], colDefDate)).toEqual([]);
        });
        it('max_value (DATETIME): should error if too late', () => {
            expect(validateFieldValue('2023-01-25T10:00:00Z', [maxDateRule], colDefDateTime)).toEqual([maxDateRule.message]);
        });
        it('max_value (DATETIME): should pass if exact max (ignoring time for date-only rule value)', () => {
            // Note: rule.value is date-only. Comparison behavior might need refinement if time is critical.
            expect(validateFieldValue('2023-01-20T23:59:59Z', [maxDateRule], colDefDateTime)).toEqual([]);
        });
    });

    describe('regex', () => {
        const colDef = { type: 'TEXT', name: 'TestRegex' };
        const rule = { type: 'regex', value: '^[A-Z]+$', message: 'Must be uppercase letters.' };

        it('should pass for matching pattern', () => {
            expect(validateFieldValue('ABC', [rule], colDef)).toEqual([]);
        });
        it('should error for non-matching pattern', () => {
            expect(validateFieldValue('abc', [rule], colDef)).toEqual([rule.message]);
        });
        it('should error for partially matching pattern', () => {
            expect(validateFieldValue('A1B', [rule], colDef)).toEqual([rule.message]);
        });
        it('should handle invalid regex pattern in rule gracefully', () => {
            const invalidRegexRule = { ...rule, value: '[' }; // Invalid regex
            expect(validateFieldValue('ABC', [invalidRegexRule], colDef)).toEqual(["Invalid validation pattern configured."]);
        });
    });

    describe('unique', () => {
        const textColDef = { id: 1, type: 'TEXT', name: 'UniqueTextCol' };
        const numColDef = { id: 2, type: 'NUMBER', name: 'UniqueNumCol' };

        beforeEach(() => {
            db.prepare("INSERT INTO database_columns (id, type, name) VALUES (?, ?, ?), (?, ?, ?)")
              .run(textColDef.id, textColDef.type, textColDef.name, numColDef.id, numColDef.type, numColDef.name);

            // Seed initial data
            db.prepare("INSERT INTO database_row_values (row_id, column_id, value_text) VALUES (1, ?, ?)")
              .run(textColDef.id, 'existing_text');
            db.prepare("INSERT INTO database_row_values (row_id, column_id, value_number) VALUES (2, ?, ?)")
              .run(numColDef.id, 123);
        });

        const rule = { type: 'unique', message: 'Value must be unique.' };

        it('add: should pass for new unique text value', () => {
            expect(validateFieldValue('new_text', [rule], textColDef, null, db)).toEqual([]);
        });
        it('add: should error for existing text value', () => {
            expect(validateFieldValue('existing_text', [rule], textColDef, null, db)).toEqual([rule.message]);
        });
        it('add: should pass for new unique number value', () => {
            expect(validateFieldValue(456, [rule], numColDef, null, db)).toEqual([]);
        });
        it('add: should error for existing number value', () => {
            expect(validateFieldValue(123, [rule], numColDef, null, db)).toEqual([rule.message]);
        });

        it('update: should pass if value is unchanged for current row', () => {
            expect(validateFieldValue('existing_text', [rule], textColDef, { id: 1 }, db)).toEqual([]);
        });
        it('update: should error if value exists in another row', () => {
            // Insert another row with 'another_text'
            db.prepare("INSERT INTO database_row_values (row_id, column_id, value_text) VALUES (3, ?, ?)")
              .run(textColDef.id, 'another_text');
            // Try to update row 1 to 'another_text'
            expect(validateFieldValue('another_text', [rule], textColDef, { id: 1 }, db)).toEqual([rule.message]);
        });
        it('update: should pass if changing to a new unique value', () => {
            expect(validateFieldValue('super_new_text', [rule], textColDef, { id: 1 }, db)).toEqual([]);
        });

        it('should skip unique check if db not provided', () => {
            expect(validateFieldValue('any_text', [rule], textColDef, null, null)).toEqual([]);
            // Consider adding a console.warn spy here if logging is implemented for this case
        });
    });

    describe('Multiple Rules', () => {
        const colDef = { type: 'TEXT', name: 'TestMultiRule' };
        const rules = [
            { type: 'not_empty', message: 'Cannot be empty.' },
            { type: 'min_length', value: 5, message: 'Too short (min 5).' }
        ];
        it('should return all relevant error messages', () => {
            expect(validateFieldValue('abc', rules, colDef)).toEqual([rules[1].message]); // Fails min_length
            expect(validateFieldValue('', rules, colDef)).toEqual([rules[0].message, rules[1].message]); // Fails both
        });
    });

    describe('Unknown Rule Type', () => {
        it('should ignore unknown rule types', () => {
            const rules = [{ type: 'non_existent_rule', message: 'Should not appear.' }];
            const colDef = { type: 'TEXT', name: 'TestUnknown' };
            expect(validateFieldValue('value', rules, colDef)).toEqual([]);
            // Check console.warn if implemented, but for now, just check no errors
        });
    });
});
