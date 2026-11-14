// Optional CogitoEngine vetting: service, HTTP routes, and the child-process runner.
// CogitoEngine itself is faked; these tests cover mechanics, not model behaviour.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine, AppError } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { createHandler } from '../server/app.ts';
import { createVetting, writeProjectNote } from '../server/vetting.ts';
import { cogitoEnv, createCogito, type Cogito, type CogitoInput } from '../server/cogito.ts';
import { DEFAULT_APP_SETTINGS, type AppSettings, type ChatRequest } from '../server/providers.ts';

async function fakeChat(r: ChatRequest) {
  const value =
    r.schemaName === 'judgement' ? { reason: 'ok', originality: 4, feasibility: 4, impact: 4, keywords: ['x'] }
    : { title: 'Distilled', pitch: 'A pitch.' };
  return { value, costUsd: 0, citations: [] as string[] };
}

const settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
const repo = openDb(':memory:');
const engine = createEngine({ repo, chat: fakeChat, settings: () => settings, gitInit: false, reveal: () => {} });
const autopilot = createAutopilot({ repo, engine, settings: () => settings });
const runtime = { get: () => settings, set: (s: AppSettings) => void Object.assign(settings, s), received: () => true };

// ---- a fake Cogito: records inputs, answers with Python-shaped run records
const inputs: CogitoInput[] = [];
let gate: Promise<void> | null = null;
let behaviour: 'ok' | 'refused' | 'throw' | 'missing_arm' = 'ok';

function runRecord(arm: 'peer' | 'strict', input: CogitoInput, status = 'completed') {
  const peer = arm === 'peer';
  return {
    run_id: `board${input.boardId}_idea${input.idea.id}_${arm}_T`, arm, status, error: null, jury_shown_to_seats: input.showJury,
    markdown: `# ${arm} record\n`,
    source: { board_id: input.boardId, idea_id: input.idea.id },
    result: peer
      ? {
          kind: 'peer', independence_warning: 'Not independent review: model family is undisclosed.',
          refused_seat: status === 'refused' ? 'opener' : null,
          seats: [{ seat: 'opener', body: 'b', flags: [], refusal: status === 'refused', model: 'm', provider: 'p', prompt: 'SECRET PROMPT', system: 'SYS' }],
          notes: [
            { id: 'n1', author: 'pressure_a', type: 'counter-proposal', text: 'Use a magnetic separator instead of a sieve.', status: 'open', by: null, history: [] },
            { id: 'n2', author: 'pressure_a', type: 'objection', text: 'Weak premise.', status: 'unresolved', by: 'pressure_b', history: [] },
          ],
          labels: [],
        }
      : { kind: 'strict', refused_step: null, steps: [{ step: 'perceive', role: 'Worker', output: 'o', refusal: false, prompt: 'P', system: 'S' }] },
  };
}

const cogito: Cogito = {
  configured: true,
  maxRunsPerDay: 4,
  async run(input) {
    inputs.push(input);
    if (gate) await gate;
    if (behaviour === 'throw') throw new AppError(502, 'cogito_failed', 'exit 1: MISTRAL_API_KEY not set');
    const arms: ('peer' | 'strict')[] = input.arm === 'both' ? ['strict', 'peer'] : [input.arm];
    const runs = arms.map((a) => runRecord(a, input, behaviour === 'refused' ? 'refused' : 'completed'));
    return { runs: behaviour === 'missing_arm' ? runs.slice(1) : runs };
  },
};

const vetting = createVetting({ repo, engine, cogito });
let server: Server;
let base = '';
before(async () => {
  server = createServer(createHandler({ repo, engine, autopilot, runtime, vetting, publicDir: join(import.meta.dirname, '..', 'public') }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}
async function newIdea(extra: Record<string, unknown> = {}) {
  const board = (await api('POST', '/api/boards', { lang: 'en', goal: 'Cheap water' })).data.board;
  const idea = (await api('POST', `/api/boards/${board.id}/seed`, { text: 'Rain sieve' })).data.idea;
  await engine.idle();
  if (extra.projectPath) repo.setProjectPath(idea.id, extra.projectPath as string);
  return { board, idea };
}
const reset = () => { inputs.length = 0; gate = null; behaviour = 'ok'; (cogito as any).maxRunsPerDay = 999; };

test('status reports the feature and the daily cap', async () => {
  const s = (await api('GET', '/api/cogito')).data;
  assert.deepEqual(s, { configured: true, runsToday: repo.vettingsOn(new Date().toLocaleDateString('sv-SE')), maxRunsPerDay: cogito.maxRunsPerDay });
});

test('start → background run → stored, slimmed for the browser, full record on request', async () => {
  reset();
  const { board, idea } = await newIdea();
  const events: any[] = [];
  const unsub = engine.bus.on(board.id, (e: any) => events.push(e));
  const r = await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'peer' });
  assert.equal(r.status, 200);
  assert.equal(r.data.vettings[0].status, 'running');
  await vetting.idle();
  const list = (await api('GET', `/api/ideas/${idea.id}/vettings`)).data.vettings;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'completed');
  assert.equal(list[0].run.arm, 'peer');
  assert.equal(JSON.stringify(list[0]).includes('SECRET PROMPT'), false, 'prompts stay out of what the browser gets');
  assert.equal(list[0].run.markdown, undefined);
  const full = (await api('GET', `/api/vettings/${list[0].id}/run.json`)).data;
  assert.equal(full.run.result.seats[0].prompt, 'SECRET PROMPT', 'the audit record keeps everything');
  // the bridge got a plain idea payload, the board goal, and the jury hidden by default
  assert.equal(inputs[0].goal, 'Cheap water');
  assert.equal(inputs[0].showJury, false);
  assert.equal(inputs[0].idea.title, 'Rain sieve');
  const kinds = events.filter((e) => e.type === 'vetting').map((e) => e.vetting.status);
  assert.deepEqual(kinds, ['running', 'completed'], 'the browser is told when it starts and when it ends');
  assert.equal(JSON.stringify(events).includes('SECRET PROMPT'), false);
  unsub();
});

