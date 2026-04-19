/* ============================================================
   EduVault – Main Server Entry Point
   Node.js + Express REST API backend
   
   Endpoints:
     /api/auth/*       – Login, register, session
     /api/subjects/*   – Subject management
     /api/uploads/*    – Image uploads
     /api/grades/*     – Grade management
     /api/drive/*      – Google Drive proxy
     /api/bridge       – Legacy Google Apps Script bridge compat
   ============================================================ */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { initializeDatabase } = require('./db/database');
const { initGoogleAuth, isGoogleReady } = require('./services/googleApi');

const authRoutes = require('./routes/auth');
const subjectRoutes = require('./routes/subjects');
const uploadRoutes = require('./routes/uploads');
const gradeRoutes = require('./routes/grades');
const driveRoutes = require('./routes/drive');

const app = express();
const PORT = process.env.PORT || 3001;

/* ── Security Middleware ────────────────────────────────── */
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

/* ── CORS – allow the frontend dev server ───────────────────── */
const allowedOrigins = [
    process.env.FRONTEND_URL,            // from .env or Railway env vars
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://localhost:3000',
    'http://localhost:8080',
    'null',                              // for file:// opened pages
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, Postman)
        if (!origin) return callback(null, true);
        // Exact match list
        if (allowedOrigins.includes(origin)) return callback(null, true);
        // Allow any Netlify or Railway preview URL
        if (/\.netlify\.app$/.test(origin) || /\.up\.railway\.app$/.test(origin)) {
            return callback(null, true);
        }
        callback(new Error('CORS: Origin not allowed: ' + origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

/* ── Rate Limiting ──────────────────────────────────────── */
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many auth attempts. Please wait 15 minutes.' }
});

app.use(limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

/* ── Body Parsing ───────────────────────────────────────── */
app.use(express.json({ limit: '50mb' }));  // 50MB for base64 images
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/* ── Health Check ───────────────────────────────────────── */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        googleConnected: isGoogleReady(),
        uptime: Math.floor(process.uptime())
    });
});

