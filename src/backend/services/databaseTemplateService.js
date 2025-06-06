// src/backend/services/databaseTemplateService.js
const { getDb } = require("../../db"); // Adjusted path for db.js in root
const databaseDefService = require('./databaseDefService');
const permissionService = require('./permissionService'); // For checking permissions on the parent database

// Helper to validate template_values JSON
function _validateTemplateValues(templateValuesJson, databaseId, dbInstance) {
    const db = dbInstance || getDb();
    let parsedValues;
    try {
        parsedValues = JSON.parse(templateValuesJson);
    } catch (e) {
        return "template_values must be a valid JSON object string.";
    }
    if (typeof parsedValues !== 'object' || parsedValues === null || Array.isArray(parsedValues)) {
        return "template_values must be a JSON object.";
    }

    const columnDefs = db.prepare("SELECT id, type FROM database_columns WHERE database_id = ?").all(databaseId);
    const validColumnIds = new Set(columnDefs.map(col => col.id));
    const nonComputableColumnTypes = ['TEXT', 'NUMBER', 'DATE', 'DATETIME', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'RELATION']; // Added RELATION

    for (const columnIdStr of Object.keys(parsedValues)) {
        const columnId = parseInt(columnIdStr, 10);
        if (isNaN(columnId) || !validColumnIds.has(columnId)) {
            return `Invalid columnId "${columnIdStr}" in template_values. It does not exist in database ${databaseId}.`;
        }
        const colDef = columnDefs.find(c => c.id === columnId);
        if (!colDef || !nonComputableColumnTypes.includes(colDef.type)) {
            return `ColumnId "${columnIdStr}" (type: ${colDef ? colDef.type : 'unknown'}) in template_values is for a computed column or invalid type and cannot be templated.`;
        }
        // Further type validation for the value itself could be added here if necessary
    }
    return null; // No error
}

async function createRowTemplate({ databaseId, name, description = null, templateValuesJson, requestingUserId }) {
    const db = getDb();
    if (!databaseId || !name || !templateValuesJson || requestingUserId === null) {
        return { success: false, error: "Database ID, name, templateValuesJson, and requestingUserId are required." };
    }

    const permCheck = await permissionService.checkUserDatabasePermission(databaseId, requestingUserId, 'WRITE');
    if (!permCheck.V) {
        return { success: false, error: "Authorization failed: Insufficient permissions to create a template for this database." };
    }

    const validationError = _validateTemplateValues(templateValuesJson, databaseId, db);
    if (validationError) {
        return { success: false, error: validationError };
    }

    try {
        const stmt = db.prepare(
            `INSERT INTO database_row_templates (database_id, name, description, template_values)
             VALUES (?, ?, ?, ?)`
        );
        const info = stmt.run(databaseId, name.trim(), description, templateValuesJson);
        const newTemplateId = info.lastInsertRowid;
        // Fetch the newly created template to return it completely, including parsed values
        const fetchResult = await getRowTemplateById(newTemplateId, requestingUserId);
        if (!fetchResult.success) {
            console.error(`Template ${newTemplateId} created but failed to fetch immediately: ${fetchResult.error}`);
            return { success: false, error: fetchResult.error || "Template created but could not be fully retrieved." };
        }
        return { success: true, template: fetchResult.template };
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return { success: false, error: "A template with this name already exists for this database." };
        }
        console.error("Error creating row template:", err.message);
        return { success: false, error: "Failed to create row template." };
    }
}

async function getRowTemplateById(templateId, requestingUserId) {
    const db = getDb();
    if (templateId === null || requestingUserId === null) {
        return { success: false, error: "Template ID and requestingUserId are required." };
    }
    try {
        const template = db.prepare("SELECT * FROM database_row_templates WHERE id = ?").get(templateId);
        if (!template) {
            return { success: false, error: "Template not found." };
        }
        const permCheck = await permissionService.checkUserDatabasePermission(template.database_id, requestingUserId, 'READ');
        if (!permCheck.V) {
            return { success: false, error: "Authorization failed: Insufficient permissions to view this template." };
        }
        try {
            template.template_values = JSON.parse(template.template_values);
        } catch (e) {
            console.error(`Error parsing template_values JSON for template ${template.id}:`, e.message);
            return { success: false, error: "Failed to parse template data." };
        }
        return { success: true, template };
    } catch (err) {
        console.error("Error getting row template by ID:", err.message);
        return { success: false, error: "Failed to retrieve row template." };
    }
}

