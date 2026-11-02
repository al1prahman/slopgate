import type { AddedLine, ChangedFile } from './types.js';

interface MutableFile {
  path: string;
  oldPath?: string;
  addedLines: AddedLine[];
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPathPrefix(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('a/') || value.startsWith('b/')) {
    return value.slice(2);
  }
  return value;
}

function pathFromHeader(rest: string): string {
  const match = /^a\/(.*) b\/(.*)$/.exec(rest);
  return match?.[2] ?? rest;
}

export function parseDiff(unifiedDiff: string): ChangedFile[] {
  const files: MutableFile[] = [];
  let current: MutableFile | null = null;
  let newLineNo = 0;

  for (const raw of unifiedDiff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      current = {
        path: pathFromHeader(raw.slice('diff --git '.length)),
        addedLines: [],
        isBinary: false,
        isNew: false,
        isDeleted: false,
      };
      files.push(current);
      newLineNo = 0;
      continue;
    }
    if (!current) {
      continue;
    }

    if (raw.startsWith('rename from ')) {
      current.oldPath = stripPathPrefix(raw.slice('rename from '.length));
    } else if (raw.startsWith('rename to ')) {
      current.path = stripPathPrefix(raw.slice('rename to '.length));
    } else if (raw.startsWith('new file mode')) {
      current.isNew = true;
    } else if (raw.startsWith('deleted file mode')) {
      current.isDeleted = true;
    } else if (raw.startsWith('Binary files ')) {
      current.isBinary = true;
    } else if (raw.startsWith('--- ')) {
      if (raw.slice(4).trim() === '/dev/null') {
        current.isNew = true;
      }
    } else if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      if (target !== '/dev/null') {
        current.path = stripPathPrefix(target);
      }
    } else if (raw.startsWith('@@')) {
      const match = HUNK_HEADER.exec(raw);
      newLineNo = match ? Number(match[1]) : 0;
    } else if (raw.startsWith('+')) {
      current.addedLines.push({ line: newLineNo, content: raw.slice(1) });
      newLineNo += 1;
    } else if (raw.startsWith('-')) {
      // Removed line: does not exist in the new file, counter stays put.
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" marker.
    } else if (raw.startsWith(' ')) {
      newLineNo += 1;
    }
  }

  return files;
}