/* ── Routes ─────────────────────────────────────────────── */
app.use('/api/auth', authRoutes.router);
app.use('/api/subjects', subjectRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/grades', gradeRoutes);
app.use('/api/drive', driveRoutes);

/* ── Legacy Bridge – Google Apps Script Compatibility ─────
   This endpoint speaks the same protocol as the old Apps Script
   bridge so the existing frontend JS works without changes.
─────────────────────────────────────────────────────────── */
const { getDb } = require('./db/database');
const { uploadFileToDrive, listDriveFolder, copyDriveFile, appendGradeToSheets, readGradesFromSheets } = require('./services/googleApi');
const bcrypt = require('bcryptjs');

app.all('/api/bridge', async (req, res) => {
    try {
        let action, data;

        // Support both GET (query params) and POST (body)
        if (req.method === 'GET') {
            action = req.query.action;
            data = req.query.data ? JSON.parse(decodeURIComponent(req.query.data)) : {};
        } else {
            const body = req.body;
            action = body.action;
            data = body.data || body;
        }

        const db = getDb();

        switch (action) {

            // ── Get all users ────────────────────────────
            case 'getUsers': {
                const users = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
                const rows = [
                    ['ID', 'Password', 'Role', 'FirstName', 'LastName'],
                    ...users.map(u => [u.id, u.password, u.role, u.first_name, u.last_name])
                ];
                return res.json(rows);
            }

            // ── Register a new user ──────────────────────
            case 'registerUser': {
                const [id, password, role, firstName, lastName] = data.values || [];
                if (!id || !password) return res.json({ error: 'Missing fields' });
                const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(String(id).trim());
                if (existing) return res.json({ error: 'Student ID already registered.' });
                const hashed = bcrypt.hashSync(String(password), 10);
                db.prepare(`
                    INSERT INTO users (id, password, role, first_name, last_name)
                    VALUES (?, ?, ?, ?, ?)
                `).run(String(id).trim(), hashed, role || 'student', firstName || '', lastName || '');
                return res.json({ success: true });
            }

            // ── Get subjects ─────────────────────────────
            case 'getSubjects': {
                const subjects = db.prepare('SELECT * FROM subjects ORDER BY name ASC').all();
                const rows = [
                    ['Name', 'FolderID', 'HighID', 'SheetID'],
                    ...subjects.map(s => [s.name, s.folder_id, s.high_folder_id || '', s.sheet_id || ''])
                ];
                return res.json(rows);
            }

            // ── Upload file ───────────────────────────────
            case 'upload': {
                const { base64, fileName, folderId, mimeType } = data;
                if (!base64 || !fileName) return res.json({ error: 'Missing file data' });
                const buffer = Buffer.from(base64, 'base64');
                const driveFile = await uploadFileToDrive(buffer, fileName, mimeType || 'image/jpeg', folderId);
                return res.json({ id: driveFile.id, name: driveFile.name, webViewLink: driveFile.webViewLink });
            }

            // ── List Drive folder ─────────────────────────
            case 'list': {
                const { folderId } = data;
                const files = await listDriveFolder(folderId);
                return res.json(files);
            }

            // ── Append grade ──────────────────────────────
            case 'appendGrade': {
                const { sheetId, tabName, values } = data;
                const [studentId, firstName, lastName, imageFile, mark, gradedAt, subject] = values || [];
                
                // Save to local DB
                const subjectRow = db.prepare('SELECT * FROM subjects WHERE name = ?').get(subject);
                db.prepare(`
                    INSERT INTO grades (student_id, first_name, last_name, image_file, mark, subject_id, subject_name, graded_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(studentId, firstName, lastName, imageFile, parseFloat(mark), subjectRow?.id || null, subject || null, gradedAt || new Date().toISOString());

                if (imageFile) {
                    db.prepare('UPDATE uploads SET grade = ?, graded_at = ? WHERE drive_name = ?')
                        .run(parseFloat(mark), gradedAt || new Date().toISOString(), imageFile);
                }

                // Sync to Sheets (non-blocking)
                appendGradeToSheets({ sheetId, tabName, studentId, firstName, lastName, imageFile, mark: parseFloat(mark), subject, gradedAt })
                    .catch(e => console.warn('Sheets sync:', e.message));

                return res.json({ success: true });
            }

            // ── Get grades ────────────────────────────────
            case 'getGrades': {
                const { sheetId, tabName } = data;
                const grades = db.prepare('SELECT * FROM grades ORDER BY graded_at ASC').all();
                const rows = [
                    ['StudentID', 'FirstName', 'LastName', 'ImageFile', 'Mark', 'GradedAt', 'Subject'],
                    ...grades.map(g => [g.student_id, g.first_name, g.last_name, g.image_file, g.mark, g.graded_at, g.subject_name])
                ];
                return res.json(rows);
            }

            // ── Copy file (high achievers) ─────────────────
            case 'copy': {
                const { fileId, destFolderId } = data;
                const result = await copyDriveFile(fileId, destFolderId);
                return res.json(result);
            }

            default:
                return res.status(400).json({ error: `Unknown action: ${action}` });
        }
    } catch (err) {
        console.error('Bridge error:', err);
        res.status(500).json({ error: err.message });
    }
});

/* ── 404 Handler ────────────────────────────────────────── */
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

/* ── Global Error Handler ───────────────────────────────── */
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (err.message && err.message.includes('CORS')) {
        return res.status(403).json({ error: err.message });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Max ${process.env.MAX_FILE_SIZE_MB || 10}MB allowed.` });
    }
    res.status(500).json({ error: err.message || 'Internal server error' });
});

/* ── Bootstrap ──────────────────────────────────────────── */
async function start() {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║        EduVault Backend Server       ║');
    console.log('╚══════════════════════════════════════╝\n');

    // Init DB
    initializeDatabase();
    console.log('📦 Database ready');

    // Init Google APIs (non-blocking, app works without it)
    initGoogleAuth().then(() => {
        if (isGoogleReady()) {
            console.log('🔗 Google Drive & Sheets connected');
        } else {
            console.log('⚠️  Google APIs not configured – running in simulation mode');
            console.log('   To enable on Railway: set the GOOGLE_SERVICE_ACCOUNT_JSON env var.');
            console.log('   To enable locally: add google-service-account.json to the backend folder.');
        }
    });

    app.listen(PORT, () => {
        console.log(`\n🚀 Server running at: http://localhost:${PORT}`);
        console.log(`📋 Health check:      http://localhost:${PORT}/api/health`);
        console.log(`🔌 Bridge endpoint:   http://localhost:${PORT}/api/bridge`);
        console.log(`\n💡 Update js/config.js: APPS_SCRIPT_URL → http://localhost:${PORT}/api/bridge\n`);
    });
}

start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
