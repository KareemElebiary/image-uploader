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

        // Option A: credentials provided as a JSON string env var (Railway/cloud hosting)
        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            let credentials;
            try {
                credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            } catch (parseErr) {
                console.error('❌ GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:', parseErr.message);
                return;
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

    const res = await driveClient.files.create({
        requestBody: {
            name: fileName,
            parents: folderId ? [folderId] : [],
        },
        media: {
            mimeType,
            body: readableStream,
        },
        fields: 'id, name, webViewLink, createdTime',
    });

    // Make file readable by anyone with the link
    await driveClient.permissions.create({
        fileId: res.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
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

/* ── Append a grade row to Google Sheets ────────────────── */
async function appendGradeToSheets({ sheetId, tabName, studentId, firstName, lastName, imageFile, mark, subject, gradedAt }) {
    if (!sheetsClient) return { success: true, simulated: true };

    const values = [[
        studentId, firstName, lastName, imageFile, mark, gradedAt || new Date().toLocaleString(), subject
    ]];

    await sheetsClient.spreadsheets.values.append({
        spreadsheetId: sheetId || process.env.SHEETS_ID,
        range: `${tabName || 'Grades'}!A:G`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
    });

    return { success: true };
}

/* ── Read all grades from Google Sheets ─────────────────── */
async function readGradesFromSheets(sheetId, tabName) {
    if (!sheetsClient) return [];

    const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId || process.env.SHEETS_ID,
        range: `${tabName || 'Grades'}!A:G`,
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
    isGoogleReady: () => googleReady,
};
