# 🍡 Project Architecture & API Reference

> Automatically generated architecture graph and API specification.
> **Modules**: 93 | **Total Symbols**: 679

## 🏗️ Architecture Diagram

```mermaid
graph TD;
  src_acp_test_ts["src/acp.test.ts (1 symbols)"]
  src_acp_ts["src/acp.ts (11 symbols)"]
  src_ambient_ts["src/ambient.ts (8 symbols)"]
  src_autopsy_ts["src/autopsy.ts (8 symbols)"]
  src_background_tasks_test_ts["src/background-tasks.test.ts (1 symbols)"]
  src_background_tasks_ts["src/background-tasks.ts (7 symbols)"]
  src_budget_ts["src/budget.ts (15 symbols)"]
  src_checkpoint_manager_ts["src/checkpoint-manager.ts (7 symbols)"]
  src_clarify_ts["src/clarify.ts (11 symbols)"]
  src_cli_ts["src/cli.ts (10 symbols)"]
  src_codebase_sql_test_ts["src/codebase-sql.test.ts (1 symbols)"]
  src_codebase_sql_ts["src/codebase-sql.ts (1 symbols)"]
  src_codegraph_ts["src/codegraph.ts (33 symbols)"]
  src_config_ts["src/config.ts (7 symbols)"]
  src_consolidate_test_ts["src/consolidate.test.ts (2 symbols)"]
```

## 📦 Modules & API Reference

### `src/acp.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 5 | `function` | `function freshSessions(): Map<string, AcpSession>` |

### `src/acp.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 52 | `interface` | `export interface AcpSession` |
| 64 | `interface` | `export interface RpcCall` |
| 70 | `interface` | `export interface RpcResponse` |
| 78 | `function` | `function promptText(prompt: unknown): string` |
| 95 | `type` | `export type AcpNotify` |
| 98 | `function` | `function toolKind(toolName: string): string` |
| 110 | `function` | `export async function handleRpc(` |
| 158 | `function` | `const genMessageId = () => ...` |
| 160 | `function` | `const handleEvent = (e: MochiEvent) => ...` |
| 341 | `function` | `export async function serverLoop(cwd: string): Promise<void>` |
| 344 | `function` | `const send = (msg: unknown) => ...` |

### `src/ambient.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 10 | `interface` | `export interface AmbientOpts` |
| 20 | `interface` | `export interface AmbientReport` |
| 31 | `function` | `function run(cmd: string, cwd: string, timeoutMs: number): Promise<` |
| 41 | `function` | `export async function checkOnce(opts: AmbientOpts): Promise<AmbientReport[]>` |
| 58 | `function` | `export function detectCommands(cwd: string): string[]` |
| 71 | `function` | `function writeProposal(cwd: string, report: AmbientReport): string` |
| 98 | `function` | `export function startAmbient(opts: AmbientOpts): () => void` |
| 100 | `function` | `const tick = async () => ...` |

### `src/autopsy.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 13 | `interface` | `export interface DebugAttempt` |
| 26 | `interface` | `export interface Autopsy` |
| 42 | `function` | `function autopsyDir(workspaceDir: string): string` |
| 49 | `function` | `function autopsyPath(workspaceDir: string, taskId: string): string` |
| 58 | `function` | `export function loadOrCreateAutopsy(` |
| 85 | `function` | `export function appendAttempt(` |
| 97 | `function` | `export function finalizeAutopsy(` |
| 109 | `function` | `export function autopsyOneLine(a: Autopsy): string` |

### `src/background-tasks.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 8 | `function` | `function sleep(ms: number)` |

### `src/background-tasks.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 12 | `interface` | `export interface BackgroundTask` |
| 27 | `function` | `function prune()` |
| 37 | `function` | `export function startBackgroundTask(` |
| 95 | `function` | `export function killTask(id: string): boolean` |
| 117 | `function` | `export function getTask(id: string): BackgroundTask \| undefined` |
| 121 | `function` | `export function listTasks(): BackgroundTask[]` |
| 126 | `function` | `export function describeTask(t: BackgroundTask, maxOutput = 1500): string` |

### `src/budget.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 3 | `interface` | `export interface BudgetLimits` |
| 12 | `type` | `export type BudgetPhase` |
| 14 | `interface` | `export interface BudgetSnapshot` |
| 52 | `function` | `export function estimateCostUsd(tokens: number \|` |
| 76 | `class` | `export class BudgetEngine` |
| 121 | `method` | `remainingTokens(): number` |
| 125 | `method` | `remainingCostUsd(): number` |
| 129 | `method` | `remainingDurationMs(): number` |
| 134 | `method` | `ratio(): number` |
| 145 | `method` | `phase(): BudgetPhase` |
| 154 | `method` | `snapshot(model: string): BudgetSnapshot` |
| 170 | `method` | `canUseTokens(tokens: number): boolean` |
| 174 | `method` | `canMakeModelCall(): boolean` |
| 180 | `method` | `canExecuteTool(): boolean` |
| 184 | `method` | `shouldUseCheaperModel(): boolean` |

### `src/checkpoint-manager.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 9 | `interface` | `export interface NamedCheckpoint` |
| 18 | `function` | `function getCheckpointsDir(cwd: string): string` |
| 24 | `function` | `function runGit(cwd: string, args: string[]): string` |
| 30 | `function` | `export async function saveNamedCheckpoint(` |
| 62 | `function` | `export function listNamedCheckpoints(cwd: string): NamedCheckpoint[]` |
| 81 | `function` | `export async function restoreNamedCheckpoint(` |
| 122 | `function` | `export function deleteNamedCheckpoint(cwd: string, name: string): boolean` |

### `src/clarify.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 9 | `interface` | `export interface Choice` |
| 16 | `interface` | `export interface ClarifyQuestion` |
| 22 | `interface` | `export interface Renderer` |
| 23 | `method` | `render(q: ClarifyQuestion): string;` |
| 24 | `method` | `receive(): Promise<string>;` |
| 28 | `function` | `export function renderMenu(q: ClarifyQuestion): string` |
| 42 | `function` | `export function resolveChoice(q: ClarifyQuestion, raw: string \| null): MenuOutcome` |
| 60 | `interface` | `export interface MenuOutcome` |
| 67 | `function` | `export async function askUserChoice(` |
| 77 | `function` | `export function defaultRenderer(): Renderer` |
| 84 | `method` | `async receive()` |

