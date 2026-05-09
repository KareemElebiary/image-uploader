/* Resolve a subject row from client subjectId (numeric id or slug) and/or display name */

function normalizeSlug(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[\s()-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

function resolveSubjectRow(db, subjectId, subjectName) {
    if (subjectId != null && String(subjectId).trim() !== '') {
        const raw = String(subjectId).trim();
        if (/^[0-9]+$/.test(raw)) {
            const byNum = db.prepare('SELECT * FROM subjects WHERE id = ?').get(parseInt(raw, 10));
            if (byNum) return byNum;
        }
        const low = raw.toLowerCase();
        let row = db.prepare(`
            SELECT * FROM subjects
            WHERE LOWER(IFNULL(TRIM(slug), '')) = ?
        `).get(low);
        if (row) return row;
        row = db.prepare(`
            SELECT * FROM subjects
            WHERE LOWER(IFNULL(TRIM(slug), '')) = ?
        `).get(normalizeSlug(raw));
        if (row) return row;
        row = db.prepare(`
            SELECT * FROM subjects
            WHERE LOWER(TRIM(name)) = ?
        `).get(low);
        if (row) return row;
    }
    if (subjectName != null && String(subjectName).trim() !== '') {
        const nm = String(subjectName).trim();
        const row = db.prepare(`
            SELECT * FROM subjects
            WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
        `).get(nm);
        if (row) return row;
        const snake = normalizeSlug(nm);
        if (snake) {
            const bySnake = db.prepare(`
                SELECT * FROM subjects
                WHERE LOWER(IFNULL(TRIM(slug), '')) = ?
            `).get(snake);
            if (bySnake) return bySnake;
        }
    }
    return null;
}

module.exports = { resolveSubjectRow, normalizeSlug };
