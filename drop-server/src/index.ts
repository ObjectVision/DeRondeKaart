/**
 * Boot the drop server: validate config (fail fast on a bad/missing public
 * key), open storage, start the P3 sweep, listen on loopback.
 *
 * TLS is nginx's job — this process binds 127.0.0.1 behind the
 * aanleveren.woonzorglimburg.nl site (see server/setup_drop_server.sh).
 */

import { dataDir, host, port, publicKey, limits } from "./config.js";
import { createDropServer } from "./server.js";
import { Storage } from "./storage.js";

const pubkey = publicKey(); // throws with a clear message if unset/invalid

const storage = new Storage(dataDir);
storage.startSweep();
// One sweep at boot: clears stray .part files from a crashed upload and
// surfaces pickup/TTL warnings without waiting a full interval.
storage.sweep().catch((err) => console.error("[storage] boot sweep failed:", err));

const server = createDropServer({ storage, publicKeyB64: pubkey });
server.listen(port, host, () => {
  console.log(
    `[drop] listening on http://${host}:${port} — data in ${dataDir}, ` +
      `${storage.storedBytes}B stored, max upload ${limits.maxDropBytes}B`,
  );
});