async function getTemplatesForDatabase(databaseId, requestingUserId) {
    const db = getDb();
    if (databaseId === null || requestingUserId === null) {
        return { success: false, error: "Database ID and requestingUserId are required." };
    }
    try {
        const permCheck = await permissionService.checkUserDatabasePermission(databaseId, requestingUserId, 'READ');
        if (!permCheck.V) {
            return { success: false, error: "Authorization failed: Insufficient permissions to view templates for this database." };
        }
        const templates = db.prepare("SELECT * FROM database_row_templates WHERE database_id = ? ORDER BY name ASC").all(databaseId);
        const parsedTemplates = templates.map(t => {
            try {
                return { ...t, template_values: JSON.parse(t.template_values) };
            } catch (e) {
                console.error(`Error parsing template_values for template ${t.id} in getTemplatesForDatabase:`, e.message);
                return { ...t, template_values_parse_error: true, _raw_template_values: t.template_values };
            }
        });
        return { success: true, templates: parsedTemplates };
    } catch (err) {
        console.error("Error getting templates for database:", err.message);
        return { success: false, error: "Failed to retrieve templates for database." };
    }
}

async function updateRowTemplate(templateId, updates, requestingUserId) {
    const db = getDb();
    if (templateId === null || !updates || Object.keys(updates).length === 0 || requestingUserId === null) {
        return { success: false, error: "Template ID, updates object, and requestingUserId are required." };
    }

    const currentTemplateResult = await getRowTemplateById(templateId, requestingUserId);
    if (!currentTemplateResult.success) {
        return currentTemplateResult;
    }
    const currentTemplate = currentTemplateResult.template;

    const permCheckWrite = await permissionService.checkUserDatabasePermission(currentTemplate.database_id, requestingUserId, 'WRITE');
    if (!permCheckWrite.V) {
        return { success: false, error: "Authorization failed: Insufficient permissions to update this template." };
    }

    let newName = updates.name !== undefined ? updates.name.trim() : currentTemplate.name;
    let newDescription = updates.description !== undefined ? updates.description : currentTemplate.description;
    let finalTemplateValuesJson;

    if (updates.templateValuesJson !== undefined) {
        const validationError = _validateTemplateValues(updates.templateValuesJson, currentTemplate.database_id, db);
        if (validationError) {
            return { success: false, error: validationError };
        }
        finalTemplateValuesJson = updates.templateValuesJson;
    } else {
        finalTemplateValuesJson = JSON.stringify(currentTemplate.template_values);
    }

    if (newName === "") return { success: false, error: "Template name cannot be empty." };

    try {
        const stmt = db.prepare(
            `UPDATE database_row_templates
             SET name = ?, description = ?, template_values = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
        );
        stmt.run(newName, newDescription, finalTemplateValuesJson, templateId);
        const updatedTemplateResult = await getRowTemplateById(templateId, requestingUserId);
        if (!updatedTemplateResult.success) {
             return { success: false, error: updatedTemplateResult.error || "Template updated but could not be fully retrieved." };
        }
        return { success: true, template: updatedTemplateResult.template };
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message.includes('database_row_templates.database_id, database_row_templates.name')) {
            return { success: false, error: "A template with this name already exists for this database." };
        }
        console.error("Error updating row template:", err.message);
        return { success: false, error: "Failed to update row template." };
    }
}

async function deleteRowTemplate(templateId, requestingUserId) {
    const db = getDb();
    if (templateId === null || requestingUserId === null) {
        return { success: false, error: "Template ID and requestingUserId are required." };
    }

    const templateData = db.prepare("SELECT database_id FROM database_row_templates WHERE id = ?").get(templateId);
    if (!templateData) {
        return { success: false, error: "Template not found." };
    }

    const permCheck = await permissionService.checkUserDatabasePermission(templateData.database_id, requestingUserId, 'WRITE');
    if (!permCheck.V) {
        return { success: false, error: "Authorization failed: Insufficient permissions to delete this template." };
    }

    try {
        const stmt = db.prepare("DELETE FROM database_row_templates WHERE id = ?");
        const info = stmt.run(templateId);
        return { success: info.changes > 0 };
    } catch (err) {
        console.error("Error deleting row template:", err.message);
        return { success: false, error: "Failed to delete row template." };
    }
}

module.exports = {
    createRowTemplate,
    getRowTemplateById,
    getTemplatesForDatabase,
    updateRowTemplate,
    deleteRowTemplate,
};
