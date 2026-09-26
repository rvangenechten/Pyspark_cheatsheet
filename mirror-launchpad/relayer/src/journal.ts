import fs from "node:fs";
import path from "node:path";

export interface JournalEntry {
  side: "buy" | "sell";
  state: "swapping" | "swapped";
  signature?: string;
  amountOut?: string;
}

interface State {
  lastBlock?: string;
  orders: Record<string, JournalEntry>;
}

/**
 * Tiny write-through JSON store. Records each swap before and after it runs
 * so a restart never swaps twice for the same order.
 */
export class Journal {
  private state: State = { orders: {} };

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) this.state = JSON.parse(fs.readFileSync(file, "utf8"));
  }

  get(id: bigint) {
    return this.state.orders[id.toString()];
  }

  set(id: bigint, entry: JournalEntry) {
    this.state.orders[id.toString()] = entry;
    this.flush();
  }

  done(id: bigint) {
    delete this.state.orders[id.toString()];
    this.flush();
  }

  get lastBlock(): bigint | undefined {
    return this.state.lastBlock ? BigInt(this.state.lastBlock) : undefined;
  }

  set lastBlock(b: bigint | undefined) {
    this.state.lastBlock = b?.toString();
    this.flush();
  }

  private flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
