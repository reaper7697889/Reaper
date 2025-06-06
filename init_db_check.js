const db = require('./db.js'); db.getDb(); console.log('DB handle obtained, schema should be initialized.'); db.closeDb();
