// ─── 数据源(ChatBI)──────────────────────────────────────────────────────────
// 租户上传的结构化数据(SQLite / CSV / XLSX)统一落成 SQLite 文件,agent 通过
// in-process MCP 工具(list_datasources / query_datasource)只读查询。
// 只读保证在这一层强制:readOnly 连接 + 单条 SELECT/WITH 校验 + 行数/字节上限。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import readXlsxFile from 'read-excel-file/node';

export const MAX_DATASOURCE_UPLOAD_BYTES = 50 * 1024 * 1024;
export const DATASOURCE_QUERY_MAX_ROWS = 200;
export const DATASOURCE_QUERY_MAX_BYTES = 64 * 1024;
export const DATASOURCE_UPLOAD_EXTENSIONS = ['.sqlite', '.db', '.csv', '.xlsx'];

export type DatasourceColumn = { name: string; type: string };
export type DatasourceTable = { name: string; rowCount: number; columns: DatasourceColumn[] };

export function datasourceUploadFormat(filename: string): 'sqlite' | 'csv' | 'xlsx' | null {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.sqlite' || ext === '.db') return 'sqlite';
  if (ext === '.csv') return 'csv';
  if (ext === '.xlsx') return 'xlsx';
  return null;
}

// ─── CSV 解析(RFC4180 子集:引号、转义引号、跨行字段)──────────────────────
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

