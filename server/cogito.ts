// Optional bridge to CogitoEngine, a separate Python project (github.com/ksarith).
// It runs ONE idea through a Cogito flow in a child process and returns the run
// records. Nothing here is needed unless COGITO_DIR is set.
//
//   COGITO_DIR               path to the CogitoEngine checkout (enables the feature)
//   COGITO_PYTHON            python executable (default python3)
//   COGITO_FLOW              peer-cluster YAML (default: the one shipped with Cogito)
//   COGITO_TIMEOUT_S         kill a run after this many seconds (default 600)
//   COGITO_MAX_RUNS_PER_DAY  daily cap on runs, local midnight (default 10)
//   COGITO_PROVIDER / COGITO_MODEL / MISTRAL_API_KEY: read by Cogito itself.
//
// Cogito's own calls do not report cost, so the dollar budget cannot see them:
// the run cap is the only brake. Keys follow the app's rule: browser-entered
// keys go to the child's environment only, never to disk.
import { spawn } from 'node:child_process';
import { AppError } from './engine.ts';
import { keyFor, type AppSettings } from './providers.ts';

export type CogitoArm = 'peer' | 'strict' | 'both';

export type CogitoInput = {
  boardId: number;
  idea: Record<string, unknown>;
  goal: string;
  arm: CogitoArm;
  showJury: boolean;
};

export type Cogito = {
  configured: boolean;
  maxRunsPerDay: number;
  run(input: CogitoInput): Promise<{ runs: any[] }>;
};

export type CogitoOptions = {
  settings: () => AppSettings;
  dir?: string;
  python?: string;
  flow?: string;
  timeoutS?: number;
  maxRunsPerDay?: number;
  /** Replaces the whole command line (tests). Default: python -m cogito.ideagen_bridge vet-one --stdin */
  command?: string[];
};

const MAX_OUTPUT = 8 * 1024 * 1024;

/** The child's environment: ours, plus browser-entered keys Cogito can use; keys it cannot use are left out. */
export function cogitoEnv(settings: AppSettings, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.OPENROUTER_API_KEY;
  delete env.AZURE_OPENAI_API_KEY;
  const anthropic = keyFor(settings, 'anthropic');
  const openai = keyFor(settings, 'openai');
  if (anthropic) env.ANTHROPIC_API_KEY = anthropic;
  if (openai) env.OPENAI_API_KEY = openai;
  return env;
}

export function createCogito(o: CogitoOptions): Cogito {
  const timeoutS = o.timeoutS && o.timeoutS > 0 ? o.timeoutS : 600;
  const command =
    o.command ??
    (o.dir ? [o.python || 'python3', '-m', 'cogito.ideagen_bridge', 'vet-one', '--stdin', ...(o.flow ? ['--flow', o.flow] : [])] : null);

  return {
    configured: !!command,
    maxRunsPerDay: o.maxRunsPerDay ?? 10,
    run(input) {
      if (!command) throw new AppError(501, 'cogito_off', 'CogitoEngine is not configured (set COGITO_DIR to its folder, then restart)');
      return new Promise((resolve, reject) => {
        const child = spawn(command[0], command.slice(1), { cwd: o.dir, env: cogitoEnv(o.settings()), stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const fail = (code: string, msg: string) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.kill();
          reject(new AppError(502, code, msg));
        };
        timer = setTimeout(() => fail('cogito_timeout', `no result after ${timeoutS}s; the run was stopped`), timeoutS * 1000);
        child.stdout.on('data', (d) => {
          out += d;
          if (out.length > MAX_OUTPUT) fail('cogito_failed', 'output too large');
        });
        child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
        child.on('error', (e) => fail('cogito_failed', `cannot start ${command[0]}: ${e.message}`));
        child.on('close', (code) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (code !== 0) return reject(new AppError(502, 'cogito_failed', `exit ${code}: ${err.trim() || 'no message'}`));
          try {
            const parsed = JSON.parse(out);
            if (!Array.isArray(parsed?.runs)) throw new Error('no "runs" list');
            resolve(parsed);
          } catch (e: any) {
            reject(new AppError(502, 'cogito_failed', `unreadable output: ${e.message}`));
          }
        });
        child.stdin.on('error', () => {}); // the child may die before reading; 'close' reports it
        child.stdin.end(JSON.stringify({ board_id: input.boardId, idea: input.idea, goal: input.goal, arm: input.arm, show_jury: input.showJury }));
      });
    },
  };
}

export function cogitoFromEnv(settings: () => AppSettings, env: NodeJS.ProcessEnv = process.env): Cogito {
  const cap = Number(env.COGITO_MAX_RUNS_PER_DAY);
  return createCogito({
    settings,
    dir: env.COGITO_DIR || undefined,
    python: env.COGITO_PYTHON || undefined,
    flow: env.COGITO_FLOW || undefined,
    timeoutS: Number(env.COGITO_TIMEOUT_S) || 600,
    maxRunsPerDay: env.COGITO_MAX_RUNS_PER_DAY !== undefined && Number.isFinite(cap) && cap >= 0 ? cap : 10,
  });
}
