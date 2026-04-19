/* ============================================================
   EduVault – Drive Proxy Routes
   These routes expose Google Drive operations through the backend
   so the frontend doesn't need its own Google auth.
   
   GET  /api/drive/list/:folderId  – List files in a folder
   GET  /api/drive/status          – Check if Google is connected
   ============================================================ */

const express = require('express');
const { verifyToken, requireAdmin } = require('./auth');
const { listDriveFolder, isGoogleReady } = require('../services/googleApi');

const router = express.Router();

/* ── GET /api/drive/status ──────────────────────────────── */
router.get('/status', (req, res) => {
    res.json({
        connected: isGoogleReady(),
        mode: isGoogleReady() ? 'service_account' : 'simulated'
    });
});

/* ── GET /api/drive/list/:folderId ──────────────────────── */
router.get('/list/:folderId', verifyToken, requireAdmin, async (req, res) => {
    try {
        const files = await listDriveFolder(req.params.folderId);
        res.json(files);
    } catch (err) {
        res.status(500).json({ error: 'Drive listing failed: ' + err.message });
    }
});

module.exports = router;
