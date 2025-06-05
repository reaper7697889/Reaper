// src/backend/services/dataTemplateService.js
const { getDb } = require("../db");
const databaseDefService = require("./databaseDefService");
const permissionService = require('./permissionService');

const SYSTEM_USER_ID = 0; // Or import from a shared constants file if available

/**
 * Safely parses a JSON string, expected to be template_values.
 * @param {string} jsonString - The JSON string to parse.
 * @returns {object|null} The parsed object, or an empty object if parsing fails or input is null/empty.
 */
function _parseTemplateValues(jsonString) {
    if (!jsonString) {
        return {}; // Or null, depending on desired representation for empty/no values
    }
    try {
        const parsed = JSON.parse(jsonString);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (e) {
        console.error("Failed to parse template_values JSON:", e.message, jsonString);
        return { _error: "parse_failed", original: jsonString }; // Indicate error
    }
}

/**
 * Validates that keys in templateValues correspond to actual column IDs in the target database.
 * @param {object} templateValues - The template values object (keys are expected to be column IDs).
 * @param {number} targetDatabaseId - The ID of the target database.
 * @param {object} db - Database instance.
 * @returns {Promise<{isValid: boolean, error?: string}>}
 */
async function _validateTemplateValuesKeys(templateValues, targetDatabaseId, requestingUserId = null) {
    if (typeof templateValues !== 'object' || templateValues === null) {
        return { isValid: false, error: "template_values must be an object." };
    }
    if (Object.keys(templateValues).length === 0) {
        return { isValid: true }; // Empty template is valid
    }

    // We need to fetch columns with a user context that allows seeing all columns,
    // or assume system/owner context for this internal validation.
    // Passing null for requestingUserId to getColumnsForDatabase fetches all columns irrespective of user.
    const columns = await databaseDefService.getColumnsForDatabase(targetDatabaseId, null);
    if (!columns || columns.length === 0) {
        // This case should ideally be caught by target_database_id validation first.
        return { isValid: false, error: `No columns found for database ID ${targetDatabaseId}. Cannot validate template values.` };
    }

    const validColumnIds = new Set(columns.map(col => String(col.id))); // Store IDs as strings for comparison

    for (const key in templateValues) {
        if (!validColumnIds.has(String(key))) {
            return { isValid: false, error: `Invalid column ID '${key}' found in template_values.` };
        }
        // Deeper type checking for fieldValue against columnDef.type can be added here as a refinement.
    }
    return { isValid: true };
}

// Helper to get DB owner ID (simplified, assumes db schema)
async function _getDbOwnerId(databaseId, dbInstance) {
    const db = dbInstance || getDb(); // Use provided db or global one
    try {
        const dbOwnerInfo = db.prepare("SELECT user_id FROM note_databases WHERE id = ?").get(databaseId);
        return dbOwnerInfo ? dbOwnerInfo.user_id : null; // Returns user_id or null if not found/public
    } catch (error) {
        console.error(`Error fetching owner for database ID ${databaseId}:`, error.message);
        return undefined; // Indicate error or inability to determine owner
    }
}


/**
 * Creates a new data template.
 * @param {object} args - { name, description, target_database_id, template_values, requestingUserId }
 * @returns {Promise<object>} Result object with success status and template data or error.
 */
async function createTemplate({ name, description = null, target_database_id, template_values, requestingUserId }) { // Renamed userId to requestingUserId
    if (!name || typeof name !== 'string' || name.trim() === "") {
        return { success: false, error: "Template name is required." };
    }
    if (target_database_id === null || target_database_id === undefined) {
        return { success: false, error: "target_database_id is required." };
    }
    if (typeof template_values !== 'object' || template_values === null) {
        return { success: false, error: "template_values must be an object." };
    }

    const db = getDb();

    // Permission Check: User must own or have 'write'/'admin' permission on the target database
    if (requestingUserId !== SYSTEM_USER_ID) {
        const dbOwnerId = await _getDbOwnerId(target_database_id, db);
        const isDbOwner = dbOwnerId === requestingUserId;
        let canWriteDb = false;
        if (dbOwnerId === null) { // Public DB, check for explicit write
             canWriteDb = await permissionService.checkPermission(requestingUserId, 'database', target_database_id, 'write');
        } else if (!isDbOwner) { // Not public, not owner, check explicit write
            canWriteDb = await permissionService.checkPermission(requestingUserId, 'database', target_database_id, 'write');
        }

        if (!isDbOwner && !canWriteDb) {
            return { success: false, error: "Permission denied: Cannot create template for this database. Requires ownership or 'write' permission on the database." };
        }
    }

    // Validate target_database_id existence (already implicitly checked by permission if not owner and DB is not public)
    const targetDb = await databaseDefService.getDatabaseById(target_database_id, requestingUserId);
    if (!targetDb) {
        return { success: false, error: `Target database ID ${target_database_id} not found or not accessible by the requesting user.` };
    }

    // Validate template_values keys (passing requestingUserId for consistency, though _validateTemplateValuesKeys uses null for now)
    const valueKeysValidation = await _validateTemplateValuesKeys(template_values, target_database_id, requestingUserId);
    if (!valueKeysValidation.isValid) {
        return { success: false, error: valueKeysValidation.error };
    }

    let stringifiedValues;
    try {
        stringifiedValues = JSON.stringify(template_values);
    } catch (e) {
        return { success: false, error: "Failed to stringify template_values: " + e.message };
    }

    const sql = `
        INSERT INTO data_templates (name, description, target_database_id, template_values, user_id)
        VALUES (?, ?, ?, ?, ?)
    `;
    try {
        const info = db.prepare(sql).run(name.trim(), description, target_database_id, stringifiedValues, requestingUserId); // Template owned by creator
        const newTemplateId = info.lastInsertRowid;

        if (newTemplateId && requestingUserId !== SYSTEM_USER_ID) { // Grant admin on the template to its creator, unless system is creator
            await permissionService.grantPermission(requestingUserId, requestingUserId, 'data_template', newTemplateId, 'admin');
            // Note: 'data_template' needs to be added to ALLOWED_OBJECT_TYPES in permissionService for this to work.
            // If it's not, this grant will fail silently or throw depending on permissionService's strictness.
            // For now, assuming 'data_template' will be added or this grant is best-effort.
            console.log(`Granted admin permission to creator ${requestingUserId} for data_template ${newTemplateId}`);
        }

        const newTemplate = await getTemplateById(newTemplateId, requestingUserId);
        return { success: true, template: newTemplate };
    } catch (err) {
        console.error("Error creating data template:", err.message);
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return { success: false, error: "A template with this name already exists for the target database." };
        }
        return { success: false, error: "Failed to create data template." };
    }
}

