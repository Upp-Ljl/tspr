import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import type { AgentDiscovery, AgentStatus, FrontierTask, NetworkError, SuggestedInteraction } from './types.js';
import type { LlmClient, Logger } from './_deps.js';
import { FrontierQueue } from './frontier.js';
import { canonicalizeUrl, structuralHash } from './dedup.js';
import { captureSnapshot } from './snapshot.js';
import { isLoginRedirect } from './login.js';
import { v4 as uuidv4 } from './uuid.js';

const PULL_TIMEOUT_MS = 5_000; // How long an agent waits for a task before going idle
const NAVIGATION_TIMEOUT_MS = 10_000;
const CC_CALL_TIMEOUT_MS = 15_000;

export interface ExplorationState {
  runId: string;
  baseUrl: string;
  frontier: FrontierQueue;
  discoveries: Map<string, AgentDiscovery>;
  visitedUrls: Set<string>;
  agentStatuses: Map<string, AgentStatus>;
  startedAt: number;
  stoppedAt?: number;
  stopReason?: string;
  stopSignal: { stopped: boolean };
  explorationCcCallCount: number;
  maxCcCalls: number;
  maxPages: number;
  runDir: string;
  urlQueryParamBlacklist: string[];
}

export class AgentLoop {
  private agentId: string;
  private agentIndex: number;
  private context?: BrowserContext;
  private storageStateJson?: string;
  private driftRecoveryAttempts = 0;

  constructor(
    private readonly browser: Browser,
    private readonly state: ExplorationState,
    private readonly llmClient: LlmClient,
    private readonly logger: Logger,
    agentIndex: number, // 1-indexed
  ) {
    this.agentIndex = agentIndex;
    this.agentId = `agent-${agentIndex}`;
    this.state.agentStatuses.set(this.agentId, 'idle');
  }

  setStorageState(storageStateJson: string): void {
    this.storageStateJson = storageStateJson;
  }

  async run(): Promise<void> {
    try {
      await this.initContext();
    } catch (err) {
      this.logger.error(`[${this.agentId}] Failed to init context`, { err });
      this.state.agentStatuses.set(this.agentId, 'dead');
      return;
    }

    while (!this.state.stopSignal.stopped) {
      this.state.agentStatuses.set(this.agentId, 'idle');

      // Wait for a task (with timeout)
      const task = await this.pullWithTimeout();

      if (this.state.stopSignal.stopped) break;

      if (task === null) {
        // No task available — remain idle
        continue;
      }

      this.state.agentStatuses.set(this.agentId, 'working');

      try {
        await this.processTask(task);
      } catch (err) {
        this.logger.error(`[${this.agentId}] Task processing error`, { taskId: task.id, err });
        // Agent continues unless context is dead
        if (!this.context || this.context.browser()?.isConnected() === false) {
          this.state.agentStatuses.set(this.agentId, 'dead');
          break;
        }
      }
    }

    this.state.agentStatuses.set(this.agentId, 'dead');
    try { await this.context?.close(); } catch { /* ignore */ }
  }

  private async initContext(): Promise<void> {
    let contextOptions: BrowserContextOptions = {};
    if (this.storageStateJson) {
      contextOptions = {
        storageState: JSON.parse(this.storageStateJson) as BrowserContextOptions['storageState'],
      };
    }
    this.context = await this.browser.newContext(contextOptions);
  }

