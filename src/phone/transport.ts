// Transport boundary only. Host-specific ws/http or Workers upgrade APIs
// belong in the host adapter, never in core.ts or audio.ts.

/** Host adapters wrap their websocket implementation in this small interface. */
export type PhoneSocket = {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
};
