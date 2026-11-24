// Launch sniper for the 6-hour pump.fun sprint.
//
// The bet behind this bot: by the time a coin shows momentum it has usually
// already topped. The money is at the launch, in the first seconds, before
// the crowd — and the way to keep it is to cut losers fast and let the rare
// runner run. So it only buys coins a few slots old that pass a rug filter
// on their opening tape, sizes small, and exits on a hair trigger.
//
// Entry (decided within a few slots of the CreateEvent):
//   * the creator's own buy in the create slot is real but small (a big
//     creator buy is a bundle about to dump), the creator has not sold,
//     only a handful of other wallets bought in, sells have not overwhelmed
//     buys, and no single sell is large against the real SOL reserve;
//   * the curve holds real SOL in a tradeable band and its price has not
//     already run away from the create price;
//   * recent flow is positive: net SOL in over the last few slots, from at
//     least two distinct buyers.
//
// Sizing: one buy per coin, up to `stakeSol`, capped at 1% of the curve's
// real SOL reserve (the harness cap) and at least `minBuySol` to be worth
// the tx fee.
//
// Exits: the position is cut at a stop loss against cost, or the moment the
// creator sells. Half the position is banked at the first take-profit
// level; the rest rides with a trailing stop and a time limit, unless the
// curve is near bonding completion (real SOL close to the ~85 SOL target),
// in which case it is ridden — the harness closes it at the final reserves,
// usually the best exit available. A fade in recent flow or a single whale
// sell also exits.
//
// Guardrail pacing: the competition ranks below every entry that misses it,
// so the bot must finish with round trips of >= 0.01 SOL on >= 20 coins
// and a drawdown <= 50%. The sniper trades far more than that on its own,
// but a pace check (own fills and coins vs elapsed block time) opens tiny
// probe round trips on liquid curves whenever the bot falls behind pace.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.

import type { BatchMsg, Intent, Mint, World } from "./main.ts";

export interface SnipeParams {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  reserveLo: number;
  reserveHi: number;
  /** Creator's own buys in the create slot: at least / at most this many SOL. */
  devBuyLo: number;
  devBuyHi: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Distinct non-creator buyers before entry: at least / at most. */
  buyersLo: number;
  buyersHi: number;
  /** Lamports sold by others / lamports bought, at most (as a share). */
  sellRatioMax: number;
  /** Largest single non-creator sell, as a share of real SOL before it, at most. */
  bigSellShareMax: number;
  /** Price now over the create price, minus 1: window. */
  runupLo: number;
  runupHi: number;
  /** Recent-flow window (slots) and what it must show. */
  flowSlots: number;
  flowMinSol: number;
  flowMinBuyers: number;
  /** Slippage on buys (bps); sells always go out wide open. */
  slipBps: number;
  /** Exits. */
  stopLoss: number;
  /** First take-profit: sell tp1Share of the position once it is worth this much over cost. */
  tp1At: number;
  tp1Share: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trailDrop from the best value. */
  trailArm: number;
  trailDrop: number;
  /** Exit after holding this many slots. */
  holdMax: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdFreeIfUp: number;
  /** Exit when net SOL over fadeSlots slots falls below fadeNetSol. */
  fadeSlots: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  whaleSellSol: number;
  /** Exit when the creator sells while held. */
  exitDevSell: boolean;
  /** Hold on (no fade or trail exit) once the curve's real SOL passes this. */
  rideReserveSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  coolDown: number;
  /** Most momentum positions open at once (the rest of max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: pace the run toward at least this many coins / fills. */
  goalCoins: number;
  goalFills: number;
  /** Seconds of block time the pace is measured over. */
  paceWindowSec: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

/** Tuned for a 6-hour sprint: launch entries, fast cuts, runners ride.
 *  Final parameters are revision 0, the best of three graded variants on
 *  the dev window (rev 0: -0.0148 SOL; rev 1, stricter entries + looser
 *  profit-taking: -0.0469; rev 2, tighter -8% stop: -0.0219). The gaps are
 *  inside the 90% interval (±0.28 SOL), so no further tuning on this one
 *  small window — the final window is fresh data. */
export const DEFAULT_SNIPE: SnipeParams = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.3,
  minBuySol: 0.005,
  reserveLo: 3.0,
  reserveHi: 30,
  devBuyLo: 0.05,
  devBuyHi: 1.0,
  skipDevSold: true,
  buyersLo: 1,
  buyersHi: 6,
  sellRatioMax: 0.5,
  bigSellShareMax: 0.2,
  runupLo: -0.05,
  runupHi: 0.6,
  flowSlots: 10,
  flowMinSol: 0.05,
  flowMinBuyers: 2,
  slipBps: 10_000,
  stopLoss: 0.12,
  tp1At: 0.25,
  tp1Share: 0.5,
  trailArm: 0.25,
  trailDrop: 0.25,
  holdMax: 300,
  holdFreeIfUp: 1.0,
  fadeSlots: 20,
  fadeNetSol: -1.0,
  whaleSellSol: 3,
  exitDevSell: true,
  rideReserveSol: 70,
  coolDown: 150,
  maxMain: 4,
  goalCoins: 30,
  goalFills: 120,
  paceWindowSec: 21_600,
  probeSol: 0.02,
  maxProbes: 1,
  maxExposureSol: 3,
};

