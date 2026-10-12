/** Layout of a backup archive, shared by backup.ts and restore.ts. */
export const ARCHIVE_MANIFEST = "catmemes-backup.json";
export const ARCHIVE_DB = "gatos.db";
export const ARCHIVE_MEDIA = "media/";

/** Same rule the server applies to media keys; anything else in an archive is ignored. */
export const MEDIA_NAME = /^[A-Za-z0-9_.-]+$/;

export const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
export const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