### `src/cli.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 26 | `function` | `function parseArgs(argv: string[]):` |
| 58 | `function` | `function configFromFlags(flags: Record<string, string \| boolean>): Partial<MochiConfig>` |
| 94 | `function` | `function printHelp()` |
| 168 | `function` | `function cliDirname(): string` |
| 173 | `function` | `function srcFileNewer(dir: string, mtime: number): boolean` |
| 190 | `function` | `async function main()` |
| 345 | `function` | `const post = async (action2: string, extra: Record<string, unknown> = {}) => ...` |
| 999 | `function` | `const onData = (c: Buffer) => ...` |
| 1118 | `function` | `const files = (() => ...` |
| 1159 | `function` | `async function interactive(runtime: import('./runtime.js').Runtime, initialPrompt?: string)` |

### `src/codebase-sql.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 11 | `function` | `const ctx = () => ...` |

### `src/codebase-sql.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 18 | `method` | `async execute(args, ctx)` |

### `src/codegraph.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 14 | `function` | `function tsc(): typeof import('typescript')` |
| 23 | `function` | `export function hasSqlite(): boolean` |
| 38 | `type` | `export type LanguageId` |
| 88 | `function` | `function heritage(node: ts.ClassLikeDeclaration \| ts.InterfaceDeclaration): string[]` |
| 101 | `function` | `function indexFile(file: string, rel: string, database: SqliteDb): void` |
| 105 | `function` | `const lineOf = (p: number) => ...` |
| 108 | `function` | `const emit = (name: string, kind: string, start: number, body: string) => ...` |
| 113 | `function` | `function visit(node: ts.Node): void` |
| 145 | `type` | `export type ParserBackend` |
| 185 | `function` | `function nameOf(node: any): string \| undefined` |
| 212 | `function` | `export function isLightMode(): boolean` |
| 217 | `function` | `function treeSitterAvailable(): boolean` |
| 231 | `function` | `async function ensureCore(): Promise<boolean>` |
| 255 | `function` | `export async function ensureLanguage(lang: LanguageId \| string): Promise<boolean>` |
| 290 | `function` | `async function preloadGrammars(cwd: string, langs?: readonly string[]): Promise<void>` |
| 323 | `function` | `export function loadTreeSitter():` |
| 334 | `function` | `export function getParserBackend(): ParserBackend` |
| 345 | `function` | `export async function ensureParserLoaded(): Promise<void>` |
| 347 | `function` | `function namedChildren(node: any): any[]` |
| 360 | `function` | `function tsIndexFile(file: string, rel: string, database: SqliteDb): void` |
| 403 | `function` | `function callName(node: any): string \| undefined` |
| 422 | `interface` | `interface CachedDb` |
| 429 | `function` | `function fingerprint(full: string): string` |
| 438 | `function` | `function db(cwd: string): SqliteDb` |
| 487 | `function` | `export async function getFunctionSynapse(cwd: string, name: string): Promise<string>` |
| 498 | `function` | `export async function findCallers(cwd: string, name: string): Promise<string>` |
| 539 | `function` | `export async function typeHierarchy(cwd: string, name: string): Promise<string>` |
| 552 | `interface` | `export interface BlastRadiusReport` |
| 565 | `function` | `export async function computeSymbolBlastRadius(cwd: string, name: string): Promise<BlastRadiusReport>` |
| 606 | `interface` | `interface Sym` |
| 612 | `function` | `export function querySymbolGraph(cwd: string, sql: string, maxRows = 50): Promise<` |
| 624 | `function` | `export function querySymbolGraphSync(cwd: string, sql: string, maxRows = 50):` |
| 645 | `function` | `export async function warmCodegraph(cwd: string, langs?: readonly string[]): Promise<void>` |

### `src/config.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 42 | `function` | `function readJsonFile(path: string): Record<string, unknown> \| undefined` |
| 51 | `function` | `function envModelConfig(): Partial<MochiConfig['model']>` |
| 70 | `function` | `export function loadConfig(overrides: Partial<MochiConfig> =` |
| 75 | `function` | `function isPlaceholderKey(key: string \| undefined): boolean` |
| 133 | `function` | `function merge(target: Record<string, unknown>, source: Record<string, unknown>)` |
| 148 | `function` | `export function loadProjectConfig(projectDir: string): Partial<MochiConfig>` |
| 158 | `function` | `export function validateConfig(config: MochiConfig): string[]` |

### `src/consolidate.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 9 | `function` | `function failedTask(over: Partial<Task> =` |
| 28 | `function` | `function failedResult(failed: Task[]): GoalResult` |

### `src/consolidate.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 26 | `function` | `function failureReason(task: Task): string` |
| 37 | `interface` | `export interface ConsolidationResult` |
| 43 | `function` | `export function consolidate(workspaceDir: string, result: GoalResult, model = 'mochi'): ConsolidationResult` |
| 68 | `function` | `export function consolidateReason(task: Pick<Task, 'attempts' \| 'output'>): string` |

### `src/context.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 8 | `function` | `function cfg(): MochiConfig` |
| 127 | `function` | `const mk = (name: string) => ...` |

### `src/context.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 23 | `function` | `function fingerprint(path: string): string` |
| 33 | `function` | `function rulesSource(path: string, label: string): string` |
| 37 | `function` | `export function approxTokens(text: string): number` |
| 45 | `interface` | `export interface ContextState` |
| 59 | `interface` | `export interface ContextPacket` |
| 66 | `class` | `export class ContextEngine` |
| 128 | `method` | `estimateTokens(): number` |
| 134 | `method` | `private loadMemory(query = ''): string` |
| 164 | `method` | `private loadProjectRules(task?: Task): string` |
| 204 | `method` | `private skills(): string` |
| 221 | `method` | `private buildSystemPrompt(tools: ToolDefinition[], repo?: RepoInfo, task?: Task): string` |
| 274 | `method` | `private toolGuidelines(tools: ToolDefinition[]): string` |
| 277 | `function` | `const add = (names: string[], text: string) => ...` |
| 298 | `method` | `private buildVolatilePrompt(task?: Task): string` |
| 327 | `method` | `private buildStatePrompt(task?: Task): string` |
| 352 | `method` | `buildPacket(tools: ToolDefinition[], task?: Task, repo?: RepoInfo): ContextPacket` |
| 416 | `method` | `private trackFileOp(message: ChatMessage)` |
| 444 | `method` | `effectiveContextTokens(): number` |
| 450 | `method` | `private stateLedger(): string` |
| 491 | `method` | `async previewCompact(): Promise<ChatMessage[] \| null>` |
| 497 | `method` | `async compact(checkpoint?: string)` |

### `src/cron.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 10 | `function` | `const tmp = () => ...` |

