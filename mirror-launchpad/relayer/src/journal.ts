import fs from "node:fs";
import path from "node:path";

interface State {
  lastBlock?: string;
}

/**
 * Remembers the last processed EVM block so restarts don't miss events.
 * Which orders were swapped is tracked on-chain by vault receipts, not here.
 */
export class Journal {
  private state: State = {};

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) this.state = JSON.parse(fs.readFileSync(file, "utf8"));
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