test('Cogito never touches the idea: scores and medal override are unchanged', async () => {
  reset();
  const { idea } = await newIdea();
  const before = repo.getIdea(idea.id)!;
  await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'both', showJury: true });
  await vetting.idle();
  const after = repo.getIdea(idea.id)!;
  for (const k of ['originality', 'feasibility', 'impact', 'reason', 'medalOverride', 'judgedAt'] as const) assert.equal(after[k], before[k], k);
  assert.equal(inputs[0].showJury, true, 'opt-in is passed through');
  assert.equal(inputs[0].arm, 'both');
});

test('a refusal is stored as a refusal; a failure as a failure with its reason', async () => {
  reset();
  const { idea } = await newIdea();
  behaviour = 'refused';
  await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'peer' });
  await vetting.idle();
  assert.equal(repo.listVettings(idea.id)[0].status, 'refused');
  behaviour = 'throw';
  await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'peer' });
  await vetting.idle();
  const [failed] = repo.listVettings(idea.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /MISTRAL_API_KEY/);
  behaviour = 'missing_arm';
  await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'both' });
  await vetting.idle();
  const rows = repo.listVettings(idea.id).slice(0, 2);
  assert.deepEqual(rows.map((r) => r.status).sort(), ['completed', 'failed'], 'an arm Cogito did not return is failed, not invented');
});

test('one run per idea at a time; unknown arm and unknown idea are rejected', async () => {
  reset();
  const { idea } = await newIdea();
  let release!: () => void;
  gate = new Promise((r) => (release = r));
  assert.equal((await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'peer' })).status, 200);
  const again = await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'peer' });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'cogito_busy');
  release();
  await vetting.idle();
  assert.equal((await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'weird' })).status, 400);
  assert.equal((await api('POST', '/api/ideas/999999/vet', { arm: 'peer' })).status, 404);
});

test('daily run cap counts arms, failed runs included', async () => {
  reset();
  const day = new Date().toLocaleDateString('sv-SE');
  const base0 = repo.vettingsOn(day);
  const { idea } = await newIdea();
  const room = 3;
  (cogito as any).maxRunsPerDay = base0 + room;
  for (let i = 0; i < room; i++) {
    await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'peer' });
    await vetting.idle();
  }
  const over = await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'peer' });
  assert.equal(over.status, 429);
  assert.equal(over.data.code, 'cogito_cap');
  assert.equal(inputs.length, room, 'no run started past the cap');
});

test('a person seeds a counter-proposal: it becomes a seed the jury judges; objections cannot be seeded', async () => {
  reset();
  const { board, idea } = await newIdea();
  await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'peer' });
  await vetting.idle();
  const v = repo.listVettings(idea.id)[0];
  const r = await api('POST', `/api/vettings/${v.id}/seed`, { noteId: 'n1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.idea.kind, 'seed');
  assert.equal(r.data.idea.boardId, board.id);
  assert.equal(r.data.vetting.run.bridge_seeded.n1, r.data.idea.id);
  await engine.idle();
  assert.equal(repo.getIdea(r.data.idea.id)!.originality, 4, 'the board\'s own jury judged it');
  assert.equal((await api('POST', `/api/vettings/${v.id}/seed`, { noteId: 'n1' })).data.code, 'already_seeded');
  assert.equal((await api('POST', `/api/vettings/${v.id}/seed`, { noteId: 'n2' })).data.code, 'no_note');
  assert.equal((await api('POST', `/api/vettings/${v.id}/seed`, { noteId: 'zz' })).status, 404);
});

test('vetting an idea that has a project folder leaves COGITO_VETTING.md there, never overwriting', async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), 'cogito-proj-'));
  writeFileSync(join(dir, 'COGITO_VETTING.md'), 'mine');
  const { idea } = await newIdea({ projectPath: dir });
  await api('POST', `/api/ideas/${idea.id}/vet`, { arm: 'peer' });
  await vetting.idle();
  assert.equal(readFileSync(join(dir, 'COGITO_VETTING.md'), 'utf8'), 'mine');
  assert.match(readFileSync(join(dir, 'COGITO_VETTING-2.md'), 'utf8'), /peer record/);
});

