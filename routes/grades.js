/* ============================================================
   EduVault – Grades Routes
   POST /api/grades               – Submit a grade (admin)
   GET  /api/grades               – List all grades (admin)
   GET  /api/grades/student/:id   – Get grades for a student
   GET  /api/grades/subject/:id   – Get grades for a subject
   DELETE /api/grades/:id         – Delete a grade (admin)
   ============================================================ */

const express = require('express');
const { getDb } = require('../db/database');
const { verifyToken, requireAdmin } = require('./auth');
const { appendGradeToSheets, copyDriveFile } = require('../services/googleApi');

const router = express.Router();
const HIGH_SCORE = parseInt(process.env.HIGH_SCORE_THRESHOLD || '80');

/* ── POST /api/grades ───────────────────────────────────── */
router.post('/', verifyToken, requireAdmin, async (req, res) => {
    const { studentId, firstName, lastName, imageFile, driveFileId, mark, subjectId, subjectName } = req.body;

    if (!studentId || mark === undefined || mark === null) {
        return res.status(400).json({ error: 'studentId and mark are required.' });
    }

    const gradeValue = parseFloat(mark);
    if (isNaN(gradeValue) || gradeValue < 0 || gradeValue > 100) {
        return res.status(400).json({ error: 'Mark must be a number between 0 and 100.' });
    }

    const db = getDb();

    // Look up subject if provided
    let subject = null;
    let resolvedSubjectId = subjectId;
    let resolvedSubjectName = subjectName;

    if (subjectId) {
        subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
        if (subject) {
            resolvedSubjectName = subject.name;
        }
    }

    const gradedAt = new Date().toISOString();

    // Insert grade record
    const result = db.prepare(`
        INSERT INTO grades (student_id, first_name, last_name, image_file, drive_file_id, mark, subject_id, subject_name, graded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        String(studentId).trim(),
        firstName || null,
        lastName || null,
        imageFile || null,
        driveFileId || null,
        gradeValue,
        resolvedSubjectId || null,
        resolvedSubjectName || null,
        gradedAt
    );

    // Update the uploads table too
    if (driveFileId) {
        db.prepare(`
            UPDATE uploads SET grade = ?, graded_at = ? WHERE drive_file_id = ?
        `).run(gradeValue, gradedAt, driveFileId);
    }

    // Copy to High Achievers folder if score ≥ threshold
    let copiedToHighAchievers = false;
    if (gradeValue >= HIGH_SCORE && subject && subject.high_folder_id && driveFileId) {
        try {
            await copyDriveFile(driveFileId, subject.high_folder_id);
            copiedToHighAchievers = true;
        } catch (copyErr) {
            console.warn('⚠️  High Achievers copy failed:', copyErr.message);
        }
    }

    // Sync to Google Sheets (non-blocking)
    if (subject) {
        appendGradeToSheets({
            sheetId: subject.sheet_id || process.env.SHEETS_ID,
            tabName: process.env.SHEETS_TAB_GRADES || 'Grades',
            studentId,
            firstName: firstName || '',
            lastName: lastName || '',
            imageFile: imageFile || '',
            mark: gradeValue,
            subject: resolvedSubjectName || '',
            gradedAt: new Date().toLocaleString()
        }).catch(err => console.warn('Sheets sync failed:', err.message));
    }

    const grade = db.prepare('SELECT * FROM grades WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({
        ...formatGrade(grade),
        copiedToHighAchievers
    });
});

/* ── GET /api/grades (admin) ────────────────────────────── */
router.get('/', verifyToken, requireAdmin, (req, res) => {
    const db = getDb();
    const { subjectId, studentId, limit } = req.query;

    let sql = 'SELECT * FROM grades WHERE 1=1';
    const params = [];
    if (subjectId) { sql += ' AND subject_id = ?'; params.push(subjectId); }
    if (studentId) { sql += ' AND student_id = ?'; params.push(studentId); }
    sql += ' ORDER BY graded_at DESC';
    if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit)); }

    const grades = db.prepare(sql).all(...params);
    res.json(grades.map(formatGrade));
});

/* ── GET /api/grades/stats (admin) ─────────────────────── */
router.get('/stats', verifyToken, requireAdmin, (req, res) => {
    const db = getDb();
    const { subjectId } = req.query;

    let sql = 'SELECT * FROM grades WHERE 1=1';
    const params = [];
    if (subjectId) { sql += ' AND subject_id = ?'; params.push(subjectId); }

    const grades = db.prepare(sql).all(...params);

    const total = grades.length;
    const avg = total > 0 ? grades.reduce((s, g) => s + g.mark, 0) / total : 0;
    const high = grades.filter(g => g.mark >= HIGH_SCORE).length;
    const passed = grades.filter(g => g.mark >= 50).length;
    const failed = grades.filter(g => g.mark < 50).length;

    const distribution = { '0-49': 0, '50-69': 0, '70-79': 0, '80-89': 0, '90-100': 0 };
    grades.forEach(g => {
        if (g.mark < 50) distribution['0-49']++;
        else if (g.mark < 70) distribution['50-69']++;
        else if (g.mark < 80) distribution['70-79']++;
        else if (g.mark < 90) distribution['80-89']++;
        else distribution['90-100']++;
    });

    res.json({ total, average: parseFloat(avg.toFixed(2)), highAchievers: high, passed, failed, distribution });
});

/* ── GET /api/grades/student/:studentId ─────────────────── */
router.get('/student/:studentId', verifyToken, (req, res) => {
    // Students can only see their own grades; admins can see all
    if (req.user.role !== 'admin' && req.user.id !== req.params.studentId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const db = getDb();
    const grades = db.prepare('SELECT * FROM grades WHERE student_id = ? ORDER BY graded_at DESC').all(req.params.studentId);
    res.json(grades.map(formatGrade));
});

/* ── GET /api/grades/subject/:subjectId ─────────────────── */
router.get('/subject/:subjectId', verifyToken, requireAdmin, (req, res) => {
    const db = getDb();
    const grades = db.prepare('SELECT * FROM grades WHERE subject_id = ? ORDER BY graded_at DESC').all(req.params.subjectId);
    res.json(grades.map(formatGrade));
});

/* ── DELETE /api/grades/:id (admin) ─────────────────────── */
router.delete('/:id', verifyToken, requireAdmin, (req, res) => {
    const db = getDb();
    const grade = db.prepare('SELECT * FROM grades WHERE id = ?').get(req.params.id);
    if (!grade) return res.status(404).json({ error: 'Grade not found' });
    db.prepare('DELETE FROM grades WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

/* ── Format helper ──────────────────────────────────────── */
function formatGrade(g) {
    return {
        id: g.id,
        studentId: g.student_id,
        firstName: g.first_name,
        lastName: g.last_name,
        imageFile: g.image_file,
        driveFileId: g.drive_file_id,
        mark: g.mark,
        subjectId: g.subject_id,
        subjectName: g.subject_name,
        gradedAt: g.graded_at,
        gradedBy: g.graded_by
    };
}

module.exports = router;
