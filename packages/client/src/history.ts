/**
 * Command history buffer with up/down arrow navigation.
 *
 * Framework-agnostic — `up()` and `down()` return the history entry
 * directly so the host application can update its own input element.
 */
const MAX_HISTORY = 200;

export class CommandHistory {
  private entries: string[] = [];
  private index = -1;

  /** Push a new command to the front of the history and reset the cursor. */
  push(command: string): void {
    const trimmed = command.trim();
    if (!trimmed) return;
    if (this.entries[0] === trimmed) {
      this.index = -1;
      return;
    }
    this.entries.unshift(trimmed);
    if (this.entries.length > MAX_HISTORY) this.entries.pop();
    this.index = -1;
  }

  /** Move the cursor toward older entries. Returns the entry or `null` if at the end. */
  up(): string | null {
    if (this.index < this.entries.length - 1) {
      this.index++;
      return this.entries[this.index];
    }
    return null;
  }

  /** Move the cursor toward newer entries. Returns the entry, or `null` when past the newest. */
  down(): string | null {
    if (this.index > 0) {
      this.index--;
      return this.entries[this.index];
    }
    if (this.index === 0) {
      this.index = -1;
      return null;
    }
    return null;
  }

  /** The current cursor position (-1 means "no selection"). */
  get cursor(): number {
    return this.index;
  }

  /** Reset the cursor without clearing entries. */
  reset(): void {
    this.index = -1;
  }

  /** Return a shallow copy of all history entries (newest first). */
  all(): string[] {
    return [...this.entries];
  }
}
