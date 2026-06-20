import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";

export async function openIndexDatabase({ configRoot, previewRoot, thumbnailRoot }) {
  await mkdir(configRoot, { recursive: true });
  await mkdir(thumbnailRoot, { recursive: true });
  await mkdir(previewRoot, { recursive: true });
  const database = new Database(join(configRoot, "komios.db"));
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    create table if not exists files (
      path text primary key,
      display_path text not null,
      name text not null,
      kind text not null,
      mime text not null,
      size integer,
      mtime_ms real,
      indexed_at integer not null
    );

    create index if not exists files_kind_idx on files(kind);
    create index if not exists files_indexed_at_idx on files(indexed_at);

    create table if not exists media_info (
      path text primary key references files(path) on delete cascade,
      size integer not null,
      mtime_ms real not null,
      payload_json text not null,
      probed_at integer not null
    );

    create table if not exists thumbnails (
      path text primary key references files(path) on delete cascade,
      size integer not null,
      mtime_ms real not null,
      thumb_path text not null,
      width integer,
      height integer,
      generated_at integer not null
    );

    create table if not exists auth_users (
      username text primary key,
      password_hash text not null,
      password_salt text not null,
      password_iterations integer not null,
      updated_at integer not null
    );

    create table if not exists auth_sessions (
      token_hash text primary key,
      username text not null references auth_users(username) on delete cascade,
      expires_at integer not null,
      created_at integer not null,
      last_seen_at integer not null
    );

    create index if not exists auth_sessions_expires_at_idx on auth_sessions(expires_at);
  `);
  return database;
}

export function createIndexStatements(db) {
  return {
    fileByPath: db.prepare("select path, display_path, name, kind, mime, size, mtime_ms, indexed_at from files where path = ?"),
    upsertFile: db.prepare(`
      insert into files(path, display_path, name, kind, mime, size, mtime_ms, indexed_at)
      values(@path, @display_path, @name, @kind, @mime, @size, @mtime_ms, @indexed_at)
      on conflict(path) do update set
        display_path = excluded.display_path,
        name = excluded.name,
        kind = excluded.kind,
        mime = excluded.mime,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `),
    mediaByPath: db.prepare("select payload_json, size, mtime_ms, probed_at from media_info where path = ?"),
    upsertMedia: db.prepare(`
      insert into media_info(path, size, mtime_ms, payload_json, probed_at)
      values(@path, @size, @mtime_ms, @payload_json, @probed_at)
      on conflict(path) do update set
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        payload_json = excluded.payload_json,
        probed_at = excluded.probed_at
    `),
    thumbnailByPath: db.prepare("select thumb_path, size, mtime_ms, width, height, generated_at from thumbnails where path = ?"),
    upsertThumbnail: db.prepare(`
      insert into thumbnails(path, size, mtime_ms, thumb_path, width, height, generated_at)
      values(@path, @size, @mtime_ms, @thumb_path, @width, @height, @generated_at)
      on conflict(path) do update set
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        thumb_path = excluded.thumb_path,
        width = excluded.width,
        height = excluded.height,
        generated_at = excluded.generated_at
    `),
    stats: db.prepare(`
      select
        (select count(*) from files) as files,
        (select count(*) from media_info) as media,
        (select count(*) from thumbnails) as thumbnails,
        (select count(*) from auth_sessions where expires_at > unixepoch() * 1000) as activeSessions
    `),
    authUserByUsername: db.prepare("select username, password_hash, password_salt, password_iterations, updated_at from auth_users where username = ?"),
    upsertAuthUser: db.prepare(`
      insert into auth_users(username, password_hash, password_salt, password_iterations, updated_at)
      values(@username, @password_hash, @password_salt, @password_iterations, @updated_at)
      on conflict(username) do update set
        password_hash = excluded.password_hash,
        password_salt = excluded.password_salt,
        password_iterations = excluded.password_iterations,
        updated_at = excluded.updated_at
    `),
    authSessionByTokenHash: db.prepare("select token_hash, username, expires_at, created_at, last_seen_at from auth_sessions where token_hash = ?"),
    upsertAuthSession: db.prepare(`
      insert into auth_sessions(token_hash, username, expires_at, created_at, last_seen_at)
      values(@token_hash, @username, @expires_at, @created_at, @last_seen_at)
      on conflict(token_hash) do update set
        username = excluded.username,
        expires_at = excluded.expires_at,
        last_seen_at = excluded.last_seen_at
    `),
    touchAuthSession: db.prepare("update auth_sessions set last_seen_at = @last_seen_at where token_hash = @token_hash"),
    deleteAuthSession: db.prepare("delete from auth_sessions where token_hash = ?"),
    deleteExpiredAuthSessions: db.prepare("delete from auth_sessions where expires_at <= ?"),
  };
}
