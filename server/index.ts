import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";

const DB_PATH = process.env.DB_PATH || import.meta.dir + "/rooms.json";
const SERVER_SECRET = process.env.SERVER_SECRET || "";

type Room = { data: string; updatedAt: number };
type DB = Record<string, Room>;

// ─── In-memory DB with periodic flush ─────────────────────────────
let db: DB = {};
let dirty = false;

const file = Bun.file(DB_PATH);
if (await file.exists()) {
  db = await file.json();
  console.log(`[db] loaded ${Object.keys(db).length} rooms from ${DB_PATH}`);
}

setInterval(async () => {
  if (!dirty) return;
  await Bun.write(DB_PATH, JSON.stringify(db));
  dirty = false;
  console.log(`[db] flushed to disk`);
}, 5000);

// ─── Server ───────────────────────────────────────────────────────
const app = new Elysia()
  .use(cors())
  .onBeforeHandle(({ request, status }) => {
    if (!SERVER_SECRET) return;
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${SERVER_SECRET}`) {
      return status(401, { error: "Unauthorized" });
    }
  })
  .onRequest(({ request }) => {
    console.log(`→ ${request.method} ${new URL(request.url).pathname}`);
  })
  .onAfterResponse(({ request, set }) => {
    console.log(`← ${request.method} ${new URL(request.url).pathname} ${set.status || 200}`);
  })
  .onError(({ request, code, error }) => {
    console.log(`✗ ${request.method} ${new URL(request.url).pathname} [${code}] ${error.message}`);
  })
  .post("/room", () => {
    const id = crypto.randomUUID();
    db[id] = { data: "", updatedAt: Date.now() };
    dirty = true;
    console.log(`  [room] created: ${id}`);
    return { id };
  })
  .get("/room/:id", ({ params: { id }, status }) => {
    const room = db[id];
    if (!room) return status(404, { error: "Room not found" });
    return { data: room.data, updatedAt: room.updatedAt };
  })
  .put(
    "/room/:id",
    ({ params: { id }, body, status }) => {
      const room = db[id];
      if (!room) return status(404, { error: "Room not found" });
      room.data = body.data;
      room.updatedAt = Date.now();
      dirty = true;
      console.log(`  [room] ${id.slice(0, 8)}... ← ${body.data.length} chars`);
      return { ok: true };
    },
    {
      body: t.Object({
        data: t.String(),
      }),
    },
  )
  .delete("/room/:id", ({ params: { id }, status }) => {
    if (!db[id]) return status(404, { error: "Room not found" });
    delete db[id];
    dirty = true;
    return { ok: true };
  })
  .listen(3456);

console.log(`Cookie Sync server running on http://localhost:${app.server?.port}`);
