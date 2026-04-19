/* ============================================================
   EduVault – Subjects Routes
   GET    /api/subjects           – List all subjects
   POST   /api/subjects           – Create a subject (admin)
   PUT    /api/subjects/:id       – Update a subject (admin)
   DELETE /api/subjects/:id       – Delete a subject (admin)
   ============================================================ */

const express = require('express');
const { getDb } = require('../db/database');
const { verifyToken, requireAdmin } = require('./auth');

const router = express.Router();

/* ── GET /api/subjects ──────────────────────────────────── */
router.get('/', (req, res) => {
    const db = getDb();
    const subjects = db.prepare('SELECT * FROM subjects ORDER BY name ASC').all();
    res.json(subjects.map(s => ({
        id: s.id,
        name: s.name,
        folderId: s.folder_id,
        highId: s.high_folder_id,
        sheetId: s.sheet_id,
        createdAt: s.created_at
    })));
});

/* ── GET /api/subjects/:id ──────────────────────────────── */
router.get('/:id', (req, res) => {
    const db = getDb();
    const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(req.params.id);
    if (!subject) return res.status(404).json({ error: 'Subject not found' });
    res.json({
        id: subject.id,
        name: subject.name,
        folderId: subject.folder_id,
        highId: subject.high_folder_id,
        sheetId: subject.sheet_id,
        createdAt: subject.created_at
    });
});

/* ── POST /api/subjects (admin only) ────────────────────── */
router.post('/', verifyToken, requireAdmin, (req, res) => {
    const { name, folderId, highId, sheetId } = req.body;
    if (!name || !folderId) {
        return res.status(400).json({ error: 'name and folderId are required.' });
    }

    const db = getDb();
    try {
        const result = db.prepare(`
            INSERT INTO subjects (name, folder_id, high_folder_id, sheet_id)
            VALUES (?, ?, ?, ?)
        `).run(
            String(name).trim(),
            String(folderId).trim(),
            highId ? String(highId).trim() : null,
            sheetId ? String(sheetId).trim() : null
        );

        const created = db.prepare('SELECT * FROM subjects WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json({
            id: created.id,
            name: created.name,
            folderId: created.folder_id,
            highId: created.high_folder_id,
            sheetId: created.sheet_id
        });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: `Subject "${name}" already exists.` });
        }
        throw err;
    }
});

/* ── PUT /api/subjects/:id (admin only) ─────────────────── */
router.put('/:id', verifyToken, requireAdmin, (req, res) => {
    const { name, folderId, highId, sheetId } = req.body;
    const db = getDb();

    const subject = db.prepare('SELECT id FROM subjects WHERE id = ?').get(req.params.id);
    if (!subject) return res.status(404).json({ error: 'Subject not found' });

    db.prepare(`
        UPDATE subjects
        SET name = COALESCE(?, name),
            folder_id = COALESCE(?, folder_id),
            high_folder_id = COALESCE(?, high_folder_id),
            sheet_id = COALESCE(?, sheet_id)
        WHERE id = ?
    `).run(
        name ? String(name).trim() : null,
        folderId ? String(folderId).trim() : null,
        highId !== undefined ? (highId ? String(highId).trim() : null) : undefined,
        sheetId !== undefined ? (sheetId ? String(sheetId).trim() : null) : undefined,
        req.params.id
    );

    const updated = db.prepare('SELECT * FROM subjects WHERE id = ?').get(req.params.id);
    res.json({
        id: updated.id,
        name: updated.name,
        folderId: updated.folder_id,
        highId: updated.high_folder_id,
        sheetId: updated.sheet_id
    });
});

/* ── DELETE /api/subjects/:id (admin only) ──────────────── */
router.delete('/:id', verifyToken, requireAdmin, (req, res) => {
    const db = getDb();
    const subject = db.prepare('SELECT id FROM subjects WHERE id = ?').get(req.params.id);
    if (!subject) return res.status(404).json({ error: 'Subject not found' });

    db.prepare('DELETE FROM subjects WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Subject deleted.' });
});

module.exports = router;