/**
 * Retrieves a single data template by its ID.
 * @param {number} templateId - The ID of the template.
 * @param {number|null} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object|null>} The template object or null if not found or not permitted.
 */
async function getTemplateById(templateId, requestingUserId = null) { // Added requestingUserId
    const db = getDb();
    const sql = "SELECT * FROM data_templates WHERE id = ?";
    try {
        const template = db.prepare(sql).get(templateId);
        if (!template) return null;

        if (requestingUserId !== null && requestingUserId !== SYSTEM_USER_ID) {
            const isTemplateOwner = template.user_id === requestingUserId;
            const isTemplatePublic = template.user_id === null;

            let canReadParentDb = false;
            const dbOwnerId = await _getDbOwnerId(template.target_database_id, db);
            const isDbOwner = dbOwnerId === requestingUserId;

            if (dbOwnerId === null) { // Public DB
                canReadParentDb = true; // Anyone can "read" a public DB for this purpose
            } else if (isDbOwner) {
                canReadParentDb = true;
            } else {
                canReadParentDb = await permissionService.checkPermission(requestingUserId, 'database', template.target_database_id, 'read');
            }

            // Allow if:
            // 1. User owns the template.
            // 2. Template is public AND user can read the parent database.
            // 3. User has general read access to the parent database (which might imply seeing all its templates by some policies - current logic handles this via canReadParentDb).
            if (!isTemplateOwner && !(isTemplatePublic && canReadParentDb) && !canReadParentDb) {
                 console.warn(`Access denied for user ${requestingUserId} on template ${templateId}. Lacks direct ownership, or template is not public with parent DB read access, or lacks parent DB read access.`);
                 return null;
            }
        }

        template.template_values = _parseTemplateValues(template.template_values);
        return template;
    } catch (err) {
        console.error(`Error getting template by ID ${templateId} for user ${requestingUserId}:`, err.message);
        return null;
    }
}

