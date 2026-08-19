import { createHash } from 'node:crypto';

/**
 * Deterministic fake-CRM data generator.
 *
 * Sprint task 9 requires 5,000 contacts and 1,000 jobs. Generating them from a
 * seeded PRNG rather than a checked-in file keeps the repository small and,
 * more importantly, makes the dataset *reproducible*: the same seed yields
 * byte-identical records, so "migrate twice, expect zero duplicates" is a real
 * assertion rather than a coincidence of random data.
 *
 * The generator deliberately produces the edge cases Scope §60 lists, at
 * controlled rates, so the happy path is never the only path exercised.
 */

/** xorshift128 PRNG - small, fast, and identical across Node versions. */
export class SeededRandom {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string) {
    const hash = createHash('sha256').update(seed).digest();
    this.a = hash.readUInt32LE(0) || 1;
    this.b = hash.readUInt32LE(4) || 2;
    this.c = hash.readUInt32LE(8) || 3;
    this.d = hash.readUInt32LE(12) || 4;
  }

  next(): number {
    let t = this.d;
    const s = this.a;
    this.d = this.c;
    this.c = this.b;
    this.b = s;
    t ^= t << 11;
    t ^= t >>> 8;
    this.a = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.a / 0x1_0000_0000;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const FIRST_NAMES = [
  'James', 'Maria', 'Robert', 'Linda', 'Michael', 'Patricia', 'David', 'Jennifer',
  'William', 'Elizabeth', 'Richard', 'Barbara', 'Joseph', 'Susan', 'Thomas', 'Jessica',
  'Christopher', 'Sarah', 'Daniel', 'Karen', 'Miguel', 'Ana', 'José', 'Renée', 'Søren',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  "O'Brien", 'Nguyen', 'Müller', 'Kowalski', 'Okafor',
];

const STREETS = [
  'Maple St', 'Oak Avenue', 'Cedar Lane', 'Pine Road', 'Elm Drive', 'Birch Court',
  'Sunset Blvd', 'Willow Way', 'Ridgeline Dr', 'Harbor Street',
];

const CITIES: ReadonlyArray<readonly [string, string, string]> = [
  ['Austin', 'Texas', '78701'], ['Denver', 'colorado', '80202'], ['Tampa', 'FL', '33602'],
  ['Columbus', 'Ohio', '43215'], ['Phoenix', 'AZ', '85004'], ['Raleigh', 'North Carolina', '27601'],
  ['Boise', 'ID', '83702'], ['Toronto', 'ON', 'M5H 2N2'],
];

const LEAD_SOURCES = ['Referral', 'Google', 'Facebook Ad', 'Door Knock', 'Storm Canvass', 'Repeat Customer', 'Yard Sign'];
const JOB_TYPES = ['Roof Replacement', 'Roof Repair', 'Siding', 'Gutters', 'Windows', 'Storm Damage', 'Inspection'];
const JOB_STATUSES = ['Lead', 'Inspection Scheduled', 'Estimate Sent', 'Approved', 'In Production', 'Complete', 'Lost'];
const TAGS = ['insurance', 'retail', 'commercial', 'residential', 'hail', 'wind', 'priority', 'financing'];
const USER_ROLES = ['Owner', 'Sales Rep', 'Project Manager', 'Estimator', 'Office Admin', 'Crew Lead'];

export interface MockDataset {
  users: MockUser[];
  tags: MockTag[];
  pipelines: MockPipeline[];
  stages: MockStage[];
  contacts: MockContact[];
  jobs: MockJob[];
  notes: MockNote[];
  files: MockFile[];
}

export interface MockUser {
  id: string; first_name: string; last_name: string; email: string | null;
  phone: string | null; role: string; active: boolean;
}
export interface MockTag { id: string; name: string; }
export interface MockPipeline { id: string; name: string; }
export interface MockStage { id: string; pipeline_id: string; name: string; position: number; }

export interface MockContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name?: string;
  email: string | null;
  phone: string | null;
  secondary_email?: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  lead_source: string | null;
  tags: string;
  assigned_user_id: string | null;
  created: string | number | null;
  modified: string | number | null;
  notes_count: number;
  custom: Record<string, unknown>;
  /** Deliberately malformed for Test 6 (bad record in a batch). */
  __malformed?: boolean;
}

export interface MockJob {
  id: string; job_number: string; name: string; contact_id: string | null;
  street: string | null; city: string | null; state: string | null; zip: string | null;
  job_type: string; status: string; value: string | number | null;
  assigned_user_ids: string[]; start: string | null; completed: string | null;
  lead_source: string | null; tags: string; created: string; modified: string;
}

export interface MockNote {
  id: string; parent_type: 'contact' | 'job'; parent_id: string; body: string;
  author_user_id: string | null; author_name: string; created: string;
}

export interface MockFile {
  id: string; parent_type: 'contact' | 'job'; parent_id: string; name: string;
  mime: string; size: number; url: string | null; kind: 'document' | 'image';
  /** Simulates an asset the source lists but cannot serve (Test 9). */
  __unavailable?: boolean;
}