// SQLite 标识符统一走双引号包裹;这里只收敛字符集避免诡异表头,不做 SQL 拼接转义。
function sanitizeIdentifier(raw: unknown, fallback: string) {
  const cleaned = String(raw ?? '').trim()
    .replace(/[^\w一-鿿]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

function quoteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

function dedupeIdentifiers(names: string[]) {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

function cellToString(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

const INTEGER_RE = /^-?\d{1,15}$/;
const REAL_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function inferColumnType(values: string[]): 'INTEGER' | 'REAL' | 'TEXT' {
  let sawAny = false;
  let allInteger = true;
  let allReal = true;
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    sawAny = true;
    if (!INTEGER_RE.test(trimmed)) allInteger = false;
    if (!REAL_RE.test(trimmed)) allReal = false;
    if (!allReal) break;
  }
  if (!sawAny) return 'TEXT';
  if (allInteger) return 'INTEGER';
  if (allReal) return 'REAL';
  return 'TEXT';
}

type TabularSheet = { name: string; rows: string[][] };

// 表格(CSV 单表 / XLSX 每 sheet 一表)写入新建 SQLite。首行视为表头。
function importTabularToSqlite(sheets: TabularSheet[], destPath: string) {
  const db = new DatabaseSync(destPath);
  try {
    db.exec('BEGIN');
    const usedTableNames = new Set<string>();
    for (const [sheetIndex, sheet] of sheets.entries()) {
      if (!sheet.rows.length) continue;
      let tableName = sanitizeIdentifier(sheet.name, `table_${sheetIndex + 1}`);
      while (usedTableNames.has(tableName.toLowerCase())) tableName = `${tableName}_2`;
      usedTableNames.add(tableName.toLowerCase());

      const header = dedupeIdentifiers(
        sheet.rows[0].map((cell, index) => sanitizeIdentifier(cell, `col_${index + 1}`)),
      );
      const dataRows = sheet.rows.slice(1).map((cells) => header.map((_, index) => cellToString(cells[index])));
      const types = header.map((_, index) => inferColumnType(dataRows.map((cells) => cells[index])));

      const columnsDdl = header.map((name, index) => `${quoteIdentifier(name)} ${types[index]}`).join(', ');
      db.exec(`CREATE TABLE ${quoteIdentifier(tableName)} (${columnsDdl})`);
      if (!dataRows.length) continue;
      const placeholders = header.map(() => '?').join(', ');
      const insert = db.prepare(`INSERT INTO ${quoteIdentifier(tableName)} VALUES (${placeholders})`);
      for (const cells of dataRows) {
        insert.run(...cells.map((value, index) => {
          const trimmed = value.trim();
          if (!trimmed) return null;
          if (types[index] === 'INTEGER' || types[index] === 'REAL') {
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? parsed : trimmed;
          }
          return value;
        }));
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

async function xlsxBufferToSheets(buffer: Buffer): Promise<TabularSheet[]> {
  const parsed = await readXlsxFile(buffer) as unknown;
  const sheets = Array.isArray(parsed) && parsed.every((item) => item && typeof item === 'object' && 'data' in item)
    ? (parsed as Array<{ sheet?: string; data: unknown[][] }>).map((item, index) => ({
      name: item.sheet || `Sheet${index + 1}`,
      rows: item.data.map((cells) => cells.map(cellToString)),
    }))
    : [{ name: 'Sheet1', rows: (parsed as unknown[][]).map((cells) => cells.map(cellToString)) }];
  return sheets.filter((sheet) => sheet.rows.length > 0);
}

// 上传入口:任意支持格式 → destDir/data.sqlite,返回探查出的表结构。
export async function importDatasourceUpload(originalName: string, buffer: Buffer, destDir: string) {
  const format = datasourceUploadFormat(originalName);
  if (!format) throw new Error(`仅支持上传 ${DATASOURCE_UPLOAD_EXTENSIONS.join(' / ')} 文件`);
  fs.mkdirSync(destDir, { recursive: true });
  const dbPath = path.join(destDir, 'data.sqlite');
  if (format === 'sqlite') {
    fs.writeFileSync(dbPath, buffer);
  } else if (format === 'csv') {
    const baseName = sanitizeIdentifier(path.basename(originalName, path.extname(originalName)), 'table_1');
    importTabularToSqlite([{ name: baseName, rows: parseCsv(buffer.toString('utf8')) }], dbPath);
  } else {
    importTabularToSqlite(await xlsxBufferToSheets(buffer), dbPath);
  }
  let tables: DatasourceTable[];
  try {
    tables = inspectSqliteSchema(dbPath);
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw new Error(`不是有效的 SQLite 数据库: ${(error as Error).message || 'unknown'}`);
  }
  if (!tables.length) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw new Error('数据源没有任何表(文件为空或表头缺失)');
  }
  return { dbPath, format, tables };
}

export function inspectSqliteSchema(dbPath: string): DatasourceTable[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tableRows = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all() as Array<{ name: string }>;
    return tableRows.map(({ name }) => {
      const columns = (db.prepare('SELECT name, type FROM pragma_table_info(?)').all(name) as Array<{ name: string; type: string | null }>)
        .map((column) => ({ name: column.name, type: column.type || 'TEXT' }));
      let rowCount = 0;
      try {
        rowCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(name)}`).get() as { c: number }).c) || 0;
      } catch {}
      return { name, rowCount, columns };
    });
  } finally {
    db.close();
  }
}

// 只读校验:单条语句、SELECT/WITH 开头、禁 ATTACH/PRAGMA(防读宿主任意文件)。
// 写操作即使绕过关键字检查,也会被 readOnly 连接在执行层拒绝。
export function validateReadOnlySql(sql: string): { ok: true; sql: string } | { ok: false; reason: string } {
  const trimmed = String(sql || '').trim().replace(/;\s*$/, '');
  if (!trimmed) return { ok: false, reason: 'SQL 不能为空' };
  if (trimmed.includes(';')) return { ok: false, reason: '只允许执行单条语句' };
  if (!/^(select|with)\b/i.test(trimmed)) return { ok: false, reason: '只允许 SELECT / WITH 只读查询' };
  const banned = trimmed.match(/\b(attach|detach|pragma|vacuum|reindex)\b/i);
  if (banned) return { ok: false, reason: `查询中禁止使用 ${banned[1].toUpperCase()}` };
  return { ok: true, sql: trimmed };
}

export type DatasourceQueryResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
};

export function runDatasourceQuery(dbPath: string, sql: string): DatasourceQueryResult {
  const check = validateReadOnlySql(sql);
  if (!check.ok) throw new Error(check.reason);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const statement = db.prepare(check.sql);
    const rows: Array<Record<string, unknown>> = [];
    let truncated = false;
    for (const row of statement.iterate()) {
      if (rows.length >= DATASOURCE_QUERY_MAX_ROWS) { truncated = true; break; }
      rows.push(row as Record<string, unknown>);
    }
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows, rowCount: rows.length, truncated };
  } finally {
    db.close();
  }
}

// 序列化给工具输出/HTTP 响应,按字节上限截断行(保证 JSON 始终完整)。
export function serializeQueryResult(result: DatasourceQueryResult, maxBytes = DATASOURCE_QUERY_MAX_BYTES) {
  const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? Number(value) : value);
  let rows = result.rows;
  let truncated = result.truncated;
  let json = JSON.stringify({ columns: result.columns, rowCount: rows.length, truncated, rows }, replacer);
  while (Buffer.byteLength(json) > maxBytes && rows.length > 1) {
    rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
    truncated = true;
    json = JSON.stringify({ columns: result.columns, rowCount: rows.length, truncated, rows }, replacer);
  }
  return json;
}