### `src/cron.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 13 | `interface` | `export interface CronJob` |
| 30 | `function` | `export function everyInterval(spec: string): number \| null` |
| 41 | `function` | `function fieldSet(v: string): number[]` |
| 57 | `function` | `function nextCron(fields: string[], from: number): number \| null` |
| 73 | `function` | `function matches(d: Date, mins: number[], hours: number[], doms: number[], mons: number[], dows: number[]): boolean` |
| 84 | `function` | `export function nextRunFor(spec: string, from = Date.now()): number \| null` |
| 92 | `function` | `export function isRunnable(spec: string): boolean` |
| 97 | `function` | `export function bumpJob(job: CronJob): CronJob` |
| 103 | `function` | `function loadJobs(dir: string): CronJob[]` |
| 114 | `function` | `function saveJobs(dir: string, jobs: CronJob[]): void` |
| 120 | `function` | `export function addJob(dir: string, prompt: string, schedule: string, notify?: string):` |
| 143 | `function` | `export async function notifyJobResult(job: CronJob, summary: string): Promise<void>` |
| 172 | `function` | `export function jobNotify(job: CronJob): string \| null` |
| 176 | `function` | `export function removeJob(dir: string, id: string): boolean` |
| 182 | `function` | `export function updateJob(dir: string, job: CronJob): void` |
| 187 | `function` | `export function listJobs(dir: string): CronJob[]` |
| 192 | `function` | `export function dueJobs(dir: string, now = Date.now()): CronJob[]` |

### `src/daemon.live.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 20 | `function` | `function makeConfig(): MochiConfig` |
| 44 | `function` | `function api(port: number, token: string, path: string, body?: unknown)` |

### `src/daemon.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 9 | `function` | `async function retryUntil<T>(fn: () => T \| undefined, timeout: number): Promise<T>` |

### `src/daemon.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 20 | `interface` | `export interface DaemonInfo` |
| 29 | `function` | `export function daemonInfoPath(workspaceDir: string): string` |
| 33 | `function` | `export function readDaemonInfo(workspaceDir: string): DaemonInfo \| undefined` |
| 43 | `function` | `function pidAlive(pid: number): boolean` |
| 53 | `function` | `function timingSafeEqualStr(a: string, b: string): boolean` |
| 61 | `function` | `export function daemonRunning(workspaceDir: string): boolean` |
| 66 | `function` | `function writeInfo(workspaceDir: string, info: DaemonInfo): void` |
| 81 | `function` | `export async function startDaemon(opts:` |
| 114 | `function` | `export async function startDaemonInProcess(opts:` |
| 143 | `function` | `const runDue = async () => ...` |
| 176 | `function` | `function getDashboardHtml(token: string): string` |
| 258 | `function` | `async function sendGoal()` |
| 306 | `function` | `function sendQuick(cmd)` |
| 311 | `function` | `function addMsg(text, type)` |
| 325 | `function` | `async function handleRequest(` |
| 331 | `function` | `const send = (code: number, body: unknown) => ...` |
| 460 | `function` | `const sse = (event: string, data: unknown) => ...` |
| 466 | `function` | `const onAbort = () => ...` |
| 491 | `function` | `export async function serverMain(argv: string[]): Promise<void>` |

### `src/diagnosis.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 8 | `type` | `export type FailureKind` |
| 18 | `interface` | `export interface Hypothesis` |
| 26 | `interface` | `export interface DiagnosisResult` |
| 34 | `function` | `export function classifyFailure(failureText: string):` |
| 65 | `function` | `export function rankHypotheses(h: Hypothesis[]): Hypothesis[]` |
| 76 | `function` | `export function syntaxProbe(file: string): string \| undefined` |
| 96 | `function` | `export function typeProbe(file: string): string \| undefined` |
| 115 | `function` | `export function formInitialHypotheses(` |
| 120 | `function` | `const base = (file: string \| undefined) => ...` |
| 176 | `function` | `export function evaluateProbe(` |
| 192 | `function` | `export function diagnosisToPrompt(diag: DiagnosisResult): string` |

### `src/diagnostics.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 8 | `function` | `function tsProject()` |
| 57 | `method` | `writeFileSync(good, 'def fine():\n    return 1\n');` |

### `src/diagnostics.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 18 | `interface` | `export interface FileDiagnostics` |
| 29 | `function` | `function cap(lines: string[]): string[]` |
| 35 | `interface` | `interface TsService` |
| 43 | `function` | `function getTsService(root: string): TsService \| undefined` |
| 87 | `function` | `async function diagnoseTsViaCli(path: string, cwd: string): Promise<FileDiagnostics>` |
| 96 | `function` | `function diagnoseTs(path: string, root: string): FileDiagnostics` |
| 120 | `function` | `function exec(cmd: string, args: string[], cwd: string, timeout: number): Promise<` |
| 133 | `function` | `async function diagnosePython(path: string, cwd: string): Promise<FileDiagnostics>` |
| 144 | `function` | `export async function diagnoseFile(path: string, cwd: string): Promise<FileDiagnostics>` |
| 171 | `function` | `export function renderDiagnostics(diags: FileDiagnostics[]): string` |

### `src/discord.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 10 | `interface` | `export interface DiscordConfig` |
| 19 | `function` | `export function loadDiscordConfig(cwd: string): DiscordConfig \| null` |
| 61 | `function` | `export async function sendDiscordMessage(` |
| 89 | `function` | `export async function handleDiscordMessage(` |

### `src/docgen.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 9 | `interface` | `export interface ModuleDoc` |
| 15 | `interface` | `export interface ProjectDocs` |
| 27 | `function` | `function scanSourceFiles(dir: string, maxFiles = 100): string[]` |
| 57 | `function` | `function extractImports(content: string): string[]` |
| 72 | `function` | `export function generateProjectDocs(cwd: string, opts:` |

### `src/doctor.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 11 | `function` | `function tmp(): string` |

### `src/doctor.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 11 | `interface` | `export interface DoctorReport` |
| 29 | `function` | `export async function doctorReport(opts:` |
| 43 | `function` | `const tsAvailable = (() => ...` |
| 76 | `function` | `export function formatDoctor(r: DoctorReport): string` |
| 77 | `function` | `const ok = (b: boolean) => ...` |
| 93 | `interface` | `export interface RepairItem` |
| 100 | `function` | `export async function repairDoctor(opts:` |

### `src/dox.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 11 | `interface` | `export interface DocChunk` |
| 22 | `function` | `export function indexDocs(root: string, maxChunks = 400): DocChunk[]` |
| 64 | `function` | `export function queryDocs(root: string, query: string, limit = 5): DocChunk[]` |
| 82 | `interface` | `export interface AdrInput` |
| 92 | `function` | `export function nextAdrNumber(adrDir: string): number` |
| 103 | `function` | `export function generateAdr(root: string, input: AdrInput): string` |

