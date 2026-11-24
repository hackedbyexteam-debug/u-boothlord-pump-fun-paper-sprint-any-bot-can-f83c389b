// Pump.fun Paper Sprint — replay client for agent-fun/replay/v2.
//
// This file only speaks the harness protocol and keeps the bot's picture of
// the world: bonding curves, cash, positions and orders still in flight.
// The trading brain lives in strategy.ts and only ever sees a World plus
// one batch at a time.
//
// The wire is NDJSON on stdin/stdout. The harness sends one hello, then
// batches, then done; the bot answers each batch with exactly one reply
// line. Nothing here reads the clock, the network or randomness, so two
// runs over the same data emit byte-identical replies.

export type Mint = string;

/** One bonding curve as the bot knows it. Reserves are raw lamport/token counts. */
export interface Curve {
  mint: Mint;
  createdSlot: number | null;
  vTokens: bigint;
  vQuote: bigint;
  rTokens: bigint;
  rQuote: bigint;
  seenSlot: number;
  trades: number;
  done: boolean;
}

export interface Holding {
  tokens: bigint;
  cost: bigint;
}

export interface PendingOrder {
  side: "buy" | "sell";
  id: string;
  mint: Mint;
  amount: bigint;
  decidedSlot: number;
}

/** One order the strategy wants, before client ids are stamped on it. */
export interface Intent {
  side: "buy" | "sell";
  mint: Mint;
  /** Buy: lamports to spend. Sell: tokens to sell. */
  amount: bigint;
  slippageBps: number;
}

export interface HelloMsg {
  protocol: string;
  seed: string;
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: string;
    priority_fee_lamports: string;
    failed_tx_bps: number;
  };
}

export interface BatchEvent {
  event: string;
  mint: string;
  slot: number;
  [key: string]: unknown;
}

export interface BatchMark {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

export interface BatchFill {
  client_id: string;
  mint: string;
  side: string;
  status: string;
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: string;
  token_amount: string;
  fee_lamports: string;
  tx_fee_lamports: string;
  fee_fallback: boolean;
}

export interface BatchMsg {
  type: "batch";
  seq: number;
  slot: number;
  events: BatchEvent[];
  marks: BatchMark[];
  fills: BatchFill[];
  account: {
    cash_lamports: string;
    positions: Array<{ mint: string; token_amount: string; cost_lamports: string }>;
  };
}

export interface Strategy {
  decide(world: World, batch: BatchMsg): readonly Intent[] | void;
}

const U64 = /^(0|[1-9][0-9]{0,19})$/;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Read a u64 out of the wire (number, bigint or decimal string) and hand it back as a decimal string. */
function u64String(value: unknown, what: string): string {
  let n: bigint | null = null;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && U64.test(value)) n = BigInt(value);
  if (n === null || n < 0n) throw new Error(`${what} must be a u64, got ${String(value)}`);
  return n.toString();
}

/** The bot's whole picture of the run, refreshed from every batch before the strategy sees it. */
export class World {
  readonly hello: HelloMsg;
  seq = -1;
  slot = -1;
  cash = 0n;
  readonly curves = new Map<Mint, Curve>();
  readonly positions = new Map<Mint, Holding>();
  readonly pending = new Map<string, PendingOrder>();
  #takenIds = new Set<string>();
  #nextId = 1;

  constructor(hello: HelloMsg) {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
  }

  /** A fresh client id. The harness reserves ids starting with "_" for its own closes. */
  nextId(): string {
    for (;;) {
      const id = `o${this.#nextId++}`;
      if (!this.#takenIds.has(id)) {
        this.#takenIds.add(id);
        return id;
      }
    }
  }

