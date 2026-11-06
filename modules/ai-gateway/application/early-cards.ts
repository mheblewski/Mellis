/**
 * Cards right after the text (cards-after-text.v1, AI_CARDS_AFTER_TEXT, with dose-one-turn.v1): once the model has
 * finished the answer, each card is prepared as soon as the model has written it, instead of all of them when the turn
 * ends, so the app can show it under the finished text. The gateway's tool loop then reads the results from here, so
 * limits, audits and the check of the answer against its cards work as they do without this.
 *
 * Nothing runs before the answer is finished, so no card can appear above missing text. A turn with any other tool
 * keeps the order of its calls: from that call on nothing more runs early and the loop does the rest.
 */

export type EarlyCardTool = 'propose_bolus' | 'propose_rescue_carbs';

export interface EarlyCardsDeps {
  /** Prepares a card; only called for tools that have a limit left and arguments the tool allows. */
  propose: (tool: EarlyCardTool, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Tells the app the answer is finished; awaited before the first card is prepared. Must not throw. */
  onAnswerReady: (answer: unknown) => Promise<void>;
  /** The argument names each attached card tool allows; a tool missing here never runs early. */
  allowedKeys: Partial<Record<EarlyCardTool, string[]>>;
  /** What is left of this answer's limits when the turn starts. */
  bolusCallsLeft: number;
  rescueCallsLeft: number;
  rescueOptionsCarded: ReadonlySet<string>;
  totalCallsLeft: number;
  isAborted: () => boolean;
}

interface QueuedCard {
  call_id: string;
  tool: EarlyCardTool;
  args: Record<string, unknown>;
}

export class EarlyCards {
  private readonly waiting: QueuedCard[] = [];
  private readonly results = new Map<string, Promise<Record<string, unknown>>>();
  private readonly rescueOptions: Set<string>;
  private bolusLeft: number;
  private rescueLeft: number;
  private totalLeft: number;
  private chain: Promise<unknown> = Promise.resolve();
  private answerReady = false;
  private closed = false;

  constructor(private readonly deps: EarlyCardsDeps) {
    this.bolusLeft = deps.bolusCallsLeft;
    this.rescueLeft = deps.rescueCallsLeft;
    this.rescueOptions = new Set(deps.rescueOptionsCarded);
    this.totalLeft = deps.totalCallsLeft;
  }

  /** A tool call the model finished writing, in the order written. */
  onToolReady(call: { call_id: string; name: string; arguments: Record<string, unknown> }): void {
    if (this.closed) return;
    const tool = call.name as EarlyCardTool;
    const allowed = this.deps.allowedKeys[tool];
    if (!allowed) {
      // Another tool's result may matter to what follows: from here on the loop runs the calls in their order.
      this.closed = true;
      return;
    }
    if (!Object.keys(call.arguments).every((key) => allowed.includes(key)) || !this.takeLimit(tool, call.arguments)) {
      this.closed = true;
      return;
    }
    const card = { call_id: call.call_id, tool, args: call.arguments };
    if (this.answerReady) this.start(card);
    else this.waiting.push(card);
  }

  /** The answer's tool call is finished: the text cannot change any more in this turn. */
  onAnswerReady(answer: unknown): void {
    if (this.closed || this.answerReady) return;
    this.answerReady = true;
    this.chain = this.chain.then(() => this.deps.onAnswerReady(answer)).catch(() => undefined);
    for (const card of this.waiting.splice(0)) this.start(card);
  }

  /** The turn's response came: calls still waiting for the answer stay with the loop. */
  close(): void {
    this.closed = true;
    this.waiting.length = 0;
  }

  /** Waits for the cards in progress (a failed call must not leave one being written after it). */
  async settled(): Promise<void> {
    this.close();
    await this.chain;
  }

  /** The result of a card prepared early, or undefined when the loop has to prepare it. */
  take(callId: string): Promise<Record<string, unknown>> | undefined {
    const result = this.results.get(callId);
    this.results.delete(callId);
    return result;
  }

  /** The same limits as the loop's, so a card made here is never one the loop would have refused. */
  private takeLimit(tool: EarlyCardTool, args: Record<string, unknown>): boolean {
    if (this.totalLeft <= 0) return false;
    if (tool === 'propose_bolus') {
      if (this.bolusLeft <= 0) return false;
      this.bolusLeft -= 1;
    } else {
      const option = String(args.option ?? '');
      const replaces = option !== '' && this.rescueOptions.has(option);
      if (!replaces) {
        if (this.rescueLeft <= 0) return false;
        this.rescueLeft -= 1;
      }
      this.rescueOptions.add(option);
    }
    this.totalLeft -= 1;
    return true;
  }

  private start(card: QueuedCard): void {
    const result = this.chain.then(() => {
      if (this.deps.isAborted()) throw new Error('EARLY_CARD_ABORTED');
      return this.deps.propose(card.tool, card.args);
    });
    // The loop reads the outcome; the chain goes on after a failed card, as the loop does.
    result.catch(() => undefined);
    this.results.set(card.call_id, result);
    this.chain = result.catch(() => undefined);
  }
}