### `src/esm-hygiene.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 16 | `function` | `function listTsFiles(dir: string, acc: string[] = []): string[]` |
| 30 | `function` | `function stripComments(src: string): string` |

### `src/events.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 3 | `class` | `export class EventBus` |
| 47 | `method` | `async emitAwait(event: MochiEvent)` |

### `src/fast-events.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 3 | `type` | `type Handler` |
| 5 | `interface` | `export interface EventBusStats` |
| 13 | `class` | `export class FastEventBus` |
| 26 | `method` | `on(type: CompactEvent['type'] \| '*', handler: Handler): () => void` |
| 45 | `method` | `emit(event: CompactEvent): void` |
| 66 | `method` | `flush(): void` |
| 77 | `method` | `private dispatch(event: CompactEvent, updateStats = true): void` |
| 87 | `method` | `private updateStats(count: number, elapsed: number): void` |
| 95 | `method` | `getStats(): EventBusStats` |

### `src/git.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 14 | `function` | `function makeRepo(): string` |
| 21 | `function` | `function dirty(cwd: string): boolean` |

### `src/git.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 4 | `function` | `function run(cwd: string, args: string[]): Promise<string>` |
| 19 | `function` | `export async function isRepo(cwd: string): Promise<boolean>` |
| 28 | `function` | `export async function status(cwd: string): Promise<string>` |
| 33 | `function` | `export async function diff(cwd: string): Promise<string>` |
| 38 | `function` | `export async function log(cwd: string, n = 10): Promise<string>` |
| 43 | `interface` | `export interface CheckpointResult` |
| 49 | `function` | `export async function checkpoint(cwd: string, message = 'mochi checkpoint'): Promise<CheckpointResult>` |
| 68 | `function` | `export async function restore(cwd: string, checkpoint: CheckpointResult): Promise<string>` |
| 88 | `function` | `export async function preEditSnapshot(cwd: string, message = 'mochi pre-edit', stateDir = '.mochi'): Promise<CheckpointResult \| null>` |
| 110 | `function` | `export async function rollbackToSnapshot(cwd: string, cp: CheckpointResult, stateDir = '.mochi'): Promise<string>` |

### `src/hooks.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 5 | `type` | `export type HookName` |
| 24 | `interface` | `export interface HookConfig` |
| 28 | `interface` | `export interface HookResult` |
| 35 | `class` | `export class HookManager` |
| 49 | `method` | `list(): HookName[]` |
| 53 | `method` | `enabled(name: HookName): boolean` |
| 57 | `method` | `private commandsFor(name: HookName): string[]` |
| 64 | `method` | `async runBefore(name: HookName, context: Record<string, string> =` |
| 76 | `method` | `async runAfter(name: HookName, context: Record<string, string> =` |

### `src/kv-cache.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 9 | `type` | `export type CacheState` |
| 11 | `interface` | `export interface CacheStatus` |
| 28 | `class` | `export class KvCacheTracker` |
| 33 | `method` | `get lastCacheSaved(): number` |
| 35 | `method` | `get totalCacheSaved(): number` |
| 55 | `method` | `recordCacheHit(savedTokens: number): void` |
| 61 | `method` | `status(): CacheStatus` |
| 89 | `method` | `badge(): string` |
| 95 | `method` | `reset(): void` |

### `src/learning.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 4 | `interface` | `export interface RecoveryRecord` |
| 11 | `interface` | `export interface LearningState` |
| 23 | `function` | `export function classifyFailure(error: string): RecoveryRecord \| undefined` |
| 32 | `class` | `export class LearningStore` |
| 51 | `method` | `private save()` |
| 57 | `method` | `private find(pattern: string, strategy: string): RecoveryRecord \| undefined` |
| 72 | `method` | `successRate(pattern: string, strategy: string): number` |
| 78 | `method` | `bestStrategy(pattern: string): RecoveryRecord \| undefined` |
| 84 | `method` | `knownStrategies(): RecoveryRecord[]` |

### `src/lessons.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 13 | `interface` | `export interface Lesson` |
| 27 | `function` | `export function lessonsPath(workspaceDir: string): string` |
| 31 | `function` | `export function loadLessons(workspaceDir: string): Lesson[]` |
| 42 | `function` | `export function saveLessons(workspaceDir: string, lessons: Lesson[]): void` |
| 49 | `function` | `export function recordLesson(workspaceDir: string, lesson: Omit<Lesson, 'useCount' \| 'successCount' \| 'recordedAtMs'>): Lesson[]` |
| 72 | `function` | `export function retrieveLessons(workspaceDir: string, signal: string, kind?: string, limit = 3): Lesson[]` |
| 86 | `function` | `export function markLessonUsed(workspaceDir: string, id: string, succeeded: boolean): void` |
| 97 | `function` | `export function lessonsToPrompt(lessons: Lesson[]): string` |

### `src/memory.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 4 | `interface` | `export interface MemoryEntry` |
| 12 | `function` | `function entryToMarkdown(e: MemoryEntry): string` |
| 22 | `class` | `export class MemoryStore` |
| 73 | `method` | `load(kind?: MemoryEntry['kind']): string` |
| 93 | `method` | `entries(kind?: MemoryEntry['kind']): MemoryEntry[]` |
| 120 | `method` | `summary(): string` |

### `src/model-manager.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 26 | `function` | `function base(): MochiConfig` |

### `src/model-manager.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 4 | `interface` | `export interface ProviderSelection` |
| 11 | `function` | `export function currentConfig(): MochiConfig` |
| 15 | `function` | `export function setProvider(config: MochiConfig, selection: ProviderSelection): MochiConfig` |
| 39 | `function` | `export function login(config: MochiConfig, providerId: string, apiKey: string, model?: string): MochiConfig` |
| 50 | `function` | `export function selectProviderById(config: MochiConfig, providerId: string, model?: string): MochiConfig` |
| 60 | `function` | `export function listProviderIds(): string[]` |
| 64 | `function` | `export function listModelsForProvider(providerId: string): string[]` |
| 69 | `function` | `export function describeConfig(config: MochiConfig): string` |
| 78 | `function` | `export function maskApiKey(key: string): string` |

### `src/model-router.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 13 | `type` | `export type TaskTier` |
| 15 | `interface` | `interface RouterDecision` |
| 22 | `function` | `export function classifyTaskTier(taskTitle: string, taskRole?: string): TaskTier` |
| 39 | `function` | `export function resolveModel(config: ModelConfig, tier: TaskTier): string` |
| 51 | `function` | `async function sleep(ms: number): Promise<void>` |
| 55 | `interface` | `export interface RetryConfig` |
| 67 | `function` | `export async function withFailover<T>(` |