test('project note: written next to the project, never overwriting anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cogito-proj-'));
  writeFileSync(join(dir, 'COGITO_VETTING.md'), 'mine');
  const a = writeProjectNote(dir, 'one')!;
  const b = writeProjectNote(dir, 'two')!;
  assert.match(a, /COGITO_VETTING-2\.md$/);
  assert.match(b, /COGITO_VETTING-3\.md$/);
  assert.equal(readFileSync(join(dir, 'COGITO_VETTING.md'), 'utf8'), 'mine');
  assert.equal(writeProjectNote(join(dir, 'nope'), 'x'), null);
  assert.equal(existsSync(join(dir, 'nope')), false);
});

test('a restart closes runs the dead process left open', () => {
  const r = openDb(':memory:');
  const b = r.createBoard({ title: 't' });
  const i = r.insertIdea({ boardId: b.id, title: 'x', pitch: '', kind: 'seed', sourceUrl: null, x: 0, y: 0, generation: 0 });
  r.insertVetting({ ideaId: i.id, arm: 'peer', day: '2026-11-14' });
  assert.equal(r.hasRunningVetting(i.id), true);
  createVetting({ repo: r, engine: createEngine({ repo: r, chat: fakeChat, settings: () => settings, gitInit: false, reveal: () => {} }), cogito });
  assert.equal(r.hasRunningVetting(i.id), false);
  assert.match(r.listVettings(i.id)[0].error!, /restarted/);
});

test('deleting an idea deletes its vettings', async () => {
  reset();
  const { idea } = await newIdea();
  repo.insertVetting({ ideaId: idea.id, arm: 'strict', day: '2026-11-14' });
  await api('DELETE', `/api/ideas/${idea.id}`);
  assert.equal(repo.listVettings(idea.id).length, 0);
});

// ---- without COGITO_DIR the feature is simply off
test('unconfigured: status says so, routes answer 501, nothing else changes', async () => {
  const off = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public') }));
  await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${(off.address() as any).port}`;
  const s = await (await fetch(`${b}/api/cogito`)).json();
  assert.equal(s.configured, false);
  const r = await fetch(`${b}/api/ideas/1/vet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 501);
  off.close();
  const none = createCogito({ settings: () => settings });
  assert.equal(none.configured, false);
  assert.throws(() => none.run({ boardId: 1, idea: {}, goal: '', arm: 'peer', showJury: false }), /not configured/);
});

// ---- the child-process runner, against a fake command (no Python needed)
const script = (body: string) => {
  const f = join(mkdtempSync(join(tmpdir(), 'cogito-fake-')), 'fake.mjs');
  writeFileSync(f, body);
  return f;
};
const input: CogitoInput = { boardId: 3, idea: { id: 9, title: 'T' }, goal: 'G', arm: 'peer', showJury: false };

test('runner: sends snake_case JSON on stdin, parses runs from stdout', async () => {
  const f = script(`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify({runs:[{arm:p.arm,echo:p}]}))})`);
  const out = await createCogito({ settings: () => settings, command: [process.execPath, f] }).run(input);
  assert.deepEqual(out.runs[0].echo, { board_id: 3, idea: { id: 9, title: 'T' }, goal: 'G', arm: 'peer', show_jury: false });
});

test('runner: non-zero exit, unreadable output and timeout are loud AppErrors', async () => {
  const bad = script(`console.error('MISTRAL_API_KEY not set');process.exit(1)`);
  await assert.rejects(createCogito({ settings: () => settings, command: [process.execPath, bad] }).run(input), (e: any) => e.code === 'cogito_failed' && /MISTRAL_API_KEY/.test(e.message));
  const junk = script(`console.log('not json')`);
  await assert.rejects(createCogito({ settings: () => settings, command: [process.execPath, junk] }).run(input), (e: any) => e.code === 'cogito_failed');
  const slow = script(`setTimeout(()=>{},30000)`);
  await assert.rejects(createCogito({ settings: () => settings, command: [process.execPath, slow], timeoutS: 0.3 }).run(input), (e: any) => e.code === 'cogito_timeout');
  await assert.rejects(createCogito({ settings: () => settings, command: ['/nonexistent/python'] }).run(input), (e: any) => e.code === 'cogito_failed');
});

test('runner environment: browser keys reach the child, never disk; keys Cogito cannot use are dropped', () => {
  const s: AppSettings = { ...structuredClone(DEFAULT_APP_SETTINGS), keys: { anthropic: 'sk-ant-browser', openai: 'sk-oa-browser' } };
  const env = cogitoEnv(s, { PATH: '/bin', OPENROUTER_API_KEY: 'or', AZURE_OPENAI_API_KEY: 'az', ANTHROPIC_API_KEY: 'sk-ant-env', MISTRAL_API_KEY: 'mi' });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-browser', 'browser key wins, as everywhere else');
  assert.equal(env.OPENAI_API_KEY, 'sk-oa-browser');
  assert.equal(env.MISTRAL_API_KEY, 'mi', 'Cogito reads its own default provider key from the environment');
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.AZURE_OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
});
