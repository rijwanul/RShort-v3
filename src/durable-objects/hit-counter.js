// One HitCounter instance exists per URL id (idFromName(String(urlId))).
// Because a Durable Object processes requests for a given id one at a
// time, incrementing here is race-free - this is what previous KV/D1
// based attempts were missing (KV is only eventually consistent, and
// concurrent D1 UPDATE ... SET count = count + 1 statements can lose
// writes under load).
//
// Raw hit events (date + referrer bucket) are buffered in memory and
// flushed to D1's hit_logs table on an alarm, so the dashboard's
// "refresh" button gets an instant, always-correct total from the DO's
// own durable storage, while date-wise / referrer analytics come from
// the periodically-flushed D1 rows.

const FLUSH_INTERVAL_MS = 20000;
const MAX_BUFFER = 200;

export class HitCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buffer = [];
    this.total = null;
  }

  async ensureLoaded() {
    if (this.total === null) {
      this.total = (await this.state.storage.get("total")) || 0;
      this.buffer = (await this.state.storage.get("buffer")) || [];
    }
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/hit") {
      const body = await request.json();
      this.total += 1;
      this.buffer.push({
        urlId: body.urlId,
        hitDate: body.hitDate,
        referrerBucket: body.referrerBucket || "direct",
      });
      await this.state.storage.put("total", this.total);
      await this.state.storage.put("buffer", this.buffer);

      if (this.buffer.length >= MAX_BUFFER) {
        await this.flush();
      } else {
        const alarm = await this.state.storage.getAlarm();
        if (!alarm) await this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
      }

      return new Response(JSON.stringify({ total: this.total }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/count") {
      return new Response(JSON.stringify({ total: this.total }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      this.total = 0;
      this.buffer = [];
      await this.state.storage.deleteAll();
      return new Response(JSON.stringify({ total: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    await this.ensureLoaded();
    await this.flush();
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    await this.state.storage.put("buffer", this.buffer);

    try {
      const stmts = events.map((e) =>
        this.env.DB.prepare(
          "INSERT INTO hit_logs (url_id, hit_date, referrer_bucket) VALUES (?, ?, ?)"
        ).bind(e.urlId, e.hitDate, e.referrerBucket)
      );
      await this.env.DB.batch(stmts);
    } catch (err) {
      // If the flush fails, put the events back so the next alarm retries.
      this.buffer = events.concat(this.buffer);
      await this.state.storage.put("buffer", this.buffer);
      await this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }
}