### `src/modes.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 5 | `function` | `const base = () => ...` |

### `src/modes.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 13 | `type` | `export type AgentMode` |
| 15 | `interface` | `export interface ModeSpec` |
| 75 | `function` | `export function modeSpec(mode: AgentMode): ModeSpec` |
| 79 | `function` | `export function isMode(s: string): s is AgentMode` |
| 84 | `function` | `export function applyMode(config: MochiConfig, mode: AgentMode): MochiConfig` |
| 94 | `function` | `export function modeInstruction(mode: AgentMode): string` |
| 101 | `function` | `export function formatModes(current: AgentMode): string` |

### `src/mutation.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 9 | `function` | `function makeRepo(): string` |

### `src/mutation.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 23 | `interface` | `export interface MutationCheck` |
| 72 | `function` | `function isTestFile(path: string): boolean` |
| 91 | `function` | `function isInStringOrComment(source: string, idx: number): boolean` |
| 125 | `function` | `export function findMutation(source: string):` |
| 157 | `function` | `export function changedSourceFiles(cwd: string): string[]` |
| 207 | `function` | `export async function runMutationCheck(` |

### `src/one-shot.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 10 | `interface` | `interface ClassifyInput` |
| 17 | `type` | `export type OneShotKind` |
| 48 | `function` | `export function classifyOneShot(input: ClassifyInput):` |
| 93 | `function` | `export function classifyContentOnly(input: ClassifyInput): boolean` |

### `src/perf.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 3 | `function` | `function sse(payload: object)` |
| 7 | `interface` | `export interface PerfReport` |
| 18 | `function` | `export function benchmarkStream(chunks = 10_000): PerfReport` |
| 44 | `function` | `export function formatPerfReport(report: PerfReport): string` |
| 45 | `function` | `const pct = (v: number) => ...` |

### `src/performance-pipeline.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 5 | `function` | `function sse(payload: object)` |

### `src/performance-pipeline.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 8 | `interface` | `export interface PipelineState` |
| 18 | `interface` | `export interface PipelineStats` |
| 26 | `class` | `export class PerformancePipeline` |
| 52 | `method` | `private wire(): void` |
| 69 | `method` | `write(chunk: string): void` |
| 76 | `method` | `end(): void` |
| 81 | `method` | `private emitBatched(events: CompactEvent[]): void` |
| 93 | `method` | `markRegion(region: UIRegion): void` |
| 97 | `method` | `render(): void` |
| 101 | `method` | `getStats(): PipelineStats` |

### `src/permission.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 13 | `type` | `export type PermissionPolicy` |
| 22 | `function` | `export function detectPolicy(flags: Record<string, string \| boolean>): PermissionPolicy` |
| 41 | `interface` | `export interface PermissionRequest` |
| 48 | `type` | `export type PermissionDecision` |
| 50 | `class` | `export class PermissionManager` |
| 63 | `method` | `get currentPolicy(): PermissionPolicy` |
| 65 | `method` | `setPolicy(p: PermissionPolicy): void` |
| 68 | `method` | `autoAllow(req: PermissionRequest): boolean` |
| 111 | `method` | `badge(): string` |
| 128 | `function` | `export function parsePermissionSlashCommand(` |

### `src/pipeline.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 8 | `function` | `function streamFrom(text: string): Readable` |

### `src/pipeline.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 12 | `interface` | `export interface ReviewFinding` |
| 23 | `function` | `export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string>` |
| 37 | `function` | `export function parseFindings(text: string): ReviewFinding[]` |
| 66 | `function` | `export function findingsToNdjson(findings: ReviewFinding[]): string` |
| 71 | `function` | `export function renderFindings(findings: ReviewFinding[]): string` |
| 82 | `function` | `export function countBySeverity(findings: ReviewFinding[]): Record<ReviewFinding['severity'], number>` |
| 89 | `function` | `export function loadDiff(files: string[], cwd: string): string` |
| 111 | `function` | `function runGit(cwd: string, args: string[]): string` |
| 121 | `function` | `export function readLocalInput(file: string): string` |

### `src/plugins.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 7 | `function` | `function makeProject(dir: string)` |
| 12 | `function` | `function makeReg(project: string)` |
| 108 | `function` | `function makeSource(name: string, hooks?: Record<string, string \| string[]>)` |

### `src/plugins.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 15 | `interface` | `export interface PluginManifest` |
| 25 | `interface` | `export interface PluginRecord` |
| 41 | `function` | `export function isHookName(s: string): s is HookName` |
| 46 | `function` | `export function readManifest(dir: string): PluginManifest` |
| 56 | `function` | `function defaultUserPluginsDir(): string` |
| 61 | `class` | `export class PluginRegistry` |
| 68 | `method` | `list(): PluginRecord[]` |
| 94 | `method` | `has(name: string): boolean` |
| 99 | `method` | `isProjectScoped(name: string): boolean` |
| 109 | `method` | `install(sourceDir: string, opts:` |
| 127 | `method` | `remove(name: string): boolean` |
| 137 | `method` | `mergedHooks(): HookConfig` |
| 151 | `method` | `syncToHooksFile(hooksFile: string, existing: HookConfig =` |
| 163 | `method` | `get dir()` |
| 167 | `method` | `private ensureUserDir(): string` |
| 174 | `function` | `function toArray(v: string \| string[] \| undefined): string[]` |

### `src/pr.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 8 | `interface` | `export interface Issue` |
| 16 | `interface` | `export interface PrOptions` |
| 27 | `interface` | `export interface PrResult` |
| 35 | `function` | `function run(cmd: string, args: string[], cwd: string): Promise<string>` |
| 45 | `function` | `export async function fetchIssue(issueNumber: number, ghBin = 'gh'): Promise<Issue>` |
| 58 | `function` | `export async function defaultBranch(cwd: string): Promise<string>` |
| 71 | `function` | `export async function runIssueToPr(opts: PrOptions): Promise<PrResult>` |

### `src/providers.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 6 | `type` | `export type ProviderKind` |
| 8 | `interface` | `export interface Provider` |
| 46 | `function` | `export function configFilePath(): string` |
| 52 | `function` | `export function loadConfigFile(): MochiConfig` |
| 62 | `function` | `export function saveConfigFile(cfg: MochiConfig): void` |

