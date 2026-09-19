import type { DramaBatch, DramaReferenceAsset, DramaSegment, DramaSourceAnalysis } from "./drama-production";
import { desktopDatabase, rebaseLocalMedia, type D1Database } from './desktop-platform';

export type DramaIdentity = { teamId: string; userId: string; projectId?: string | null };

export class DramaStoreAccessError extends Error {}

const memoryBatches = new Map<string, DramaBatch>();
let schemaReady: Promise<void> | null = null;

async function database(): Promise<D1Database | null> {
  return desktopDatabase();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function emptyDramaAnalysis(): DramaSourceAnalysis {
  return {
    status: "pending",
    job_id: null,
    analyzer_version: "dramaforge-media-v1",
    detected_language: null,
    media: null,
    shots: [],
    transcript: [],
    ocr_texts: [],
    characters: [],
    scenes: [],
    started_at: null,
    completed_at: null,
    transient_cleanup: { status: "pending", attempted_at: null, message: null },
    failure: null,
  };
}

async function ensureSchema(db: D1Database) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS drama_batches (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        project_id TEXT,
        source_name TEXT NOT NULL,
        source_duration_seconds INTEGER NOT NULL,
        source_asset_json TEXT NOT NULL,
        rights_confirmed_at TEXT NOT NULL DEFAULT 'legacy-unverified',
        rights_statement_version TEXT NOT NULL DEFAULT 'legacy-unverified',
        rights_evidence_reference TEXT,
        target_type TEXT NOT NULL,
        processing_mode TEXT NOT NULL,
        model TEXT NOT NULL,
        resolution TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL,
        source_language TEXT NOT NULL DEFAULT 'zh-CN',
        target_language TEXT NOT NULL DEFAULT 'zh-CN',
        analysis_json TEXT,
        storyboard_assets_json TEXT,
        storyboard_assets_confirmed_at TEXT,
        subtitle_layout_confirmed_at TEXT,
        auto_review_enabled INTEGER NOT NULL DEFAULT 0,
        max_auto_regenerations INTEGER NOT NULL DEFAULT 1,
        retry_budget_confirmed_at TEXT,
        status TEXT NOT NULL,
        estimated_points INTEGER NOT NULL,
        assembly_job_id TEXT,
        assembly_url TEXT,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS drama_segments (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        source_start_seconds INTEGER NOT NULL DEFAULT 0,
        source_end_seconds INTEGER NOT NULL DEFAULT 0,
        source_asset_json TEXT,
        capability TEXT NOT NULL,
        storyboard_status TEXT NOT NULL DEFAULT 'pending',
        storyboard_asset_json TEXT,
        storyboard_review_status TEXT NOT NULL DEFAULT 'pending',
        storyboard_revision INTEGER NOT NULL DEFAULT 0,
        storyboard_failure_json TEXT,
        review_status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        job_id TEXT,
        job_status TEXT,
        result_url TEXT,
        quality_review_json TEXT,
        auto_regeneration_count INTEGER NOT NULL DEFAULT 0,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_drama_batches_team_updated ON drama_batches(team_id, updated_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_drama_batches_project_updated ON drama_batches(project_id, updated_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_drama_segments_batch_position ON drama_segments(batch_id, position)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_drama_segments_batch_job_status ON drama_segments(batch_id, job_status)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS drama_reference_assets (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        asset_json TEXT NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_drama_reference_assets_batch_kind ON drama_reference_assets(batch_id, kind)"),
    ]);
    const segmentColumns = await db.prepare("PRAGMA table_info(drama_segments)").all<{ name: string }>();
    const existing = new Set(segmentColumns.results.map((column) => column.name));
    if (!existing.has("source_start_seconds")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN source_start_seconds INTEGER NOT NULL DEFAULT 0").run();
    if (!existing.has("source_end_seconds")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN source_end_seconds INTEGER NOT NULL DEFAULT 0").run();
    if (!existing.has("source_asset_json")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN source_asset_json TEXT").run();
    if (!existing.has("storyboard_status")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN storyboard_status TEXT NOT NULL DEFAULT 'pending'").run();
    if (!existing.has("storyboard_asset_json")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN storyboard_asset_json TEXT").run();
    if (!existing.has("storyboard_review_status")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN storyboard_review_status TEXT NOT NULL DEFAULT 'pending'").run();
    if (!existing.has("storyboard_revision")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN storyboard_revision INTEGER NOT NULL DEFAULT 0").run();
    if (!existing.has("storyboard_failure_json")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN storyboard_failure_json TEXT").run();
    if (!existing.has("quality_review_json")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN quality_review_json TEXT").run();
    if (!existing.has("auto_regeneration_count")) await db.prepare("ALTER TABLE drama_segments ADD COLUMN auto_regeneration_count INTEGER NOT NULL DEFAULT 0").run();
    const batchColumns = await db.prepare("PRAGMA table_info(drama_batches)").all<{ name: string }>();
    const existingBatchColumns = new Set(batchColumns.results.map((column) => column.name));
    if (!existingBatchColumns.has("rights_confirmed_at")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN rights_confirmed_at TEXT NOT NULL DEFAULT 'legacy-unverified'").run();
    if (!existingBatchColumns.has("rights_statement_version")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN rights_statement_version TEXT NOT NULL DEFAULT 'legacy-unverified'").run();
    if (!existingBatchColumns.has("rights_evidence_reference")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN rights_evidence_reference TEXT").run();
    if (!existingBatchColumns.has("storyboard_assets_json")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN storyboard_assets_json TEXT").run();
    if (!existingBatchColumns.has("storyboard_assets_confirmed_at")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN storyboard_assets_confirmed_at TEXT").run();
    if (!existingBatchColumns.has("subtitle_layout_confirmed_at")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN subtitle_layout_confirmed_at TEXT").run();
    if (!existingBatchColumns.has("source_language")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN source_language TEXT NOT NULL DEFAULT 'zh-CN'").run();
    if (!existingBatchColumns.has("target_language")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN target_language TEXT NOT NULL DEFAULT 'zh-CN'").run();
    if (!existingBatchColumns.has("analysis_json")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN analysis_json TEXT").run();
    if (!existingBatchColumns.has("auto_review_enabled")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN auto_review_enabled INTEGER NOT NULL DEFAULT 0").run();
    if (!existingBatchColumns.has("max_auto_regenerations")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN max_auto_regenerations INTEGER NOT NULL DEFAULT 1").run();
    if (!existingBatchColumns.has("retry_budget_confirmed_at")) await db.prepare("ALTER TABLE drama_batches ADD COLUMN retry_budget_confirmed_at TEXT").run();
    await db.prepare("PRAGMA optimize").run();
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function assertOwnership(batch: DramaBatch, identity: DramaIdentity) {
  if (batch.team_id !== identity.teamId) throw new DramaStoreAccessError("无权访问其他团队的短剧项目");
  if (identity.projectId && batch.project_id && identity.projectId !== batch.project_id) {
    throw new DramaStoreAccessError("短剧项目不属于当前主站项目");
  }
}

function mapSegment(row: Record<string, unknown>): DramaSegment {
  return {
    id: String(row.id),
    batch_id: String(row.batch_id),
    position: Number(row.position),
    title: String(row.title),
    prompt: String(row.prompt),
    duration_seconds: Number(row.duration_seconds),
    source_start_seconds: Number(row.source_start_seconds || 0),
    source_end_seconds: Number(row.source_end_seconds || row.duration_seconds || 0),
    source_asset: row.source_asset_json ? JSON.parse(String(row.source_asset_json)) : null,
    capability: "multi_reference",
    storyboard_status: String(row.storyboard_status || "pending") as DramaSegment["storyboard_status"],
    storyboard_asset: row.storyboard_asset_json ? JSON.parse(String(row.storyboard_asset_json)) : null,
    storyboard_review_status: String(row.storyboard_review_status || "pending") as DramaSegment["storyboard_review_status"],
    storyboard_revision: Number(row.storyboard_revision || 0),
    storyboard_failure: row.storyboard_failure_json ? JSON.parse(String(row.storyboard_failure_json)) : null,
    review_status: String(row.review_status) as DramaSegment["review_status"],
    revision: Number(row.revision),
    job_id: row.job_id ? String(row.job_id) : null,
    job_status: row.job_status ? String(row.job_status) as DramaSegment["job_status"] : null,
    result_url: row.result_url ? String(row.result_url) : null,
    quality_review: row.quality_review_json ? JSON.parse(String(row.quality_review_json)) : null,
    auto_regeneration_count: Number(row.auto_regeneration_count || 0),
    failure: row.failure_json ? JSON.parse(String(row.failure_json)) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapReferenceAsset(row: Record<string, unknown>): DramaReferenceAsset {
  return {
    id: String(row.id),
    batch_id: String(row.batch_id),
    kind: String(row.kind) as DramaReferenceAsset["kind"],
    name: String(row.name),
    description: String(row.description),
    asset: JSON.parse(String(row.asset_json)),
    review_status: String(row.review_status || "pending") as DramaReferenceAsset["review_status"],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapBatch(row: Record<string, unknown>, segments: DramaSegment[], referenceAssets: DramaReferenceAsset[] = []): DramaBatch {
  return rebaseLocalMedia({
    id: String(row.id),
    team_id: String(row.team_id),
    user_id: String(row.user_id),
    project_id: row.project_id ? String(row.project_id) : null,
    source_name: String(row.source_name),
    source_duration_seconds: Number(row.source_duration_seconds),
    source_asset: JSON.parse(String(row.source_asset_json)),
    rights_confirmed_at: String(row.rights_confirmed_at || "legacy-unverified"),
    rights_statement_version: String(row.rights_statement_version || "legacy-unverified"),
    rights_evidence_reference: row.rights_evidence_reference ? String(row.rights_evidence_reference) : null,
    target_type: String(row.target_type) as DramaBatch["target_type"],
    processing_mode: String(row.processing_mode) as DramaBatch["processing_mode"],
    model: String(row.model),
    resolution: String(row.resolution) as DramaBatch["resolution"],
    aspect_ratio: String(row.aspect_ratio) as DramaBatch["aspect_ratio"],
    source_language: String(row.source_language || "zh-CN") as DramaBatch["source_language"],
    target_language: String(row.target_language || "zh-CN") as DramaBatch["target_language"],
    analysis: row.analysis_json ? JSON.parse(String(row.analysis_json)) : emptyDramaAnalysis(),
    storyboard_assets: row.storyboard_assets_json ? JSON.parse(String(row.storyboard_assets_json)) : { characters: "", scenes: "", props: "", visual_style: "", continuity_notes: "" },
    reference_assets: referenceAssets,
    storyboard_assets_confirmed_at: row.storyboard_assets_confirmed_at ? String(row.storyboard_assets_confirmed_at) : null,
    subtitle_layout_confirmed_at: row.subtitle_layout_confirmed_at ? String(row.subtitle_layout_confirmed_at) : null,
    auto_review_enabled: Boolean(Number(row.auto_review_enabled || 0)),
    max_auto_regenerations: Math.max(1, Math.min(5, Number(row.max_auto_regenerations || 1))) as DramaBatch["max_auto_regenerations"],
    retry_budget_confirmed_at: row.retry_budget_confirmed_at ? String(row.retry_budget_confirmed_at) : null,
    status: String(row.status) as DramaBatch["status"],
    estimated_points: Number(row.estimated_points),
    assembly_job_id: row.assembly_job_id ? String(row.assembly_job_id) : null,
    assembly_url: row.assembly_url ? String(row.assembly_url) : null,
    failure: row.failure_json ? JSON.parse(String(row.failure_json)) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    segments,
  } as DramaBatch);
}

export async function createDramaBatchRecord(batch: DramaBatch) {
  const db = await database();
  if (!db) {
    memoryBatches.set(batch.id, clone(batch));
    return clone(batch);
  }
  await ensureSchema(db);
  await db.batch([
    db.prepare(`INSERT INTO drama_batches (
      id, team_id, user_id, project_id, source_name, source_duration_seconds, source_asset_json,
      rights_confirmed_at, rights_statement_version, rights_evidence_reference,
      target_type, processing_mode, model, resolution, aspect_ratio, source_language, target_language, analysis_json,
      storyboard_assets_json, storyboard_assets_confirmed_at, subtitle_layout_confirmed_at,
      auto_review_enabled, max_auto_regenerations, retry_budget_confirmed_at, status, estimated_points,
      assembly_job_id, assembly_url, failure_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      batch.id, batch.team_id, batch.user_id, batch.project_id, batch.source_name,
      batch.source_duration_seconds, JSON.stringify(batch.source_asset), batch.rights_confirmed_at,
      batch.rights_statement_version, batch.rights_evidence_reference, batch.target_type,
      batch.processing_mode, batch.model, batch.resolution, batch.aspect_ratio, batch.source_language, batch.target_language, JSON.stringify(batch.analysis),
      JSON.stringify(batch.storyboard_assets), batch.storyboard_assets_confirmed_at, batch.subtitle_layout_confirmed_at,
      batch.auto_review_enabled ? 1 : 0, batch.max_auto_regenerations, batch.retry_budget_confirmed_at, batch.status,
      batch.estimated_points, batch.assembly_job_id, batch.assembly_url, batch.failure ? JSON.stringify(batch.failure) : null,
      batch.created_at, batch.updated_at,
    ),
    ...batch.segments.map((segment) => db.prepare(`INSERT INTO drama_segments (
      id, batch_id, position, title, prompt, duration_seconds, source_start_seconds, source_end_seconds,
      source_asset_json, capability, storyboard_status, storyboard_asset_json, storyboard_review_status, storyboard_revision, storyboard_failure_json,
      review_status, revision, job_id, job_status, result_url, quality_review_json, auto_regeneration_count, failure_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      segment.id, segment.batch_id, segment.position, segment.title, segment.prompt,
      segment.duration_seconds, segment.source_start_seconds, segment.source_end_seconds,
      segment.source_asset ? JSON.stringify(segment.source_asset) : null, segment.capability,
      segment.storyboard_status, segment.storyboard_asset ? JSON.stringify(segment.storyboard_asset) : null, segment.storyboard_review_status,
      segment.storyboard_revision, segment.storyboard_failure ? JSON.stringify(segment.storyboard_failure) : null,
      segment.review_status, segment.revision,
      segment.job_id, segment.job_status, segment.result_url,
      segment.quality_review ? JSON.stringify(segment.quality_review) : null, segment.auto_regeneration_count,
      segment.failure ? JSON.stringify(segment.failure) : null, segment.created_at, segment.updated_at,
    )),
    ...batch.reference_assets.map((asset) => db.prepare(`INSERT INTO drama_reference_assets (
      id, batch_id, kind, name, description, asset_json, review_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      asset.id, batch.id, asset.kind, asset.name, asset.description, JSON.stringify(asset.asset), asset.review_status, asset.created_at, asset.updated_at,
    )),
  ]);
  return batch;
}

export async function getDramaBatchRecord(identity: DramaIdentity, batchId: string) {
  const db = await database();
  if (!db) {
    const batch = memoryBatches.get(batchId);
    if (!batch) return null;
    assertOwnership(batch, identity);
    return clone(batch);
  }
  await ensureSchema(db);
  const batchRow = await db.prepare("SELECT * FROM drama_batches WHERE id = ?").bind(batchId).first<Record<string, unknown>>();
  if (!batchRow) return null;
  const segmentRows = await db.prepare("SELECT * FROM drama_segments WHERE batch_id = ? ORDER BY position ASC").bind(batchId).all<Record<string, unknown>>();
  const referenceRows = await db.prepare("SELECT * FROM drama_reference_assets WHERE batch_id = ? ORDER BY kind, created_at ASC").bind(batchId).all<Record<string, unknown>>();
  const batch = mapBatch(batchRow, segmentRows.results.map(mapSegment), referenceRows.results.map(mapReferenceAsset));
  assertOwnership(batch, identity);
  return batch;
}

export async function listDramaBatchRecords(identity: DramaIdentity, limit = 20) {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const db = await database();
  if (!db) {
    return [...memoryBatches.values()]
      .filter((batch) => batch.team_id === identity.teamId && (!identity.projectId || batch.project_id === identity.projectId))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, safeLimit)
      .map(clone);
  }
  await ensureSchema(db);
  const query = identity.projectId
    ? db.prepare("SELECT * FROM drama_batches WHERE team_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT ?").bind(identity.teamId, identity.projectId, safeLimit)
    : db.prepare("SELECT * FROM drama_batches WHERE team_id = ? ORDER BY updated_at DESC LIMIT ?").bind(identity.teamId, safeLimit);
  const rows = await query.all<Record<string, unknown>>();
  return Promise.all(rows.results.map(async (row) => {
    const batchId = String(row.id);
    const [segments, references] = await Promise.all([
      db.prepare("SELECT * FROM drama_segments WHERE batch_id = ? ORDER BY position ASC").bind(batchId).all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM drama_reference_assets WHERE batch_id = ? ORDER BY kind, created_at ASC").bind(batchId).all<Record<string, unknown>>(),
    ]);
    const batch = mapBatch(row, segments.results.map(mapSegment), references.results.map(mapReferenceAsset));
    assertOwnership(batch, identity);
    return batch;
  }));
}

export async function saveDramaBatchRecord(identity: DramaIdentity, batch: DramaBatch) {
  assertOwnership(batch, identity);
  const db = await database();
  if (!db) {
    memoryBatches.set(batch.id, clone(batch));
    return clone(batch);
  }
  await ensureSchema(db);
  const statements = [
    db.prepare(`UPDATE drama_batches SET source_language = ?, target_language = ?, analysis_json = ?,
      storyboard_assets_json = ?, storyboard_assets_confirmed_at = ?, subtitle_layout_confirmed_at = ?,
      auto_review_enabled = ?, max_auto_regenerations = ?, retry_budget_confirmed_at = ?,
      status = ?, estimated_points = ?, assembly_job_id = ?, assembly_url = ?, failure_json = ?, updated_at = ?
      WHERE id = ? AND team_id = ?`).bind(
      batch.source_language, batch.target_language, JSON.stringify(batch.analysis),
      JSON.stringify(batch.storyboard_assets), batch.storyboard_assets_confirmed_at, batch.subtitle_layout_confirmed_at,
      batch.auto_review_enabled ? 1 : 0, batch.max_auto_regenerations, batch.retry_budget_confirmed_at,
      batch.status, batch.estimated_points, batch.assembly_job_id, batch.assembly_url,
      batch.failure ? JSON.stringify(batch.failure) : null, batch.updated_at, batch.id, identity.teamId,
    ),
    ...batch.segments.map((segment) => db.prepare(`INSERT OR IGNORE INTO drama_segments (
      id, batch_id, position, title, prompt, duration_seconds, source_start_seconds, source_end_seconds,
      source_asset_json, capability, storyboard_status, storyboard_asset_json, storyboard_review_status, storyboard_revision, storyboard_failure_json,
      review_status, revision, job_id, job_status, result_url, quality_review_json, auto_regeneration_count, failure_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      segment.id, segment.batch_id, segment.position, segment.title, segment.prompt, segment.duration_seconds,
      segment.source_start_seconds, segment.source_end_seconds, segment.source_asset ? JSON.stringify(segment.source_asset) : null,
      segment.capability, segment.storyboard_status, segment.storyboard_asset ? JSON.stringify(segment.storyboard_asset) : null,
      segment.storyboard_review_status, segment.storyboard_revision, segment.storyboard_failure ? JSON.stringify(segment.storyboard_failure) : null,
      segment.review_status, segment.revision, segment.job_id, segment.job_status, segment.result_url,
      segment.quality_review ? JSON.stringify(segment.quality_review) : null, segment.auto_regeneration_count,
      segment.failure ? JSON.stringify(segment.failure) : null, segment.created_at, segment.updated_at,
    )),
    ...batch.segments.map((segment) => db.prepare(`UPDATE drama_segments SET
      title = ?, prompt = ?, duration_seconds = ?, source_start_seconds = ?, source_end_seconds = ?,
      source_asset_json = ?, storyboard_status = ?, storyboard_asset_json = ?, storyboard_review_status = ?, storyboard_revision = ?, storyboard_failure_json = ?,
      review_status = ?, revision = ?, job_id = ?, job_status = ?, result_url = ?, quality_review_json = ?, auto_regeneration_count = ?,
      failure_json = ?, updated_at = ? WHERE id = ? AND batch_id = ?`).bind(
      segment.title, segment.prompt, segment.duration_seconds,
      segment.source_start_seconds, segment.source_end_seconds, segment.source_asset ? JSON.stringify(segment.source_asset) : null,
      segment.storyboard_status, segment.storyboard_asset ? JSON.stringify(segment.storyboard_asset) : null, segment.storyboard_review_status,
      segment.storyboard_revision, segment.storyboard_failure ? JSON.stringify(segment.storyboard_failure) : null,
      segment.review_status, segment.revision, segment.job_id, segment.job_status, segment.result_url,
      segment.quality_review ? JSON.stringify(segment.quality_review) : null, segment.auto_regeneration_count,
      segment.failure ? JSON.stringify(segment.failure) : null, segment.updated_at, segment.id, batch.id,
    )),
    db.prepare("DELETE FROM drama_reference_assets WHERE batch_id = ?").bind(batch.id),
    ...batch.reference_assets.map((asset) => db.prepare(`INSERT INTO drama_reference_assets (
      id, batch_id, kind, name, description, asset_json, review_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      asset.id, batch.id, asset.kind, asset.name, asset.description, JSON.stringify(asset.asset), asset.review_status, asset.created_at, asset.updated_at,
    )),
  ];
  await db.batch(statements);
  return batch;
}

export function requestIdentity(request: Request): DramaIdentity {
  return {
    teamId: request.headers.get("x-team-id") || "standalone-team",
    userId: request.headers.get("x-user-id") || "standalone-user",
    projectId: request.headers.get("x-project-id") || null,
  };
}