/**
 * Retrieves all data templates for a given database.
 * @param {number} databaseId - The ID of the target database.
 * @param {number|null} requestingUserId - The ID of the user making the request.
 * @returns {Promise<Array<object>>} An array of template objects.
 */
async function getTemplatesForDatabase(databaseId, requestingUserId = null) { // Added requestingUserId
    const db = getDb();

    if (requestingUserId !== SYSTEM_USER_ID && requestingUserId !== null) {
        const dbOwnerId = await _getDbOwnerId(databaseId, db);
        const isDbOwner = dbOwnerId === requestingUserId;
        let canReadDb = false;
        if (dbOwnerId === null || isDbOwner) { // Public DB or owner
            canReadDb = true;
        } else {
            canReadDb = await permissionService.checkPermission(requestingUserId, 'database', databaseId, 'read');
        }
        if (!canReadDb) {
            console.warn(`User ${requestingUserId} denied access to templates for DB ${databaseId} due to lack of DB read permission.`);
            return [];
        }
    }

    const sql = "SELECT * FROM data_templates WHERE target_database_id = ? ORDER BY name ASC";
    try {
        const templates = db.prepare(sql).all(databaseId);
        // If user can read the DB, they can see all templates associated with it.
        // Further filtering (e.g., only public templates + user's own templates if not DB owner/admin) could be added here if needed.
        // For now, DB read access grants visibility to all its templates.
        return templates.map(t => ({
            ...t,
            template_values: _parseTemplateValues(t.template_values)
        }));
    } catch (err) {
        console.error(`Error getting templates for database ${databaseId} (user ${requestingUserId}):`, err.message);
        return [];
    }
}

/**
 * Updates an existing data template.
 * @param {number} templateId - The ID of the template to update.
 * @param {object} updates - Object containing fields to update (name, description, template_values, target_database_id).
 * @param {number} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object>} Result object with success status and updated template data or error.
 */