### `src/relevance.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 13 | `function` | `function tokenize(text: string): string[]` |
| 23 | `function` | `export function tokenOverlap(query: string, candidate: string): number` |
| 38 | `function` | `export function scoreEntry(query: string, title: string, body: string, kind = ''): number` |
| 44 | `interface` | `export interface SelectableEntry` |
| 59 | `function` | `export function selectRelevant(` |

### `src/repo.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 66 | `function` | `const hintFor = (f: (dir: string) => ...` |

### `src/repo.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 16 | `interface` | `export interface LangSpec` |
| 63 | `function` | `function pickExisting(root: string, paths: string[]): string[]` |
| 70 | `function` | `function globAny(root: string, glob: string): boolean` |
| 220 | `function` | `export function detectLang(root: string): string \| undefined` |
| 231 | `function` | `function resolveFn<T>(v: T \| ((root: string) => T) \| undefined, root: string): T \| undefined` |
| 235 | `function` | `export function detectRepo(root: string): RepoInfo` |
| 304 | `function` | `export function findProjectRoot(cwd: string): string` |
| 316 | `function` | `export function languageHint(repo: RepoInfo): string` |

### `src/retrieval.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 8 | `interface` | `export interface SymbolInfo` |
| 15 | `interface` | `export interface ReferenceInfo` |
| 21 | `interface` | `export interface ImportInfo` |
| 26 | `interface` | `export interface RetrievalResult` |
| 36 | `class` | `export class RetrievalEngine` |
| 39 | `method` | `listFiles(max = 2000): string[]` |
| 41 | `function` | `const walk = (dir: string) => ...` |
| 128 | `method` | `private gitLog(file: string): Promise<string[]>` |
| 139 | `method` | `private scoreFile(query: string, file: string): number` |
| 151 | `method` | `async inspect(query: string, maxResults = 5): Promise<RetrievalResult>` |

### `src/rules.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 4 | `interface` | `export interface ProjectRule` |
| 15 | `function` | `export function parseRuleFile(filePath: string): ProjectRule \| null` |
| 65 | `function` | `export function loadRules(projectRoot: string): ProjectRule[]` |
| 82 | `function` | `export function selectActiveRules(` |
| 116 | `function` | `export function synthesizeRule(` |

### `src/runtime.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 10 | `function` | `function makeRepo(): string` |
| 17 | `function` | `function baseConfig(): MochiConfig` |
| 29 | `function` | `async function fakeServer(): Promise<FakeOpenAI>` |

### `src/runtime.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 22 | `interface` | `export interface RuntimeOptions` |
| 27 | `class` | `export class Runtime` |
| 71 | `method` | `abort(reason = 'aborted by user'): void` |
| 76 | `method` | `resetAbort(): void` |
| 83 | `method` | `get aborted(): boolean` |
| 89 | `method` | `get signal(): AbortSignal` |
| 96 | `function` | `const onSig = () => ...` |
| 109 | `method` | `static create(opts?: RuntimeOptions): Runtime` |
| 113 | `method` | `async checkpoint(message = 'mochi checkpoint'): Promise<CheckpointResult>` |
| 122 | `method` | `async rollback(): Promise<string>` |
| 132 | `method` | `async speculate(question: string): Promise<SpeculativeResult>` |
| 144 | `method` | `setMode(mode: string): string` |
| 152 | `method` | `setReasoning(level: string): string` |
| 178 | `method` | `getReasoning(): import('./types.js').ReasoningLevel` |
| 183 | `method` | `newSession(): string` |
| 189 | `method` | `resetSession(): void` |
| 194 | `method` | `listTools(): Array<` |
| 205 | `method` | `getToolNames(): string[]` |
| 214 | `method` | `async inspect(query: string)` |
| 218 | `method` | `async goal(objective: string, constraints: string[] = [], opts?:` |
| 227 | `method` | `async runGoal(objective: string, constraints: string[] = [], opts?:` |
| 255 | `method` | `async team(objective: string, opts?:` |
| 272 | `method` | `async plan(objective: string): Promise<string>` |
| 286 | `method` | `async approvePlan(): Promise<string>` |
| 300 | `method` | `async resumeGoal(goalId: string): Promise<string>` |
| 336 | `method` | `async enhance(task: string, mode?: import('./chameleon.js').ChameleonMode, budget?: import('./budget.js').BudgetEngine)` |
| 342 | `method` | `async runPrompt(prompt: string, opts?:` |
| 381 | `method` | `async review(input: string): Promise<string>` |
| 402 | `method` | `async fix(input: string): Promise<string>` |
| 417 | `method` | `private recordUsage(goal: string, result:` |
| 430 | `method` | `providerInfo(): string` |
| 434 | `method` | `modelList(): string[]` |
| 438 | `method` | `async useProvider(providerId: string, model?: string)` |
| 447 | `method` | `async loginProvider(provider: string, apiKey: string, model?: string)` |
| 475 | `method` | `async recordGood(): Promise<string>` |
| 479 | `method` | `return (lines.length ? lines.join('\n') : '  (no checks configured)') + '\nRecorded as known-good baseline.';` |
| 482 | `method` | `async knownGood(): Promise<string>` |

### `src/say-hi.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 5 | `function` | `export function sayHi(): string` |

### `src/scheduler.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 1 | `type` | `type Task` |
| 3 | `class` | `export class BatchScheduler` |
| 8 | `method` | `schedule(task: Task): void` |
| 15 | `method` | `flush(): void` |

### `src/security.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 55 | `function` | `const mkCtx = (mode: string) => ...` |

### `src/security.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 27 | `function` | `export function redact(input: string): string` |
| 35 | `function` | `export function redactObject<T>(value: T, depth = 3): T` |
| 47 | `type` | `export type CommandRisk` |
| 72 | `function` | `export function classifyCommand(cmd: string): CommandRisk` |
| 80 | `interface` | `export interface Approval` |
| 88 | `class` | `export class ApprovalQueue` |
| 91 | `method` | `request(reason: string): Approval` |
| 97 | `method` | `decide(id: string, status: 'approved' \| 'denied'): Approval \| undefined` |
| 103 | `method` | `pending(): Approval[]` |
| 106 | `function` | `function randomId(): string` |

