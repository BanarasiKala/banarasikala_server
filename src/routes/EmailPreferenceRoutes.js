const express = require('express');
const router = express.Router();
const EmailPreferenceController = require('../controllers/EmailPreferenceController');

// Public by design — these are opened from an unsubscribe link in an email client, where
// there is no session. The signed token in the link is the authorisation.
router.get('/', EmailPreferenceController.getPreferences);
router.post('/', EmailPreferenceController.updatePreferences);

module.exports = router;
