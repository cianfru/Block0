import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, parseOne, parseRedisUrl } from "../store/redis-tcp.mjs";

test("encode: RESP array with byte-correct lengths (multibyte safe)", () => {
  assert.equal(encode(["GET", "k"]), "*2\r\n$3\r\nGET\r\n$1\r\nk\r\n");
  assert.equal(encode(["SET", "k", "€"]), "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\n€\r\n"); // € = 3 bytes
});

test("parseOne: every reply type", () => {
  assert.deepEqual(parseOne(Buffer.from("+OK\r\n")), { v: "OK", next: 5 });
  assert.equal(parseOne(Buffer.from(":7\r\n")).v, 7);
  assert.equal(parseOne(Buffer.from("$5\r\nhello\r\n")).v, "hello");
  assert.equal(parseOne(Buffer.from("$-1\r\n")).v, null);              // nil bulk
  assert.deepEqual(parseOne(Buffer.from("*2\r\n$1\r\na\r\n$1\r\nb\r\n")).v, ["a", "b"]);
  const err = parseOne(Buffer.from("-ERR nope\r\n"));
  assert.ok(err.err && err.v instanceof Error && /nope/.test(err.v.message));
});

test("parseOne: returns null until the FULL reply has arrived (split across TCP chunks)", () => {
  assert.equal(parseOne(Buffer.from("$5\r\nhel")), null);              // body not complete
  assert.equal(parseOne(Buffer.from("$5\r\nhello")), null);            // trailing CRLF missing
  assert.equal(parseOne(Buffer.from("*2\r\n$1\r\na\r\n")), null);      // array missing 2nd element
  assert.equal(parseOne(Buffer.from("+OK")), null);                    // header CRLF missing
});

test("parseOne: bulk string containing JSON (uses length prefix, not CRLF scanning)", () => {
  const json = JSON.stringify({ a: 1, s: "x,y" });
  const b = Buffer.from(`$${Buffer.byteLength(json)}\r\n${json}\r\n`);
  assert.equal(parseOne(b).v, json);
});

test("parseRedisUrl: Railway-style URL + rediss TLS", () => {
  const u = parseRedisUrl("redis://default:secretpw@host.internal:6379");
  assert.equal(u.host, "host.internal"); assert.equal(u.port, 6379);
  assert.equal(u.pass, "secretpw"); assert.equal(u.user, "default"); assert.equal(u.tls, false);
  assert.equal(parseRedisUrl("rediss://x:y@h:6380").tls, true);
  assert.equal(parseRedisUrl("http://nope"), null);   // wrong scheme → null
  assert.equal(parseRedisUrl("garbage"), null);
});