  /** Base + priority fee charged on every order sent, filled or not. */
  feePerOrder(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /** The most lamports one mint's buys may spend in a single batch (1% of its real SOL reserve). */
  buyCap(mint: Mint): bigint {
    const curve = this.curves.get(mint);
    if (curve === undefined || curve.done) return 0n;
    return (curve.rQuote * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / 10_000n;
  }

  /** Positions held plus mints with a buy still pending: what counts against the open-position cap. */
  openSlots(): number {
    const mints = new Set<Mint>(this.positions.keys());
    for (const order of this.pending.values()) if (order.side === "buy") mints.add(order.mint);
    return mints.size;
  }

  /** Cash left after reserving what every pending order would take if it filled. */
  spareCash(): bigint {
    const fee = this.feePerOrder();
    let free = this.cash;
    for (const order of this.pending.values()) {
      free -= fee;
      if (order.side === "buy") free -= order.amount;
    }
    return free;
  }

  /** One token's price in SOL on this curve's virtual reserves, as a float. */
  priceOf(mint: Mint): number {
    const curve = this.curves.get(mint);
    if (curve === undefined || curve.vTokens === 0n) return 0;
    return Number(curve.vQuote) / Number(curve.vTokens);
  }

  /** Fold a batch into the picture: fills, cash, positions, marks and events, in that order. */
  ingest(batch: BatchMsg): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const fill of batch.fills) this.pending.delete(fill.client_id);
    this.cash = BigInt(batch.account.cash_lamports);
    this.positions.clear();
    for (const held of batch.account.positions) {
      const tokens = BigInt(held.token_amount);
      if (tokens > 0n) {
        this.positions.set(held.mint, { tokens, cost: BigInt(held.cost_lamports) });
      }
    }
    for (const mark of batch.marks) {
      const known = this.curves.get(mark.mint);
      if (known !== undefined && mark.slot < known.seenSlot) continue;
      const curve = known ?? this.freshCurve(mark.mint, null, mark.slot);
      curve.vTokens = BigInt(mark.virtual_token_reserves);
      curve.vQuote = BigInt(mark.virtual_quote_reserves);
      curve.rTokens = BigInt(mark.real_token_reserves);
      curve.rQuote = BigInt(mark.real_quote_reserves);
      curve.seenSlot = mark.slot;
    }
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        const curve = this.freshCurve(event.mint, event.slot, event.slot);
        curve.vTokens = BigInt(event.virtual_token_reserves as string);
        curve.vQuote = BigInt(event.virtual_quote_reserves as string);
        curve.rTokens = BigInt(event.real_token_reserves as string);
        curve.rQuote = 0n;
      } else if (event.event === "TradeEvent") {
        const curve = this.curves.get(event.mint) ?? this.freshCurve(event.mint, null, event.slot);
        curve.vTokens = BigInt(event.virtual_token_reserves as string);
        curve.vQuote = BigInt(event.virtual_quote_reserves as string);
        curve.rTokens = BigInt(event.real_token_reserves as string);
        const realQuote = (event.real_quote_reserves as string | undefined) ??
          (event.real_sol_reserves as string | undefined);
        if (realQuote !== undefined) curve.rQuote = BigInt(realQuote);
        curve.seenSlot = event.slot;
        curve.trades += 1;
      } else if (event.event === "CompleteEvent") {
        const curve = this.curves.get(event.mint) ?? this.freshCurve(event.mint, null, event.slot);
        curve.done = true;
      }
    }
  }

  private freshCurve(mint: Mint, created: number | null, slot: number): Curve {
    const curve: Curve = {
      mint,
      createdSlot: created,
      vTokens: 0n,
      vQuote: 0n,
      rTokens: 0n,
      rQuote: 0n,
      seenSlot: slot,
      trades: 0,
      done: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }

  /** Check the strategy's orders, stamp client ids on them and return the wire form. */
  wire(intents: readonly Intent[] | void | null | undefined): Array<Record<string, unknown>> {
    if (intents === undefined || intents === null) return [];
    if (!Array.isArray(intents)) throw new Error(`batch ${this.seq}: strategy must return an array of orders`);
    const cap = this.hello.caps.max_orders_per_batch;
    if (intents.length > cap) {
      throw new Error(`batch ${this.seq}: ${intents.length} orders over max_orders_per_batch (${cap})`);
    }
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!;
      if (intent.side !== "buy" && intent.side !== "sell") {
        throw new Error(`batch ${this.seq} order ${i}: bad side`);
      }
      if (typeof intent.mint !== "string" || !MINT_RE.test(intent.mint)) {
        throw new Error(`batch ${this.seq} order ${i}: bad mint`);
      }
      if (!Number.isInteger(intent.slippageBps) || intent.slippageBps < 0 || intent.slippageBps > 10_000) {
        throw new Error(`batch ${this.seq} order ${i}: bad max_slippage_bps`);
      }
      const id = this.nextId();
      const amount = u64String(intent.amount, `batch ${this.seq} order ${i} amount`);
      if (!ID_RE.test(id)) throw new Error("bad client id");
      out.push(
        intent.side === "buy"
          ? { side: "buy", client_id: id, mint: intent.mint, quote_lamports: amount, max_slippage_bps: intent.slippageBps }
          : { side: "sell", client_id: id, mint: intent.mint, token_amount: amount, max_slippage_bps: intent.slippageBps },
      );
      this.pending.set(id, {
        side: intent.side,
        id,
        mint: intent.mint,
        amount: intent.amount,
        decidedSlot: this.slot,
      });
    }
    return out;
  }
}

/** Split stdin into newline-terminated lines (handles lines up to 1 MiB). */
async function* lines(): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let tail = "";
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    tail += decoder.decode(chunk, { stream: true });
    let cut = tail.indexOf("\n");
    while (cut !== -1) {
      let line = tail.slice(0, cut);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
      tail = tail.slice(cut + 1);
      cut = tail.indexOf("\n");
    }
  }
  tail += decoder.decode();
  if (tail.length > 0) yield tail;
}

/** Drive one strategy through the whole replay and count the batches it answered. */
export async function runBot(strategy: Strategy): Promise<{ batches: number }> {
  let world: World | null = null;
  let batches = 0;
  for await (const line of lines()) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line) as { type?: unknown };
    if (msg.type === "hello") {
      if (world !== null) throw new Error("second hello");
      const hello = msg as unknown as HelloMsg;
      if (hello.protocol !== "agent-fun/replay/v2") throw new Error(`unsupported protocol ${hello.protocol}`);
      world = new World(hello);
    } else if (msg.type === "batch") {
      if (world === null) throw new Error("batch before hello");
      const batch = msg as unknown as BatchMsg;
      world.ingest(batch);
      const orders = world.wire(strategy.decide(world, batch));
      const text = JSON.stringify({ type: "reply", seq: batch.seq, orders });
      if (new TextEncoder().encode(text).byteLength > 65_536) {
        throw new Error(`batch ${batch.seq}: reply over 65536 bytes`);
      }
      process.stdout.write(`${text}\n`);
      batches++;
    } else if (msg.type === "done") {
      if (world === null) throw new Error("done before hello");
      return { batches };
    } else {
      throw new Error(`unknown message type ${String(msg.type)}`);
    }
  }
  throw new Error(world === null ? "input ended before hello" : `input ended before done (after ${batches} batches)`);
}

// ---------------------------------------------------------------- entrypoint

import { createSniper } from "./strategy.ts";

const result = await runBot(createSniper());
process.stderr.write(`done after ${result.batches} batches\n`);

export { LAMPORTS_PER_SOL };