async function updateTemplate(templateId, updates, requestingUserId) {
    const { name, description, template_values, target_database_id } = updates;
    if (Object.keys(updates).length === 0 && !updates.hasOwnProperty('description') && !updates.hasOwnProperty('template_values') ) { // description/template_values can be set to null
        return { success: true, template: await getTemplateById(templateId, requestingUserId), message: "No updates provided." };
    }

    const db = getDb();
    const existingTemplateRawData = db.prepare("SELECT * FROM data_templates WHERE id = ?").get(templateId);
    if (!existingTemplateRawData) {
        return { success: false, error: "Template not found." };
    }

    if (requestingUserId !== SYSTEM_USER_ID) {
        const isTemplateOwner = existingTemplateRawData.user_id === requestingUserId;

        const currentDbOwnerId = await _getDbOwnerId(existingTemplateRawData.target_database_id, db);
        const isCurrentDbOwner = currentDbOwnerId === requestingUserId;
        let canAdminCurrentDb = false;
        if (currentDbOwnerId === null) {
            canAdminCurrentDb = await permissionService.checkPermission(requestingUserId, 'database', existingTemplateRawData.target_database_id, 'admin');
        } else if (!isCurrentDbOwner) {
             canAdminCurrentDb = await permissionService.checkPermission(requestingUserId, 'database', existingTemplateRawData.target_database_id, 'admin');
        }
        const canManageViaCurrentDb = isCurrentDbOwner || canAdminCurrentDb;

        if (!isTemplateOwner && !canManageViaCurrentDb) {
            return { success: false, error: "Permission denied: Must own template or own/admin its current target database to update." };
        }

        if (updates.hasOwnProperty('target_database_id') && updates.target_database_id !== existingTemplateRawData.target_database_id) {
            if(updates.target_database_id === null || updates.target_database_id === undefined){
                 return { success: false, error: "New target_database_id cannot be null or undefined." };
            }
            const newTargetDbInfo = await databaseDefService.getDatabaseById(updates.target_database_id, requestingUserId);
            if (!newTargetDbInfo) {
                 return { success: false, error: `New target database ID ${updates.target_database_id} not found or not accessible.` };
            }
            const newDbOwnerId = newTargetDbInfo.user_id;
            const isNewDbOwner = newDbOwnerId === requestingUserId;
            let canWriteNewDb = false;
            if (newDbOwnerId === null) {
                canWriteNewDb = await permissionService.checkPermission(requestingUserId, 'database', updates.target_database_id, 'write');
            } else if (!isNewDbOwner) {
                canWriteNewDb = await permissionService.checkPermission(requestingUserId, 'database', updates.target_database_id, 'write');
            }
            if (!isNewDbOwner && !canWriteNewDb ) {
                 return { success: false, error: "Permission denied: Actor lacks write/ownership rights on the new target database." };
            }
        }
    }

    // Re-fetch with permissions after initial checks, to ensure template is still accessible by this user
    const existingTemplate = await getTemplateById(templateId, requestingUserId);
    if (!existingTemplate) {
        return { success: false, error: "Template not found or access denied after initial permission checks." };
    }

    const fieldsToUpdate = {};
    if (updates.hasOwnProperty('name')) { // Check hasOwnProperty for name
        if (!updates.name || typeof updates.name !== 'string' || updates.name.trim() === "") {
            return { success: false, error: "Template name cannot be empty." };
        }
        fieldsToUpdate.name = updates.name.trim();
    }
    if (updates.hasOwnProperty('description')) {
        fieldsToUpdate.description = updates.description; // Allows null or empty string
    }
    if (updates.hasOwnProperty('target_database_id')) {
        fieldsToUpdate.target_database_id = updates.target_database_id;
    }
    if (updates.hasOwnProperty('template_values')) {
        if (updates.template_values !== null && (typeof updates.template_values !== 'object')) { // Allow null to clear
            return { success: false, error: "template_values must be an object or null." };
        }
        const dbIdForValidation = updates.target_database_id !== undefined ? updates.target_database_id : existingTemplate.target_database_id;
        if (updates.template_values !== null) { // Only validate if not null
            const valueKeysValidation = await _validateTemplateValuesKeys(updates.template_values, dbIdForValidation, requestingUserId);
            if (!valueKeysValidation.isValid) {
                return { success: false, error: valueKeysValidation.error };
            }
        }
        try {
            fieldsToUpdate.template_values = updates.template_values === null ? null : JSON.stringify(updates.template_values);
        } catch (e) {
            return { success: false, error: "Failed to stringify template_values for update: " + e.message };
        }
    }

    if (Object.keys(fieldsToUpdate).length === 0) {
         return { success: true, template: existingTemplate, message: "No effective changes." };
    }

    fieldsToUpdate.updated_at = new Date().toISOString();

    const setClauses = Object.keys(fieldsToUpdate).map(key => `${key} = ?`).join(", ");
    const values = [...Object.values(fieldsToUpdate), templateId];

    const sql = `UPDATE data_templates SET ${setClauses} WHERE id = ?`;

    try {
        const info = db.prepare(sql).run(...values);
        if (info.changes > 0) {
            const updatedTemplate = await getTemplateById(templateId, requestingUserId); // Pass RUId
            return { success: true, template: updatedTemplate };
        }
        return { success: false, error: "Template not found or update failed (no changes made)." };
    } catch (err) {
        console.error(`Error updating template ${templateId}:`, err.message);
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') { // Handles unique constraint on (target_database_id, name)
            return { success: false, error: "A template with this name already exists for the target database, or target database ID changed and resulted in a name conflict." };
        }
        return { success: false, error: "Failed to update template." };
    }
}

/**
 * Deletes a data template.
 * @param {number} templateId - The ID of the template to delete.
 * @param {number} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object>} Result object with success status or error.
 */