  private async pullWithTimeout(): Promise<FrontierTask | null> {
    const deadline = Date.now() + PULL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.state.stopSignal.stopped) return null;
      const task = await this.state.frontier.pop();
      if (task !== null) return task;
      // Brief wait before retry
      await sleep(200);
    }
    return null;
  }

  private async processTask(task: FrontierTask): Promise<void> {
    if (!this.context) return;

    const page = await this.context.newPage();
    const consoleErrors: string[] = [];
    const networkErrors: NetworkError[] = [];

    // Attach listeners
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('response', response => {
      const status = response.status();
      if (status >= 400) {
        networkErrors.push({
          url: response.url(),
          status,
          method: response.request().method(),
        });
      }
    });

    try {
      // Navigate
      await page.goto(task.url, {
        timeout: NAVIGATION_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      }).catch(() => { /* ignore navigation timeout */ });

      // Check for auth drift
      const currentUrl = page.url();
      if (isLoginRedirect(currentUrl) && this.driftRecoveryAttempts < 1) {
        this.driftRecoveryAttempts++;
        this.logger.warn(`[${this.agentId}] Auth drift detected, attempting recovery`);
        // Re-init context with fresh storage state (best-effort)
        await page.close();
        await this.context.close();
        await this.initContext();
        return; // Skip this task; it will stay in processed state
      } else if (isLoginRedirect(currentUrl) && this.driftRecoveryAttempts >= 1) {
        this.logger.error(`[${this.agentId}] Second auth drift — marking dead`);
        await page.close();
        this.state.agentStatuses.set(this.agentId, 'dead');
        return;
      }

      // Capture DOM + screenshot
      const { html: domSnapshot, screenshotBuffer } = await captureSnapshot(page);
      const pageTitle = await page.title().catch(() => '');

      // Compute structural hash for dedup
      const domHash = structuralHash(domSnapshot);

      // Check dedup
      if (this.state.discoveries.has(domHash)) {
        await page.close();
        return; // Already seen this page structure
      }

      // Check page cap
      if (this.state.visitedUrls.size >= this.state.maxPages) {
        this.state.stopSignal.stopped = true;
        if (!this.state.stopReason) this.state.stopReason = 'page_cap';
        await page.close();
        return;
      }

      // Record visit
      const canonUrl = canonicalizeUrl(currentUrl, this.state.urlQueryParamBlacklist);
      this.state.visitedUrls.add(canonUrl);

      // Write artifacts
      const snapshotsDir = path.join(this.state.runDir, 'snapshots');
      const screenshotsDir = path.join(this.state.runDir, 'screenshots');
      const agentLogsDir = path.join(this.state.runDir, 'agent-logs');

      let domSnapshotPath = '';
      let screenshotPath = '';

      try {
        await mkdir(snapshotsDir, { recursive: true });
        await mkdir(screenshotsDir, { recursive: true });
        await mkdir(agentLogsDir, { recursive: true });

        domSnapshotPath = path.join(snapshotsDir, `${domHash}.html`);
        screenshotPath = path.join(screenshotsDir, `${domHash}.png`);

        await writeFile(domSnapshotPath, domSnapshot, 'utf-8');
        if (screenshotBuffer.length > 0) {
          await writeFile(screenshotPath, screenshotBuffer);
        }
      } catch (err) {
        this.logger.warn(`[${this.agentId}] Failed to write artifacts`, { err });
        // Skip this discovery if we can't write (per B-3-11 — omit rather than include broken path)
        await page.close();
        return;
      }

      // Ask cc for interactions (haiku)
      let suggestedInteractions: SuggestedInteraction[] = [];

      if (this.state.explorationCcCallCount < this.state.maxCcCalls) {
        suggestedInteractions = await this.getInteractionSuggestions(domSnapshot, page);
      } else {
        // maxCcCalls exhausted
        this.state.stopSignal.stopped = true;
        if (!this.state.stopReason) this.state.stopReason = 'cost_cap';
        suggestedInteractions = await this.heuristicInteractions(page);
      }

      // Record discovery
      const discovery: AgentDiscovery = {
        agentId: this.agentId,
        taskId: task.id,
        url: canonUrl,
        pageTitle,
        domHash,
        domSnapshotPath,
        screenshotPath,
        consoleErrors,
        networkErrors,
        suggestedInteractions,
        timestampMs: Date.now(),
      };

      this.state.discoveries.set(domHash, discovery);

      // Write agent log
      try {
        const logPath = path.join(agentLogsDir, `${this.agentId}.jsonl`);
        await writeFile(logPath, JSON.stringify(discovery) + '\n', { flag: 'a' });
      } catch { /* ignore log write failures */ }

      // Push new tasks to frontier
      for (const interaction of suggestedInteractions) {
        if (!interaction.hint) continue;

        // For nav interactions, extract URL if present; otherwise use same URL with hint
        let targetUrl = canonUrl;
        // Simple heuristic: if hint mentions a URL or path, use that
        const urlMatch = interaction.hint.match(/https?:\/\/[^\s"']+/);
        if (urlMatch) {
          targetUrl = urlMatch[0];
        }

        const canonTarget = canonicalizeUrl(targetUrl, this.state.urlQueryParamBlacklist);
        if (this.state.visitedUrls.has(canonTarget)) continue;

        const frontierTask: FrontierTask = {
          id: generateId(),
          url: canonTarget,
          interactionHint: interaction.hint,
          depth: task.depth + 1,
          sourceAgentId: this.agentId,
          enqueuedAt: Date.now(),
        };
        await this.state.frontier.push(frontierTask);
      }

      // Also extract all links from the page and push them
      await this.pushLinksFromPage(page, task.depth, canonUrl);

    } finally {
      await page.close().catch(() => { /* ignore */ });
    }
  }

  private async getInteractionSuggestions(
    domSnapshot: string,
    _page: Page,
  ): Promise<SuggestedInteraction[]> {
    const prompt = `Given this HTML DOM of a web page, suggest 3 interactions a real user would try next. Consider buttons, links, forms, inputs.
Return ONLY JSON with this exact shape:
{"interactions": [{"hint": "...", "selector": "..."}]}
No markdown, no explanation.

DOM:
${domSnapshot.slice(0, 8000)}`;

    try {
      this.state.explorationCcCallCount++;
      const result = await Promise.race([
        this.llmClient.run({ model: 'haiku', prompt, timeoutMs: CC_CALL_TIMEOUT_MS }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('cc timeout')), CC_CALL_TIMEOUT_MS),
        ),
      ]);

      let parsed: { interactions?: Array<{ hint: string; selector?: string }> };
      try {
        parsed = JSON.parse(result.stdout) as typeof parsed;
      } catch {
        const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('no JSON in response');
        parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
      }

      return Array.isArray(parsed.interactions) ? parsed.interactions : [];
    } catch {
      this.logger.warn(`[${this.agentId}] cc call failed, using heuristic fallback`);
      return []; // fallback handled by caller via heuristicInteractions if needed
    }
  }

  private async heuristicInteractions(page: Page): Promise<SuggestedInteraction[]> {
    try {
      const hints = await page.evaluate(() => {
        const results: Array<{ hint: string; selector?: string }> = [];
        // Find links
        document.querySelectorAll('a[href]').forEach(el => {
          const href = el.getAttribute('href');
          if (href && !href.startsWith('#') && !href.startsWith('mailto:')) {
            results.push({ hint: `navigate to ${href}`, selector: `a[href="${href}"]` });
          }
        });
        // Find buttons
        document.querySelectorAll('button').forEach((el, i) => {
          results.push({ hint: `click button "${el.textContent?.trim() || i}"`, selector: `button:nth-of-type(${i + 1})` });
        });
        // Find inputs
        document.querySelectorAll('input:not([type=hidden])').forEach((el, i) => {
          results.push({ hint: `fill input "${el.getAttribute('name') || i}"`, selector: `input:nth-of-type(${i + 1})` });
        });
        return results.slice(0, 5);
      });
      return hints;
    } catch {
      return [];
    }
  }

  private async pushLinksFromPage(page: Page, currentDepth: number, currentPageUrl: string): Promise<void> {
    try {
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(el => el.getAttribute('href'))
          .filter((h): h is string => !!h && !h.startsWith('#') && !h.startsWith('mailto:'));
      });

      for (const href of links) {
        let absoluteUrl: string;
        try {
          absoluteUrl = new URL(href, currentPageUrl).toString();
        } catch {
          continue;
        }

        // Only follow same-origin links
        const base = new URL(this.state.baseUrl);
        const target = new URL(absoluteUrl);
        if (target.origin !== base.origin) continue;

        const canonTarget = canonicalizeUrl(absoluteUrl, this.state.urlQueryParamBlacklist);
        if (this.state.visitedUrls.has(canonTarget)) continue;

        const task: FrontierTask = {
          id: generateId(),
          url: canonTarget,
          depth: currentDepth + 1,
          sourceAgentId: this.agentId,
          enqueuedAt: Date.now(),
        };
        await this.state.frontier.push(task);
      }
    } catch {
      // ignore
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateId(): string {
  return uuidv4();
}
