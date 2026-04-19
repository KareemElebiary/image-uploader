/* ============================================================
   EduVault – Database Schema & Initialization
   Using better-sqlite3 for fast, synchronous SQLite access
   ============================================================ */

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'eduvault.db');

let db;

function getDb() {
    if (!db) {
        const fs = require('fs');
        const dataDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');  // Better write performance
        db.pragma('foreign_keys = ON');
    }
    return db;
}

function initializeDatabase() {
    const db = getDb();

    // ── Users Table ─────────────────────────────────────────
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id          TEXT PRIMARY KEY,
            password    TEXT NOT NULL,
            role        TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student','admin')),
            first_name  TEXT NOT NULL,
            last_name   TEXT NOT NULL,
            email       TEXT UNIQUE,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    // ── Subjects Table ───────────────────────────────────────
    db.exec(`
        CREATE TABLE IF NOT EXISTS subjects (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL UNIQUE,
            folder_id       TEXT NOT NULL,
            high_folder_id  TEXT,
            sheet_id        TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    // ── Uploads Table ────────────────────────────────────────
    db.exec(`
        CREATE TABLE IF NOT EXISTS uploads (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            drive_file_id   TEXT UNIQUE,
            drive_name      TEXT NOT NULL,
            drive_view_link TEXT,
            student_id      TEXT NOT NULL,
            first_name      TEXT,
            last_name       TEXT,
            subject_id      INTEGER,
            subject_name    TEXT,
            uploaded_at     TEXT NOT NULL DEFAULT (datetime('now')),
            grade           REAL,
            graded_at       TEXT,
            FOREIGN KEY(subject_id) REFERENCES subjects(id)
        );
    `);

    // ── Grades Table ─────────────────────────────────────────
    db.exec(`
        CREATE TABLE IF NOT EXISTS grades (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id      TEXT NOT NULL,
            first_name      TEXT,
            last_name       TEXT,
            image_file      TEXT,
            drive_file_id   TEXT,
            mark            REAL NOT NULL,
            subject_id      INTEGER,
            subject_name    TEXT,
            graded_at       TEXT NOT NULL DEFAULT (datetime('now')),
            graded_by       TEXT DEFAULT 'admin',
            FOREIGN KEY(subject_id) REFERENCES subjects(id)
        );
    `);

    // ── Seed admin user if not exists ────────────────────────
    const adminId = process.env.ADMIN_USERNAME || 'admin';
    const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(adminId);
    if (!existing) {
        const hashed = bcrypt.hashSync(adminPw, 10);
        db.prepare(`
            INSERT INTO users (id, password, role, first_name, last_name, email)
            VALUES (?, ?, 'admin', 'Administrator', '', 'admin@eduvault.local')
        `).run(adminId, hashed);
        console.log(`✅ Admin user created: ${adminId}`);
    }

    // ── Seed demo students (dev mode only) ───────────────────
    if (process.env.NODE_ENV !== 'production') {
        const demos = [
            { id: 'STU001', first_name: 'Ahmed',   last_name: 'Hassan',   email: 'ahmed@demo.com',   pw: 'student123' },
            { id: 'STU002', first_name: 'Sara',    last_name: 'Ali',      email: 'sara@demo.com',    pw: 'student123' },
            { id: 'STU003', first_name: 'Mohamed', last_name: 'Ibrahim',  email: 'mohamed@demo.com', pw: 'student123' },
        ];
        const insertDemo = db.prepare(`
            INSERT OR IGNORE INTO users (id, password, role, first_name, last_name, email)
            VALUES (?, ?, 'student', ?, ?, ?)
        `);
        for (const d of demos) {
            const hashed = bcrypt.hashSync(d.pw, 10);
            insertDemo.run(d.id, hashed, d.first_name, d.last_name, d.email);
        }

        // Seed a demo subject if none exist
        const subjectCount = db.prepare('SELECT COUNT(*) as c FROM subjects').get();
        if (subjectCount.c === 0) {
            db.prepare(`
                INSERT OR IGNORE INTO subjects (name, folder_id, high_folder_id, sheet_id)
                VALUES (?, ?, ?, ?)
            `).run(
                'Computer Science',
                process.env.DRIVE_MAIN_FOLDER_ID || 'YOUR_FOLDER_ID',
                process.env.DRIVE_HIGH_ACHIEVERS_FOLDER_ID || 'YOUR_HIGH_FOLDER_ID',
                process.env.SHEETS_ID || ''
            );
            console.log('✅ Demo subject "Computer Science" seeded.');
        }
    }

    console.log('✅ Database initialized at:', DB_PATH);
    return db;
}

module.exports = { getDb, initializeDatabase };