async function deleteTemplate(templateId, requestingUserId) { // Added requestingUserId
    const db = getDb();
    // Fetch first to check ownership/permissions before deleting
    const templateRawData = db.prepare("SELECT * FROM data_templates WHERE id = ?").get(templateId);

    if (!templateRawData) {
        return { success: false, error: "Template not found." };
    }

    if (requestingUserId !== SYSTEM_USER_ID) {
        const isTemplateOwner = templateRawData.user_id === requestingUserId;
        const dbOwnerId = await _getDbOwnerId(templateRawData.target_database_id, db);
        const isDbOwner = dbOwnerId === requestingUserId;
        let canAdminDb = false;
        if(dbOwnerId === null) { // Public DB
            canAdminDb = await permissionService.checkPermission(requestingUserId, 'database', templateRawData.target_database_id, 'admin');
        } else if (!isDbOwner) {
            canAdminDb = await permissionService.checkPermission(requestingUserId, 'database', templateRawData.target_database_id, 'admin');
        }
        const canManageViaDb = isDbOwner || canAdminDb;

        if (!isTemplateOwner && !canManageViaDb) {
            return { success: false, error: "Permission denied: Must own template or own/admin its target database." };
        }
    }

    const sql = "DELETE FROM data_templates WHERE id = ?";
    try {
        const info = db.prepare(sql).run(templateId);
        if (info.changes > 0) {
            // Also revoke any permissions explicitly set ON this data_template object itself
            await permissionService.revokeAllPermissionsForObject('data_template', templateId);
            // Note: 'data_template' needs to be in ALLOWED_OBJECT_TYPES in permissionService
            console.log(`Revoked all permissions for data_template ${templateId}`);
            return { success: true };
        }
        return { success: false, error: "Template not found or delete operation failed." };
    } catch (err) {
        console.error(`Error deleting template ${templateId}:`, err.message);
        return { success: false, error: "Failed to delete template." };
    }
}


/**
 * Retrieves a template and resolves its values against the current column definitions
 * of its target database, mapping column IDs to column names.
 * @param {number} templateId - The ID of the template.
 * @param {number} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object>} Result object with success status, resolved values, template name, and target DB ID, or an error.
 */
async function getResolvedTemplateValues(templateId, requestingUserId = null) {
    // Pass requestingUserId to getTemplateById for permission checking
    const template = await getTemplateById(templateId, requestingUserId);

    if (!template) {
        return { success: false, error: "Template not found or not accessible." };
    }

    // Pass requestingUserId to getColumnsForDatabase for permission checking on the database
    const columns = await databaseDefService.getColumnsForDatabase(template.target_database_id, requestingUserId);
    if (!columns) {
        // This can happen if the user can see the template (e.g., owns it) but cannot read the target_database
        return { success: false, error: `Could not fetch columns for target database ID ${template.target_database_id} or permission denied on database.` };
    }

    const columnMap = new Map(columns.map(col => [String(col.id), col]));
    const resolvedValues = {};

    if (template.template_values && typeof template.template_values === 'object' && !template.template_values._error) {
        for (const [columnIdStr, value] of Object.entries(template.template_values)) {
            // const columnId = parseInt(columnIdStr, 10); // No longer needed if keys are stored as strings
            if (columnMap.has(columnIdStr)) {
                const columnDef = columnMap.get(columnIdStr);
                resolvedValues[columnDef.name] = value;
            } else {
                console.warn(`Column ID '${columnIdStr}' from template ${templateId} not found in target database ${template.target_database_id}. Skipping this template value.`);
            }
        }
    } else if (template.template_values && template.template_values._error) {
        console.warn(`Template ${templateId} has invalid template_values JSON. Proceeding with empty resolved values.`);
    }


    return {
        success: true,
        values: resolvedValues,
        templateName: template.name,
        targetDatabaseId: template.target_database_id
    };
}

module.exports = {
    createTemplate,
    getTemplateById,
    getTemplatesForDatabase,
    updateTemplate,
    deleteTemplate,
    getResolvedTemplateValues, // Added
};