export interface GenerateOptions {
  seed?: string;
  contacts: number;
  jobs: number;
  users?: number;
  notesPerJob?: number;
  filesPerJob?: number;
  /** Fraction of contacts that duplicate an earlier one (Scope §60). */
  duplicateRate?: number;
  /** Fraction of contacts with neither email nor phone (Scope §60). */
  noContactInfoRate?: number;
  /** Fraction of contacts with a deliberately invalid schema (Test 6). */
  malformedRate?: number;
  /** Fraction of files the source lists but cannot serve (Test 9). */
  unavailableFileRate?: number;
}

export function generateDataset(options: GenerateOptions): MockDataset {
  const rng = new SeededRandom(options.seed ?? 'builderlync-sprint-1');
  const userCount = options.users ?? 12;
  const duplicateRate = options.duplicateRate ?? 0.02;
  const noContactInfoRate = options.noContactInfoRate ?? 0.03;
  const malformedRate = options.malformedRate ?? 0;
  const unavailableFileRate = options.unavailableFileRate ?? 0;
  const notesPerJob = options.notesPerJob ?? 0;
  const filesPerJob = options.filesPerJob ?? 0;

  // --- users -------------------------------------------------------------
  const users: MockUser[] = [];
  for (let i = 0; i < userCount; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    users.push({
      id: `U${String(i + 1).padStart(4, '0')}`,
      first_name: first,
      last_name: last,
      // Scope §60: deleted/disabled employees still own historical work.
      email: rng.chance(0.05) ? null : `${first}.${last}@example-roofing.com`.toLowerCase().replace(/'/g, ''),
      phone: rng.chance(0.3) ? null : formatPhone(rng),
      role: rng.pick(USER_ROLES),
      active: !rng.chance(0.2),
    });
  }

  // --- config objects ----------------------------------------------------
  const tags: MockTag[] = TAGS.map((name, i) => ({ id: `T${i + 1}`, name }));
  const pipelines: MockPipeline[] = [
    { id: 'P1', name: 'Sales Pipeline' },
    { id: 'P2', name: 'Production Pipeline' },
  ];
  const stages: MockStage[] = [
    ...['New Lead', 'Contacted', 'Inspected', 'Estimate Sent', 'Won', 'Lost'].map((name, i) => ({
      id: `S1${i}`, pipeline_id: 'P1', name, position: i,
    })),
    ...['Scheduled', 'In Progress', 'Punch List', 'Complete'].map((name, i) => ({
      id: `S2${i}`, pipeline_id: 'P2', name, position: i,
    })),
  ];

  // --- contacts ----------------------------------------------------------
  const contacts: MockContact[] = [];
  for (let i = 0; i < options.contacts; i += 1) {
    const id = `C${String(i + 1).padStart(6, '0')}`;

    // Duplicates re-use an earlier contact's identity with cosmetic drift, so
    // deduplication has something real to catch (Scope §60, Test 2).
    if (i > 50 && rng.chance(duplicateRate)) {
      const original = contacts[rng.int(contacts.length)];
      if (original) {
        contacts.push({
          ...original,
          id,
          phone: original.phone ? reformatPhone(original.phone, rng) : null,
          email: original.email ? original.email.toUpperCase() : null,
          created: isoDate(rng),
          modified: isoDate(rng),
        });
        continue;
      }
    }

    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const [city, state, zip] = rng.pick(CITIES);
    const noContactInfo = rng.chance(noContactInfoRate);
    const malformed = malformedRate > 0 && rng.chance(malformedRate);

    contacts.push({
      id,
      // Some sources send one "full name" column instead of two (Guide §12).
      first_name: rng.chance(0.9) ? first : null,
      last_name: rng.chance(0.9) ? last : null,
      full_name: rng.chance(0.1) ? `${last}, ${first}` : undefined,
      email: noContactInfo ? null : `${first}.${last}${i}@example.com`.toLowerCase().replace(/'/g, ''),
      phone: noContactInfo ? null : formatPhone(rng),
      secondary_email: rng.chance(0.08) ? `${first}${i}@work-example.com`.toLowerCase() : null,
      street: `${100 + rng.int(9800)} ${rng.pick(STREETS)}`,
      city, state, zip,
      country: rng.chance(0.03) ? 'Canada' : 'USA',
      lead_source: rng.chance(0.08) ? null : rng.pick(LEAD_SOURCES),
      tags: pickTags(rng),
      assigned_user_id: rng.chance(0.06) ? null : rng.pick(users).id,
      // Mixed date formats in one column, exactly as real exports arrive.
      created: rng.chance(0.15) ? excelSerial(rng) : isoDate(rng),
      modified: isoDate(rng),
      notes_count: rng.int(4),
      custom: {
        referred_by: rng.chance(0.2) ? rng.pick(FIRST_NAMES) : '',
        insurance_claim: rng.chance(0.3) ? 'yes' : 'no',
        // Scope §60: extremely long notes, HTML, special characters.
        internal_memo: rng.chance(0.02) ? `<b>VIP</b> — ${'detail '.repeat(300)}` : '',
      },
      ...(malformed ? { __malformed: true } : {}),
    });
  }

  // --- jobs --------------------------------------------------------------
  const jobs: MockJob[] = [];
  for (let i = 0; i < options.jobs; i += 1) {
    // Scope §60: some jobs have no customer at all.
    const contact = rng.chance(0.02) ? null : contacts[rng.int(contacts.length)];
    const [city, state, zip] = rng.pick(CITIES);
    const assigned = rng.chance(0.05) ? [] : [rng.pick(users).id, ...(rng.chance(0.25) ? [rng.pick(users).id] : [])];

    jobs.push({
      id: `J${String(i + 1).padStart(6, '0')}`,
      job_number: `2024-${String(1000 + i)}`,
      name: `${rng.pick(JOB_TYPES)} - ${contact?.last_name ?? 'Unknown'}`,
      contact_id: contact?.id ?? null,
      street: contact?.street ?? `${100 + rng.int(9800)} ${rng.pick(STREETS)}`,
      city, state, zip,
      job_type: rng.pick(JOB_TYPES),
      status: rng.pick(JOB_STATUSES),
      // Money arrives formatted, blank, or parenthesized-negative.
      value: rng.chance(0.06) ? null : rng.chance(0.1) ? `$${(rng.int(40000) + 2000).toLocaleString()}.00` : rng.int(45000) + 1500,
      assigned_user_ids: [...new Set(assigned)],
      start: rng.chance(0.2) ? null : isoDate(rng),
      completed: rng.chance(0.5) ? null : isoDate(rng),
      lead_source: rng.chance(0.1) ? null : rng.pick(LEAD_SOURCES),
      tags: pickTags(rng),
      created: isoDate(rng),
      modified: isoDate(rng),
    });
  }

  // --- notes and files ---------------------------------------------------
  const notes: MockNote[] = [];
  const files: MockFile[] = [];

  for (const job of jobs) {
    for (let k = 0; k < notesPerJob; k += 1) {
      const author = rng.pick(users);
      notes.push({
        id: `N${notes.length + 1}`,
        parent_type: 'job',
        parent_id: job.id,
        body: rng.chance(0.1)
          ? `<p>Customer called re: <b>schedule</b> &amp; deposit</p>`
          : `Spoke with homeowner about ${rng.pick(JOB_TYPES).toLowerCase()}. Follow up ${rng.int(14) + 1} days.`,
        author_user_id: author.id,
        author_name: `${author.first_name} ${author.last_name}`,
        created: isoDate(rng),
      });
    }

    for (let k = 0; k < filesPerJob; k += 1) {
      const isImage = rng.chance(0.7);
      const unavailable = unavailableFileRate > 0 && rng.chance(unavailableFileRate);
      files.push({
        id: `F${files.length + 1}`,
        parent_type: 'job',
        parent_id: job.id,
        name: isImage ? `roof-${k + 1}.jpg` : `estimate-${job.job_number}.pdf`,
        mime: isImage ? 'image/jpeg' : 'application/pdf',
        size: 1024 * (isImage ? 40 + rng.int(400) : 20 + rng.int(80)),
        url: unavailable ? null : `mock://files/${job.id}/${k + 1}`,
        kind: isImage ? 'image' : 'document',
        ...(unavailable ? { __unavailable: true } : {}),
      });
    }
  }

  return { users, tags, pipelines, stages, contacts, jobs, notes, files };
}

function pickTags(rng: SeededRandom): string {
  const count = rng.int(3);
  const chosen = new Set<string>();
  for (let i = 0; i < count; i += 1) chosen.add(rng.pick(TAGS));
  return [...chosen].join(', ');
}

function formatPhone(rng: SeededRandom): string {
  const area = 200 + rng.int(700);
  const prefix = 200 + rng.int(700);
  const line = rng.int(10000);
  const formats = [
    `(${area}) ${prefix}-${String(line).padStart(4, '0')}`,
    `${area}-${prefix}-${String(line).padStart(4, '0')}`,
    `${area}.${prefix}.${String(line).padStart(4, '0')}`,
    `+1${area}${prefix}${String(line).padStart(4, '0')}`,
    `${area}${prefix}${String(line).padStart(4, '0')} ext 12`,
  ];
  return rng.pick(formats);
}

/** Same number, different formatting - the duplicate case dedupe must catch. */
function reformatPhone(phone: string, rng: SeededRandom): string {
  const digits = phone.replace(/\D/g, '').slice(-10);
  if (digits.length < 10) return phone;
  const a = digits.slice(0, 3);
  const b = digits.slice(3, 6);
  const c = digits.slice(6);
  return rng.pick([`(${a}) ${b}-${c}`, `${a}.${b}.${c}`, `+1 ${a} ${b} ${c}`, `${a}${b}${c}`]);
}

function isoDate(rng: SeededRandom): string {
  const start = Date.UTC(2019, 0, 1);
  const end = Date.UTC(2025, 11, 31);
  return new Date(start + rng.int(end - start)).toISOString();
}

/** Excel serial dates, which appear in almost every real CRM export. */
function excelSerial(rng: SeededRandom): number {
  return 43_800 + rng.int(2_000);
}
