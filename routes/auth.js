/* ============================================================
   EduVault – Authentication Routes
   POST /api/auth/login          – Student or Admin login  
   POST /api/auth/register       – Student registration
   POST /api/auth/logout         – Clear session token
   GET  /api/auth/me             – Validate current session
   ============================================================ */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_dev_secret';
const JWT_EXPIRES = '8h';

/* ── Middleware: verify JWT ─────────────────────────────── */
function verifyToken(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

/* ── POST /api/auth/login ───────────────────────────────── */
router.post('/login', (req, res) => {
    const { id, password } = req.body;
    if (!id || !password) {
        return res.status(400).json({ error: 'Student ID and password are required.' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(String(id).trim());

    if (!user) {
        return res.status(401).json({ error: 'Invalid Student ID or password.' });
    }

    const passwordMatch = bcrypt.compareSync(password, user.password);
    if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid Student ID or password.' });
    }

    const token = jwt.sign(
        { id: user.id, role: user.role, firstName: user.first_name, lastName: user.last_name },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES }
    );

    res.json({
        token,
        user: {
            id: user.id,
            role: user.role,
            firstName: user.first_name,
            lastName: user.last_name,
            email: user.email
        }
    });
});

/* ── POST /api/auth/register ────────────────────────────── */
router.post('/register', (req, res) => {
    const { id, firstName, lastName, email, password } = req.body;

    if (!id || !firstName || !lastName || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const db = getDb();

    // Check duplicate Student ID
    const existingId = db.prepare('SELECT id FROM users WHERE id = ?').get(String(id).trim());
    if (existingId) {
        return res.status(409).json({ error: 'This Student ID is already registered.' });
    }

    // Check duplicate email (if provided)
    if (email) {
        const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).trim());
        if (existingEmail) {
            return res.status(409).json({ error: 'This email is already registered.' });
        }
    }

    const hashed = bcrypt.hashSync(password, 10);
    db.prepare(`
        INSERT INTO users (id, password, role, first_name, last_name, email)
        VALUES (?, ?, 'student', ?, ?, ?)
    `).run(
        String(id).trim(),
        hashed,
        String(firstName).trim(),
        String(lastName).trim(),
        email ? String(email).trim() : null
    );

    const token = jwt.sign(
        { id, role: 'student', firstName, lastName },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES }
    );

    res.status(201).json({
        token,
        user: { id, role: 'student', firstName, lastName, email }
    });
});

/* ── GET /api/auth/me ───────────────────────────────────── */
router.get('/me', verifyToken, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, role, first_name, last_name, email, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
        id: user.id,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        createdAt: user.created_at
    });
});

/* ── GET /api/auth/users  (admin only) ──────────────────── */
router.get('/users', verifyToken, requireAdmin, (req, res) => {
    const db = getDb();
    const users = db.prepare('SELECT id, role, first_name, last_name, email, created_at FROM users ORDER BY created_at DESC').all();
    res.json(users.map(u => ({
        id: u.id,
        role: u.role,
        firstName: u.first_name,
        lastName: u.last_name,
        email: u.email,
        createdAt: u.created_at
    })));
});

module.exports = { router, verifyToken, requireAdmin };