### `src/session-store.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 13 | `interface` | `export interface SessionMessage` |
| 19 | `function` | `export function hasSqlite(): boolean` |
| 24 | `interface` | `export interface SessionRow` |
| 62 | `class` | `export class SessionStore` |
| 83 | `method` | `close(): void` |
| 87 | `method` | `begin(obj:` |
| 118 | `method` | `append(sessionId: string, role: string, content: string): void` |
| 130 | `method` | `messages(sessionId: string): SessionMessage[]` |
| 136 | `method` | `search(query: string, limit = 10): Array<` |
| 150 | `method` | `list(limit = 20): SessionRow[]` |
| 161 | `method` | `session(id: string): SessionRow \| undefined` |
| 170 | `method` | `markCompleted(id: string, status: 'completed'): void` |
| 175 | `method` | `rename(id: string, objective: string): void` |
| 181 | `method` | `recentSummaries(limit = 5): Array<` |
| 195 | `method` | `fullTranscript(sessionId: string): string` |
| 204 | `method` | `delete(id: string): void` |
| 215 | `function` | `export function sessionKey(objective: string): string` |

### `src/skills.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 16 | `interface` | `export interface Skill` |
| 31 | `function` | `export function validateSkillName(name: string): string[]` |
| 41 | `function` | `export function parseFrontmatter(raw: string):` |
| 80 | `function` | `export function loadSkillFile(filePath: string):` |
| 122 | `function` | `export function discoverSkills(dir: string, depth = 0, maxEntries = 4096):` |
| 165 | `function` | `export function loadProjectSkills(projectDir: string, userDir?: string, extraDirs: string[] = []):` |
| 169 | `function` | `function add(skills: Skill[], d: string[])` |
| 191 | `function` | `export function formatSkillsForPrompt(skills: Skill[], limit?: number): string` |
| 208 | `function` | `function esc(s: string): string` |
| 213 | `function` | `export function readSkillBody(skill: Skill, projectDir: string): string` |
| 227 | `type` | `export type SkillContext` |
| 232 | `function` | `export function bundledSkillsDir(): string \| null` |
| 254 | `function` | `export function loadAllSkills(projectDir: string, userDir?: string):` |
| 259 | `function` | `const add = (d: string) => ...` |

### `src/speculative.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 5 | `interface` | `export interface SpeculativeCandidate` |
| 11 | `interface` | `export interface SpeculativeResult` |
| 18 | `class` | `export class SpeculativeEngine` |
| 25 | `method` | `async speculate(question: string): Promise<SpeculativeResult>` |

### `src/sqlite.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 8 | `interface` | `export interface Stmt` |
| 9 | `method` | `get(...params: unknown[]): unknown;` |
| 10 | `method` | `all(...params: unknown[]): unknown[];` |
| 11 | `method` | `run(...params: unknown[]):` |
| 14 | `interface` | `export interface SqliteDb` |
| 15 | `method` | `exec(sql: string): void;` |
| 16 | `method` | `prepare(sql: string): Stmt;` |
| 17 | `method` | `close(): void;` |
| 20 | `type` | `type DbCtor` |
| 21 | `type` | `export type SqliteSource` |
| 26 | `function` | `async function detect(): Promise<` |
| 59 | `function` | `function ensureReady(): Promise<void>` |
| 72 | `function` | `export async function sqliteDriverAsync(): Promise<DbCtor \| null>` |
| 85 | `function` | `function syncProbe(): void` |
| 104 | `function` | `export function sqliteSource(): SqliteSource` |
| 115 | `function` | `export function hasSqlite(): boolean` |
| 138 | `function` | `export function openDb(path: string): SqliteDb` |

### `src/state-store.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 4 | `interface` | `interface TestState` |

### `src/state-store.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 3 | `type` | `type Listener` |
| 5 | `class` | `export class StateStore<T extends Record<string, unknown>>` |
| 18 | `method` | `markHot(key: keyof T & string): void` |
| 33 | `method` | `subscribeRegion(region: UIRegion, listener: Listener): () => void` |
| 45 | `method` | `subscribeAll(listener: Listener): () => void` |
| 53 | `method` | `getDirty(): UIRegion[]` |
| 57 | `method` | `isDirty(region: UIRegion): boolean` |
| 61 | `method` | `flush(): void` |
| 78 | `method` | `snapshot(): T` |

### `src/stream-events.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 1 | `type` | `export type CompactEvent` |
| 9 | `type` | `export type UIRegion` |
| 20 | `interface` | `export interface DirtySet` |
| 22 | `method` | `mark(region: UIRegion): void;` |
| 23 | `method` | `clear(): void;` |
| 24 | `method` | `has(region: UIRegion): boolean;` |
| 25 | `method` | `isEmpty(): boolean;` |
| 28 | `function` | `export function createDirtySet(): DirtySet` |

### `src/stream-parser.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 4 | `function` | `function sse(payload: object)` |

### `src/stream-parser.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 3 | `interface` | `interface ToolCallAccumulator` |
| 16 | `class` | `export class StreamParser` |
| 28 | `method` | `write(chunk: string): CompactEvent[]` |
| 50 | `method` | `end(): CompactEvent[]` |
| 63 | `method` | `private parseLine(line: string, events: CompactEvent[]): 'continue' \| 'done'` |
| 109 | `method` | `private consumeToolCalls(toolCalls: any[], events: CompactEvent[]): void` |
| 133 | `method` | `private emitToolEnds(events: CompactEvent[]): void` |

### `src/taskkind.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 7 | `type` | `export type TaskKind` |
| 20 | `function` | `export function classifyTaskKind(task: Pick<Task, 'title' \| 'description' \| 'role'>): TaskKind` |
| 50 | `function` | `export function kindHint(kind: TaskKind): string` |

### `src/termix.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 6 | `function` | `function makeConfig(url: string)` |

### `src/termix.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 12 | `type` | `export type TermixMode` |
| 14 | `interface` | `export interface TermixOptions` |
| 21 | `interface` | `export interface SessionResult` |
| 32 | `interface` | `export interface TermixRun` |
| 50 | `function` | `const SYSTEM = (role: string, communicate: boolean) => ...` |
| 57 | `function` | `function peerNotes(broadcast: string[], selfIndex: number): string` |
| 61 | `function` | `function nextUserPrompt(i: number, mode: TermixMode, peer: string, mine: string): string` |
| 70 | `function` | `async function runSession(` |
| 146 | `function` | `export async function termix(opts: TermixOptions): Promise<TermixRun>` |

### `src/testdetect.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 25 | `function` | `function hasProjectMarker(dir: string): boolean` |
| 38 | `function` | `function nearestProjectRoot(dir: string): string \| undefined` |
| 47 | `function` | `export function autoTestCommand(cwd: string, fileScope: string[] \| undefined): string \| null` |
| 150 | `function` | `export function isWeakVerification(command: string \| undefined): boolean` |
| 171 | `function` | `export function cwdForScope(cwd: string, fileScope: string[] \| undefined): string \| undefined` |
| 195 | `function` | `export function withCwd(cmd: string, dir: string \| undefined): string` |

