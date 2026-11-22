import { createServer, type Server, type Socket } from "node:net";
import type { PGliteInterface } from "@electric-sql/pglite";

/**
 * Test support: PGlite — real Postgres in process — served over TCP on
 * 127.0.0.1, so that code which only talks the wire protocol (the `pg`
 * driver in a child process: the entry point) runs
 * against a real database inside `npm test`, without Docker. Every message
 * is handed to PGlite unchanged (`execProtocolRaw`); nothing is emulated.
 *
 * PGlite has ONE session: the server accepts one connection at a time
 * (point a pool at it with DATABASE_POOL_SIZE=1), and every connection
 * shares that session's state. Any password is accepted.
 */
export interface PgliteServer {
  port: number;
  /** A connection URL for this server; the password is not checked. */
  url(credentials?: { user?: string; password?: string }): string;
  close(): Promise<void>;
}

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const TERMINATE = 0x58; // 'X'

export async function startPgliteServer(db: PGliteInterface): Promise<PgliteServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let started = false;
    // One message at a time, in order: PGlite's session is not re-entrant.
    let queue = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          // Startup-phase messages: int32 length, int32 code, no type byte.
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const message = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          const code = message.readInt32BE(4);
          if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
            socket.write("N"); // no TLS here; the client continues in plaintext or gives up
            continue;
          }
          started = true;
          enqueue(message);
        } else {
          if (buffer.length < 5) return;
          const length = buffer.readInt32BE(1) + 1;
          if (buffer.length < length) return;
          const message = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          if (message[0] === TERMINATE) {
            socket.end();
            return;
          }
          enqueue(message);
        }
      }
    });
    function enqueue(message: Buffer) {
      queue = queue
        .then(async () => {
          if (socket.destroyed) return;
          const reply = await db.execProtocolRaw(new Uint8Array(message));
          if (reply.length > 0 && !socket.destroyed) socket.write(Buffer.from(reply));
        })
        .catch(() => {
          socket.destroy();
        });
    }
  });
  server.maxConnections = 1;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("PGlite server: no TCP port");
  const port = address.port;
  return {
    port,
    url: ({ user = "postgres", password = "postgres" } = {}) =>
      `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
