'use strict';

/**
 * Small filesystem helpers shared across modules.
 */

const fs = require('fs');
const path = require('path');

/**
 * Writes a file atomically: the data is written to a sibling temp file first
 * and then renamed over the destination. Rename is atomic on the same volume
 * (POSIX rename(2); Windows MoveFileEx via libuv), so a reader or a crash can
 * never observe a half-written file — you get either the old contents or the
 * new ones, never a truncated mix.
 *
 * The temp file lives in the SAME directory as the destination so the rename
 * stays on one filesystem (a cross-device rename would fall back to a
 * non-atomic copy). Best-effort cleanup of the temp file on failure.
 *
 * @param {string} filePath  destination path
 * @param {string|Buffer} data  contents to write
 */
function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  // Unique per-process temp name so concurrent writers can't clobber each other.
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw e;
  }
}

module.exports = { writeFileAtomic };
