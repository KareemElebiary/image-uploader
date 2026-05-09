/* ============================================================
   EduVault – Google Drive & Sheets Integration
   Provides helper functions to interact with:
     • Google Drive API (upload, list, copy files)
     • Google Sheets API (read/write grades)
   
   Authentication: Service Account (recommended) or falls back
   to a simulated mode when credentials aren't configured.
   ============================================================ */

const path = require('path');
const fs = require('fs');

let google;
let auth;
let driveClient;
let sheetsClient;
let googleReady = false;

/* ── Initialize Google Auth ─────────────────────────────── */
async function initGoogleAuth() {
    if (googleReady) return;

    try {
        const { google: googleLib } = require('googleapis');
        google = googleLib;

        const SCOPES = [
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/spreadsheets',
        ];

        // Option A: credentials provided as a JSON string env var (Railway/Render/cloud hosting)
        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            let credentials;
            try {
                credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            } catch (parseErr) {
                console.error('❌ GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:', parseErr.message);
                return;
            }
            // Fix: Render/Railway often double-escapes \n in private keys → restore real newlines
            if (credentials.private_key) {
                credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
            }
            auth = new google.auth.GoogleAuth({
                credentials,
                scopes: SCOPES,
            });
            driveClient = google.drive({ version: 'v3', auth });
            sheetsClient = google.sheets({ version: 'v4', auth });
            googleReady = true;
            console.log('✅ Google APIs initialized via GOOGLE_SERVICE_ACCOUNT_JSON env var');
            return;
        }

        // Option B: key file on disk (local development)
        const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
            path.join(__dirname, '..', 'google-service-account.json');

        if (fs.existsSync(keyFilePath)) {
            auth = new google.auth.GoogleAuth({
                keyFile: keyFilePath,
                scopes: SCOPES,
            });
            driveClient = google.drive({ version: 'v3', auth });
            sheetsClient = google.sheets({ version: 'v4', auth });
            googleReady = true;
            console.log('✅ Google APIs initialized via Service Account key file');
        } else {
            console.warn('⚠️  No Google credentials found.');
            console.warn('   Set GOOGLE_SERVICE_ACCOUNT_JSON env var (for Railway)');
            console.warn('   or place google-service-account.json in the backend folder (for local dev).');
        }
    } catch (err) {
        console.error('❌ Google API init error:', err.message);
    }
}

/* ── Upload file to Google Drive ────────────────────────── */
async function uploadFileToDrive(fileBuffer, fileName, mimeType, folderId) {
    if (!googleReady) {
        // Simulate upload in dev mode
        const fakeId = `sim_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        return {
            id: fakeId,
            name: fileName,
            webViewLink: `https://drive.google.com/file/d/${fakeId}/view`,
            simulated: true
        };
    }

    const { Readable } = require('stream');
    const readableStream = Readable.from(fileBuffer);

    console.log(`📁 Uploading "${fileName}" to folder: ${folderId || '(root - no folder set!)'}`);

    if (!folderId) {
        throw new Error('No Drive folder ID provided. Set DRIVE_MAIN_FOLDER_ID env var on Render.');
    }

    const res = await driveClient.files.create({
        requestBody: {
            name: fileName,
            parents: [folderId],
        },
        media: {
            mimeType,
            body: readableStream,
        },
        fields: 'id, name, webViewLink, createdTime',
        supportsAllDrives: true,
    });

    // Make file readable by anyone with the link
    await driveClient.permissions.create({
        fileId: res.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
        supportsAllDrives: true,
    });

    return res.data;
}

/* ── List files in a Drive folder ───────────────────────── */
async function listDriveFolder(folderId) {
    if (!googleReady) return [];

    const res = await driveClient.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name, webViewLink, thumbnailLink, createdTime)',
        orderBy: 'createdTime desc',
        pageSize: 200,
    });

    return res.data.files || [];
}

/* ── Copy a file to another Drive folder ────────────────── */
async function copyDriveFile(fileId, destFolderId) {
    if (!googleReady) return { id: `copy_${fileId}`, simulated: true };

    const res = await driveClient.files.copy({
        fileId,
        requestBody: { parents: [destFolderId] },
        fields: 'id, name',
    });

    return res.data;
}

/* ── Delete a Drive file ────────────────────────────────── */
async function deleteDriveFile(fileId) {
    if (!googleReady) return { success: true, simulated: true };
    await driveClient.files.delete({ fileId });
    return { success: true };
}

const SHEET_HEADERS = [['Student ID', 'First Name', 'Last Name', 'Image File', 'Mark %', 'Graded At']];

function sanitizeSheetTabTitle(raw) {
    let s = String(raw ?? 'Grades')
        .replace(/[\\/:?*\[\]\u0000-\u001f]/g, '-')
        .replace(/^'+|'+$/g, '')
        .trim()
        .slice(0, 99);
    return s || 'Grades';
}

