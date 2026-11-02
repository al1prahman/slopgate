export type Severity = 'block' | 'warn' | 'info';

export interface AddedLine {
  readonly line: number;
  readonly content: string;
}

export interface ChangedFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly addedLines: readonly AddedLine[];
  readonly isBinary: boolean;
  readonly isNew: boolean;
  readonly isDeleted: boolean;
}

export interface Finding {
  readonly severity: Severity;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly suggestion?: string;
  readonly evidence?: string;
}

export interface ScanResult {
  readonly findings: readonly Finding[];
  readonly filesScanned: number;
  readonly linesAdded: number;
  readonly cacheHits: number;
  readonly durationMs: number;
  readonly verdict: 'pass' | 'warn' | 'block';
}
