import { EventEmitter } from "node:events";
import type { LibraryStreamEvent } from "@agent-thinking/contracts";

export class LibraryEventBus extends EventEmitter {
  emitEvent(event: LibraryStreamEvent): void {
    this.emit("library-event", event);
  }

  subscribe(listener: (event: LibraryStreamEvent) => void): () => void {
    this.on("library-event", listener);
    return () => this.off("library-event", listener);
  }
}