const SOL = 1e9;
/** Protocol + creator fee per side, as a share of the trade (95 + 30 bps). */
const TRADE_FEE = 0.0125;

interface Tape {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinNote {
  createdSlot: number | null;
  creator: string | null;
  createPrice: number;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<string>;
  boughtSol: number;
  soldSol: number;
  worstSellShare: number;
  tape: Tape[];
  entries: number;
  lastExitSlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  dead: boolean;
}

interface OpenTrade {
  openedSlot: number;
  peakSol: number;
  investedSol: number;
  exiting: boolean;
  filled: boolean;
  partialDone: boolean;
  devSoldAtEntry: boolean;
  lastValueSol: number;
}

export function createSniper(p: SnipeParams = DEFAULT_SNIPE) {
  const notes = new Map<Mint, CoinNote>();
  const open = new Map<Mint, OpenTrade>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Mint, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Mint>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  const noteOf = (mint: Mint): CoinNote => {
    let note = notes.get(mint);
    if (note === undefined) {
      note = {
        createdSlot: null,
        creator: null,
        createPrice: 0,
        devBuySol: 0,
        devSold: false,
        buyers: new Set(),
        boughtSol: 0,
        soldSol: 0,
        worstSellShare: 0,
        tape: [],
        entries: 0,
        lastExitSlot: -1e12,
        dead: false,
      };
      notes.set(mint, note);
    }
    return note;
  };

  /** Net recorded SOL (buys minus sells) and distinct buyers over the last `w` slots. */
  const flowOver = (note: CoinNote, now: number, w: number): { net: number; buyers: number } => {
    let net = 0;
    const buyers = new Set<string>();
    for (let i = note.tape.length - 1; i >= 0; i--) {
      const trade = note.tape[i]!;
      if (trade.slot <= now - w) break;
      net += trade.buy ? trade.sol : -trade.sol;
      if (trade.buy) buyers.add(trade.user);
    }
    return { net, buyers: buyers.size };
  };

  return {
    decide(world: World, batch: BatchMsg): Intent[] {
      const now = batch.slot;
      const whaleSold = new Set<Mint>();
      const touched = new Set<Mint>();
      for (const fill of batch.fills) {
        if (fill.status === "filled" && !fill.client_id.startsWith("_")) {
          myFills++;
          myCoins.add(fill.mint);
        }
      }
      for (const event of batch.events) {
        if (typeof event.block_time === "number") {
          if (firstBlockTime === null) firstBlockTime = event.block_time;
          if (lastBlockTime === null || event.block_time > lastBlockTime) lastBlockTime = event.block_time;
        }
        if (event.event === "CreateEvent") {
          const note = noteOf(event.mint);
          note.createdSlot = event.slot;
          note.creator = event.creator as string;
          note.createPrice = Number(event.virtual_quote_reserves as string) / Number(event.virtual_token_reserves as string);
        } else if (event.event === "TradeEvent") {
          const note = noteOf(event.mint);
          const sol = Number(event.sol_amount as string) / SOL;
          const isDev = note.creator !== null && event.user === note.creator;
          note.tape.push({
            slot: event.slot,
            buy: event.is_buy as boolean,
            sol,
            user: event.user as string,
            price: Number(event.virtual_quote_reserves as string) / Number(event.virtual_token_reserves as string),
          });
          touched.add(event.mint);
          if (event.is_buy) {
            note.boughtSol += sol;
            if (isDev && event.slot === note.createdSlot) note.devBuySol += sol;
            else if (!isDev) note.buyers.add(event.user as string);
          } else if (isDev) {
            note.devSold = true;
          } else {
            note.soldSol += sol;
            const reserveBefore = Number(event.real_quote_reserves as string) / SOL + sol;
            if (reserveBefore > 0) {
              const share = sol / reserveBefore;
              if (share > note.worstSellShare) note.worstSellShare = share;
            }
          }
          if (!event.is_buy && sol >= p.whaleSellSol) whaleSold.add(event.mint);
        }
      }
      // Prune old tape entries: only the fade/flow windows are ever read.
      const keep = Math.max(p.flowSlots, p.fadeSlots) + 5;
      for (const mint of touched) {
        const note = notes.get(mint)!;
        let cut = 0;
        while (cut < note.tape.length && note.tape[cut]!.slot <= now - keep) cut++;
        if (cut > 0) note.tape.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Mint, number>();
      for (const order of world.pending.values()) {
        pendingByMint.set(order.mint, (pendingByMint.get(order.mint) ?? 0) + 1);
      }

      const intents: Intent[] = [];
      const cap = world.hello.caps.max_orders_per_batch;
      const txSol = Number(world.feePerOrder()) / SOL;

      // Exits first: a position that must go outranks any new entry.
      for (const [mint, trade] of open) {
        const held = world.positions.get(mint);
        const curve = world.curves.get(mint);
        if (held === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const note = noteOf(mint);
            if (trade.filled) note.lastExitSlot = now;
            else note.entries--;
          }
          continue;
        }
        trade.filled = true;
        if (curve === undefined || curve.done) continue;
        const mark = marks.get(mint);
        const vQuote = mark ? Number(mark.virtual_quote_reserves) : Number(curve.vQuote);
        const vTokens = mark ? Number(mark.virtual_token_reserves) : Number(curve.vToken);
        const realSol = (mark ? Number(mark.real_quote_reserves) : Number(curve.rQuote)) / SOL;
        const tokens = Number(held.tokens);
        // Value of selling the whole position now, curve fee and tx fee deducted.
        const value = ((tokens * vQuote) / (vTokens + tokens) / SOL) * (1 - TRADE_FEE) - txSol;
        const cost = Number(held.cost) / SOL;
        if (value > trade.peakSol) trade.peakSol = value;
        trade.lastValueSol = value;
        const note = noteOf(mint);
        const riding = realSol >= p.rideReserveSol;
        let exit = trade.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.exitDevSell && note.devSold && !trade.devSoldAtEntry) exit = true;
        if (!exit && !riding && trade.peakSol >= cost * (1 + p.trailArm) && value < trade.peakSol * (1 - p.trailDrop)) exit = true;
        if (!exit && !riding && flowOver(note, now, p.fadeSlots).net < p.fadeNetSol) exit = true;
        if (!exit && !riding && whaleSold.has(mint)) exit = true;
        if (!exit && now - trade.openedSlot > p.holdMax && value < cost * (1 + p.holdFreeIfUp)) exit = true;
        if (exit) {
          trade.exiting = true;
          if (pendingByMint.has(mint)) {
            let sellPending = false;
            for (const order of world.pending.values()) {
              if (order.mint === mint && order.side === "sell") sellPending = true;
            }
            if (sellPending) continue;
          }
          if (intents.length >= cap) break;
          intents.push({ side: "sell", mint, amount: held.tokens, slippageBps: 10_000 });
          continue;
        }
        // First take-profit: bank tp1Share of the position, let the rest ride.
        if (!trade.partialDone && cost > 0 && value >= cost * (1 + p.tp1At)) {
          if (pendingByMint.has(mint)) continue;
          const part = (held.tokens * BigInt(Math.round(p.tp1Share * 10_000))) / 10_000n;
          if (part > 0n && part < held.tokens) {
            if (intents.length >= cap) break;
            intents.push({ side: "sell", mint, amount: part, slippageBps: 10_000 });
            trade.partialDone = true;
            // Rebase the trailing stop on the remaining half's value.
            trade.peakSol = value * (1 - p.tp1Share);
          }
        }
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const held = world.positions.get(mint);
        const curve = world.curves.get(mint);
        if (held === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.done || pendingByMint.has(mint)) continue;
        if (intents.length >= cap) break;
        intents.push({ side: "sell", mint, amount: held.tokens, slippageBps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: launches that pass the rug filter, decided young.
      let free = Number(world.spareCash()) / SOL;
      let slotsLeft = world.hello.caps.max_open_positions - world.openSlots();
      let mainLeft = p.maxMain - open.size;
      let exposure = 0;
      for (const [mint, trade] of open) {
        exposure += Math.max(trade.investedSol, Number(world.positions.get(mint)?.cost ?? 0n) / SOL);
      }
      for (const mint of touched) {
        if (intents.length >= cap) break;
        const note = notes.get(mint)!;
        const trade = open.get(mint);
        const curve = world.curves.get(mint);
        if (curve === undefined || curve.done) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        if (trade !== undefined) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) break;
        if (note.dead || open.has(mint)) continue;
        if (note.createdSlot === null) continue;
        const age = now - note.createdSlot;
        if (age < p.minAge || age > p.maxAge) {
          if (age > p.maxAge) note.dead = true;
          continue;
        }
        if (note.entries >= 1 || now - note.lastExitSlot < p.coolDown) continue;
        const realSol = Number(curve.rQuote) / SOL;
        if (realSol < p.reserveLo || realSol > p.reserveHi) continue;
        // Rug filter on the opening tape.
        if (note.devBuySol < p.devBuyLo || note.devBuySol > p.devBuyHi) {
          note.dead = true;
          continue;
        }
        if (p.skipDevSold && note.devSold) {
          note.dead = true;
          continue;
        }
        if (note.buyers.size < p.buyersLo || note.buyers.size > p.buyersHi) continue;
        if (note.boughtSol > 0 && note.soldSol > p.sellRatioMax * note.boughtSol) continue;
        if (note.worstSellShare > p.bigSellShareMax) continue;
        const price = Number(curve.vQuote) / Number(curve.vToken);
        if (note.createPrice > 0) {
          const runup = price / note.createPrice - 1;
          if (runup < p.runupLo || runup > p.runupHi) continue;
        }
        const flow = flowOver(note, now, p.flowSlots);
        if (flow.net < p.flowMinSol || flow.buyers < p.flowMinBuyers) continue;
        const capSol = Math.floor(Number(world.buyCap(mint))) / SOL;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * SOL));
        intents.push({ side: "buy", mint, amount: lamports, slippageBps: p.slipBps });
        free -= amount + txSol;
        exposure += amount;
        open.set(mint, {
          openedSlot: now,
          peakSol: 0,
          investedSol: amount,
          exiting: false,
          filled: false,
          partialDone: false,
          devSoldAtEntry: note.devSold,
          lastValueSol: 0,
        });
        note.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceWindowSec);
        const needCoins = myCoins.size < Math.ceil(p.goalCoins * pace);
        const needFills = myFills < Math.ceil(p.goalFills * pace);
        if (needCoins || needFills) {
          const minReserve = (p.probeSol * 10_000) / world.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (intents.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || world.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = world.curves.get(mint);
            if (curve === undefined || curve.done) continue;
            if (Number(curve.rQuote) / SOL < minReserve * 1.5) continue;
            if (free < p.probeSol + 2 * txSol) break;
            intents.push({ side: "buy", mint, amount: BigInt(Math.floor(p.probeSol * SOL)), slippageBps: p.slipBps });
            probes.set(mint, false);
            free -= p.probeSol + txSol;
          }
        }
      }
      return intents;
    },
  };
}
