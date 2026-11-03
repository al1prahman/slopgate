import { readBlob } from './git.js';
import type { ChangedFile } from './types.js';

// git reports UTF-16 text as binary — "Binary files ... differ", no
// numstat — so every scanner in this package skips it. On Windows that
// encoding is the default for files written through PowerShell
// redirection or Notepad's "Unicode" save, which means a secret committed
// from such a file was silently invisible to the gate.
//
// For a NEW file the blob at the scan's end ref is the whole file: decode
// it and treat every line as added. Modified UTF-16 files stay skipped —
// git exposes no line structure to recover which lines are new, and
// guessing would either miss lines or invent findings.

export function hydrateUtf16NewFiles(
  files: readonly ChangedFile[],
  cwd: string,
  endRef: string,
): ChangedFile[] {
  return files.map((file) => {
    if (!file.isBinary || !file.isNew || file.isDeleted) return file;

    const blob = readBlob(cwd, endRef, file.path);
    const text = blob === null ? null : decodeUtf16(blob);
    if (text === null) return file;

    const lines = text.split(/\r?\n/);
    // A trailing newline yields an empty final element; it is not a line.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    return {
      ...file,
      isBinary: false,
      addedLines: lines.map((content, index) => ({ line: index + 1, content })),
    };
  });
}

// BOM-marked UTF-16 only: that is what PowerShell and Notepad write, and
// without a BOM the bytes are indistinguishable from arbitrary binary.
// Returns null for anything that is not BOM-marked UTF-16.
export function decodeUtf16(buf: Buffer): string | null {
  if (buf.length < 2) return null;

  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le', 2);
  }

  if (buf[0] === 0xfe && buf[1] === 0xff) {
    // Node has no utf16be codec; swap each pair and read it as LE.
    const swapped = Buffer.from(buf);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const low = swapped[i] as number;
      const high = swapped[i + 1] as number;
      swapped[i] = high;
      swapped[i + 1] = low;
    }
    return swapped.toString('utf16le', 2);
  }

  return null;
}

// The ref holding the "new" side of a range: HEAD~3..HEAD -> HEAD,
// A...B -> B. A bare revision diffs against the working tree, so the
// revision itself is the end.
export function rangeEndRef(range: string): string {
  const separator = range.includes('...') ? '...' : '..';
  const index = range.indexOf(separator);
  if (index === -1) return range.trim() || 'HEAD';
  return range.slice(index + separator.length).trim() || 'HEAD';
}
