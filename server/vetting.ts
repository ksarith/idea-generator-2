// Vetting an idea with CogitoEngine (optional; see server/cogito.ts).
//
// Rules that keep this honest:
//  * Cogito never writes fitness. Nothing here touches scores, medals, or the
//    autopilot: a vetting is a record next to the idea, not a verdict on it.
//  * Counter-proposals become seeds only when a person picks them. The board's
//    own jury then judges them like any other idea.
//  * A refusal is a valid result and is stored as one. A failed run is stored
//    as failed, with the reason; nothing is retried behind your back.
//  * No pass/fail is derived from the agents' agreement. The UI shows flags
//    and open questions only.
import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { localDay, type Repo, type Vetting } from './db.ts';
import { AppError, type Engine } from './engine.ts';
import type { Cogito, CogitoArm } from './cogito.ts';

const ARMS: CogitoArm[] = ['peer', 'strict', 'both'];

/** What the browser needs: the run record without the (large) prompts and system texts. */
function slim(v: Vetting): Vetting {
  if (!v.run) return v;
  const run = structuredClone(v.run);
  delete run.markdown;
  for (const s of [...(run.result?.seats ?? []), ...(run.result?.steps ?? [])]) {
    delete s.prompt;
    delete s.system;
  }
  return { ...v, run };
}

/** Add COGITO_VETTING.md to a project folder. Never overwrites: a second note becomes -2, -3 … */
export function writeProjectNote(projectPath: string, markdown: string): string | null {
  try {
    if (!statSync(projectPath).isDirectory()) return null;
  } catch {
    return null;
  }
  for (let n = 1; n < 1000; n++) {
    const file = join(projectPath, n === 1 ? 'COGITO_VETTING.md' : `COGITO_VETTING-${n}.md`);
    try {
      writeFileSync(file, markdown, { flag: 'wx' });
      return file;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') return null;
    }
  }
  return null;
}

export function createVetting({ repo, engine, cogito }: { repo: Repo; engine: Engine; cogito: Cogito }) {
  const pending = new Set<Promise<void>>();
  repo.failRunningVettings('the server restarted while this was running');

  const emit = (v: Vetting) => {
    const idea = repo.getIdea(v.ideaId);
    if (idea) engine.bus.emit(idea.boardId, { type: 'vetting', vetting: slim(v) });
  };

  async function finish(rows: Vetting[], idea: NonNullable<ReturnType<Repo['getIdea']>>, arm: CogitoArm, showJury: boolean) {
    try {
      const board = repo.getBoard(idea.boardId);
      const out = await cogito.run({
        boardId: idea.boardId,
        goal: board?.goal ?? '',
        arm,
        showJury,
        idea: { id: idea.id, title: idea.title, pitch: idea.pitch, originality: idea.originality, feasibility: idea.feasibility, impact: idea.impact, reason: idea.reason },
      });
      const notes: string[] = [];
      for (const row of rows) {
        const run = out.runs.find((r: any) => r.arm === row.arm);
        if (!run) {
          emit(repo.finishVetting(row.id, { status: 'failed', error: `Cogito returned no ${row.arm} run` })!);
          continue;
        }
        if (run.markdown) notes.push(`<!-- ${run.run_id} (${run.arm}) -->\n${run.markdown}`);
        emit(repo.finishVetting(row.id, { status: run.status, run, error: run.error ?? null })!);
      }
      if (idea.projectPath && notes.length) writeProjectNote(idea.projectPath, notes.join('\n\n---\n\n'));
    } catch (e: any) {
      for (const row of rows) emit(repo.finishVetting(row.id, { status: 'failed', error: e?.message ?? String(e) })!);
    }
  }

  return {
    status() {
      return { configured: cogito.configured, runsToday: repo.vettingsOn(localDay()), maxRunsPerDay: cogito.maxRunsPerDay };
    },

    list(ideaId: number): Vetting[] {
      if (!repo.getIdea(ideaId)) throw new AppError(404, 'not_found', 'Idea not found');
      return repo.listVettings(ideaId).map(slim);
    },

    /** The full stored record, prompts included: the audit trail. */
    fullRun(id: number): string {
      const v = repo.getVetting(id);
      if (!v) throw new AppError(404, 'not_found', 'Vetting not found');
      return JSON.stringify(v, null, 2);
    },

    start(ideaId: number, body: any): { vettings: Vetting[] } {
      if (!cogito.configured) throw new AppError(501, 'cogito_off', 'CogitoEngine is not configured (set COGITO_DIR to its folder, then restart)');
      const idea = repo.getIdea(ideaId);
      if (!idea) throw new AppError(404, 'not_found', 'Idea not found');
      const arm: CogitoArm = body?.arm ?? 'peer';
      if (!ARMS.includes(arm)) throw new AppError(400, 'bad_request', 'arm must be peer, strict or both');
      const showJury = body?.showJury === true;
      if (repo.hasRunningVetting(ideaId)) throw new AppError(409, 'cogito_busy', 'This idea is already being vetted');
      const arms = arm === 'both' ? (['strict', 'peer'] as const) : ([arm] as const);
      const day = localDay();
      const used = repo.vettingsOn(day);
      if (used + arms.length > cogito.maxRunsPerDay) {
        throw new AppError(429, 'cogito_cap', `Daily Cogito run cap reached (${used} of ${cogito.maxRunsPerDay} used; COGITO_MAX_RUNS_PER_DAY)`);
      }
      const rows = arms.map((a) => repo.insertVetting({ ideaId, arm: a, day }));
      rows.forEach(emit);
      const job = finish(rows, idea, arm, showJury).finally(() => pending.delete(job));
      pending.add(job);
      return { vettings: rows.map(slim) };
    },

    /** A person picks one counter-proposal: it becomes a seed on the idea's board, near its parent. */
    async seedNote(vettingId: number, noteId: unknown) {
      const v = repo.getVetting(vettingId);
      if (!v) throw new AppError(404, 'not_found', 'Vetting not found');
      const note = (v.run?.result?.notes ?? []).find((n: any) => n.id === noteId && n.type === 'counter-proposal');
      if (!note) throw new AppError(404, 'no_note', 'No such counter-proposal in this vetting');
      if (v.run.bridge_seeded?.[note.id]) throw new AppError(409, 'already_seeded', 'This counter-proposal is already a seed');
      const idea = repo.getIdea(v.ideaId);
      if (!idea) throw new AppError(404, 'not_found', 'Idea not found');
      const { idea: seeded } = await engine.seed(idea.boardId, { text: note.text, x: idea.x + 160, y: idea.y + 100 });
      v.run.bridge_seeded = { ...(v.run.bridge_seeded ?? {}), [note.id]: seeded.id };
      const updated = repo.setVettingRun(v.id, v.run)!;
      emit(updated);
      return { idea: seeded, vetting: slim(updated) };
    },

    /** Resolves when every background run has been stored (tests, graceful stop). */
    idle: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

export type VettingService = ReturnType<typeof createVetting>;
