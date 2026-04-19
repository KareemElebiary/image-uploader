/* ============================================================
   EduVault – Upload Routes
   POST /api/uploads              – Upload image to Drive + log in DB
   GET  /api/uploads              – List all uploads (admin)
   GET  /api/uploads/mine         – Get my uploads (student, needs token)
   GET  /api/uploads/:id          – Get a single upload record
   DELETE /api/uploads/:id        – Delete an upload (admin)
   ============================================================ */

const express = require('express');
const multer = require('multer');
const { getDb } = require('../db/database');
const { verifyToken, requireAdmin } = require('./auth');
const {
    uploadFileToDrive,
    listDriveFolder,
    copyDriveFile,
    isGoogleReady
} = require('../services/googleApi');

const router = express.Router();

/* ── Multer – in-memory storage (we stream to Drive) ─────── */
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '10');
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPG, PNG, WEBP allowed.'));
        }
    }
});

/* ── POST /api/uploads ──────────────────────────────────── */
router.post('/', verifyToken, upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file provided.' });
    }

    const { subjectId } = req.body;
    const db = getDb();

    // Look up subject
    let subject = null;
    if (subjectId) {
        subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
        if (!subject) return res.status(404).json({ error: 'Subject not found.' });
    }

    const user = req.user;
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const safeName = (user.firstName || user.id).replace(/[^a-zA-Z0-9]/g, '_');
    const fileName = `${safeName}_${user.id}.${ext}`;

    try {
        // Upload to Google Drive
        const driveFile = await uploadFileToDrive(
            req.file.buffer,
            fileName,
            req.file.mimetype,
            subject ? subject.folder_id : process.env.DRIVE_MAIN_FOLDER_ID
        );

        // Save to local DB
        const result = db.prepare(`
            INSERT INTO uploads
                (drive_file_id, drive_name, drive_view_link, student_id, first_name, last_name, subject_id, subject_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            driveFile.id,
            driveFile.name || fileName,
            driveFile.webViewLink || null,
            user.id,
            user.firstName,
            user.lastName,
            subject ? subject.id : null,
            subject ? subject.name : null
        );

        const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(result.lastInsertRowid);

        res.status(201).json({
            id: upload.id,
            driveFileId: upload.drive_file_id,
            driveName: upload.drive_name,
            driveViewLink: upload.drive_view_link,
            studentId: upload.student_id,
            firstName: upload.first_name,
            lastName: upload.last_name,
            subjectName: upload.subject_name,
            uploadedAt: upload.uploaded_at,
            grade: upload.grade,
            simulated: driveFile.simulated || false
        });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
});

/* ── POST /api/uploads/base64 (legacy bridge compat) ─────── */
// Accepts base64 encoded image – same as what Google Apps Script bridge used
router.post('/base64', verifyToken, async (req, res) => {
    const { base64, fileName, mimeType, subjectId } = req.body;
    if (!base64 || !fileName) {
        return res.status(400).json({ error: 'base64 and fileName are required.' });
    }

    const db = getDb();
    let subject = null;
    if (subjectId) {
        subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
    }

    try {
        const buffer = Buffer.from(base64, 'base64');
        const driveFile = await uploadFileToDrive(
            buffer,
            fileName,
            mimeType || 'image/jpeg',
            subject ? subject.folder_id : process.env.DRIVE_MAIN_FOLDER_ID
        );

        const user = req.user;
        const result = db.prepare(`
            INSERT INTO uploads
                (drive_file_id, drive_name, drive_view_link, student_id, first_name, last_name, subject_id, subject_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            driveFile.id,
            driveFile.name || fileName,
            driveFile.webViewLink || null,
            user.id,
            user.firstName,
            user.lastName,
            subject ? subject.id : null,
            subject ? subject.name : null
        );

        const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json({
            id: upload.drive_file_id,
            name: upload.drive_name,
            webViewLink: upload.drive_view_link,
            simulated: driveFile.simulated || false
        });
    } catch (err) {
        console.error('Base64 upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

/* ── GET /api/uploads/mine ──────────────────────────────── */
router.get('/mine', verifyToken, (req, res) => {
    const db = getDb();
    const uploads = db.prepare(`
        SELECT * FROM uploads WHERE student_id = ? ORDER BY uploaded_at DESC
    `).all(req.user.id);

    res.json(uploads.map(formatUpload));
});

/* ── GET /api/uploads (admin) ───────────────────────────── */
router.get('/', verifyToken, requireAdmin, (req, res) => {
    const db = getDb();
    const { subjectId, studentId } = req.query;

    let sql = 'SELECT * FROM uploads WHERE 1=1';
    const params = [];
    if (subjectId) { sql += ' AND subject_id = ?'; params.push(subjectId); }
    if (studentId) { sql += ' AND student_id = ?'; params.push(studentId); }
    sql += ' ORDER BY uploaded_at DESC';

    const uploads = db.prepare(sql).all(...params);
    res.json(uploads.map(formatUpload));
});

/* ── GET /api/uploads/:id ───────────────────────────────── */
router.get('/:id', verifyToken, (req, res) => {
    const db = getDb();
    const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id);
    if (!upload) return res.status(404).json({ error: 'Upload not found' });

    // Students can only view their own uploads; admins can view all
    if (req.user.role !== 'admin' && upload.student_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
    }

    res.json(formatUpload(upload));
});

/* ── DELETE /api/uploads/:id (admin) ────────────────────── */
router.delete('/:id', verifyToken, requireAdmin, (req, res) => {
    const db = getDb();
    const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id);
    if (!upload) return res.status(404).json({ error: 'Upload not found' });

    db.prepare('DELETE FROM uploads WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

/* ── Format helper ──────────────────────────────────────── */
function formatUpload(u) {
    return {
        id: u.id,
        driveFileId: u.drive_file_id,
        driveName: u.drive_name,
        driveViewLink: u.drive_view_link,
        studentId: u.student_id,
        firstName: u.first_name,
        lastName: u.last_name,
        subjectId: u.subject_id,
        subjectName: u.subject_name,
        uploadedAt: u.uploaded_at,
        grade: u.grade,
        gradedAt: u.graded_at
    };
}

module.exports = router;