/** Extract spreadsheet ID if user pasted full docs.google.com URL */
function normalizeSpreadsheetId(id) {
    if (id == null || id === '') return null;
    const s = typeof id === 'string' ? id.trim() : String(id).trim();
    const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return (m ? m[1] : s) || null;
}

/** Sheet tab segment for A1 notation (quotes added only when needed) */
function escapeSheetTitle(title) {
    const inner = String(title).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return inner;
    return `'${inner.replace(/'/g, "''")}'`;
}

/** Ensure worksheet exists; seed header row on brand-new tabs only */
async function ensureGradeSheetTabReady(spreadsheetId, desiredTitle) {
    if (!sheetsClient || !spreadsheetId) return;

    const sid = normalizeSpreadsheetId(spreadsheetId);
    if (!sid) return;

    const title = sanitizeSheetTabTitle(desiredTitle);
    const meta = await sheetsClient.spreadsheets.get({
        spreadsheetId: sid,
        fields: 'sheets.properties(sheetId,title)'
    });

    const sheets = meta.data.sheets || [];
    const exists = sheets.some(s => s.properties && s.properties.title === title);

    if (!exists) {
        try {
            await sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId: sid,
                requestBody: {
                    requests: [{ addSheet: { properties: { title } } }]
                }
            });
        } catch (e) {
            const msg = String(e.message || e);
            if (!/already exists|duplicate/i.test(msg)) throw e;
        }
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: sid,
            range: `${escapeSheetTitle(title)}!A1:F1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: SHEET_HEADERS }
        });
        return;
    }

    const head = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${escapeSheetTitle(title)}!A1:F1`
    }).catch(() => ({ data: {} }));

    const row = head.data.values && head.data.values[0];
    if (!row || row.length === 0 || !(row[0] && String(row[0]).trim())) {
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: sid,
            range: `${escapeSheetTitle(title)}!A1:F1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: SHEET_HEADERS }
        });
    }
}

/* ── Append a grade row to Google Sheets ────────────────── */
async function appendGradeToSheets({ sheetId, tabName, studentId, firstName, lastName, imageFile, mark, gradedAt }) {
    if (!sheetsClient) {
        console.warn('⚠️  Sheets: skipped append (Google Sheets API not initialized — check service account credentials).');
        return { success: false, simulated: true };
    }

    const spreadsheetId = normalizeSpreadsheetId(sheetId || process.env.SHEETS_ID);
    const rawTab = tabName || process.env.SHEETS_TAB_GRADES || 'Grades';

    if (!spreadsheetId) {
        const err = new Error('Missing spreadsheet id — set SHEETS_ID (or subject sheetId) on the server.');
        console.error('⚠️  Sheets:', err.message);
        throw err;
    }

    await ensureGradeSheetTabReady(spreadsheetId, rawTab).catch(err => {
        console.error('⚠️  Sheets tab setup failed:', err.message, err.errors || '');
        throw err;
    });

    const safeTab = sanitizeSheetTabTitle(rawTab);
    const range = `${escapeSheetTitle(safeTab)}!A:F`;

    const values = [[
        studentId, firstName, lastName, imageFile, mark, gradedAt || new Date().toLocaleString()
    ]];

    await sheetsClient.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
    });

    return { success: true };
}

/* ── Read all grades from Google Sheets ─────────────────── */
async function readGradesFromSheets(sheetId, tabName) {
    if (!sheetsClient) return [];

    const t = sanitizeSheetTabTitle(tabName || 'Grades');
    const sid = normalizeSpreadsheetId(sheetId || process.env.SHEETS_ID);
    if (!sid) return [];

    const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${escapeSheetTitle(t)}!A:F`,
    });

    return res.data.values || [];
}

/* ── Write user list from DB to Sheets (sync helper) ─────── */
async function syncUsersToSheets(users) {
    if (!sheetsClient) return { simulated: true };

    const values = [
        ['ID', 'Password', 'Role', 'First Name', 'Last Name'],
        ...users.map(u => [u.id, u.password, u.role, u.first_name, u.last_name])
    ];

    await sheetsClient.spreadsheets.values.update({
        spreadsheetId: process.env.SHEETS_ID,
        range: `${process.env.SHEETS_TAB_USERS || 'Users'}!A:E`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
    });

    return { success: true };
}

module.exports = {
    initGoogleAuth,
    uploadFileToDrive,
    listDriveFolder,
    copyDriveFile,
    deleteDriveFile,
    appendGradeToSheets,
    readGradesFromSheets,
    syncUsersToSheets,
    sanitizeSheetTabTitle,
    isGoogleReady: () => googleReady,
};
