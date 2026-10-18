export type Dataset = 'live' | 'validation';
export type Kind = 'fast_enabled' | 'background_generation' | 'foreground_compaction';
export type Outcome = 'completed' | 'failed' | 'cancelled' | 'unknown';
export type MetricEvent = { schemaVersion: 1; eventId: string; kind: Kind; occurredAt: string | null; dataset: Dataset } & ({ kind: 'fast_enabled' } | { kind: Exclude<Kind, 'fast_enabled'>; durationMs: number | null; outcome: Outcome; model: string | null; provider: string | null; unknownReason?: string });
const reasons = new Set(['clock_invalid','observation_failed','scope_left','terminal_missing','uuid_failed']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const instant = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?Z$/u;
function normalizeUtc(v: unknown): string | null { if (v === null) return null; if (typeof v !== 'string') throw new Error('invalid_event'); const m=instant.exec(v); if(!m)throw new Error('invalid_event'); const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number); const ms=Number((m[7]??'').padEnd(3,'0')); const d=new Date(Date.UTC(year,month-1,day,hour,minute,second,ms)); if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day||d.getUTCHours()!==hour||d.getUTCMinutes()!==minute||d.getUTCSeconds()!==second)throw new Error('invalid_event'); return d.toISOString(); }
function safeText(v: unknown): v is string { return typeof v==='string'&&v.length<=128&&!/[\u0000-\u001f\u007f]/u.test(v); }
export function normalizeEvent(input: unknown): MetricEvent {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)throw new Error('invalid_event');
  const x=input as Record<string,unknown>; const kind=x.kind;
  const base=['schemaVersion','eventId','kind','occurredAt','dataset'];
  const fast=kind==='fast_enabled'; const keys=fast?base:[...base,'durationMs','outcome','model','provider',...(Object.hasOwn(x,'unknownReason')?['unknownReason']:[])];
  if(Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))throw new Error('invalid_event');
  if(x.schemaVersion!==1||typeof x.eventId!=='string'||!uuid.test(x.eventId)||!(x.dataset==='live'||x.dataset==='validation')||!(kind==='fast_enabled'||kind==='background_generation'||kind==='foreground_compaction'))throw new Error('invalid_event');
  const occurredAt=normalizeUtc(x.occurredAt); if(fast&&occurredAt===null)throw new Error('invalid_event');
  if(fast)return {schemaVersion:1,eventId:x.eventId,kind:'fast_enabled',occurredAt,dataset:x.dataset};
  const durationMs=x.durationMs;
  if(!(durationMs===null||(typeof durationMs==='number'&&Number.isFinite(durationMs)&&durationMs>=0&&durationMs<=86400000))||!(x.outcome==='completed'||x.outcome==='failed'||x.outcome==='cancelled'||x.outcome==='unknown')||!(x.model===null||safeText(x.model))||!(x.provider===null||safeText(x.provider)))throw new Error('invalid_event');
  if(durationMs===null ? x.outcome!=='unknown'||typeof x.unknownReason!=='string'||!reasons.has(x.unknownReason) : x.outcome==='unknown'||Object.hasOwn(x,'unknownReason'))throw new Error('invalid_event');
  return {schemaVersion:1,eventId:x.eventId,kind,occurredAt,dataset:x.dataset,durationMs,outcome:x.outcome,model:x.model,provider:x.provider,...(durationMs===null?{unknownReason:x.unknownReason as string}:{})};
}
export function canonicalEvent(event: MetricEvent): string { const e=normalizeEvent(event); return e.kind==='fast_enabled'?JSON.stringify({schemaVersion:e.schemaVersion,eventId:e.eventId,kind:e.kind,occurredAt:e.occurredAt,dataset:e.dataset}):JSON.stringify({schemaVersion:e.schemaVersion,eventId:e.eventId,kind:e.kind,occurredAt:e.occurredAt,dataset:e.dataset,durationMs:e.durationMs,outcome:e.outcome,model:e.model,provider:e.provider,...(e.durationMs===null?{unknownReason:e.unknownReason}:{})}); }