### `src/trace.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 51 | `function` | `function format<T>(_x: T): string; function format(entries: unknown[]): string` |

### `src/trace.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 16 | `interface` | `export interface TraceEntry` |
| 23 | `class` | `export class TraceRecorder` |
| 36 | `method` | `attach(events: EventBus): this` |
| 41 | `method` | `attachAgent(events: EventBus, agentId: string): this` |
| 46 | `method` | `private write(event: MochiEvent, forcedAgent?: string): void` |
| 63 | `method` | `log(entry: TraceEntry): void` |
| 69 | `method` | `close(): void` |
| 77 | `function` | `export function readTrace(workspaceDir: string, runId: string): TraceEntry[]` |
| 88 | `function` | `export function formatTrace(entries: TraceEntry[]): string` |

### `src/types.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 3 | `type` | `export type ModelProfile` |
| 5 | `interface` | `export interface ModelConfig` |
| 18 | `interface` | `export interface PermissionConfig` |
| 26 | `interface` | `export interface SafetyConfig` |
| 41 | `type` | `export type ReasoningLevel` |
| 43 | `interface` | `export interface MochiConfig` |
| 62 | `type` | `export type TaskStatus` |
| 64 | `interface` | `export interface Attempt` |
| 73 | `interface` | `export interface Task` |
| 95 | `interface` | `export interface TodoItem` |
| 102 | `interface` | `export interface Goal` |
| 116 | `type` | `export type AgentRole` |
| 118 | `interface` | `export interface AgentProfile` |
| 129 | `interface` | `export interface ToolParameter` |
| 137 | `interface` | `export interface ToolDefinition` |
| 145 | `interface` | `export interface ToolCall` |
| 154 | `interface` | `export interface ToolResult` |
| 162 | `interface` | `export interface ChatMessage` |
| 170 | `interface` | `export interface StreamToolCall` |
| 180 | `interface` | `export interface StreamChunk` |
| 188 | `interface` | `export interface ModelResponse` |
| 196 | `interface` | `export interface AgentState` |
| 207 | `interface` | `export interface RepoInfo` |
| 219 | `type` | `export type MochiEvent` |

### `src/usage.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 6 | `interface` | `export interface UsageRecord` |
| 15 | `interface` | `export interface UsageEntry` |
| 21 | `interface` | `export interface UsageStoreData` |
| 25 | `class` | `export class UsageStore` |
| 44 | `method` | `private save()` |
| 50 | `method` | `record(model: string, goal: string, usage: Partial<UsageRecord>): void` |
| 69 | `method` | `total(): UsageRecord` |
| 82 | `method` | `summary(): string` |
| 94 | `method` | `recent(n = 5): string` |

### `src/util.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 21 | `function` | `export function randomSlug(): string` |
| 25 | `interface` | `export interface BinaryResult` |
| 32 | `function` | `export function binarySearch<T>(array: T[], id: string, compare: (item: T) => string): BinaryResult` |
| 46 | `function` | `export function binaryInsert<T>(array: T[], item: T, compare: (item: T) => string): T[]` |
| 54 | `function` | `export function binaryInsertInPlace<T>(array: T[], item: T, compare: (item: T) => string): T[]` |
| 74 | `function` | `export function sortableId(timestamp = Date.now()): string` |
| 92 | `function` | `export function lazy<T>(init: () => T): () => T` |
| 108 | `function` | `export function getFilename(path: string \| undefined): string` |
| 116 | `function` | `export function getDirectory(path: string \| undefined): string` |
| 125 | `function` | `export function getFilenameTruncated(path: string \| undefined, maxLength = 20): string` |
| 138 | `function` | `export function truncateMiddle(text: string, maxLength = 20): string` |

### `src/verification.baseline.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 9 | `function` | `function baseline(entries: Record<string, string>): VerificationBaseline` |

### `src/verification.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 15 | `function` | `function execFileAsync(cmd: string, args: string[], cwd: string): Promise<string>` |
| 24 | `type` | `export type VerificationStatus` |
| 26 | `interface` | `export interface VerificationEvidence` |
| 35 | `interface` | `export interface VerificationResult` |
| 44 | `interface` | `export interface VerifierOptions` |
| 55 | `class` | `export class VerifierEngine` |
| 74 | `method` | `async verify(task: Task, agentSummary: string): Promise<VerificationResult>` |
| 222 | `method` | `private ruleBased(task: Task, evidence: VerificationEvidence[]): VerificationResult` |
| 258 | `method` | `private build(` |
| 290 | `function` | `const inScope = (f: string) => ...` |
| 332 | `method` | `private runCommand(command: string, timeout = 120): Promise<string>` |
| 360 | `interface` | `export interface VerificationBaseline` |
| 369 | `function` | `export function failureSignature(output: string): string` |
| 396 | `function` | `export async function captureBaseline(` |
| 423 | `function` | `export function matchesBaseline(baseline: VerificationBaseline \| undefined, command: string, output: string): boolean` |

### `src/vnext-phases.test.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 12 | `function` | `function makeContext():` |

### `src/workspace.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 13 | `class` | `export class QueueMutex` |
| 25 | `interface` | `export interface WorkspaceState` |
| 31 | `class` | `export class Workspace` |
| 77 | `method` | `loadGoal(goalId: string): Goal \| undefined` |
| 85 | `method` | `loadTasks(goalId: string): Task[]` |
| 93 | `method` | `loadState(): AgentState` |
| 121 | `method` | `loadCheckpoint(goalId?: string):` |
| 129 | `method` | `loadTodos(): import('./types.js').TodoItem[]` |
| 156 | `method` | `async appendCompletedTask(title: string): Promise<boolean>` |
| 166 | `method` | `loadWorkspaceState(): WorkspaceState` |
| 174 | `method` | `listGoals(): string[]` |

### `src/worktree.ts`
| Line | Kind | Signature |
| :--- | :--- | :--- |
| 12 | `interface` | `export interface WorktreeInfo` |
| 20 | `function` | `function git(cwd: string, args: string[]): string` |
| 28 | `function` | `function gitAsync(cwd: string, args: string[]): Promise<string>` |
| 37 | `class` | `export class WorktreeManager` |
| 49 | `method` | `async create(label = 'worker'): Promise<WorktreeInfo>` |
| 70 | `method` | `async merge(id: string, message?: string): Promise<string>` |
| 82 | `method` | `async discard(id: string): Promise<void>` |
| 92 | `method` | `async discardAll(): Promise<void>` |
| 96 | `method` | `list(): WorktreeInfo[]` |
| 100 | `method` | `get(id: string): WorktreeInfo \| undefined` |
